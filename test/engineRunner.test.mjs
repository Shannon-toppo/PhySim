// src/engine/runner.ts against the real Storm Lua Engine: tick order, the
// LifeBoatAPI-style `simulator` object, require, monitors, and suspension.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../out/engine/loadEngine.js");
const { VehicleRunner } = require("../out/engine/runner.js");
const { chunkName } = require("../out/engine/sourceRoots.js");

const engine = await loadEngine();
const files = {
  isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
  read: f => readFileSync(f)
};

/** Write a project to a temp dir and build a runner for its main.lua. */
function project(sources, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-runner-"));
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const logs = [];
  const screenEvents = [];
  const runner = new VehicleRunner(engine, {
    entry: path.join(dir, "main.lua"), roots: [dir], files,
    onLog: l => logs.push(l), onScreens: s => screenEvents.push(s), ...extra
  });
  return { dir, runner, logs, screenEvents };
}

test("tick order: default inputs, onLBSimulatorTick, onTick; outputs readable", t => {
  const { runner } = project({ "main.lua": `
    order = ""
    function onLBSimulatorTick(sim, ticks) order = order .. "S" .. ticks; sim:setInputNumber(10, ticks * 2) end
    function onTick() order = order .. "T"; output.setNumber(1, input.getNumber(10)); output.setNumber(2, input.getNumber(1)); output.setBool(1, order == "S1T") end
  ` });
  t.after(() => runner.dispose());
  assert.equal(runner.start(), "completed");
  assert.equal(runner.tick(), "completed");
  let io = runner.readIo();
  assert.equal(io.outputNumbers[0], 2);
  assert.equal(io.outputNumbers[1], 96, "monitor 1's width is the default input on channel 1");
  assert.equal(io.outputBooleans[0], true);
  runner.tick();
  assert.equal(runner.readIo().outputNumbers[0], 4);
  assert.equal(runner.tickCount, 2);
});

test("a channel the script set is not overwritten by the touch defaults", t => {
  const { runner } = project({ "main.lua": `
    function onLBSimulatorTick(sim, ticks) if ticks == 1 then sim:setInputNumber(1, 7) end end
    function onTick() output.setNumber(1, input.getNumber(1)); output.setNumber(2, input.getNumber(3)); output.setBool(1, input.getBool(1)) end
  ` });
  t.after(() => runner.dispose());
  runner.start();
  runner.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 12, y: 5, xAlt: 0, yAlt: 0 });
  runner.tick(); runner.tick();
  const io = runner.readIo();
  assert.equal(io.outputNumbers[0], 7);
  assert.equal(io.outputNumbers[1], 12);
  assert.equal(io.outputBooleans[0], true);
});

test("require: dotted names, init.lua, include-once, globals shared, missing module fails", t => {
  const { runner, dir } = project({
    "main.lua": `require("lib.util") require("lib.util") require("pkg")
      function onTick() output.setNumber(1, twice(21)); output.setNumber(2, loads); output.setNumber(3, pkgValue) end`,
    "lib/util.lua": `loads = (loads or 0) + 1; function twice(x) return x * 2 end`,
    "pkg/init.lua": `pkgValue = 5`
  });
  t.after(() => runner.dispose());
  runner.start(); runner.tick();
  assert.deepEqual(runner.readIo().outputNumbers.slice(0, 3), [42, 1, 5]);
  assert.deepEqual(runner.loadedFiles().map(f => path.relative(dir, f)).sort(),
    ["lib/util.lua", "main.lua", "pkg/init.lua"].map(p => path.normalize(p)).sort());

  const bad = project({ "main.lua": `require("nope")` });
  t.after(() => bad.runner.dispose());
  assert.throws(() => bad.runner.start(), /Could not find require: nope/);
  assert.equal(bad.runner.state, "failed");

  const escape = project({ "main.lua": `require("../x")` });
  t.after(() => escape.runner.dispose());
  assert.throws(() => escape.runner.start(), /Could not find require/);
});

test("a Lua error names the file and line, and ends the run", t => {
  const { runner } = project({ "main.lua": `function onTick()\n  local x = nil\n  return x.y\nend` });
  t.after(() => runner.dispose());
  runner.start();
  // Lua shortens a long chunk name in the message itself ("...ject/main.lua:3").
  assert.throws(() => runner.tick(), /main\.lua:3: attempt to index a nil value/);
  assert.equal(runner.state, "failed");
  assert.throws(() => runner.tick(), /failed/);
});

test("print and debug.log reach onLog with their call site", t => {
  const { runner, logs, dir } = project({ "main.lua": `print("hello", 1)\nfunction onTick() debug.log("tick") end` });
  t.after(() => runner.dispose());
  runner.start(); runner.tick();
  assert.deepEqual(logs.map(l => [l.source, l.text, l.line]), [["print", "hello\t1", 1], ["debug.log", "tick", 2]]);
  assert.equal(logs[0].chunk, chunkName(path.join(dir, "main.lua")));
});

test("monitors: default 3x3, setScreen from the script, a frame per powered monitor, repeats skipped", t => {
  const { runner, screenEvents } = project({ "main.lua": `
    simulator:setScreen(1, "1x1")
    second = simulator:setScreen(5, "2x1", true, true)
    function onDraw() local w, h = screen.getWidth(), screen.getHeight(); screen.setColor(255, 0, 0); screen.drawRectF(0, 0, w, h) end
    function onTick() output.setNumber(1, second) end
  ` });
  t.after(() => runner.dispose());
  assert.deepEqual(runner.screenList().map(s => s.size), ["3x3"]);
  runner.start();
  assert.deepEqual(runner.screenList().map(s => [s.number, s.width, s.height, s.portrait]), [[1, 32, 32, false], [2, 32, 64, true]]);
  assert.ok(screenEvents.length >= 2);
  runner.tick();
  assert.equal(runner.readIo().outputNumbers[0], 2, "an unknown screen number takes the next free one");
  const frames = runner.takeFrames();
  assert.deepEqual(frames.map(f => [f.screen, f.width, f.height, f.pixels.length]), [[1, 32, 32, 4096], [2, 32, 64, 8192]]);
  assert.deepEqual(Array.from(frames[0].pixels.slice(0, 3)), [255, 0, 0]);
  runner.tick();
  assert.deepEqual(runner.takeFrames(), [], "an unchanged picture is not sent again");
  assert.equal(runner.currentFrames().length, 2);
  runner.removeScreen(2);
  assert.equal(runner.currentFrames().length, 1);
  runner.configureScreen({ number: 1, size: "2x2", poweredOn: true, portrait: false });
  runner.tick();
  assert.deepEqual(runner.takeFrames().map(f => [f.screen, f.width]), [[1, 64]]);
});

test("a script without onDraw gets a blank frame; the panel's layout is seeded first", t => {
  const { runner } = project({ "main.lua": `function onTick() end` },
    { screens: [{ number: 1, size: "2x2", poweredOn: true, portrait: false }, { number: 3, size: "1x1", poweredOn: false, portrait: false }] });
  t.after(() => runner.dispose());
  runner.start(); runner.tick();
  const frames = runner.takeFrames();
  assert.deepEqual(frames.map(f => [f.screen, f.width]), [[1, 64]]);
  assert.ok(frames[0].pixels.every(b => b === 0));
});

test("setProperty, getTouchScreen(n), host pose and simulator:exit()", t => {
  const { runner } = project({ "main.lua": `
    simulator:setProperty("Gain", 2.5) simulator:setProperty("Name", "abc") simulator:setProperty("On", true)
    simulator:setScreen(2, "1x1")
    function onLBSimulatorTick(sim, ticks)
      sim:setInputNumber(20, sim:getTouchScreen(2).touchX)
      local px, py, pz, rx = __physim_host.phys()
      sim:setInputNumber(21, py + rx)
      if ticks == 2 then sim:exit() end
    end
    function onTick()
      output.setNumber(1, property.getNumber("Gain")); output.setBool(1, property.getBool("On") and property.getText("Name") == "abc")
      output.setNumber(2, input.getNumber(20)); output.setNumber(3, input.getNumber(21))
    end
  ` });
  t.after(() => runner.dispose());
  runner.start();
  runner.setTouch(2, { isTouched: true, isTouchedAlt: false, x: 9, y: 0, xAlt: 0, yAlt: 0 });
  runner.setPhysState({ position: [1, 2, 3], rotation: [0.5, 0, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
  runner.tick();
  const io = runner.readIo();
  assert.deepEqual(io.outputNumbers.slice(0, 3), [2.5, 9, 2.5]);
  assert.equal(io.outputBooleans[0], true);
  assert.equal(runner.tick(), "completed");
  assert.equal(runner.state, "exited");
});

test("setScreen with a bad size and setInputNumber out of range are Lua errors", t => {
  for (const src of [`simulator:setScreen(1, "big")`, `simulator:setInputNumber(33, 1)`, `simulator:setProperty("x", {})`]) {
    const { runner } = project({ "main.lua": src });
    t.after(() => runner.dispose());
    assert.throws(() => runner.start(), /main\.lua:1/, src);
  }
});

test("a breakpoint suspends mid-tick; resume finishes the same tick exactly once", t => {
  const { runner, dir } = project({ "main.lua":
`count = 0
function onLBSimulatorTick(sim, ticks) count = count + 1 end
function onTick()
  local a = count
  output.setNumber(1, a)
end
function onDraw()
  screen.drawClear()
end` });
  t.after(() => runner.dispose());
  const source = chunkName(path.join(dir, "main.lua"));
  runner.start();
  runner.setBreakpoints([{ source, line: 5 }]);
  assert.equal(runner.tick(), "suspended");
  assert.equal(runner.state, "suspended");
  assert.throws(() => runner.tick(), /suspended/);
  const stack = runner.stack();
  assert.equal(stack[0].line, 5);
  assert.equal(stack[0].source, source);
  const locals = runner.locals(stack[0].level);
  const a = locals.find(v => Buffer.from(v.name).toString() === "a");
  assert.ok(a, JSON.stringify(locals.map(v => Buffer.from(v.name).toString())));
  assert.equal(Number(a.value.value), 1);
  assert.equal(runner.takeFrames().length, 0, "nothing is drawn while the tick is stopped");
  runner.setBreakpoints([]);
  assert.equal(runner.resume(), "completed");
  assert.equal(runner.readIo().outputNumbers[0], 1);
  assert.equal(runner.takeFrames().length, 1);
  runner.tick();
  assert.equal(runner.readIo().outputNumbers[0], 2, "the stopped tick ran onLBSimulatorTick once, not twice");
});

test("stepping over stays suspended until the phase ends", t => {
  const { runner, dir } = project({ "main.lua": `function onTick()\n  local a = 1\n  local b = 2\n  output.setNumber(1, a + b)\nend` });
  t.after(() => runner.dispose());
  runner.start();
  runner.setBreakpoints([{ source: chunkName(path.join(dir, "main.lua")), line: 2 }]);
  assert.equal(runner.tick(), "suspended");
  runner.setBreakpoints([]);
  assert.equal(runner.resume("over"), "suspended");
  assert.equal(runner.stack()[0].line, 3);
  assert.equal(runner.resume("continue"), "completed");
  assert.equal(runner.readIo().outputNumbers[0], 3);
});

test("drawMap fills with the ocean colour instead of failing; map.* converts coordinates", t => {
  const { runner } = project({ "main.lua": `
    function onTick()
      local wx, wy = map.screenToMap(100, 200, 2, 96, 96, 48, 48)
      local px, py = map.mapToScreen(100, 200, 2, 96, 96, 100, 200)
      output.setNumber(1, wx); output.setNumber(2, wy); output.setNumber(3, px); output.setNumber(4, py)
      output.setBool(1, map.screenToMap(1, 2) == nil)
    end
    function onDraw()
      if drawn then screen.setMapColorOcean(1, 2, 3, 255) end
      screen.drawMap(0, 0, 1)
      drawn = true
    end` });
  t.after(() => runner.dispose());
  runner.start(); runner.tick();
  assert.deepEqual(Array.from(runner.takeFrames()[0].pixels.slice(0, 4)), [20, 40, 90, 255]);
  const io = runner.readIo();
  assert.deepEqual(io.outputNumbers.slice(0, 4), [100, 200, 48, 48]);
  assert.equal(io.outputBooleans[0], true);
  runner.tick();
  assert.deepEqual(Array.from(runner.takeFrames()[0].pixels.slice(0, 4)), [1, 2, 3, 255]);
});

// --- Inputs and properties held from outside the script (the AI tools) --------

test("a held input is written every tick, beats the touch defaults and loses to the script", t => {
  const { runner } = project({ "main.lua": `
    simulator:setInputNumber(9, 99)
    simulator:setInputBool(5, false)
    function onTick()
      output.setNumber(1, input.getNumber(3))   -- touch default channel, held
      output.setNumber(2, input.getNumber(20))  -- plain channel, held
      output.setNumber(3, input.getNumber(9))   -- the script's own
      output.setBool(1, input.getBool(4))
      output.setBool(2, input.getBool(5))
    end
  ` });
  t.after(() => runner.dispose());
  runner.holdInputNumber(3, 1.5);
  runner.holdInputNumber(20, -4);
  runner.holdInputNumber(9, 1);
  runner.holdInputBool(4, true);
  runner.holdInputBool(5, true);
  runner.start();
  for (let i = 0; i < 2; i++) {
    runner.tick();
    const io = runner.readIo();
    assert.deepEqual(Array.from(io.outputNumbers.slice(0, 3)), [1.5, -4, 99]);
    assert.deepEqual(io.outputBooleans.slice(0, 2), [true, false]);
  }
  assert.deepEqual(runner.heldInputList(), { numbers: [[3, 1.5], [20, -4], [9, 1]], booleans: [[4, true], [5, true]] });
});

test("a held input is seen by onLBSimulatorTick, and a released one keeps its last value", t => {
  const { runner } = project({ "main.lua": `
    function onLBSimulatorTick(sim) seen = input.getNumber(20) end
    function onTick() output.setNumber(1, seen); output.setNumber(2, input.getNumber(3)) end
  ` });
  t.after(() => runner.dispose());
  runner.holdInputNumber(20, 7);
  runner.holdInputNumber(3, 5);
  runner.start();
  runner.tick();
  assert.deepEqual(Array.from(runner.readIo().outputNumbers.slice(0, 2)), [7, 5]);
  runner.holdInputNumber(20, null);
  runner.holdInputNumber(3, null);
  runner.tick();
  const io = runner.readIo();
  assert.equal(io.outputNumbers[0], 7, "nothing else writes channel 20, so it stays");
  assert.equal(io.outputNumbers[1], 0, "channel 3 goes back to the touch default");
  assert.deepEqual(runner.heldInputList(), { numbers: [], booleans: [] });
});

test("holding an input refuses a bad channel or value", t => {
  const { runner } = project({ "main.lua": "function onTick() end" });
  t.after(() => runner.dispose());
  for (const channel of [0, 33, 1.5, NaN, "3"]) {
    assert.throws(() => runner.holdInputNumber(channel, 1), /channel/);
    assert.throws(() => runner.holdInputBool(channel, true), /channel/);
  }
  for (const value of [NaN, Infinity, "1", true, undefined]) assert.throws(() => runner.holdInputNumber(1, value), /finite number/);
  for (const value of [1, "true", undefined]) assert.throws(() => runner.holdInputBool(1, value), /true or false/);
});

test("start-up properties are in place for the top level, and the script's own setProperty wins", t => {
  const { runner, logs } = project({ "main.lua": `
    print(property.getNumber("Gain"), property.getText("Name"), property.getBool("On"), property.getNumber("Mine"))
    simulator:setProperty("Mine", 5)
    function onTick() output.setNumber(1, property.getNumber("Gain")); output.setNumber(2, property.getNumber("Mine")) end
  ` }, { properties: { Gain: 2.5, Name: "abc", On: true, Mine: 1 } });
  t.after(() => runner.dispose());
  runner.start();
  assert.match(logs[0].text, /^2\.5\tabc\ttrue\t1/);
  runner.tick();
  assert.deepEqual(Array.from(runner.readIo().outputNumbers.slice(0, 2)), [2.5, 5]);
});

test("setProperty between ticks changes one property and leaves the rest", t => {
  const { runner } = project({ "main.lua": `
    simulator:setProperty("Kept", 3)
    function onTick() output.setNumber(1, property.getNumber("Gain")); output.setNumber(2, property.getNumber("Kept")); output.setBool(1, property.getBool("Flag")) end
  ` }, { properties: { Gain: 1 } });
  t.after(() => runner.dispose());
  runner.start();
  runner.tick();
  runner.setProperty("Gain", 4);
  runner.setProperty("Flag", true);
  runner.setProperty("Label", "héllo");
  runner.tick();
  const io = runner.readIo();
  assert.deepEqual(Array.from(io.outputNumbers.slice(0, 2)), [4, 3]);
  assert.equal(io.outputBooleans[0], true);
  const list = runner.propertyList().sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(list, [
    { label: "Flag", value: true }, { label: "Gain", value: 4 }, { label: "Kept", value: 3 }, { label: "Label", value: "héllo" }
  ]);
  assert.throws(() => runner.setProperty("", 1), /label/);
  assert.throws(() => runner.setProperty("X", NaN), /finite/);
  assert.throws(() => runner.setProperty("X", null), /number, a boolean or a string/);
});
