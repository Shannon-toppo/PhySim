// media/blend.js — the packing and blending the monitor pixel buffer is built
// on. The point of these tests is that a packed word really is the RGBA byte
// order ImageData expects (get this backwards and every colour comes out with
// red and blue swapped), and that blending reproduces the game's measured
// values — alpha is blended too, and the monitor shows rgb × alpha.

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

/** What the monitor shows for one packed pixel: rgb × alpha, on black. */
const shown = (word) => ["r", "g", "b"].map(ch =>
  Math.round(unpackChannel(word, ch) * unpackChannel(word, "a") / 255));

test("blendPixel at half alpha: colour at the midpoint, alpha lowered too", () => {
  const dst = packColour(0, 0, 0, 255);
  // rgb is the plain lerp; alpha takes the same weights: 128·128 + 255·127.
  assert.deepEqual(bytesOf(blendPixel(dst, 255, 255, 255, 128)), [128, 128, 128, 191]);
  assert.deepEqual(bytesOf(blendPixel(dst, 200, 100, 40, 128)), [100, 50, 20, 191]);
});

test("the game's measured values come out (B2/B3 in doc/ingame-findings.md)", () => {
  // [destination, source rgb, alpha, what the game showed]. The buffer is
  // 8-bit, so a value may land one step off the game's.
  const black = packColour(0, 0, 0, 255), grey = packColour(128, 128, 128, 255);
  const white = packColour(255, 255, 255, 255);
  const cases = [
    [black, 255, 128, 96],   // src-over would give 128
    [grey, 255, 51, 129],    // barely moves; src-over would give 153
    [grey, 255, 204, 193],
    [white, 0, 17, 221],
    [black, 255, 64, 51],
  ];
  for (const [dst, c, a, game] of cases) {
    const got = shown(blendPixel(dst, c, c, c, a))[0];
    assert.ok(Math.abs(got - game) <= 2, `${c} a=${a}: ${got}, game ${game}`);
  }
});

test("restacking a translucent colour levels off at alpha, not at white", () => {
  // Game: 96, 119, 126, 126, 126 for white a=128 stacked on black.
  let px = packColour(0, 0, 0, 255);
  const seen = [];
  for (let i = 0; i < 5; i++) { px = blendPixel(px, 255, 255, 255, 128); seen.push(shown(px)[0]); }
  assert.deepEqual(seen, [96, 120, 126, 127, 127]);
  // and it stays there without drifting
  for (let i = 0; i < 200; i++) px = blendPixel(px, 255, 255, 255, 128);
  assert.ok(Math.abs(shown(px)[0] - 128) <= 1);
});

test("a frame starts transparent: white a=128 onto it shows as 32 (D9)", () => {
  const fresh = packColour(0, 0, 0, 0);
  assert.equal(shown(blendPixel(fresh, 255, 255, 255, 128))[0], 32);
  assert.ok(shown(blendPixel(fresh, 255, 255, 255, 32))[0] <= 1);   // game: indistinguishable from black
});

test("an opaque draw always leaves the pixel opaque", () => {
  for (const da of [0, 1, 128, 255]) {
    const out = blendPixel(packColour(9, 9, 9, da), 250, 5, 100, 255);
    assert.deepEqual(bytesOf(out), [250, 5, 100, 255]);
  }
});

test("channels stay in range for every alpha", () => {
  for (let a = 0; a <= 255; a++) {
    const out = blendPixel(packColour(255, 0, 128, 255), 0, 255, 128, a);
    for (const ch of /** @type {const} */ (["r", "g", "b", "a"])) {
      const v = unpackChannel(out, ch);
      assert.ok(v >= 0 && v <= 255, `alpha ${a} produced ${ch}=${v}`);
    }
  }
});
