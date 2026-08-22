// The text surgery PhySim performs on LifeBoatAPI's generated `_simulator.lua`.
//
// Kept free of any `vscode` import so test/simulatorLuaPatch.test.mjs can run
// it in plain Node — debugConfigPatcher.ts owns the file I/O and the user-
// facing warnings, this module owns what the patched text looks like.
//
// LifeBoatAPI regenerates _simulator.lua on every F6, so the patch is applied
// fresh each run; PHYSIM_MARKER only guards against patching the same file
// twice within one run.

/** Presence of this string means the file has already been patched. */
export const PHYSIM_MARKER = "_physim_socket";

/**
 * `local sandboxEnv = LifeBoatAPI.Tools.SimulatorSandbox.createSandbox(rootDirs)`
 * — the seam everything is injected around.
 */
const SANDBOX_LINE_RE =
  /(local\s+sandboxEnv\s*=\s*LifeBoatAPI\.Tools\.SimulatorSandbox\.createSandbox\(rootDirs\)\s*)/;

/**
 * `simulator:_beginSimulation(false, arg[1], arg[2])` — the `false` is
 * LifeBoatAPI's `attachToExistingProcess`, and flipping it to `true` skips the
 * `io.popen` that launches STORMWORKS_Simulator.exe. The Lua then connects to
 * whatever is already listening on 14238, which is us.
 */
const BEGIN_SIMULATION_RE = /(simulator:_beginSimulation\(\s*)false(\s*,)/;

// The socket library is a C module, so sandboxed scripts can never require it
// themselves — the host chunk copies it into the sandbox env instead.
const SOCKET_INJECTION = [
  "",
  "-- ==== PhySim injection (auto-added by Stormworks Physics Sensor Sim) ====",
  "sandboxEnv._physim_socket = require(\"socket\")",
  "-- ============================================================================",
  ""
].join("\n");

// LifeBoatAPI's FileSystemUtils.findPathsInDir shells out to Windows
// `dir "..." /b`, which on macOS makes every directory scan return nothing —
// so SimulatorSandbox's require map ends up empty and the user's script can't
// be loaded ("Could not find require: ..."). This runs at host level in
// _simulator.lua (outside the sandbox, io.popen available), BEFORE
// createSandbox, and swaps in a POSIX `find` with the same contract: bare
// names, files ("/a-d") vs directories ("/ad").
const POSIX_FS_INJECTION = [
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

export interface PatchOptions {
  /** Replace the Windows `dir /b` directory scan with POSIX `find` (macOS). */
  posixFileScan: boolean;
  /**
   * PhySim renders the monitors itself this run, so LifeBoatAPI must not launch
   * STORMWORKS_Simulator.exe — on Windows the exe would otherwise fight us for
   * port 14238, and on macOS it can't run at all.
   */
  builtInMonitors: boolean;
}

export interface PatchResult {
  text: string;
  /** False when the text was already patched (marker present) — text is unchanged. */
  patched: boolean;
  /** False when the createSandbox line is missing: no socket for PhySim.lua. */
  sandboxLineFound: boolean;
  /**
   * False when the `_beginSimulation(false, ...)` call is missing, so the exe
   * launch could not be suppressed. Only meaningful with builtInMonitors.
   */
  beginSimulationFound: boolean;
}

/**
 * @param text contents of LifeBoatAPI's generated `_simulator.lua`
 */
export function patchSimulatorLua(text: string, opts: PatchOptions): PatchResult {
  const sandboxLineFound = SANDBOX_LINE_RE.test(text);
  const beginSimulationFound = BEGIN_SIMULATION_RE.test(text);

  if (text.indexOf(PHYSIM_MARKER) !== -1) {
    return { text, patched: false, sandboxLineFound, beginSimulationFound };
  }

  let out = text;
  if (opts.builtInMonitors && beginSimulationFound) {
    out = out.replace(BEGIN_SIMULATION_RE, "$1true$2");
  }
  if (sandboxLineFound) {
    // The FS shim must run BEFORE createSandbox (it drives the sandbox's
    // require-map scan); the socket line after it.
    const before = opts.posixFileScan ? POSIX_FS_INJECTION : "";
    out = out.replace(SANDBOX_LINE_RE, before + "$1" + SOCKET_INJECTION);
  }
  return { text: out, patched: out !== text, sandboxLineFound, beginSimulationFound };
}
