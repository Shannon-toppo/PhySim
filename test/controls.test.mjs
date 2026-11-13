// src/engine/controls.ts — the buttons, toggles and sliders of LifeBoatAPI's
// simulator window — on its own, then through VehicleRunner on the real engine
// with the `simulator:getIsClicked / getIsToggled / getSlider` a script calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ControlBoard, MAX_CONTROLS, controlNumber, sliderValue, NO_CONTROLS } = require("../out/engine/controls.js");
const { loadEngine } = require("../out/engine/loadEngine.js");
const { VehicleRunner } = require("../out/engine/runner.js");

test("there are ten of each, as in LifeBoatAPI's window", () => {
  assert.equal(MAX_CONTROLS, 10);
  assert.deepEqual(NO_CONTROLS, { buttons: [], sliders: [] });
});

test("controlNumber takes whole numbers 1..10 and nothing else", () => {
  for (const n of [1, 5, 10]) assert.equal(controlNumber(n), n);
  for (const n of [0, 11, -1, 1.5, NaN, Infinity, "3", null, undefined, true, {}]) assert.equal(controlNumber(n), null);
});

test("sliderValue clamps into 0..1 and refuses what is not a finite number", () => {
  assert.deepEqual([0, 0.25, 1, -3, 7].map(sliderValue), [0, 0.25, 1, 0, 1]);
  for (const v of [NaN, Infinity, -Infinity, "0.5", null, undefined]) assert.equal(sliderValue(v), null);
});

test("a held button reads clicked on every tick until released", () => {
  const b = new ControlBoard();
  assert.equal(b.readClicked(1), false);
  b.press(1, true);
  for (let i = 0; i < 3; i++) { assert.equal(b.readClicked(1), true); b.endTick(); }
  b.press(1, false);
  assert.equal(b.readClicked(1), false);
});

test("a press released before any tick ran is still seen by exactly one tick", () => {
  const b = new ControlBoard();
  b.click(2);
  assert.equal(b.readClicked(2), true, "the tick after the click");
  assert.equal(b.readClicked(2), true, "asked twice in the same tick");
  b.endTick();
  assert.equal(b.readClicked(2), false);
});

test("every press flips the toggle; holding and releasing do not", () => {
  const b = new ControlBoard();
  assert.equal(b.readToggled(3), false);
  b.press(3, true);
  assert.equal(b.readToggled(3), true);
  b.press(3, true);
  b.endTick();
  assert.equal(b.readToggled(3), true, "still down: not another press");
  b.press(3, false);
  assert.equal(b.readToggled(3), true);
  b.click(3);
  assert.equal(b.readToggled(3), false);
  assert.equal(b.readToggled(4), false, "another button's toggle is its own");
});

test("sliders read 0 until set, are clamped, and can start from given positions", () => {
  const b = new ControlBoard([[2, 0.4], [3, 9], [11, 0.5], [4, NaN]]);
  assert.deepEqual([1, 2, 3, 4].map(n => b.readSlider(n)), [0, 0.4, 1, 0]);
  assert.equal(b.setSlider(1, 0.75), true);
  assert.equal(b.readSlider(1), 0.75);
  assert.equal(b.setSlider(1, -2), true);
  assert.equal(b.readSlider(1), 0);
  assert.equal(b.setSlider(1, "x"), false);
  assert.equal(b.setSlider(0, 0.5), false);
});

test("a number outside 1..10 reads unpressed / 0 and is never listed, as in LifeBoatAPI", () => {
  const b = new ControlBoard();
  for (const n of [0, 11, 2.5, NaN, undefined, "1"]) {
    assert.equal(b.readClicked(n), false);
    assert.equal(b.readToggled(n), false);
    assert.equal(b.readSlider(n), 0);
    assert.equal(b.press(n, true), false);
    assert.equal(b.click(n), false);
  }
  assert.deepEqual(b.info(), NO_CONTROLS);
});

test("info lists what the script has read, sorted, and onChange fires once per new control", () => {
  const b = new ControlBoard([[7, 0.5]]);
  const seen = [];
  b.onChange = info => seen.push(info);
  b.readClicked(5);
  b.readClicked(5);
  b.readToggled(2);
  b.readToggled(5);
  b.readSlider(7);
  b.readSlider(7);
  b.press(2, true);
  assert.equal(seen.length, 4, "button 5, toggle 2, toggle 5, slider 7 — repeats and presses are not news");
  assert.deepEqual(b.info(), {
    buttons: [{ number: 2, showsToggle: true, toggled: true, down: true }, { number: 5, showsToggle: true, toggled: false, down: false }],
    sliders: [{ number: 7, value: 0.5 }]
  });
  assert.deepEqual(seen[0], { buttons: [{ number: 5, showsToggle: false, toggled: false, down: false }], sliders: [] });
});

// --- Through the engine --------------------------------------------------------

const engine = await loadEngine();

function runner(t, source, extra = {}) {
  const controls = [];
  const r = new VehicleRunner(engine, {
    entry: "/p/main.lua", roots: [],
    files: { isFile: () => false, read: () => new TextEncoder().encode(source) },
    onControls: c => controls.push(c), ...extra
  });
  t.after(() => r.dispose());
  r.start();
  return { r, controls };
}

const SCRIPT = `
  function onLBSimulatorTick(simulator)
    simulator:setInputBool(31, simulator:getIsClicked(1))
    simulator:setInputBool(32, simulator:getIsToggled(2))
    simulator:setInputNumber(31, simulator:getSlider(1))
    simulator:setInputNumber(32, simulator:getSlider(2) * 50)
  end
  function onTick()
    output.setBool(1, input.getBool(31)); output.setBool(2, input.getBool(32))
    output.setNumber(1, input.getNumber(31)); output.setNumber(2, input.getNumber(32))
  end`;
const out = r => { const io = r.readIo(); return [io.outputBooleans[0], io.outputBooleans[1], io.outputNumbers[0], io.outputNumbers[1]]; };

test("LifeBoatAPI's template script reads the buttons and sliders through simulator:*", t => {
  const { r, controls } = runner(t, SCRIPT, { sliders: [[2, 0.5]] });
  assert.deepEqual(controls, [], "nothing is read before the first tick");
  r.tick();
  assert.deepEqual(out(r), [false, false, 0, 25]);
  assert.deepEqual(r.controlsInfo(), {
    buttons: [{ number: 1, showsToggle: false, toggled: false, down: false }, { number: 2, showsToggle: true, toggled: false, down: false }],
    sliders: [{ number: 1, value: 0 }, { number: 2, value: 0.5 }]
  });
  assert.equal(controls.length, 4);

  r.pressButton(1, true);
  r.clickButton(2);
  r.setSlider(1, 0.25);
  r.tick();
  assert.deepEqual(out(r), [true, true, 0.25, 25]);
  r.tick();
  assert.deepEqual(out(r), [true, true, 0.25, 25], "button 1 is still held; toggle 2 stays on");
  r.pressButton(1, false);
  r.clickButton(2);
  r.tick();
  assert.deepEqual(out(r), [false, false, 0.25, 25]);
  assert.equal(controls.length, 4, "using the controls is not a change of layout");
});

test("a click is seen by one tick only, even when the script reads it in onTick", t => {
  const { r } = runner(t, `
    n = 0
    function onTick() if simulator:getIsClicked(3) then n = n + 1 end; output.setNumber(1, n) end`);
  r.tick();
  r.clickButton(3);
  r.tick(); r.tick(); r.tick();
  assert.equal(r.readIo().outputNumbers[0], 1);
});

test("a script that reads no control has none; a wrong number or type reads as nothing", t => {
  const { r, controls } = runner(t, `
    function onTick()
      output.setBool(1, simulator:getIsClicked(11) or simulator:getIsToggled("2") or simulator:getIsClicked(nil))
      output.setNumber(1, simulator:getSlider(0) + simulator:getSlider(1.5))
    end`);
  r.pressButton(2, true);
  r.tick();
  assert.equal(r.readIo().outputBooleans[0], false);
  assert.equal(r.readIo().outputNumbers[0], 0);
  assert.deepEqual(controls, []);
  assert.deepEqual(r.controlsInfo(), { buttons: [], sliders: [] });
});
