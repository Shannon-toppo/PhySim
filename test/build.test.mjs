// src/build.ts through a real build worker: link, strip the simulator-only
// parts, minify — and the output must run in the game environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { runBuild } = require("../out/buildRunner.js");
const { requiredNames, collectProject, GAME_SCRIPT_LIMIT } = require("../out/build.js");
const { loadEngine } = require("../out/engine/loadEngine.js");

const BUNDLED_LUA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lua");
const engine = await loadEngine();

function project(sources) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-build-"));
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { dir, entry: path.join(dir, "main.lua"), roots: [dir, BUNDLED_LUA] };
}

const MAIN = `---@section __LB_SIMULATOR_ONLY__
do
    require("PhySim")
    phys = PhySim:new()
    simulator:setScreen(1, "3x3")
    function onLBSimulatorTick(simulator, ticks)
        phys:update()
        phys:injectAsInputs(simulator, 1)
    end
end
---@endsection
require("lib.util")
function onTick()
    output.setNumber(1, twice(input.getNumber(1)))
end
`;
const UTIL = `function twice(x) return x * 2 end
---@section neverCalled
function neverCalled() return "this text must not survive" end
---@endsection
`;

/** Run built code as the game would: default environment, no require, no simulator. */
function runInGame(code) {
  const vm = engine.createVehicle();
  try {
    vm.load(code, "@built.lua");
    vm.io.inputNumbers[0] = 21;
    vm.tick();
    return vm.io.outputNumbers[0];
  } finally {
    vm.dispose();
  }
}

test("requiredNames: both call forms and quote styles, each name once", () => {
  assert.deepEqual(requiredNames(`require("a.b") require 'c' require( "a.b" ) local r = require; x.require("d")`), ["a.b", "c", "d"]);
});

test("collectProject: follows requires transitively and skips names that resolve to nothing", () => {
  const p = project({ "main.lua": `require("one") require("ghost")`, "one.lua": `require("two.deep")`, "two/deep.lua": `require("one")` });
  const files = { isFile: f => { try { return require("node:fs").statSync(f).isFile(); } catch { return false; } }, read: f => require("node:fs").readFileSync(f) };
  const got = collectProject(p.entry, p.roots, files);
  assert.deepEqual(Object.keys(got.modules).sort(), ["/main.lua", "one", "two.deep"]);
  assert.equal(got.files["two.deep"], path.join(p.dir, "two", "deep.lua"));
});

test("a minified build links, strips simulator-only code and unused sections, and runs in the game", async () => {
  const p = project({ "main.lua": MAIN, "lib/util.lua": UTIL });
  const out = await runBuild({ entry: p.entry, roots: p.roots, minify: true });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.ok(!/PhySim|simulator|onLBSimulatorTick|must not survive/.test(out.code), out.code);
  assert.equal(out.size, Array.from(out.code).length);
  assert.ok(out.size < MAIN.length + UTIL.length);
  assert.deepEqual(out.usedFiles, [p.entry, path.join(p.dir, "lib", "util.lua")]);
  assert.equal(runInGame(out.code), 42);
});

test("minify off: same behaviour, readable output", async () => {
  const p = project({ "main.lua": MAIN, "lib/util.lua": UTIL });
  const out = await runBuild({ entry: p.entry, roots: p.roots, minify: false });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.match(out.code, /function twice\(x\)/);
  assert.ok(!/PhySim/.test(out.code));
  assert.equal(runInGame(out.code), 42);
});

test("a module that is really required but missing fails the build", async () => {
  const p = project({ "main.lua": `require("nowhere")\nfunction onTick() end` });
  const out = await runBuild({ entry: p.entry, roots: p.roots, minify: true });
  assert.equal(out.ok, false);
  assert.match(out.problems.find(x => x.severity === "error").message, /nowhere/);
});

test("a syntax error fails the build with a message", async () => {
  const p = project({ "main.lua": `require("bad")\nfunction onTick() end`, "bad.lua": `x =` });
  const out = await runBuild({ entry: p.entry, roots: p.roots, minify: true });
  assert.equal(out.ok, false);
  assert.ok(out.problems.some(x => x.severity === "error" && x.message.length > 0));
});

test("an output over the game's limit still builds, with a warning", async () => {
  const lines = Array.from({ length: 700 }, (_, i) => `output.setNumber(${(i % 32) + 1}, input.getNumber(${(i % 32) + 1}) * ${i + 1.5} + property.getNumber("p${i}"))`);
  const p = project({ "main.lua": `function onTick()\n${lines.join("\n")}\nend` });
  const out = await runBuild({ entry: p.entry, roots: p.roots, minify: true });
  assert.equal(out.ok, true, JSON.stringify(out.problems));
  assert.ok(out.size > GAME_SCRIPT_LIMIT);
  assert.ok(out.problems.some(x => x.severity === "warning" && /8192/.test(x.message)));
});

test("a missing entry file is reported, not thrown", async () => {
  const out = await runBuild({ entry: path.join(tmpdir(), "physim-absent.lua"), roots: [], minify: true });
  assert.equal(out.ok, false);
  assert.match(out.problems[0].message, /ENOENT/);
});
