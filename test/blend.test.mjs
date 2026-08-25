// media/blend.js — the packing and blending the monitor pixel buffer is built
// on. The point of these tests is that a packed word really is the RGBA byte
// order ImageData expects (get this backwards and every colour comes out with
// red and blue swapped) and that blending an opaque destination is an exact
// lerp with no drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packColour, unpackChannel, blendPixel } from "../media/blend.js";

/** The byte order an ImageData sees for one packed word. */
function bytesOf(word) {
  const u32 = new Uint32Array([word]);
  return Array.from(new Uint8Array(u32.buffer));
}

test("packColour lays bytes out as R,G,B,A in memory", () => {
  assert.deepEqual(bytesOf(packColour(1, 2, 3, 4)), [1, 2, 3, 4]);
  assert.deepEqual(bytesOf(packColour(255, 0, 0, 255)), [255, 0, 0, 255]);
  assert.deepEqual(bytesOf(packColour(0, 0, 255, 255)), [0, 0, 255, 255]);
});

test("packColour produces an unsigned word", () => {
  const white = packColour(255, 255, 255, 255);
  assert.ok(white > 0, "must not come back as a negative int32");
  assert.equal(white, 0xffffffff);
});

test("unpackChannel round-trips every channel", () => {
  const w = packColour(12, 34, 56, 78);
  assert.equal(unpackChannel(w, "r"), 12);
  assert.equal(unpackChannel(w, "g"), 34);
  assert.equal(unpackChannel(w, "b"), 56);
  assert.equal(unpackChannel(w, "a"), 78);
});

test("blendPixel at full alpha replaces the destination", () => {
  const dst = packColour(10, 20, 30, 255);
  const out = blendPixel(dst, 200, 100, 50, 255);
  assert.deepEqual(bytesOf(out), [200, 100, 50, 255]);
});

test("blendPixel at zero alpha leaves the destination alone", () => {
  const dst = packColour(10, 20, 30, 255);
  assert.equal(blendPixel(dst, 200, 100, 50, 0), dst);
});

test("blendPixel at half alpha lands on the midpoint", () => {
  const dst = packColour(0, 0, 0, 255);
  // 128/255 of 255 is 128.0, and half of 200 over 0 is 100.4 -> 100
  assert.deepEqual(bytesOf(blendPixel(dst, 255, 255, 255, 128)), [128, 128, 128, 255]);
  assert.deepEqual(bytesOf(blendPixel(dst, 200, 100, 40, 128)), [100, 50, 20, 255]);
  // and the symmetric case: half of white onto white stays white
  const white = packColour(255, 255, 255, 255);
  assert.deepEqual(bytesOf(blendPixel(white, 255, 255, 255, 128)), [255, 255, 255, 255]);
});

test("the result is always opaque — the buffer never goes see-through", () => {
  for (const a of [0, 1, 64, 128, 200, 254, 255]) {
    const out = blendPixel(packColour(9, 9, 9, 255), 250, 5, 100, a);
    assert.equal(unpackChannel(out, "a"), 255);
  }
});

test("repeated blends of the same colour converge instead of drifting", () => {
  // Rounding down would leave a stack of translucent draws permanently darker
  // than the colour being drawn.
  let px = packColour(0, 0, 0, 255);
  for (let i = 0; i < 200; i++) px = blendPixel(px, 200, 200, 200, 128);
  assert.deepEqual(bytesOf(px), [200, 200, 200, 255]);
});

test("channels stay in range for every alpha", () => {
  for (let a = 0; a <= 255; a++) {
    const out = blendPixel(packColour(255, 0, 128, 255), 0, 255, 128, a);
    for (const ch of /** @type {const} */ (["r", "g", "b"])) {
      const v = unpackChannel(out, ch);
      assert.ok(v >= 0 && v <= 255, `alpha ${a} produced ${ch}=${v}`);
    }
  }
});
