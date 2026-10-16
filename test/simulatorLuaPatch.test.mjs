// src/simulatorLuaPatch.ts — the text surgery applied to LifeBoatAPI's
// generated _simulator.lua. The sample below is the real template from
// LifeBoatAPI 0.0.33's runSimulator.js:generateSimulatorLua().

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { patchSimulatorLua, PHYSIM_MARKER } from "../out/simulatorLuaPatch.js";

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring } = require("fengari");

/** Compile (don't run) a chunk in Lua 5.3 and return the syntax error, if any. */
function luaSyntaxError(source) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const status = lauxlib.luaL_loadstring(L, to_luastring(source));
  return status === lua.LUA_OK ? null : lua.lua_tojsstring(L, -1);
}

const SAMPLE = `
require("LifeBoatAPI.Tools.Simulator.Simulator")
require("LifeBoatAPI.Tools.Simulator.SimulatorSandbox")

-- command line input
for k,v in pairs(arg) do
    arg[k] = v:gsub("##LBNEWLINE##", "\\n")
end

local rootDirs = {};
for i=3, #arg do
    rootDirs[#rootDirs+1] = LifeBoatAPI.Tools.Filepath:new(arg[i])
end

-- simulator
local sandboxEnv = LifeBoatAPI.Tools.SimulatorSandbox.createSandbox(rootDirs)
local simulator = LifeBoatAPI.Tools.Simulator:new(sandboxEnv)
sandboxEnv.simulator = simulator
simulator:_beginSimulation(false, arg[1], arg[2])

-- main require
sandboxEnv.require("MyMicrocontroller")

simulator:_giveControlToMainLoop()
`;

const TOKENS = { physToken: "0123456789abcdef0123456789abcdef", monitorToken: "fedcba9876543210fedcba9876543210" };
const WINDOWS = { posixFileScan: false, builtInMonitors: false, ...TOKENS };
const MACOS = { posixFileScan: true, builtInMonitors: true, ...TOKENS };

test("socket is injected after createSandbox, never before", () => {
  const r = patchSimulatorLua(SAMPLE, WINDOWS);
  assert.equal(r.patched, true);
  assert.equal(r.sandboxLineFound, true);
  assert.ok(r.text.includes(`sandboxEnv.${PHYSIM_MARKER} = require("socket")`));
  assert.ok(r.text.indexOf("createSandbox(rootDirs)") < r.text.indexOf(PHYSIM_MARKER));
  // the sandbox env has to exist before we can assign into it
  assert.ok(r.text.indexOf(PHYSIM_MARKER) < r.text.indexOf("local simulator ="));
});

test("the POSIX file scan shim lands before createSandbox", () => {
  const r = patchSimulatorLua(SAMPLE, MACOS);
  const shim = r.text.indexOf("FileSystemUtils.findPathsInDir");
  assert.ok(shim !== -1, "shim missing");
  assert.ok(shim < r.text.indexOf("createSandbox(rootDirs)"),
    "the shim must run before the sandbox's require-map scan");
});

test("the POSIX shim is Windows-free: not added when the platform doesn't need it", () => {
  const r = patchSimulatorLua(SAMPLE, WINDOWS);
  assert.ok(!r.text.includes("findPathsInDir"));
});

test("built-in monitors flip _beginSimulation to attach mode", () => {
  const on = patchSimulatorLua(SAMPLE, { posixFileScan: false, builtInMonitors: true, ...TOKENS });
  assert.equal(on.beginSimulationFound, true);
  assert.ok(on.text.includes("simulator:_beginSimulation(true, arg[1], arg[2])"));
  assert.ok(!on.text.includes("_beginSimulation(false"));
});

test("without built-in monitors the exe launch is left alone", () => {
  const off = patchSimulatorLua(SAMPLE, WINDOWS);
  assert.ok(off.text.includes("simulator:_beginSimulation(false, arg[1], arg[2])"));
});

test("patching is idempotent — the marker stops a second pass", () => {
  const once = patchSimulatorLua(SAMPLE, MACOS);
  const twice = patchSimulatorLua(once.text, MACOS);
  assert.equal(twice.patched, false);
  assert.equal(twice.text, once.text);
});

test("a missing createSandbox line is reported, socket injection skipped", () => {
  const text = SAMPLE.replace(
    "local sandboxEnv = LifeBoatAPI.Tools.SimulatorSandbox.createSandbox(rootDirs)",
    "local sandboxEnv = somethingElseEntirely()"
  );
  const r = patchSimulatorLua(text, MACOS);
  assert.equal(r.sandboxLineFound, false);
  assert.ok(!r.text.includes(PHYSIM_MARKER));
  // suppressing the exe still matters even when the socket injection can't happen
  assert.ok(r.text.includes("_beginSimulation(true"));
});

test("a missing _beginSimulation call is reported, not guessed at", () => {
  const text = SAMPLE.replace("simulator:_beginSimulation(false, arg[1], arg[2])", "");
  const r = patchSimulatorLua(text, MACOS);
  assert.equal(r.beginSimulationFound, false);
  assert.equal(r.sandboxLineFound, true);
  assert.ok(r.text.includes(PHYSIM_MARKER));
});

test("whitespace variations in the generated call still match", () => {
  const text = SAMPLE.replace(
    "simulator:_beginSimulation(false, arg[1], arg[2])",
    "simulator:_beginSimulation( false , arg[1], arg[2])"
  );
  const r = patchSimulatorLua(text, MACOS);
  assert.equal(r.beginSimulationFound, true);
  assert.ok(r.text.includes("_beginSimulation( true ,"));
});

test("the injected Lua is syntactically valid (compiled by fengari)", () => {
  assert.equal(luaSyntaxError(SAMPLE), null, "the sample itself must compile");
  for (const opts of [WINDOWS, MACOS, { posixFileScan: true, builtInMonitors: false, ...TOKENS }]) {
    const r = patchSimulatorLua(SAMPLE, opts);
    assert.equal(luaSyntaxError(r.text), null,
      `patched output failed to compile for ${JSON.stringify(opts)}`);
  }
});

// ── session tokens (sessionAuth.ts) ───────────────────────────────────────

/**
 * Run a patched _simulator.lua against stand-ins for the LifeBoatAPI tables it
 * touches, and report what reached the sandbox and the 14238 connection.
 */
function runPatched(source) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const harness = `
    arg = { "exe", "log" }
    require = function() return "socket-module" end
    sent = {}
    LifeBoatAPI = { Tools = {
      FileSystemUtils = {},
      Filepath = { new = function(_, p) return p end },
      SimulatorSandbox = { createSandbox = function() ENV = { require = function() end }; return ENV end },
      SimulatorConnection = { new = function(this)
        return { sendCommand = function(self, ...) sent[#sent + 1] = table.concat({ ... }, "|") end }
      end },
      Simulator = { new = function()
        return {
          _beginSimulation = function(self)
            self._connection = LifeBoatAPI.Tools.SimulatorConnection:new()
            self._connection:sendCommand("SCREENCONFIG", 1)
          end,
          _giveControlToMainLoop = function() end
        }
      end }
    } }
  `;
  for (const chunk of [harness, source, "RESULT = ENV._physim_token .. '#' .. table.concat(sent, ',')"]) {
    if (lauxlib.luaL_dostring(L, to_luastring(chunk)) !== lua.LUA_OK) {
      throw new Error(lua.lua_tojsstring(L, -1));
    }
  }
  lua.lua_getglobal(L, "RESULT");
  const [token, sent] = lua.lua_tojsstring(L, -1).split("#");
  return { token, sent: sent ? sent.split(",") : [] };
}

test("the 14238 token is the first frame on the monitor connection, ahead of SCREENCONFIG", () => {
  const r = runPatched(patchSimulatorLua(SAMPLE, MACOS).text);
  assert.deepEqual(r.sent, [`PHYSIM_AUTH|${TOKENS.monitorToken}`, "SCREENCONFIG|1"]);
});

test("PhySim.lua's sandbox gets the 14239 token, not the monitor one", () => {
  const r = runPatched(patchSimulatorLua(SAMPLE, MACOS).text);
  assert.equal(r.token, TOKENS.physToken);
});

test("with the real exe in charge, the exe's connection is left alone", () => {
  const r = runPatched(patchSimulatorLua(SAMPLE, WINDOWS).text);
  assert.deepEqual(r.sent, ["SCREENCONFIG|1"]);
  assert.equal(r.token, TOKENS.physToken);
});

test("a second pass with a new session's tokens replaces them and injects nothing twice", () => {
  const once = patchSimulatorLua(SAMPLE, MACOS);
  const next = { ...MACOS, physToken: "1".repeat(32), monitorToken: "2".repeat(32) };
  const twice = patchSimulatorLua(once.text, next);
  assert.equal(twice.patched, true);
  assert.ok(!twice.text.includes(TOKENS.physToken) && !twice.text.includes(TOKENS.monitorToken));
  assert.equal(twice.text.split("_physim_socket = ").length, 2, "socket injected once");
  assert.equal(twice.text.split("SimulatorConnection.new = ").length, 2, "wrapper injected once");
  assert.deepEqual(runPatched(twice.text).sent, [`PHYSIM_AUTH|${"2".repeat(32)}`, "SCREENCONFIG|1"]);
});

test("nothing to inject means no token line either", () => {
  const r = patchSimulatorLua("print('a different template')\n", MACOS);
  assert.equal(r.patched, false);
});

test("a token that is not lowercase hex never reaches the Lua source", () => {
  for (const bad of ['"..os.exit()..', "ABCDEF", ""]) {
    assert.throws(() => patchSimulatorLua(SAMPLE, { ...MACOS, monitorToken: bad }), /lowercase hex/);
    assert.throws(() => patchSimulatorLua(SAMPLE, { ...MACOS, physToken: bad }), /lowercase hex/);
  }
});
