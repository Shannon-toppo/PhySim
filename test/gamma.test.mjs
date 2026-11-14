// media/gamma.js — LifeBoatAPI's colour lift, shown when the monitors' "True colour" is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lift, LIFT, liftFrame, GAMMA_A, GAMMA_Y } from "../media/gamma.js";

// PhySim 1.x's "True colour" undid LifeBoatAPI's lift with this (media/mcScreen.js, 1.2.1).
const unGamma = c => (c <= 0 ? 0 : 255 * GAMMA_A * Math.pow(c / 255, GAMMA_Y));

test("lift is LifeBoatAPI's 255 * ((c/255)/0.85)^(1/2.4), rounded and clamped to a byte", () => {
  assert.equal(lift(0), 0);
  assert.equal(lift(128), Math.round(255 * Math.pow(128 / 255 / 0.85, 1 / 2.4)));
  assert.equal(lift(215), 254);
  assert.equal(lift(216), 255, "the curve reaches white at 0.85 * 255 = 216.75; rounding gets there from 216");
  assert.equal(lift(255), 255);
  assert.equal(lift(Number.NaN), 0);
});

test("1.x's un-gamma takes every lifted value below white back to where it started", () => {
  for (let c = 0; c <= 215; c++) assert.ok(Math.abs(unGamma(LIFT[c]) - c) <= 1.5, `c = ${c}`);
});

test("the table only ever brightens, and never goes backwards", () => {
  for (let c = 1; c < 256; c++) {
    assert.ok(LIFT[c] >= c, `c = ${c}`);
    assert.ok(LIFT[c] >= LIFT[c - 1], `c = ${c}`);
  }
});

test("liftFrame lifts r, g and b and keeps alpha", () => {
  const src = Uint8Array.from([0, 64, 128, 77, 255, 10, 200, 255]);
  const dst = new Uint8ClampedArray(src.length);
  liftFrame(src, dst);
  assert.deepEqual([...dst], [0, LIFT[64], LIFT[128], 77, 255, LIFT[10], LIFT[200], 255]);
  assert.deepEqual([...src], [0, 64, 128, 77, 255, 10, 200, 255], "the engine's frame is not touched");
});
