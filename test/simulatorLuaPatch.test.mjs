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

const WINDOWS = { posixFileScan: false, builtInMonitors: false };
const MACOS = { posixFileScan: true, builtInMonitors: true };

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
  const on = patchSimulatorLua(SAMPLE, { posixFileScan: false, builtInMonitors: true });
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
  for (const opts of [WINDOWS, MACOS, { posixFileScan: true, builtInMonitors: false }]) {
    const r = patchSimulatorLua(SAMPLE, opts);
    assert.equal(luaSyntaxError(r.text), null,
      `patched output failed to compile for ${JSON.stringify(opts)}`);
  }
});
