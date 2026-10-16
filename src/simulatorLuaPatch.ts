// The text surgery PhySim performs on LifeBoatAPI's generated `_simulator.lua`.
//
// Kept free of any `vscode` import so test/simulatorLuaPatch.test.mjs can run
// it in plain Node — debugConfigPatcher.ts owns the file I/O and the user-
// facing warnings, this module owns what the patched text looks like.
//
// LifeBoatAPI regenerates _simulator.lua on every F6, so the patch is applied
// fresh each run; PHYSIM_MARKER only guards against patching the same file
// twice within one run. A second pass still rewrites the session tokens, since
// each F6 renews them and a stale one would lock the Lua out.

import { AUTH_COMMAND } from "./sessionAuth";

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

/**
 * Prepended to the file so both injections below can read it. One token per
 * port: a process squatting on 14239 receives PhySim.lua's token, and must not
 * get the key to 14238 with it.
 */
const TOKEN_LINE_RE = /^local _physim_token, _physim_monitor_token = "[0-9a-f]*", "[0-9a-f]*"\n/;

function tokenLine(physToken: string, monitorToken: string): string {
  return `local _physim_token, _physim_monitor_token = "${physToken}", "${monitorToken}"\n`;
}

// The socket library is a C module, so sandboxed scripts can never require it
// themselves — the host chunk copies it into the sandbox env instead, along
// with the token PhySim.lua presents to PhysServer (port 14239).
const SOCKET_INJECTION = [
  "",
  "-- ==== PhySim injection (auto-added by Stormworks Physics Sensor Sim) ====",
  "sandboxEnv._physim_socket = require(\"socket\")",
  "sandboxEnv._physim_token = _physim_token",
  "-- ============================================================================",
  ""
].join("\n");

// SimStubServer (port 14238) only takes a connection whose first frame is the
// token. LifeBoatAPI's SimulatorConnection.new connects and returns; wrapping
// it makes the token the first thing on the wire, ahead of the SCREENCONFIG
// _beginSimulation sends next. Goes in right before that call.
const MONITOR_AUTH_INJECTION = [
  "-- ==== PhySim injection: authenticate to PhySim's monitor server ====",
  "local _physim_newConnection = LifeBoatAPI.Tools.SimulatorConnection.new",
  "LifeBoatAPI.Tools.SimulatorConnection.new = function(this)",
  "    local connection = _physim_newConnection(this)",
  `    connection:sendCommand("${AUTH_COMMAND}", _physim_monitor_token)`,
  "    return connection",
  "end",
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
  /** PhysServer's session token (port 14239), lowercase hex. */
  physToken: string;
  /** SimStubServer's session token (port 14238), lowercase hex. */
  monitorToken: string;
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
  // The tokens are pasted into Lua source; anything but hex is a caller bug.
  for (const t of [opts.physToken, opts.monitorToken]) {
    if (!/^[0-9a-f]+$/.test(t)) throw new Error("PhySim: session token must be lowercase hex");
  }
  const sandboxLineFound = SANDBOX_LINE_RE.test(text);
  const beginSimulationFound = BEGIN_SIMULATION_RE.test(text);
  const tokens = tokenLine(opts.physToken, opts.monitorToken);

  if (text.indexOf(PHYSIM_MARKER) !== -1) {
    const out = text.replace(TOKEN_LINE_RE, tokens);
    return { text: out, patched: out !== text, sandboxLineFound, beginSimulationFound };
  }

  let out = text;
  const monitorAuth = opts.builtInMonitors && beginSimulationFound;
  if (monitorAuth) {
    out = out.replace(BEGIN_SIMULATION_RE, MONITOR_AUTH_INJECTION + "$1true$2");
  }
  if (sandboxLineFound) {
    // The FS shim must run BEFORE createSandbox (it drives the sandbox's
    // require-map scan); the socket line after it.
    const before = opts.posixFileScan ? POSIX_FS_INJECTION : "";
    out = out.replace(SANDBOX_LINE_RE, before + "$1" + SOCKET_INJECTION);
  }
  if (monitorAuth || sandboxLineFound) out = tokens + out;
  return { text: out, patched: out !== text, sandboxLineFound, beginSimulationFound };
}
