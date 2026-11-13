// src/simulation.ts with real engine workers: what the panel sets before a
// run reaches the script from its first tick, runs replace and end cleanly,
// and the monitor layout/pictures stay available the way the panel needs them.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Simulation } = require("../out/simulation.js");
const { chunkName } = require("../out/engine/sourceRoots.js");
const { ZERO_STATE } = require("../out/engine/physState.js");

const LUA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lua");

const pose = (position = [0, 0, 0], rest = {}) => ({ ...ZERO_STATE, position, ...rest });

/** A Simulation whose events are recorded, disposed when the test ends. */
function make(t) {
  const sim = new Simulation();
  const seen = { logs: [], configs: [], frames: [], started: [], ended: [], stopped: [] };
  sim.onLog = l => seen.logs.push(l.text);
  sim.onScreenConfig = s => seen.configs.push(s);
  sim.onFrames = f => seen.frames.push(...f);
  sim.onStarted = (entry, files) => seen.started.push({ entry, files });
  sim.onEnded = (reason, message) => seen.ended.push({ reason, message });
  t.after(() => sim.dispose());
  return { sim, seen };
}

/** Write a script and return the request that runs it (the repo's lua/ is on the path). */
function request(source, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-simulation-"));
  const entry = path.join(dir, "main.lua");
  writeFileSync(entry, source);
  return { entry, roots: [dir, LUA_DIR], ...extra };
}

async function until(cond, what = "condition", ms = 8000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Composite I/O of the live run (rejects while the worker is still loading the engine). */
const io = sim => sim.current().request("io", {});

/** Poll the live run's I/O until `pred(io)` holds; returns the last reading. */
async function ioWhen(sim, pred, what, ms = 8000) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { last = await io(sim); if (pred(last)) return last; } catch { /* worker not ready yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; last I/O: ${last && last.outputNumbers.slice(0, 4)}`);
    await sleep(20);
  }
}

const PRINT_ONCE = `
  require("PhySim")
  local done = false
  function onTick()
    if done then return end
    done = true
    PhySim:update()
    local px, py, pz = PhySim:position()
    local s2 = simulator:getTouchScreen(2)
    print(string.format("%g|%g|%g|%g|%g|%g", py, PhySim:tickRate(), input.getNumber(1), input.getNumber(2), s2.width, s2.height))
  end`;

test("panel state set before the run is what the script sees on its first tick", async t => {
  const { sim, seen } = make(t);
  sim.setPhysState(pose([1, 12.5, 3]));
  sim.setTimeScale("0.25");
  sim.configureScreen({ number: 1, size: "2x2", poweredOn: true, portrait: false });
  sim.configureScreen({ number: 2, size: "2x1", poweredOn: true, portrait: true });
  await sim.start(request(PRINT_ONCE));
  assert.equal(sim.isRunning(), true);
  await until(() => seen.logs.length >= 1, "the first tick's print");
  // y, tick rate (60 x 0.25), monitor 1's width/height as default inputs, monitor 2's size (portrait 2x1)
  assert.equal(seen.logs[0], "12.5|15|64|64|32|64");
  assert.deepEqual(seen.configs[0].map(s => [s.number, s.size, s.width, s.height, s.portrait]),
    [[1, "2x2", 64, 64, false], [2, "2x1", 32, 64, true]], "the layout is reported before the script runs");
  assert.equal(seen.started.length, 1);
  assert.match(seen.started[0].entry, /main\.lua$/);
  assert.ok(seen.started[0].files.some(f => f.endsWith("PhySim.lua")), "the files list includes required modules");
});

test("with nothing set, a run gets the defaults: origin, real time, one 3x3 monitor", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(PRINT_ONCE));
  await until(() => seen.logs.length >= 1);
  assert.equal(seen.logs[0], "0|60|96|96|32|32", "monitor 2 does not exist: powered, 32x32");
  assert.deepEqual(sim.getScreens().map(s => s.size), ["3x3"]);
  assert.deepEqual(sim.getWantedScreens(), [], "the default monitor is the engine's, not the panel's");
});

test("a pose or speed changed while running reaches the script", async t => {
  const { sim } = make(t);
  await sim.start(request(`
    require("PhySim")
    function onTick()
      PhySim:update()
      local _, y = PhySim:position()
      output.setNumber(1, y) output.setNumber(2, PhySim:tickRate())
      output.setNumber(3, simulator:getTouchScreen(1).touchX)
    end`));
  await ioWhen(sim, r => r.outputNumbers[1] === 60, "the first ticks");
  sim.setPhysState(pose([0, 7, 0]));
  sim.setTimeScale(0.5);
  sim.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 17, y: 3, xAlt: 0, yAlt: 0 });
  await ioWhen(sim, r => r.outputNumbers[0] === 7 && r.outputNumbers[1] === 30 && r.outputNumbers[2] === 17, "the new state");
  assert.equal(sim.getTimeScale(), 0.5);
});

test("setTimeScale only takes the dropdown's speeds", () => {
  const sim = new Simulation();
  assert.equal(sim.getTimeScale(), 1);
  sim.setTimeScale("0.1");
  assert.equal(sim.getTimeScale(), 0.1);
  for (const bad of [2, 0, -1, NaN, "fast", null, undefined, 0.3]) {
    sim.setTimeScale(0.25);
    sim.setTimeScale(bad);
    assert.equal(sim.getTimeScale(), 1, String(bad));
  }
});

test("start() replaces a running run; the old run's events do not leak", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(`
    function onTick() print("A") end
    function onDraw() screen.setColor(255, 0, 0) screen.drawClear() end`));
  await until(() => seen.logs.includes("A") && seen.frames.length > 0, "run A's output");
  const firstA = sim.current();
  await sim.start(request(`
    function onTick() print("B") end
    function onDraw() screen.setColor(0, 0, 255) screen.drawClear() end`));
  assert.notEqual(sim.current(), firstA);
  assert.equal(sim.getFrames().length, 0, "the previous run's pictures are gone immediately");
  assert.deepEqual(sim.getScreens(), [], "and so is its layout, until the new run reports one");
  const logsAt = seen.logs.length, framesAt = seen.frames.length;
  await until(() => seen.logs.length >= logsAt + 3 && seen.frames.length > framesAt, "run B's output");
  await sleep(150);
  assert.deepEqual(new Set(seen.logs.slice(logsAt)), new Set(["B"]));
  for (const f of seen.frames.slice(framesAt)) {
    assert.deepEqual(Array.from(f.pixels.slice(0, 3)), [0, 0, 255], "only B's blue frames");
  }
  assert.deepEqual(Array.from(sim.getFrames()[0].pixels.slice(0, 3)), [0, 0, 255]);
  assert.deepEqual(seen.ended, [], "replacing a run is not an end");
  assert.equal(sim.isRunning(), true);
});

test("start() after a replaced run that was suspended at a breakpoint still runs", async t => {
  const { sim, seen } = make(t);
  const stops = [];
  sim.onStopped = r => stops.push(r);
  const src = `function onTick()\n  print("tick")\nend`;
  const req = request(src);
  await sim.start({ ...req, breakpoints: [{ source: chunkName(req.entry), line: 2 }] });
  await until(() => stops.length === 1, "the breakpoint");
  assert.equal(seen.logs.length, 0);
  await sim.start(request(`function onTick() print("fresh") end`));
  await until(() => seen.logs.includes("fresh"));
  assert.equal(stops.length, 1, "no further stop events from the replaced run");
});

test("stop() blanks the monitors and reports onEnded('stopped')", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(`function onDraw() screen.setColor(9, 9, 9) screen.drawClear() end`));
  await until(() => sim.getFrames().length === 1 && sim.getScreens().length === 1, "a first picture");
  const configsBefore = seen.configs.length;
  await sim.stop();
  assert.equal(sim.isRunning(), false);
  assert.equal(sim.current(), null);
  assert.deepEqual(sim.getScreens(), []);
  assert.deepEqual(sim.getFrames(), []);
  assert.equal(seen.configs.length, configsBefore + 1);
  assert.deepEqual(seen.configs.at(-1), [], "the panel is told there are no monitors");
  assert.deepEqual(seen.ended, [{ reason: "stopped", message: undefined }]);
  const frames = seen.frames.length;
  await sleep(100);
  assert.equal(seen.frames.length, frames, "nothing arrives after Stop");
});

test("stop() with no run is a no-op, and dispose() ends quietly", async t => {
  const { sim, seen } = make(t);
  await sim.stop();
  assert.deepEqual(seen.ended, []);
  assert.deepEqual(seen.configs, []);
  await sim.start(request(`function onTick() end`));
  await sim.dispose();
  assert.equal(sim.isRunning(), false);
  assert.deepEqual(seen.ended, [], "dispose fires no events");
  await sim.dispose();
});

test("a Lua error ends the run but keeps the last pictures and layout", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(`
    n = 0
    function onTick() n = n + 1; if n == 15 then error("boom at " .. n) end end
    function onDraw() screen.setColor(10, 200, 30) screen.drawClear() end`));
  await until(() => seen.ended.length === 1, "the error");
  assert.equal(seen.ended[0].reason, "error");
  assert.match(seen.ended[0].message, /main\.lua:3: boom at 15/);
  assert.equal(sim.isRunning(), false);
  assert.equal(sim.current(), null);
  const frames = sim.getFrames();
  assert.equal(frames.length, 1, "what the script had drawn is still there");
  assert.equal(frames[0].screen, 1);
  assert.deepEqual(Array.from(frames[0].pixels.slice(0, 4)), [10, 200, 30, 255]);
  assert.deepEqual(sim.getScreens().map(s => s.number), [1]);
  // Panel state can still be set with no run, and a following run starts clean.
  sim.setPhysState(pose([1, 2, 3]));
  sim.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 1, y: 1, xAlt: 0, yAlt: 0 });
  await sim.start(request(`function onTick() end`));
  assert.deepEqual(sim.getFrames(), []);
  assert.equal(seen.ended.length, 1);
});

test("an error in the script's top level is reported as an error too", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(`error("at load")`));
  await until(() => seen.ended.length === 1);
  assert.equal(seen.ended[0].reason, "error");
  assert.match(seen.ended[0].message, /at load/);
  assert.equal(seen.started.length, 0, "the script never got ticking");
});

test("simulator:exit() ends the run with reason 'exit'", async t => {
  const { sim, seen } = make(t);
  await sim.start(request(`function onLBSimulatorTick(s, ticks) if ticks == 2 then s:exit() end end`));
  await until(() => seen.ended.length === 1);
  assert.equal(seen.ended[0].reason, "exit");
  assert.equal(sim.isRunning(), false);
});

test("configureScreen and removeScreen update the wanted layout, sorted, and the live run", async t => {
  const { sim, seen } = make(t);
  sim.configureScreen({ number: 3, size: "1x1", poweredOn: true, portrait: false });
  sim.configureScreen({ number: 2, size: "2x2", poweredOn: true, portrait: false });
  sim.configureScreen({ number: 3, size: "5x3", poweredOn: false, portrait: true });
  assert.deepEqual(sim.getWantedScreens(), [
    { number: 2, size: "2x2", poweredOn: true, portrait: false },
    { number: 3, size: "5x3", poweredOn: false, portrait: true }
  ]);

  await sim.start(request(`function onDraw() screen.drawClear() end`));
  await until(() => sim.getScreens().length === 3, "the seeded layout");
  assert.deepEqual(sim.getScreens().map(s => s.number), [1, 2, 3], "the engine's default monitor 1 is kept");

  sim.configureScreen({ number: 4, size: "1x1", poweredOn: true, portrait: false });
  await until(() => sim.getScreens().some(s => s.number === 4), "monitor 4 live");
  assert.ok(seen.configs.at(-1).some(s => s.number === 4), "and the panel was told");
  assert.equal(sim.getWantedScreens().length, 3);

  await until(() => sim.getFrames().some(f => f.screen === 2), "a picture on monitor 2");
  sim.removeScreen(2);
  await until(() => !sim.getScreens().some(s => s.number === 2), "monitor 2 gone live");
  assert.deepEqual(sim.getWantedScreens().map(s => s.number), [3, 4]);
  assert.ok(!sim.getFrames().some(f => f.screen === 2), "its picture is dropped");

  // Monitor 1 was never in the panel's layout; the script's/engine's monitor can still be removed.
  sim.removeScreen(1);
  await until(() => !sim.getScreens().some(s => s.number === 1), "monitor 1 gone live");
  assert.deepEqual(sim.getWantedScreens().map(s => s.number), [3, 4]);

  sim.removeScreen(3.2);
  assert.deepEqual(sim.getWantedScreens().map(s => s.number), [4], "a fractional number is rounded");
  sim.removeScreen(99);
  assert.deepEqual(sim.getWantedScreens().map(s => s.number), [4]);
});

test("a powered-off monitor has no picture; powering it on gives one", async t => {
  const { sim } = make(t);
  sim.configureScreen({ number: 1, size: "1x1", poweredOn: false, portrait: false });
  await sim.start(request(`function onDraw() screen.setColor(1, 2, 3) screen.drawClear() end`));
  await until(() => sim.getScreens().length === 1);
  await sleep(150);
  assert.deepEqual(sim.getFrames(), []);
  sim.configureScreen({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  await until(() => sim.getFrames().length === 1, "a picture after power on");
  sim.configureScreen({ number: 1, size: "1x1", poweredOn: false, portrait: false });
  await until(() => sim.getFrames().length === 0, "the picture is dropped on power off");
});

test("setWantedScreens restores a saved layout: sanitised, replacing, and not applied to a live run", async t => {
  const { sim } = make(t);
  sim.configureScreen({ number: 7, size: "1x1", poweredOn: true, portrait: false });
  sim.setWantedScreens([
    { number: 2, size: "3x3", poweredOn: true, portrait: false },
    { number: 0, size: "3x3" }, { number: 9, size: "3x3" }, { number: 1, size: "20x20" },
    null, "x", { screen: 4, size: "2x1", portrait: true },
    { number: 2, size: "1x1" }
  ]);
  assert.deepEqual(sim.getWantedScreens(), [
    { number: 2, size: "1x1", poweredOn: true, portrait: false },
    { number: 4, size: "2x1", poweredOn: true, portrait: true }
  ], "the old layout is replaced; a repeated number takes the last entry");

  await sim.start(request(`function onTick() end`));
  await until(() => sim.getScreens().length === 3);
  sim.setWantedScreens([]);
  assert.deepEqual(sim.getWantedScreens(), []);
  await sleep(100);
  assert.equal(sim.getScreens().length, 3, "a run in progress is left alone");
});

test("a script that declares monitors lands on top of the panel's layout", async t => {
  const { sim } = make(t);
  sim.configureScreen({ number: 1, size: "2x2", poweredOn: true, portrait: false });
  await sim.start(request(`
    simulator:setScreen(1, "1x1")
    local n = simulator:setScreen(6, "3x1")
    function onTick() output.setNumber(1, n) end`));
  await until(() => sim.getScreens().length === 2, "both monitors");
  assert.deepEqual(sim.getScreens().map(s => [s.number, s.size]), [[1, "1x1"], [2, "3x1"]]);
  assert.deepEqual(sim.getWantedScreens().map(s => [s.number, s.size]), [[1, "2x2"]], "the panel's own layout is not rewritten");
  await ioWhen(sim, r => r.outputNumbers[0] === 2, "the declared monitor number");
});

// --- Messages that arrive while the worker is still loading the engine -----------------
//
// The panel does not wait for the run to be ready: the gizmo can move, or the
// speed dropdown change, in the first moments after "PhySim: Run".

test("a pose set right after start() is not lost to the engine still loading", async t => {
  const { sim } = make(t);
  await sim.start(request(`
    require("PhySim")
    function onTick() PhySim:update(); local _, y = PhySim:position(); output.setNumber(1, y) end`));
  sim.setPhysState(pose([0, 99, 0]));
  await ioWhen(sim, r => r.outputNumbers[0] === 99, "the pose", 4000);
});

test("a speed chosen right after start() is not lost to the engine still loading", async t => {
  const { sim } = make(t);
  await sim.start(request(`
    require("PhySim")
    function onTick() PhySim:update(); output.setNumber(1, PhySim:tickRate()) end`));
  sim.setTimeScale(0.5);
  await sleep(1500);
  const r = await ioWhen(sim, r => r.outputNumbers[0] !== 0, "a tick", 4000);
  assert.equal(r.outputNumbers[0], 30);
});

test("a monitor added right after start() is not lost to the engine still loading", async t => {
  const { sim } = make(t);
  await sim.start(request(`function onTick() end`));
  sim.configureScreen({ number: 2, size: "1x1", poweredOn: true, portrait: false });
  await until(() => sim.getScreens().length > 0, "a layout");
  await sleep(500);
  assert.ok(sim.getScreens().some(s => s.number === 2));
});

// --- An AI agent's run, mirrored into the panel --------------------------------

const SCREEN1 = { number: 1, width: 96, height: 96, poweredOn: true, portrait: false, size: "3x3" };
const SCREEN2 = { number: 2, width: 32, height: 32, poweredOn: true, portrait: false, size: "1x1" };
const picture = (screen, tag, w = 96, h = 96) => ({ screen, width: w, height: h, pixels: new Uint8Array(w * h * 4).fill(tag) });
const DRAWS = "function onDraw() screen.setColor(255, 0, 0); screen.drawRectF(0, 0, 2, 2) end";

test("with no run of its own, the panel shows the agent's monitors and pictures", t => {
  const { sim, seen } = make(t);
  assert.equal(sim.isShowingMirror(), false);
  const a = picture(1, 10);
  sim.showMirror([SCREEN1], [a]);
  assert.equal(sim.isShowingMirror(), true);
  assert.deepEqual(seen.configs, [[SCREEN1]]);
  assert.deepEqual(seen.frames, [a]);
  assert.deepEqual(sim.getScreens(), [SCREEN1], "a webview opened now replays the agent's run");
  assert.deepEqual(sim.getFrames(), [a]);
});

test("later updates send only what changed: no layout event for the same layout, no frame for none", t => {
  const { sim, seen } = make(t);
  sim.showMirror([SCREEN1], [picture(1, 10)]);
  sim.showMirror([SCREEN1], []);
  assert.equal(seen.configs.length, 1);
  assert.equal(seen.frames.length, 1);
  const b = picture(1, 20);
  sim.showMirror([{ ...SCREEN1 }], [b]);
  assert.equal(seen.configs.length, 1, "an equal layout in a new object is still the same layout");
  assert.deepEqual(seen.frames.at(-1), b);
  sim.showMirror([SCREEN1, SCREEN2], [picture(2, 30, 32, 32)]);
  assert.deepEqual(seen.configs.at(-1), [SCREEN1, SCREEN2]);
  assert.deepEqual(sim.getFrames().map(f => f.screen), [1, 2]);
});

test("a monitor the agent removes or powers off loses its picture", t => {
  const { sim } = make(t);
  sim.showMirror([SCREEN1, SCREEN2], [picture(1, 1), picture(2, 2, 32, 32)]);
  sim.showMirror([SCREEN1, { ...SCREEN2, poweredOn: false }], []);
  assert.deepEqual(sim.getFrames().map(f => f.screen), [1]);
  sim.showMirror([SCREEN2], [picture(2, 3, 32, 32)]);
  assert.deepEqual(sim.getFrames().map(f => f.screen), [2]);
});

test("clearMirror blanks the panel, once", t => {
  const { sim, seen } = make(t);
  sim.showMirror([SCREEN1], [picture(1, 10)]);
  sim.clearMirror();
  assert.equal(sim.isShowingMirror(), false);
  assert.deepEqual(seen.configs.at(-1), []);
  assert.deepEqual(sim.getScreens(), []);
  assert.deepEqual(sim.getFrames(), []);
  const count = seen.configs.length;
  sim.clearMirror();
  assert.equal(seen.configs.length, count);
});

test("the window's own run takes the panel from the agent, and Stop gives it back", async t => {
  const { sim, seen } = make(t);
  const mirrored = picture(1, 10);
  sim.showMirror([SCREEN1], [mirrored]);
  await sim.start(request(DRAWS));
  assert.equal(sim.isShowingMirror(), false);
  await until(() => sim.getFrames().length === 1 && sim.getFrames()[0] !== mirrored, "the run's own picture");
  assert.notDeepEqual(sim.getFrames()[0].pixels, mirrored.pixels);

  // The agent carries on meanwhile; none of it reaches the panel.
  const events = seen.frames.length;
  const later = picture(1, 20);
  sim.showMirror([SCREEN1, SCREEN2], [later, picture(2, 30, 32, 32)]);
  assert.equal(seen.frames.filter(f => f === later).length, 0);
  assert.equal(sim.getScreens().length, 1);
  assert.equal(sim.isShowingMirror(), false);
  void events;

  await sim.stop();
  assert.equal(sim.isShowingMirror(), true);
  assert.deepEqual(seen.ended.at(-1), { reason: "stopped", message: undefined });
  assert.deepEqual(seen.configs.at(-1), [SCREEN1, SCREEN2], "the agent's latest layout, after the blank Stop sends");
  assert.deepEqual(sim.getFrames().map(f => f.pixels[0]), [20, 30]);
});

test("after the window's run has failed, its last picture stays until the agent's next update", async t => {
  const { sim } = make(t);
  sim.showMirror([SCREEN1], [picture(1, 10)]);
  await sim.start(request(`${DRAWS}\nn = 0\nfunction onTick() n = n + 1; if n == 3 then error("boom") end end`));
  await until(() => !sim.isRunning(), "the run to fail");
  assert.equal(sim.isShowingMirror(), false);
  assert.equal(sim.getFrames().length, 1);
  assert.notEqual(sim.getFrames()[0].pixels[0], 10, "still the failed run's picture");
  sim.showMirror([SCREEN1], []);
  assert.equal(sim.isShowingMirror(), true);
  assert.equal(sim.getFrames()[0].pixels[0], 10);
});

test("an agent that goes away while the window's run has the panel changes nothing on screen", async t => {
  const { sim, seen } = make(t);
  sim.showMirror([SCREEN1], [picture(1, 10)]);
  await sim.start(request(DRAWS));
  await until(() => sim.getFrames().length === 1 && sim.getFrames()[0].pixels[0] !== 10, "the run's own picture");
  const configs = seen.configs.length;
  sim.clearMirror();
  assert.equal(seen.configs.length, configs);
  await sim.stop();
  assert.equal(sim.isShowingMirror(), false);
  assert.deepEqual(sim.getScreens(), []);
});

// --- The simulator's buttons and sliders -----------------------------------------

const CONTROLS = `
  function onLBSimulatorTick(simulator)
    simulator:setInputBool(31, simulator:getIsClicked(1))
    simulator:setInputBool(32, simulator:getIsToggled(1))
    simulator:setInputNumber(31, simulator:getSlider(2))
  end
  function onTick() output.setBool(1, input.getBool(31)); output.setBool(2, input.getBool(32)); output.setNumber(1, input.getNumber(31)) end`;

/** A Simulation that also records the controls it reports. */
function makeWithControls(t) {
  const made = make(t);
  made.seen.controls = [];
  made.sim.onControls = c => made.seen.controls.push(c);
  return made;
}

test("the controls a script reads are reported, and pressing them reaches the script", async t => {
  const { sim, seen } = makeWithControls(t);
  assert.deepEqual(sim.getControls(), { buttons: [], sliders: [] });
  await sim.start(request(CONTROLS));
  await until(() => sim.getControls().sliders.length === 1, "the script to read its controls");
  assert.deepEqual(sim.getControls(), {
    buttons: [{ number: 1, showsToggle: true, toggled: false, down: false }],
    sliders: [{ number: 2, value: 0 }]
  });
  assert.deepEqual(seen.controls.at(-1), sim.getControls());

  sim.setButton(1, true);
  sim.setSlider(2, 0.5);
  await ioWhen(sim, o => o.outputBooleans[0] && o.outputBooleans[1] && o.outputNumbers[0] === 0.5, "the press and the slider");
  sim.setButton(1, false);
  const after = await ioWhen(sim, o => !o.outputBooleans[0], "the release");
  assert.equal(after.outputBooleans[1], true, "the toggle stays on after the button is let go");
});

test("a slider stays where it was left for the next run; toggles start afresh", async t => {
  const { sim } = makeWithControls(t);
  await sim.start(request(CONTROLS));
  await until(() => sim.getControls().sliders.length === 1, "the controls");
  sim.setSlider(2, 0.75);
  sim.setButton(1, true);
  await ioWhen(sim, o => o.outputBooleans[1] && o.outputNumbers[0] === 0.75, "the toggle and the slider");

  await sim.start(request(CONTROLS));
  const first = await ioWhen(sim, o => o.outputNumbers[0] !== 0, "the new run's first reading");
  assert.equal(first.outputNumbers[0], 0.75);
  assert.equal(first.outputBooleans[1], false);
  await until(() => sim.getControls().sliders.length === 1, "the new run's controls");
  assert.deepEqual(sim.getControls().sliders, [{ number: 2, value: 0.75 }]);
});

test("a slider moved with nothing running is kept for the run that follows", async t => {
  const { sim } = makeWithControls(t);
  sim.setSlider(2, 0.25);
  sim.setButton(1, true);
  await sim.start(request(CONTROLS));
  const first = await ioWhen(sim, o => o.outputNumbers[0] !== 0, "the first reading");
  assert.equal(first.outputNumbers[0], 0.25);
  assert.equal(first.outputBooleans[0], false, "a button pressed before the run existed is not carried into it");
});

test("what is not a control number or a slider value is ignored", async t => {
  const { sim } = makeWithControls(t);
  await sim.start(request(CONTROLS));
  await until(() => sim.getControls().sliders.length === 1, "the controls");
  for (const n of [0, 11, 1.5, "1", null, NaN]) { sim.setButton(n, true); sim.setSlider(n, 0.5); }
  for (const v of ["0.5", NaN, null, undefined, Infinity]) sim.setSlider(2, v);
  sim.setSlider(2, 7);
  const got = await ioWhen(sim, o => o.outputNumbers[0] !== 0, "the clamped slider");
  assert.equal(got.outputNumbers[0], 1);
  assert.equal(got.outputBooleans[0], false);
});

test("the controls go away with the run: on Stop, on a Lua error, and when another script starts", async t => {
  const { sim, seen } = makeWithControls(t);
  const empty = { buttons: [], sliders: [] };
  await sim.start(request(CONTROLS));
  await until(() => sim.getControls().sliders.length === 1, "the controls");
  await sim.stop();
  assert.deepEqual(sim.getControls(), empty);
  assert.deepEqual(seen.controls.at(-1), empty);

  await sim.start(request(`${CONTROLS}\nn = 0\nlocal tick = onTick\nfunction onTick() tick(); n = n + 1; if n == 5 then error("boom") end end`));
  await until(() => !sim.isRunning(), "the run to fail");
  assert.deepEqual(sim.getControls(), empty, "a failed run's buttons would look alive");

  await sim.start(request(CONTROLS));
  await until(() => sim.getControls().sliders.length === 1, "the controls");
  const events = seen.controls.length;
  await sim.start(request("function onTick() end"));
  assert.deepEqual(sim.getControls(), empty);
  assert.deepEqual(seen.controls.at(-1), empty);
  assert.equal(seen.controls.length, events + 1);
});

test("a run that reads no controls reports none, and says nothing", async t => {
  const { sim, seen } = makeWithControls(t);
  await sim.start(request("n = 0 function onTick() n = n + 1; output.setNumber(1, n) end"));
  await ioWhen(sim, o => o.outputNumbers[0] > 3, "a few ticks");
  await sim.stop();
  assert.deepEqual(seen.controls, []);
});

// --- An agent's buttons and sliders, mirrored ---------------------------------------

const AGENT_CONTROLS = {
  buttons: [{ number: 1, showsToggle: true, toggled: true, down: false }],
  sliders: [{ number: 2, value: 0.5 }]
};

test("the agent's controls are shown with its monitors, and re-announced only when they change", t => {
  const { sim, seen } = makeWithControls(t);
  sim.showMirror([SCREEN1], [picture(1, 10)], AGENT_CONTROLS);
  assert.deepEqual(sim.getControls(), AGENT_CONTROLS);
  assert.deepEqual(seen.controls, [AGENT_CONTROLS]);
  sim.showMirror([SCREEN1], [], structuredClone(AGENT_CONTROLS));
  assert.equal(seen.controls.length, 1, "the same controls in a new object are no news");
  const held = { ...AGENT_CONTROLS, buttons: [{ ...AGENT_CONTROLS.buttons[0], down: true }] };
  sim.showMirror([SCREEN1], [], held);
  assert.deepEqual(seen.controls.at(-1), held);
  sim.showMirror([SCREEN1], []);
  assert.deepEqual(seen.controls.at(-1), { buttons: [], sliders: [] }, "an update with none takes them away");
});

test("the window's own run replaces the agent's controls with its own, and Stop brings the agent's back", async t => {
  const { sim, seen } = makeWithControls(t);
  const empty = { buttons: [], sliders: [] };
  sim.showMirror([SCREEN1], [picture(1, 10)], AGENT_CONTROLS);
  await sim.start(request(CONTROLS));
  assert.deepEqual(seen.controls.at(-1), empty, "the agent's are gone the moment the run starts");
  await until(() => sim.getControls().sliders.length === 1, "the run's own controls");
  assert.deepEqual(sim.getControls().sliders, [{ number: 2, value: 0 }], "the run's own slider, not the agent's 0.5");

  // Pressing here works this window's run; the mirrored state is somebody else's.
  sim.setButton(1, true);
  await ioWhen(sim, o => o.outputBooleans[0], "the press");

  const newer = { buttons: [], sliders: [{ number: 9, value: 1 }] };
  sim.showMirror([SCREEN1], [], newer);
  assert.equal(sim.getControls().sliders[0].number, 2, "an agent's update does not reach the panel during the run");
  await sim.stop();
  assert.deepEqual(sim.getControls(), newer);
  assert.deepEqual(seen.controls.at(-1), newer);
});

test("clearMirror takes the agent's controls away too", t => {
  const { sim, seen } = makeWithControls(t);
  sim.showMirror([SCREEN1], [picture(1, 10)], AGENT_CONTROLS);
  sim.clearMirror();
  assert.deepEqual(sim.getControls(), { buttons: [], sliders: [] });
  assert.deepEqual(seen.controls.at(-1), { buttons: [], sliders: [] });
  assert.equal(seen.controls.length, 2);
});
