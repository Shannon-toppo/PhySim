import * as vscode from "vscode";
import { normalize } from "./pathUtils";
import { SimStubServer, SIM_STUB_PORT } from "./simStubServer";

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

// LifeBoatAPI's FileSystemUtils.findPathsInDir shells out to Windows
// `dir "..." /b`, which on macOS makes every directory scan return nothing —
// so SimulatorSandbox's require map ends up empty and the user's script can't
// be loaded ("Could not find require: ..."). This runs at host level in
// _simulator.lua (outside the sandbox, io.popen available), BEFORE
// createSandbox, and swaps in a POSIX `find` with the same contract: bare
// names, files ("/a-d") vs directories ("/ad").
const DARWIN_FS_INJECTION = [
  "",
  "-- ==== PhySim injection (macOS): POSIX replacement for `dir /b` scans ====",
  "LifeBoatAPI.Tools.FileSystemUtils.findPathsInDir = function(dirPath, commandlinePattern)",
  "    local result = {}",
  "    local kind = (commandlinePattern == \"/ad\") and \"d\" or \"f\"",
  "    local process = io.popen('find \"' .. dirPath:linux() .. '\" -mindepth 1 -maxdepth 1 -type ' .. kind .. ' 2>/dev/null')",
  "    for line in process:lines() do",
  "        result[#result+1] = line:match(\"([^/]+)$\")",
  "    end",
  "    process:close()",
  "    return result",
  "end",
  "-- ============================================================================",
  ""
].join("\n");

const INJECTION = [
  "",
  "-- ==== PhySim injection (auto-added by Stormworks Physics Sensor Sim) ====",
  "sandboxEnv._physim_socket = require(\"socket\")",
  "-- ============================================================================",
  ""
].join("\n");

const SANDBOX_LINE_RE =
  /(local\s+sandboxEnv\s*=\s*LifeBoatAPI\.Tools\.SimulatorSandbox\.createSandbox\(rootDirs\)\s*)/;

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

    // (0) macOS only: LifeBoatAPI's STORMWORKS_Simulator.exe can't run here, so
    // we stand in for it on 14238. The Lua client connects once with no retry
    // as soon as it starts, so the listener has to be up before lua-debug
    // spawns Lua — this hook is the last point where that is guaranteed.
    if (this.stub) {
      try {
        await this.stub.start();
      } catch (err) {
        vscode.window.showErrorMessage(
          `PhySim: could not listen on port ${SIM_STUB_PORT} (${err instanceof Error ? err.message : String(err)}). ` +
          "Another process — possibly a previous simulator run — is using it, so the monitor view will stay blank."
        );
      }
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
      // The FS shim must run BEFORE createSandbox (it drives the sandbox's
      // require-map scan), the socket line after it.
      const before = process.platform === "darwin" ? DARWIN_FS_INJECTION : "";
      const patched = text.replace(SANDBOX_LINE_RE, before + "$1" + INJECTION);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(patched));
    } catch (err) {
      vscode.window.showWarningMessage(
        "PhySim: failed to patch _simulator.lua: " + (err instanceof Error ? err.message : String(err))
      );
    }
    return config;
  }
}
