// src/debugConfigPatcher.ts — the glue that runs between LifeBoatAPI writing
// _build/_simulator.lua and lua-debug spawning Lua. Its rules are the ones
// CLAUDE.md calls easy to break: cpath is PREPENDED (never appended), luaArch
// is forced native, arg gets our lua/ dir once, and the exe launch is only
// suppressed when PhySim is drawing the monitors.
//
// The module imports "vscode", which only exists inside the extension host, so
// a stub is served for it before the compiled file is loaded. Platform and arch
// are process-wide, hence the defineProperty swaps in `run()`.

import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

const EXT = "/ext";
const SO = path.join(EXT, "luasocket", "darwin", "?.so");
const LUA_DIR = path.join(EXT, "lua");

/** What the stub's `workspace`/`window` were asked to do, reset by `run()`. */
const env = {
  setting: false,
  files: new Map(),
  writes: [],
  errors: [],
  warnings: [],
  readError: null
};

const vscodeStub = {
  Uri: {
    file: p => ({ fsPath: p }),
    joinPath: (base, ...segs) => ({ fsPath: path.join(base.fsPath, ...segs) })
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, dflt) => (env.setting === undefined ? dflt : env.setting) }),
    fs: {
      readFile: async uri => {
        if (env.readError) throw env.readError;
        return new TextEncoder().encode(env.files.get(uri.fsPath));
      },
      writeFile: async (uri, bytes) => {
        env.writes.push({ path: uri.fsPath, text: new TextDecoder().decode(bytes) });
      }
    }
  },
  window: {
    showErrorMessage: m => { env.errors.push(m); },
    showWarningMessage: m => { env.warnings.push(m); },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} })
  },
  l10n: { t: (m, ...args) => m.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) }
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeStub : realLoad.call(this, request, ...rest);
};
const { PhysimDebugPatcher, useBuiltInMonitors } = require("../out/debugConfigPatcher.js");
Module._load = realLoad;

// LifeBoatAPI 0.0.33's generated script, trimmed to the two lines the patcher
// looks for (the full template is exercised in simulatorLuaPatch.test.mjs).
const SIMULATOR_LUA = [
  "local sandboxEnv = LifeBoatAPI.Tools.SimulatorSandbox.createSandbox(rootDirs)",
  "local simulator = LifeBoatAPI.Tools.Simulator:new(sandboxEnv)",
  "simulator:_beginSimulation(false, arg[1], arg[2])",
  ""
].join("\n");

function fakeStub({ listening = false, startError = null } = {}) {
  const calls = [];
  return {
    calls,
    start: async () => { calls.push("start"); if (startError) throw startError; },
    stop: async () => { calls.push("stop"); },
    isListening: () => listening
  };
}

function runConfig(over = {}) {
  return { type: "lua", name: "Run Simulator", program: "/proj/_build/_simulator.lua", ...over };
}

/**
 * Run the provider on `platform`/`arch`. `files` maps program path → text.
 * Always restores the real process.platform / process.arch.
 */
async function run(config, { platform = "linux", arch = "x64", setting = false, stub = null, files } = {}) {
  env.setting = setting;
  env.files = new Map(Object.entries(files ?? { "/proj/_build/_simulator.lua": SIMULATOR_LUA }));
  env.writes = [];
  env.errors = [];
  env.warnings = [];
  env.readError = null;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
  try {
    const provider = new PhysimDebugPatcher({ fsPath: EXT }, stub);
    return await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, config);
  } finally {
    Object.defineProperty(process, "platform", realPlatform);
    Object.defineProperty(process, "arch", realArch);
  }
}

// ── which sessions it touches ─────────────────────────────────────────────

test("a debug config that is not LifeBoatAPI's Run Simulator is returned untouched", async () => {
  for (const cfg of [
    { type: "node", name: "Run Simulator", program: "/p/_simulator.lua" },
    { type: "lua", name: "Something else", program: "/p/_simulator.lua" }
  ]) {
    const before = structuredClone(cfg);
    const out = await run(cfg, { platform: "darwin" });
    assert.deepEqual(out, before);
    assert.equal(env.writes.length, 0);
  }
});

// ── useBuiltInMonitors ────────────────────────────────────────────────────

test("useBuiltInMonitors: always on macOS, never elsewhere, setting-driven on Windows", async () => {
  const at = (platform, setting) => {
    env.setting = setting;
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    try { return useBuiltInMonitors(); } finally { Object.defineProperty(process, "platform", real); }
  };
  assert.equal(at("darwin", false), true);
  assert.equal(at("linux", true), false);
  assert.equal(at("win32", false), false);
  assert.equal(at("win32", true), true);
  assert.equal(at("win32", "true"), false, "only a real boolean true opts in");
});

// ── cpath / luaArch (macOS only) ──────────────────────────────────────────

test("darwin: our .so template goes in FRONT of LifeBoatAPI's literal-path cpath", async () => {
  const out = await run(runConfig({ cpath: "C:/lifeboat/socket/core.dll" }), { platform: "darwin", arch: "arm64" });
  assert.equal(out.cpath, `${SO};C:/lifeboat/socket/core.dll`);
  assert.ok(out.cpath.startsWith(SO), "appending would never be tried: searchpath returns the first readable file");
});

test("darwin: a missing or empty cpath becomes just our template", async () => {
  for (const cpath of [undefined, "", 42]) {
    const out = await run(runConfig({ cpath }), { platform: "darwin", arch: "arm64" });
    assert.equal(out.cpath, SO);
  }
});

test("darwin: running twice does not add the template twice", async () => {
  const cfg = runConfig({ cpath: "x.dll" });
  await run(cfg, { platform: "darwin", arch: "arm64" });
  const once = cfg.cpath;
  await run(cfg, { platform: "darwin", arch: "arm64" });
  assert.equal(cfg.cpath, once);
});

test("darwin: luaArch follows the native arch instead of LifeBoatAPI's hardcoded x86", async () => {
  assert.equal((await run(runConfig({ luaArch: "x86" }), { platform: "darwin", arch: "arm64" })).luaArch, "arm64");
  assert.equal((await run(runConfig({ luaArch: "x86" }), { platform: "darwin", arch: "x64" })).luaArch, "x86_64");
});

test("non-darwin: cpath and luaArch are left exactly as LifeBoatAPI wrote them", async () => {
  for (const platform of ["win32", "linux"]) {
    const out = await run(runConfig({ cpath: "a.dll", luaArch: "x86" }), { platform });
    assert.equal(out.cpath, "a.dll");
    assert.equal(out.luaArch, "x86");
  }
});

// ── config.arg ────────────────────────────────────────────────────────────

test("arg: our lua/ dir is appended after LifeBoatAPI's own roots", async () => {
  const out = await run(runConfig({ arg: ["out.lua", "src", "/proj/src"] }));
  assert.deepEqual(out.arg, ["out.lua", "src", "/proj/src", LUA_DIR]);
});

test("arg: a missing or non-array arg is replaced by just our dir", async () => {
  assert.deepEqual((await run(runConfig())).arg, [LUA_DIR]);
  assert.deepEqual((await run(runConfig({ arg: "nope" }))).arg, [LUA_DIR]);
});

test("arg: not duplicated when already present, however the path is spelt", async () => {
  const spelt = LUA_DIR.toUpperCase() + "/";
  const out = await run(runConfig({ arg: ["a", LUA_DIR] }));
  assert.equal(out.arg.filter(a => a === LUA_DIR).length, 1);
  const out2 = await run(runConfig({ arg: ["a", spelt] }));
  assert.deepEqual(out2.arg, ["a", spelt], "normalize() equates case and a trailing slash");
});

test("arg: non-string entries are skipped, not crashed on", async () => {
  const out = await run(runConfig({ arg: [1, null, "x"] }));
  assert.equal(out.arg.at(-1), LUA_DIR);
});

// ── port 14238 stand-in ───────────────────────────────────────────────────

test("built-in monitors: the stub is started before the config is handed back", async () => {
  const stub = fakeStub();
  await run(runConfig(), { platform: "darwin", arch: "arm64", stub });
  assert.deepEqual(stub.calls, ["start"]);
});

test("exe still in charge (Windows, setting off): the stub is not started", async () => {
  const stub = fakeStub();
  await run(runConfig(), { platform: "win32", setting: false, stub });
  assert.deepEqual(stub.calls, []);
});

test("setting turned off between runs: a listening stub releases the port", async () => {
  const stub = fakeStub({ listening: true });
  await run(runConfig(), { platform: "win32", setting: false, stub });
  assert.deepEqual(stub.calls, ["stop"]);
});

test("a stub that cannot bind reports an error but the run still gets patched", async () => {
  const stub = fakeStub({ startError: new Error("EADDRINUSE") });
  const out = await run(runConfig(), { platform: "darwin", arch: "arm64", stub });
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /14238/);
  assert.match(env.errors[0], /EADDRINUSE/);
  assert.deepEqual(out.arg, [LUA_DIR]);
  assert.equal(env.writes.length, 1, "_simulator.lua is still patched");
});

test("no stub supplied: nothing to start or stop, no crash", async () => {
  await run(runConfig(), { platform: "darwin", arch: "arm64", stub: null });
  assert.equal(env.errors.length, 0);
});

// ── _simulator.lua patching ───────────────────────────────────────────────

test("the socket is injected and the exe launch suppressed when PhySim draws the monitors", async () => {
  await run(runConfig(), { platform: "win32", setting: true, stub: fakeStub() });
  assert.equal(env.writes.length, 1);
  const { path: p, text } = env.writes[0];
  assert.equal(p, "/proj/_build/_simulator.lua");
  assert.match(text, /_physim_socket/);
  assert.match(text, /_beginSimulation\(\s*true\s*,/);
  assert.doesNotMatch(text, /_beginSimulation\(\s*false/);
});

test("with the real exe in charge, attachToExistingProcess stays false", async () => {
  await run(runConfig(), { platform: "win32", setting: false, stub: fakeStub() });
  assert.equal(env.writes.length, 1);
  assert.match(env.writes[0].text, /_physim_socket/);
  assert.match(env.writes[0].text, /_beginSimulation\(\s*false\s*,/);
});

test("an already patched script is not written again", async () => {
  await run(runConfig(), { platform: "win32", setting: false });
  const patched = env.writes[0].text;
  await run(runConfig(), { platform: "win32", setting: false, files: { "/proj/_build/_simulator.lua": patched } });
  assert.equal(env.writes.length, 0);
});

test("upstream changed the template: warn, write nothing, still return the config", async () => {
  const out = await run(runConfig(), {
    platform: "linux",
    files: { "/proj/_build/_simulator.lua": "print('a different template')\n" }
  });
  assert.equal(env.writes.length, 0);
  assert.equal(env.warnings.length, 1);
  assert.match(env.warnings[0], /sandbox line not found/);
  assert.deepEqual(out.arg, [LUA_DIR]);
});

test("built-in monitors but no _beginSimulation call: a second warning names the port clash", async () => {
  const noBegin = SIMULATOR_LUA.split("\n").filter(l => !l.includes("_beginSimulation")).join("\n");
  await run(runConfig(), {
    platform: "darwin", arch: "arm64", stub: fakeStub(),
    files: { "/proj/_build/_simulator.lua": noBegin }
  });
  assert.ok(env.warnings.some(w => /_beginSimulation call not found/.test(w) && /14238/.test(w)));
});

test("an unreadable _simulator.lua becomes a warning, not a thrown error", async () => {
  env.readError = null;
  const cfg = runConfig();
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    env.files = new Map();
    env.warnings = [];
    env.readError = new Error("ENOENT");
    const out = await new PhysimDebugPatcher({ fsPath: EXT }, null)
      .resolveDebugConfigurationWithSubstitutedVariables(undefined, cfg);
    assert.equal(out, cfg);
    assert.equal(env.warnings.length, 1);
    assert.match(env.warnings[0], /ENOENT/);
  } finally {
    Object.defineProperty(process, "platform", realPlatform);
    env.readError = null;
  }
});

test("a config with no program path skips patching but keeps the arg/cpath work", async () => {
  const out = await run({ type: "lua", name: "Run Simulator" }, { platform: "darwin", arch: "arm64" });
  assert.equal(env.writes.length, 0);
  assert.deepEqual(out.arg, [LUA_DIR]);
  assert.equal(out.cpath, SO);
});
