// src/agent/agentSession.ts against the real engine: a script stepped tick by
// tick with no clock, the way the AI tools drive it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../out/engine/loadEngine.js");
const {
  AgentSession, MAX_STEP_TICKS, STEP_TIME_LIMIT_MS, MAX_LOG_LINES, MAX_LOG_TEXT, MAX_SNAPSHOTS
} = require("../out/agent/agentSession.js");
const { regionStats, diffPictures } = require("../out/agent/pixels.js");

const engine = await loadEngine();
const files = {
  isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
  read: f => readFileSync(f)
};
const BUNDLED = path.resolve(import.meta.dirname, "..", "lua");

function write(sources) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-agent-"));
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** A session with `main.lua` started. */
function started(t, main, { now, start = {}, extra = {} } = {}) {
  const dir = write({ "main.lua": main, ...extra });
  const session = new AgentSession(engine, files, now);
  t.after(() => session.dispose());
  const entry = path.join(dir, "main.lua");
  session.start({ entry, roots: [dir, BUNDLED], ...start });
  return { session, dir, entry };
}

const pose = (over = {}) => ({ position: [0, 0, 0], rotation: [0, 0, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0], ...over });

test("before any script: status none, and every run-bound call says so", t => {
  const session = new AgentSession(engine, files);
  t.after(() => session.dispose());
  assert.equal(session.getStatus(), "none");
  assert.equal(session.getTicks(), 0);
  assert.deepEqual(session.screens(), []);
  for (const call of [
    () => session.step({ ticks: 1, motion: "hold" }),
    () => session.holdInputNumber(1, 1),
    () => session.setProperty("a", 1),
    () => session.configureScreen({ number: 2, size: "1x1", poweredOn: true, portrait: false }),
    () => session.setTouch(1, { x: 0, y: 0 }),
    () => session.picture(1)
  ]) assert.throws(call, /no script is running/);
});

test("start runs the top level only; step runs ticks and counts them", t => {
  const { session } = started(t, `
    print("top")
    n = 0
    function onTick() n = n + 1; output.setNumber(1, n) end
  `);
  assert.equal(session.getStatus(), "running");
  assert.equal(session.getTicks(), 0);
  assert.equal(session.logsSince(0, 10).lines[0].text, "top");
  assert.equal(session.pictures().size, 0, "nothing is drawn before the first tick");
  assert.throws(() => session.picture(1), /nothing is drawn until the first tick/);
  assert.deepEqual(session.step({ ticks: 5, motion: "hold" }), { ticksRun: 5, stopped: "done" });
  assert.equal(session.getTicks(), 5);
  assert.equal(session.io().outputNumbers[0], 5);
  session.step({ ticks: 1, motion: "hold" });
  assert.equal(session.io().outputNumbers[0], 6);
});

test("ticks must be a whole number within the limit", t => {
  const { session } = started(t, "function onTick() end");
  for (const ticks of [0, -1, 1.5, MAX_STEP_TICKS + 1, NaN, "3"]) {
    assert.throws(() => session.step({ ticks, motion: "hold" }), /ticks must be/);
  }
});

test("the same calls give the same pictures and outputs", t => {
  const main = `
    require("PhySim")
    phys = PhySim:new()
    function onLBSimulatorTick(simulator) phys:update(); phys:injectAsInputs(simulator, 1) end
    function onTick() output.setNumber(1, input.getNumber(1) * 2) end
    function onDraw() screen.setColor(255, 255, 255); screen.drawText(1, 1, string.format("%.2f", input.getNumber(1))) end
  `;
  const run = () => {
    const { session } = started(t, main);
    session.setPose(pose({ position: [1, 2, 3], velocity: [0.25, 0, 0] }));
    session.step({ ticks: 30, motion: "integrate" });
    return { io: session.io(), picture: session.picture(1).pixels, pose: session.getPose() };
  };
  const a = run(), b = run();
  assert.deepEqual(a.io, b.io);
  assert.deepEqual(a.pose, b.pose);
  assert.ok(Buffer.from(a.picture).equals(Buffer.from(b.picture)));
  assert.equal(a.io.outputNumbers[0], 17, "x = 1 + 30 * 0.25, doubled");
});

test("hold keeps the pose; integrate advances it, with acceleration, before each tick", t => {
  const { session } = started(t, `
    require("PhySim")
    phys = PhySim:new()
    function onTick() phys:update(); local x = phys:position(); output.setNumber(1, x) end
  `);
  session.setPose(pose({ position: [10, 0, 0], velocity: [1, 0, 0] }));
  session.step({ ticks: 3, motion: "hold" });
  assert.deepEqual(session.getPose().position, [10, 0, 0]);
  assert.equal(session.io().outputNumbers[0], 10);

  session.step({ ticks: 1, motion: "integrate" });
  assert.deepEqual(session.getPose().position, [11, 0, 0]);
  assert.equal(session.io().outputNumbers[0], 11, "the script sees the pose after this tick's integration");

  session.step({ ticks: 2, motion: "integrate", acceleration: { linear: [1, 0, 0], angular: [0, 0, 0] } });
  // v: 1 → 2 → 3; x: 11 → 13 → 16
  assert.deepEqual(session.getPose().velocity, [3, 0, 0]);
  assert.deepEqual(session.getPose().position, [16, 0, 0]);
});

test("the pose outlives a restart; held inputs and monitors do not", t => {
  const { session, entry, dir } = started(t, `
    require("PhySim")
    phys = PhySim:new()
    function onTick() phys:update(); local x = phys:position(); output.setNumber(1, x); output.setNumber(2, input.getNumber(20)) end
  `);
  session.setPose(pose({ position: [5, 0, 0] }));
  session.holdInputNumber(20, 9);
  session.configureScreen({ number: 2, size: "1x1", poweredOn: true, portrait: false });
  session.step({ ticks: 1, motion: "hold" });
  assert.deepEqual(Array.from(session.io().outputNumbers.slice(0, 2)), [5, 9]);
  assert.equal(session.screens().length, 2);

  session.start({ entry, roots: [dir, BUNDLED] });
  assert.equal(session.getTicks(), 0);
  assert.deepEqual(session.heldInputs(), { numbers: [], booleans: [] });
  assert.equal(session.screens().length, 1);
  session.step({ ticks: 1, motion: "hold" });
  assert.deepEqual(Array.from(session.io().outputNumbers.slice(0, 2)), [5, 0]);
});

test("a Lua error at the top level is a failed run, not a thrown request", t => {
  const { session } = started(t, `print("before")\nlocal x = nil\nx.y = 1`);
  assert.equal(session.getStatus(), "failed");
  assert.match(session.getError(), /main\.lua:3: attempt to index a nil value/);
  assert.equal(session.logsSince(0, 10).lines[0].text, "before");
  assert.throws(() => session.step({ ticks: 1, motion: "hold" }), /stopped with an error; start it again/);
});

test("a Lua error in a tick stops the step there and keeps the last pictures and outputs", t => {
  const { session } = started(t, `
    n = 0
    function onTick()
      n = n + 1
      output.setNumber(1, n)
      if n == 3 then print("about to fail"); error("boom") end
    end
    function onDraw() screen.setColor(255, 0, 0); screen.drawRectF(0, 0, n, 1) end
  `);
  const result = session.step({ ticks: 10, motion: "hold" });
  assert.deepEqual(result, { ticksRun: 3, stopped: "failed" });
  assert.equal(session.getStatus(), "failed");
  assert.equal(session.getTicks(), 3);
  assert.match(session.getError(), /main\.lua:6: boom/);
  assert.equal(session.io().outputNumbers[0], 3, "what the failing tick wrote before failing");
  assert.equal(regionStats(session.picture(1)).lit, 2, "the picture is tick 2's: the failing tick never drew");
  const lines = session.logsSince(0, 10).lines;
  assert.deepEqual([lines.at(-1).text, lines.at(-1).tick], ["about to fail", 3]);
  assert.throws(() => session.holdInputNumber(1, 1), /stopped with an error/);
});

test("an endless loop ends the run through the engine's instruction budget", t => {
  const { session } = started(t, "function onTick() while true do end end");
  assert.deepEqual(session.step({ ticks: 5, motion: "hold" }), { ticksRun: 1, stopped: "failed" });
  assert.match(session.getError(), /instruction budget/);
});

test("simulator:exit() ends the step and the run", t => {
  const { session } = started(t, `
    function onLBSimulatorTick(sim, ticks) if ticks == 4 then sim:exit() end end
    function onTick() end
  `);
  assert.deepEqual(session.step({ ticks: 10, motion: "hold" }), { ticksRun: 4, stopped: "exited" });
  assert.equal(session.getStatus(), "exited");
  assert.throws(() => session.step({ ticks: 1, motion: "hold" }), /simulator:exit\(\); start it again/);
});

test("a step past the time limit returns early with the ticks it managed", t => {
  let clock = 0;
  // Each reading of the clock moves it a third of the limit on.
  const dir = write({ "main.lua": "function onTick() end" });
  const timed = new AgentSession(engine, files, () => { const v = clock; clock += STEP_TIME_LIMIT_MS / 3; return v; });
  t.after(() => timed.dispose());
  timed.start({ entry: path.join(dir, "main.lua"), roots: [dir] });
  clock = 0;
  const result = timed.step({ ticks: 100, motion: "hold" });
  assert.equal(result.stopped, "time-limit");
  assert.ok(result.ticksRun >= 1 && result.ticksRun < 100);
  assert.equal(timed.getTicks(), result.ticksRun);
  assert.equal(timed.getStatus(), "running", "the run is intact; another step carries on");
});

test("play runs one tick per pose and leaves the last pose set", t => {
  const { session } = started(t, `
    require("PhySim")
    phys = PhySim:new()
    sum = 0
    function onTick() phys:update(); local x = phys:position(); sum = sum + x; output.setNumber(1, sum) end
  `);
  const states = [1, 2, 3, 4].map(x => pose({ position: [x, 0, 0] }));
  assert.deepEqual(session.play(states), { ticksRun: 4, stopped: "done" });
  assert.equal(session.io().outputNumbers[0], 10);
  assert.deepEqual(session.getPose().position, [4, 0, 0]);
  assert.throws(() => session.play([]), /no poses/);
});

test("monitors: the start-up layout, the script's setScreen on top, changes during the run", t => {
  const { session } = started(t, `
    simulator:setScreen(1, "5x3")
    function onDraw() screen.setColor(0, 255, 0); screen.drawRectF(0, 0, screen.getWidth(), 1) end
  `, { start: { screens: [{ number: 1, size: "1x1", poweredOn: true, portrait: false }, { number: 2, size: "2x1", poweredOn: true, portrait: true }] } });
  assert.deepEqual(session.screens().map(s => [s.number, s.width, s.height]), [[1, 160, 96], [2, 32, 64]]);
  session.step({ ticks: 1, motion: "hold" });
  assert.equal(regionStats(session.picture(1)).lit, 160);
  assert.equal(regionStats(session.picture(2)).lit, 32);

  session.configureScreen({ number: 3, size: "1x1", poweredOn: true, portrait: false });
  session.configureScreen({ number: 2, size: "2x1", poweredOn: false, portrait: true });
  session.step({ ticks: 1, motion: "hold" });
  assert.equal(regionStats(session.picture(3)).lit, 32);
  assert.throws(() => session.picture(2), /powered off/);
  session.removeScreen(3);
  assert.throws(() => session.picture(3), /no monitor 3/);
});

test("touch reaches the script on the next tick, stays down, and is checked against the monitor", t => {
  const { session } = started(t, `
    function onTick()
      output.setBool(1, input.getBool(1)); output.setNumber(3, input.getNumber(3)); output.setNumber(4, input.getNumber(4))
      local s = simulator:getTouchScreen(2)
      output.setBool(2, s.isTouched); output.setNumber(5, s.touchX)
    end
  `, { start: { screens: [{ number: 2, size: "1x1", poweredOn: true, portrait: false }] } });
  session.setTouch(1, { x: 40, y: 50 });
  session.setTouch(2, { x: 7, y: 8 });
  for (let i = 0; i < 2; i++) {
    session.step({ ticks: 1, motion: "hold" });
    const io = session.io();
    assert.deepEqual(io.outputBooleans.slice(0, 2), [true, true]);
    assert.deepEqual([io.outputNumbers[2], io.outputNumbers[3], io.outputNumbers[4]], [40, 50, 7]);
  }
  session.setTouch(1, null);
  session.step({ ticks: 1, motion: "hold" });
  assert.equal(session.io().outputBooleans[0], false);
  assert.throws(() => session.setTouch(1, { x: 96, y: 0 }), /outside monitor 1 \(96x96\)/);
  assert.throws(() => session.setTouch(1, { x: 0, y: -1 }), /outside monitor 1/);
  assert.throws(() => session.setTouch(5, { x: 0, y: 0 }), /no monitor 5/);
});

test("the picture before a step is kept, so a step's change can be measured", t => {
  const { session } = started(t, `
    n = 0
    function onTick() n = n + 1 end
    function onDraw() screen.setColor(255, 255, 255); screen.drawRectF(0, 0, n, 1) end
  `);
  session.step({ ticks: 2, motion: "hold" });
  assert.equal(session.pictureBeforeStep(1), undefined, "there was no picture before the first step");
  session.step({ ticks: 5, motion: "hold" });
  const diff = diffPictures(session.pictureBeforeStep(1), session.picture(1));
  assert.equal(diff.changed, 5);
  assert.deepEqual(diff.changedBounds, { left: 2, top: 0, right: 6, bottom: 0 });
});

test("a snapshot survives a restart and is compared with the new run's picture", t => {
  const main = w => `function onDraw() screen.setColor(255, 255, 255); screen.drawRectF(0, 0, ${w}, 2) end`;
  const { session, dir, entry } = started(t, main(10));
  assert.throws(() => session.saveSnapshot("empty"), /no picture to save/);
  session.step({ ticks: 1, motion: "hold" });
  assert.deepEqual(session.saveSnapshot("before"), [1]);

  writeFileSync(entry, main(14));
  session.start({ entry, roots: [dir] });
  session.step({ ticks: 1, motion: "hold" });
  const diff = diffPictures(session.snapshot("before", 1), session.picture(1));
  assert.equal(diff.changed, 8);
  assert.equal(diff.appeared, 8);
  assert.deepEqual(session.snapshotList(), [{ name: "before", monitors: [1] }]);
  assert.throws(() => session.snapshot("nope", 1), /no snapshot named "nope"/);
  assert.throws(() => session.snapshot("before", 2), /no picture of monitor 2/);
  assert.equal(session.deleteSnapshot("before"), true);
  assert.equal(session.deleteSnapshot("before"), false);
});

test("snapshots are capped, but an existing name can be overwritten at the cap", t => {
  const { session } = started(t, "function onDraw() screen.setColor(255, 255, 255); screen.drawRectF(0, 0, 1, 1) end");
  session.step({ ticks: 1, motion: "hold" });
  for (let i = 0; i < MAX_SNAPSHOTS; i++) session.saveSnapshot(`s${i}`);
  assert.throws(() => session.saveSnapshot("one-more"), /at most/);
  assert.deepEqual(session.saveSnapshot("s0"), [1]);
});

test("log lines carry tick, file and line; the cursor reads on; old lines are dropped and counted", t => {
  const { session, entry } = started(t, `
    n = 0
    function onTick() n = n + 1; print("tick " .. n); debug.log("dbg " .. n) end
  `);
  session.step({ ticks: 2, motion: "hold" });
  const first = session.logsSince(0, 3);
  assert.deepEqual(first.lines.map(l => [l.seq, l.tick, l.source, l.text]), [
    [0, 1, "print", "tick 1"], [1, 1, "debug.log", "dbg 1"], [2, 2, "print", "tick 2"]
  ]);
  assert.equal(first.more, 1);
  assert.equal(first.lines[0].file, entry);
  assert.equal(first.lines[0].line, 3);
  assert.equal(session.logCursor(), 4);
  assert.deepEqual(session.logsSince(3, 10).lines.map(l => l.text), ["dbg 2"]);
  assert.deepEqual(session.logsSince(4, 10), { lines: [], dropped: 0, more: 0 });

  session.step({ ticks: MAX_LOG_LINES, motion: "hold" });
  const all = session.logsSince(0, 5);
  assert.equal(all.dropped, session.logCursor() - MAX_LOG_LINES, "everything but the newest MAX_LOG_LINES lines");
  assert.equal(all.dropped, MAX_LOG_LINES + 4);
  assert.equal(all.lines[0].seq, session.logCursor() - MAX_LOG_LINES);
});

test("a very long log line is cut, with a note of how much", t => {
  const { session } = started(t, `print(string.rep("x", ${MAX_LOG_TEXT + 500}))`);
  const text = session.logsSince(0, 1).lines[0].text;
  assert.ok(text.startsWith("x".repeat(MAX_LOG_TEXT)));
  assert.match(text, /… \(500 more characters\)$/);
});

test("stop ends the run and keeps the pose", t => {
  const { session } = started(t, "function onTick() end");
  session.setPose(pose({ position: [1, 2, 3] }));
  session.step({ ticks: 1, motion: "hold" });
  session.stop();
  assert.equal(session.getStatus(), "none");
  assert.equal(session.getEntry(), null);
  assert.deepEqual(session.screens(), []);
  assert.deepEqual(session.getPose().position, [1, 2, 3]);
  session.stop();
});

test("a pose that overflows while integrating stops the step before that tick, and is never fed to the script", t => {
  const { session } = started(t, `
    require("PhySim")
    phys = PhySim:new()
    function onTick() phys:update(); local x = phys:position(); output.setBool(1, x == x and x < math.huge) end
  `);
  session.setPose(pose({ velocity: [1e308, 0, 0] }));
  assert.throws(
    () => session.step({ ticks: 5, motion: "integrate", acceleration: { linear: [1e308, 0, 0], angular: [0, 0, 0] } }),
    /overflowed while integrating tick 1 of this step \(0 ran\)/
  );
  assert.deepEqual(session.getPose().velocity, [1e308, 0, 0], "the pose is as it was");
  assert.equal(session.getTicks(), 0);
  assert.equal(session.getStatus(), "running", "the run itself is fine");

  // Overflow part-way: the ticks before it ran and are kept.
  session.setPose(pose({ position: [1.7e308, 0, 0], velocity: [5e305, 0, 0] }));
  assert.throws(() => session.step({ ticks: 50, motion: "integrate" }), /tick 20 of this step \(19 ran\)/);
  assert.equal(session.getTicks(), 19);
  assert.ok(session.getPose().position.every(Number.isFinite));
  assert.equal(session.io().outputBooleans[0], true);
});

test("setPose and play refuse a pose that is not finite", t => {
  const { session } = started(t, "function onTick() end");
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => session.setPose(pose({ rotation: [0, bad, 0] })), /finite/);
    assert.throws(() => session.play([pose(), pose({ position: [bad, 0, 0] })]), /pose 2 of the scenario is not finite/);
  }
  assert.equal(session.getTicks(), 0, "a scenario with a bad pose plays none of its rows");
});
