import * as vscode from "vscode";
import * as path from "path";

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

const MARKER = "_physim_socket";

const INJECTION = [
  "",
  "-- ==== PhySim injection (auto-added by Stormworks Physics Sensor Sim) ====",
  "sandboxEnv._physim_socket = require(\"socket\")",
  "-- ============================================================================",
  ""
].join("\n");

const SANDBOX_LINE_RE =
  /(local\s+sandboxEnv\s*=\s*LifeBoatAPI\.Tools\.SimulatorSandbox\.createSandbox\(rootDirs\)\s*)/;

function normalize(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

export class PhysimDebugPatcher implements vscode.DebugConfigurationProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    if (config.type !== "lua" || config.name !== "Run Simulator") return config;

    // (1) Ensure our bundled lua/ is in the simulator's library roots.
    const luaDir = vscode.Uri.joinPath(this.extensionUri, "lua").fsPath;
    if (!Array.isArray(config.arg)) config.arg = [];
    const wanted = normalize(luaDir);
    const already = (config.arg as unknown[]).some(a =>
      typeof a === "string" && normalize(a) === wanted
    );
    if (!already) (config.arg as string[]).push(luaDir);

    // (2) Patch _simulator.lua to expose `socket` to the sandbox env.
    if (typeof config.program !== "string") return config;
    const uri = vscode.Uri.file(config.program);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      if (text.indexOf(MARKER) !== -1) return config;
      if (!SANDBOX_LINE_RE.test(text)) {
        vscode.window.showWarningMessage(
          "PhySim: could not patch _simulator.lua (LifeBoatAPI sandbox line not found). " +
          "PhySim.lua will not be able to open a socket; falling back to raw require."
        );
        return config;
      }
      const patched = text.replace(SANDBOX_LINE_RE, "$1" + INJECTION);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(patched));
    } catch (err: any) {
      vscode.window.showWarningMessage(
        "PhySim: failed to patch _simulator.lua: " + (err?.message ?? String(err))
      );
    }
    return config;
  }
}
