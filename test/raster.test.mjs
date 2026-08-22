// media/raster.js — the integer-grid rasterisers that replace Canvas' anti-
// aliased path drawing. The point of these tests is that every shape lands on
// whole pixels, stays inside the screen no matter what the microcontroller
// passes, and never loops unboundedly on absurd input.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipSegment, strokeLine, strokeCircle, fillCircle, strokeTriangle, fillTriangle
} from "../media/raster.js";

const BOUNDS = { width: 32, height: 32 };

/** Collect plotted pixels as "x,y" keys plus the raw call list. */
function collector() {
  const calls = [];
  const set = new Set();
  const plot = (x, y) => { calls.push([x, y]); set.add(`${x},${y}`); };
  return { plot, calls, set };
}

/** Expand fill runs into the same shape a plotter would produce. */
function runCollector() {
  const c = collector();
  const fillRun = (x, y, w) => { for (let i = 0; i < w; i++) c.plot(x + i, y); };
  return { ...c, fillRun };
}

test("strokeLine: horizontal, vertical and 45-degree lines are exact", () => {
  const h = collector();
  strokeLine(h.plot, 2, 5, 6, 5, BOUNDS);
  assert.deepEqual(h.calls, [[2, 5], [3, 5], [4, 5], [5, 5], [6, 5]]);

  const v = collector();
  strokeLine(v.plot, 5, 2, 5, 5, BOUNDS);
  assert.deepEqual(v.calls, [[5, 2], [5, 3], [5, 4], [5, 5]]);

  const d = collector();
  strokeLine(d.plot, 0, 0, 4, 4, BOUNDS);
  assert.deepEqual(d.calls, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
});

test("strokeLine: every pixel is a whole number (no anti-aliasing possible)", () => {
  const c = collector();
  strokeLine(c.plot, 1.4, 2.6, 27.2, 19.9, BOUNDS);
  assert.ok(c.calls.length > 0);
  for (const [x, y] of c.calls) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y), `non-integer pixel ${x},${y}`);
  }
});

test("strokeLine: a single-point line still plots one pixel", () => {
  const c = collector();
  strokeLine(c.plot, 7, 7, 7, 7, BOUNDS);
  assert.deepEqual(c.calls, [[7, 7]]);
});

test("strokeLine: off-screen endpoints are clipped, not walked", () => {
  const c = collector();
  strokeLine(c.plot, -1e9, 16, 1e9, 16, BOUNDS);
  // Bounded by the screen width, not by the coordinates.
  assert.equal(c.calls.length, BOUNDS.width);
  for (const [x, y] of c.calls) {
    assert.ok(x >= 0 && x < BOUNDS.width && y >= 0 && y < BOUNDS.height);
  }

  const miss = collector();
  strokeLine(miss.plot, -50, -50, -10, -10, BOUNDS);
  assert.equal(miss.calls.length, 0);
});

test("clipSegment: keeps inside segments, rejects outside ones", () => {
  assert.equal(clipSegment(100, 100, 200, 200, BOUNDS), null);
  const seg = clipSegment(4, 4, 8, 8, BOUNDS);
  assert.deepEqual(seg, { x1: 4, y1: 4, x2: 8, y2: 8 });
});

test("strokeCircle: pixels sit on the radius and are eight-way symmetric", () => {
  const c = collector();
  strokeCircle(c.plot, 16, 16, 6);
  assert.ok(c.set.size > 0);
  for (const key of c.set) {
    const [x, y] = key.split(",").map(Number);
    const d = Math.hypot(x - 16, y - 16);
    assert.ok(Math.abs(d - 6) <= 1, `pixel ${key} is ${d.toFixed(2)} from the centre`);
    // mirrored points must exist too
    assert.ok(c.set.has(`${32 - x},${y}`), `missing x-mirror of ${key}`);
    assert.ok(c.set.has(`${x},${32 - y}`), `missing y-mirror of ${key}`);
  }
});

test("strokeCircle: radius 0 is one pixel, negative draws nothing", () => {
  const zero = collector();
  strokeCircle(zero.plot, 3, 4, 0);
  assert.deepEqual(zero.calls, [[3, 4]]);

  const neg = collector();
  strokeCircle(neg.plot, 3, 4, -2);
  assert.equal(neg.calls.length, 0);
});

test("strokeCircle: an absurd radius is refused instead of looping", () => {
  const c = collector();
  strokeCircle(c.plot, 16, 16, 1e9);
  assert.equal(c.calls.length, 0);
});

test("fillCircle: solid disc, widest row through the centre", () => {
  const c = runCollector();
  fillCircle(c.fillRun, 16, 16, 3, BOUNDS);
  const rows = new Map();
  for (const [, y] of c.calls) rows.set(y, (rows.get(y) ?? 0) + 1);
  assert.equal(rows.get(16), 7);            // 2r + 1
  assert.equal(rows.get(13), 1);            // top of the disc
  assert.equal(rows.get(19), 1);            // bottom
  for (const [x, y] of c.calls) {
    assert.ok(Math.hypot(x - 16, y - 16) <= 3.5);
  }
});

test("fillCircle: rows outside the screen are skipped", () => {
  const c = runCollector();
  fillCircle(c.fillRun, 16, 0, 8, BOUNDS);
  for (const [, y] of c.calls) assert.ok(y >= 0 && y < BOUNDS.height);
});

test("fillTriangle: covers its interior and its vertices", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, 4, 4, 12, 4, 4, 12, BOUNDS);
  assert.ok(c.set.has("4,4"));
  assert.ok(c.set.has("12,4"));
  assert.ok(c.set.has("4,12"));
  assert.ok(c.set.has("5,5"));              // inside
  assert.ok(!c.set.has("12,12"));           // outside the hypotenuse
  // Right triangle with legs of 8: roughly half the 9x9 bounding box.
  assert.ok(c.set.size > 35 && c.set.size < 60, `unexpected coverage ${c.set.size}`);
});

test("fillTriangle: a degenerate triangle still draws its edge", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, 2, 6, 10, 6, 6, 6, BOUNDS);
  assert.equal(c.set.size, 9);              // x = 2..10 on one row
  for (const [, y] of c.calls) assert.equal(y, 6);
});

test("fillTriangle: huge coordinates are clamped to the screen", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, -1e6, -1e6, 1e6, -1e6, 0, 1e6, BOUNDS);
  for (const [, y] of c.calls) assert.ok(y >= 0 && y < BOUNDS.height);
  assert.ok(c.calls.length > 0);
});

test("strokeTriangle: draws the three edges, corners included", () => {
  const c = collector();
  strokeTriangle(c.plot, 2, 2, 10, 2, 2, 10, BOUNDS);
  assert.ok(c.set.has("2,2"));
  assert.ok(c.set.has("10,2"));
  assert.ok(c.set.has("2,10"));
  assert.ok(c.set.has("6,2"));              // along the top edge
  assert.ok(!c.set.has("5,5"));             // interior stays empty
});
