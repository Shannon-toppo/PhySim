import * as vscode from "vscode";
import { normalize } from "./pathUtils";
import { SimStubServer, SIM_STUB_PORT } from "./simStubServer";
import { patchSimulatorLua } from "./simulatorLuaPatch";
import { log } from "./log";

// LifeBoatAPI's SimulatorSandbox builds its own restricted `require` that only
// resolves Lua files under the project's root directories (the args passed to
// _simulator.lua at startup). That means:
//
//   1. PhySim.lua is only resolvable if our bundled lua/ folder is in those
//      root directories. We'd previously relied on writing the path into the
//      workspace's `lifeboatapi.stormworks.libs.libraryPaths` setting, but
//      that only happens on activate — a workspace opened later in the same
//      VSCode session never gets injected.
//   2. `require("socket")` (a C module) cannot be called from inside scripts
//      loaded into the sandbox at all.
//
// We solve both by hooking the debug config provider, which runs after
// LifeBoatAPI assembles the launch args but BEFORE lua-debug spawns Lua:
//
//   * Append our lua/ folder to `config.arg` so the sandbox indexes PhySim.lua
//     even without any workspace setting.
//   * Patch the generated `_simulator.lua` to copy the host (non-sandboxed)
//     `socket` library into the sandbox env as `_physim_socket`.

/**
 * Whether PhySim renders the microcontroller's monitors itself this run.
 *
 * Always on macOS — `STORMWORKS_Simulator.exe` is a Windows binary and cannot
 * run there at all. On Windows the real exe is the faithful renderer, so the
 * built-in one is opt-in and experimental: enabling it suppresses the exe
 * (LifeBoatAPI's own `attachToExistingProcess` path) and PhySim answers on
 * port 14238 in its place, which also means losing the exe's input/output
 * panels. Read per debug session, so toggling the setting takes effect on the
 * next F6 rather than needing a window reload.
 */
export function useBuiltInMonitors(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform !== "win32") return false;
  return vscode.workspace.getConfiguration()
    .get<boolean>("physim.monitors.useBuiltInOnWindows", false) === true;
}

export class PhysimDebugPatcher implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly stub: SimStubServer | null = null
  ) {}

  async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    if (config.type !== "lua" || config.name !== "Run Simulator") return config;

    // (0) Stand in for STORMWORKS_Simulator.exe on 14238 when we are the ones
    // drawing the monitors. The Lua client connects once with no retry as soon
    // as it starts, so the listener has to be up before lua-debug spawns Lua —
    // this hook is the last point where that is guaranteed.
    const builtInMonitors = useBuiltInMonitors();
    log(
      `Simulate (F6) on ${process.platform}: monitors drawn by ` +
      (builtInMonitors ? "PhySim (built-in)" : "LifeBoatAPI's STORMWORKS_Simulator.exe") +
      (process.platform === "win32"
        ? ` — physim.monitors.useBuiltInOnWindows = ${builtInMonitors}`
        : "")
    );
    if (this.stub && builtInMonitors) {
      try {
        await this.stub.start();
        log(`Listening on 127.0.0.1:${SIM_STUB_PORT} in place of the simulator exe.`);
      } catch (err) {
        log(`FAILED to listen on ${SIM_STUB_PORT}: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage(
          `PhySim: could not listen on port ${SIM_STUB_PORT} (${err instanceof Error ? err.message : String(err)}). ` +
          "Another process — possibly a previous simulator run — is using it, so the monitor view will stay blank."
        );
      }
    } else if (this.stub?.isListening()) {
      // The setting was turned off between runs: release the port so
      // LifeBoatAPI's own exe can take it again.
      await this.stub.stop();
      log(`Released port ${SIM_STUB_PORT} back to LifeBoatAPI's simulator exe.`);
    }

    // (0b) macOS only: point cpath at our bundled universal luasocket .so and
    // force a native luaArch. LifeBoatAPI's own cpath entries are literal
    // `.dll` file paths with no `?` template, and Lua's package.searchpath
    // returns the first READABLE file regardless of module name — so our
    // entry MUST be prepended, never appended, or it's never tried. See
    // doc/macos-support.md ("修正時の落とし穴: cpath は「前に」入れないと効かない").
    // luaArch is separately overridden because LifeBoatAPI hardcodes "x86",
    // which would otherwise run Lua under Rosetta instead of natively.
    if (process.platform === "darwin") {
      const soTemplate = vscode.Uri.joinPath(this.extensionUri, "luasocket", "darwin", "?.so").fsPath;
      if (typeof config.cpath !== "string" || config.cpath.indexOf(soTemplate) === -1) {
        config.cpath = typeof config.cpath === "string" && config.cpath.length > 0
          ? soTemplate + ";" + config.cpath
          : soTemplate;
      }
      config.luaArch = process.arch === "arm64" ? "arm64" : "x86_64";
    }

    // (1) Ensure our bundled lua/ is in the simulator's library roots.
    const luaDir = vscode.Uri.joinPath(this.extensionUri, "lua").fsPath;
    if (!Array.isArray(config.arg)) config.arg = [];
    const wanted = normalize(luaDir);
    const already = (config.arg as unknown[]).some(a =>
      typeof a === "string" && normalize(a) === wanted
    );
    if (!already) (config.arg as string[]).push(luaDir);

    // (2) Patch _simulator.lua: expose `socket` to the sandbox env, and — when
    // we are drawing the monitors — stop LifeBoatAPI from launching the exe.
    if (typeof config.program !== "string") return config;
    const uri = vscode.Uri.file(config.program);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const result = patchSimulatorLua(text, {
        posixFileScan: process.platform === "darwin",
        builtInMonitors
      });
      log(
        `_simulator.lua: socket injection ${result.sandboxLineFound ? "ok" : "FAILED"}` +
        (builtInMonitors
          ? `, exe launch suppressed ${result.beginSimulationFound ? "ok" : "FAILED"}`
          : "")
      );
      if (!result.sandboxLineFound) {
        vscode.window.showWarningMessage(
          "PhySim: could not patch _simulator.lua (LifeBoatAPI sandbox line not found). " +
          "PhySim.lua will not be able to open a socket; falling back to raw require."
        );
      }
      if (builtInMonitors && !result.beginSimulationFound) {
        vscode.window.showWarningMessage(
          "PhySim: could not stop LifeBoatAPI from launching STORMWORKS_Simulator.exe " +
          "(_beginSimulation call not found). It will compete with PhySim for port " +
          `${SIM_STUB_PORT}, so the monitors may stay blank.`
        );
      }
      if (!result.patched) return config;
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(result.text));
    } catch (err) {
      vscode.window.showWarningMessage(
        "PhySim: failed to patch _simulator.lua: " + (err instanceof Error ? err.message : String(err))
      );
    }
    return config;
  }
}
