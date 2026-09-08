// media/monitorConfig.js — the multi-monitor layout rules shared by the panel
// controls and (for the size table) src/simStubServer.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PX_PER_BLOCK, SCREEN_SIZES, DEFAULT_SIZE, MAX_SCREENS,
  parseSize, sizePixels, pixelsToSize, nextScreenNumber, fitScale
} from "../media/monitorConfig.js";

test("every listed size parses, and DEFAULT_SIZE is one of them", () => {
  for (const size of SCREEN_SIZES) assert.ok(parseSize(size), `${size} must parse`);
  assert.ok(SCREEN_SIZES.includes(DEFAULT_SIZE));
});

test("parseSize rejects what a script or a stale setting could hand us", () => {
  for (const bad of ["", "3", "3x", "x3", "0x3", "3x0", "axb", null, undefined, "3 by 3"]) {
    assert.equal(parseSize(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("sizePixels: blocks are 32px, portrait swaps the axes", () => {
  assert.deepEqual(sizePixels("3x3", false), { width: 96, height: 96 });
  assert.deepEqual(sizePixels("5x3", false), { width: 160, height: 96 });
  assert.deepEqual(sizePixels("5x3", true), { width: 96, height: 160 });
  assert.deepEqual(sizePixels("1x1", false), { width: PX_PER_BLOCK, height: PX_PER_BLOCK });
});

test("sizePixels falls back rather than producing a zero-sized canvas", () => {
  assert.deepEqual(sizePixels("nonsense", false), sizePixels(DEFAULT_SIZE, false));
});

test("pixelsToSize round-trips every size in both orientations", () => {
  for (const size of SCREEN_SIZES) {
    for (const portrait of [false, true]) {
      const { width, height } = sizePixels(size, portrait);
      assert.equal(pixelsToSize(width, height, portrait), size, `${size} portrait=${portrait}`);
    }
  }
});

test("nextScreenNumber fills the lowest gap, and reports 0 when full", () => {
  assert.equal(nextScreenNumber([]), 1);
  assert.equal(nextScreenNumber([1]), 2);
  // A removed screen 2 must be reused, not skipped past MAX_SCREENS.
  assert.equal(nextScreenNumber([1, 3]), 2);
  const full = Array.from({ length: MAX_SCREENS }, (_, i) => i + 1);
  assert.equal(nextScreenNumber(full), 0);
});

// The whole point of one shared factor: two different-sized monitors must not
// come out looking the same size.
test("fitScale returns a single factor that keeps monitors in one row", () => {
  // Two 96px monitors, 400px of column: 2*(96s+2) + 10 <= 400 -> s = 2.
  assert.equal(fitScale([96, 96], 400), 2);
  // The same column with one monitor fits twice the factor.
  assert.equal(fitScale([96], 400), 4);
});

test("fitScale falls back to the widest monitor once a row can't hold them", () => {
  // Four 160px monitors can't share a 400px row even at 1x, so they wrap and
  // the factor is what the widest alone can take: floor(398/160) = 2.
  assert.equal(fitScale([160, 160, 160, 160], 400), 2);
});

test("fitScale never returns a factor that would blur or vanish the pixels", () => {
  assert.equal(fitScale([96, 96, 96], 40), 1, "clamps up to 1, never 0");
  assert.equal(fitScale([8], 100000), 16, "clamps down to the max");
  assert.equal(fitScale([], 400), 1, "no monitors is not a division by zero");
  assert.equal(fitScale([96], NaN), 1);
});
