// src/engine/session.ts with a real worker thread: the 60 Hz loop, events, the
// request/response channel, and how a run ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { EngineSession } = require("../out/engine/session.js");
const { chunkName } = require("../out/engine/sourceRoots.js");
const { ZERO_STATE } = require("../out/engine/physState.js");

function run(source, overrides = {}, events = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-session-"));
  const entry = path.join(dir, "main.lua");
  writeFileSync(entry, source);
  const seen = { logs: [], frames: [], screens: [], stopped: [], ended: null };
  let wake = () => {};
  const session = new EngineSession(
    { entry, roots: [dir], screens: [], timeScale: 1, phys: ZERO_STATE, breakpoints: [], ...overrides(entry) },
    {
      log: l => { seen.logs.push(l); wake(); },
      frames: f => { seen.frames.push(...f); wake(); },
      screens: s => { seen.screens.push(s); wake(); },
      stopped: r => { seen.stopped.push(r); wake(); },
      ended: (reason, message) => { seen.ended = { reason, message }; wake(); },
      ...events
    });
  /** Resolve once `cond()` holds; events re-check it. */
  const until = (cond, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the worker")), ms);
    const check = () => { if (cond()) { clearTimeout(timer); wake = () => {}; resolve(); } };
    wake = check; check();
  });
  return { session, seen, until, entry };
}
const none = () => ({});

test("ticks at about 60 Hz, delivers logs, frames and the monitor layout", async t => {
  const { session, seen, until } = run(`
    n = 0
    function onTick() n = n + 1; if n % 30 == 0 then print("t" .. n) end; output.setNumber(1, n) end
    function onDraw() screen.setColor(0, 255, 0); screen.drawRectF(0, 0, n % 8, 4) end`, none);
  t.after(() => session.dispose());
  const t0 = performance.now();
  await until(() => seen.logs.length >= 2);
  const elapsed = performance.now() - t0;
  assert.deepEqual(seen.logs.slice(0, 2).map(l => l.text), ["t30", "t60"]);
  assert.ok(elapsed > 700 && elapsed < 2500, `60 ticks took ${elapsed} ms`);
  assert.deepEqual(seen.screens[0].map(s => s.size), ["3x3"]);
  assert.ok(seen.frames.length > 10);
  assert.equal(seen.frames[0].pixels.length, 96 * 96 * 4);
  const io = await session.request("io", {});
  assert.ok(io.outputNumbers[0] >= 60);
});

test("slow motion ticks proportionally slower", async t => {
  const { session, seen, until } = run(`n = 0 function onTick() n = n + 1; if n == 6 then print("six") end end`,
    () => ({ timeScale: 0.1 }));
  t.after(() => session.dispose());
  const t0 = performance.now();
  await until(() => seen.logs.length >= 1);
  assert.ok(performance.now() - t0 > 700, "6 ticks at 6 Hz take about a second");
});

test("a Lua error ends the run with its message", async t => {
  const { session, seen, until } = run(`function onTick() error("boom") end`, none);
  t.after(() => session.dispose());
  await until(() => seen.ended);
  assert.equal(seen.ended.reason, "error");
  assert.match(seen.ended.message, /main\.lua:1: boom/);
  assert.equal(session.isRunning(), false);
  await assert.rejects(session.request("io", {}), /not running/);
});

test("simulator:exit() ends the run cleanly", async t => {
  const { session, seen, until } = run(`function onLBSimulatorTick(sim, ticks) if ticks == 3 then sim:exit() end end`, none);
  t.after(() => session.dispose());
  await until(() => seen.ended);
  assert.equal(seen.ended.reason, "exit");
});

test("breakpoint: stopped event, inspection, step, continue", async t => {
  const { session, seen, until } = run(
`n = 0
function onTick()
  n = n + 1
  local big = 1 << 40
  output.setNumber(1, n)
end`, entry => ({ breakpoints: [{ source: chunkName(entry), line: 4 }] }));
  t.after(() => session.dispose());
  await until(() => seen.stopped.length === 1);
  assert.equal(seen.stopped[0], "breakpoint");
  const stack = await session.request("stack", {});
  assert.equal(stack[0].line, 4);
  await session.request("resume", { mode: "over" });
  await until(() => seen.stopped.length === 2);
  assert.equal(seen.stopped[1], "step");
  const locals = await session.request("locals", { level: (await session.request("stack", {}))[0].level });
  const big = locals.find(v => Buffer.from(v.name).toString() === "big");
  assert.equal(big.value.value, 1n << 40n, "a Lua integer crosses the worker boundary as a bigint");
  const n = await session.request("evaluate", { expression: "n", level: stack[0].level });
  assert.equal(Number(n.value), 1, "ticking is held while suspended");
  await session.request("setBreakpoints", { points: [] });
  await session.request("resume", { mode: "continue" });
  await new Promise(r => setTimeout(r, 200));
  const io = await session.request("io", {});
  assert.ok(io.outputNumbers[0] > 3, "ticking resumed");
});

test("panel inputs reach the script; replay resends the current picture", async t => {
  const { session, seen, until } = run(`
    function onLBSimulatorTick(sim) local x, y = __physim_host.phys(); sim:setInputNumber(9, y) end
    function onTick() output.setNumber(1, input.getNumber(9)); output.setNumber(2, input.getNumber(3)); output.setNumber(3, input.getNumber(1)) end
    function onDraw() screen.drawClear() end`, none);
  t.after(() => session.dispose());
  await until(() => seen.frames.length >= 1);
  session.setPhysState({ ...ZERO_STATE, position: [0, 12.5, 0] });
  session.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 40, y: 2, xAlt: 0, yAlt: 0 });
  session.configureScreen({ number: 1, size: "2x2", poweredOn: true, portrait: false });
  await until(() => seen.frames.some(f => f.width === 64));
  await new Promise(r => setTimeout(r, 100));
  const io = await session.request("io", {});
  assert.deepEqual(io.outputNumbers.slice(0, 3), [12.5, 40, 64]);
  const before = seen.frames.length;
  session.replay();
  await until(() => seen.frames.length > before);
  assert.deepEqual(session.getScreens().map(s => s.size), ["2x2"]);
});

test("a missing entry file is an error, not a hang", async t => {
  const { session, seen, until } = run(``, entry => ({ entry: entry + ".absent" }));
  t.after(() => session.dispose());
  await until(() => seen.ended);
  assert.equal(seen.ended.reason, "error");
  assert.match(seen.ended.message, /ENOENT/);
});
