// media/raster.js — the integer-grid rasterisers that replace Canvas' anti-
// aliased path drawing.
//
// The reference is the game itself: test/ingame.test.mjs replays the in-game
// verification pages against screenshots. The tests here pin one rule each,
// so a regression names the rule it broke instead of just "page A4 differs",
// each tagged with the page that shows it. The rest check that every shape
// lands on whole pixels, stays inside the screen whatever the microcontroller
// passes, and never loops unboundedly on absurd input.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  strokeLine, strokeCircle, fillCircle, strokeTriangle, fillTriangle,
  strokeRectangle, fillRectangle, circleSides
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

/** Lit columns of one row, in plot order. */
const cols = (c, y) => c.calls.filter(([, py]) => py === y).map(([x]) => x);

// --- One rule per test ------------------------------------------------------

test("strokeLine: the end pixel is not drawn, whichever way the line runs", () => {
  const h = collector();
  strokeLine(h.plot, 2, 5, 6, 5, BOUNDS);
  assert.deepEqual(h.calls, [[2, 5], [3, 5], [4, 5], [5, 5]]);

  // Reversed, it starts at 6 and stops short of 2 — not the same pixels.
  const back = collector();
  strokeLine(back.plot, 6, 5, 2, 5, BOUNDS);
  assert.deepEqual(back.set, new Set(["3,5", "4,5", "5,5", "6,5"]));

  const v = collector();
  strokeLine(v.plot, 5, 2, 5, 5, BOUNDS);
  assert.deepEqual(v.calls, [[5, 2], [5, 3], [5, 4]]);

  const d = collector();
  strokeLine(d.plot, 0, 0, 4, 4, BOUNDS);
  assert.deepEqual(d.calls, [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test("strokeLine: a line lights a pixel once it leaves that pixel's diamond (A5)", () => {
  // Not a length threshold: 0.5px reaches the diamond's edge and lights one
  // pixel, 0.3px stays inside and lights none.
  const lengths = { 0: [], 0.3: [], 0.5: [12], 0.9: [12], 1: [12], 1.1: [12], 1.5: [12, 13], 2: [12, 13] };
  for (const [len, want] of Object.entries(lengths)) {
    const c = collector();
    strokeLine(c.plot, 12, 7, 12 + Number(len), 7, BOUNDS);
    assert.deepEqual(cols(c, 7), want, `length ${len}`);
  }
});

test("strokeLine: a half-integer rounds down the screen in y and left in x (A4)", () => {
  const rows = { 0: 10, 0.25: 10, 0.5: 11, 0.75: 11, [-0.25]: 10 };
  for (const [f, want] of Object.entries(rows)) {
    const c = collector();
    strokeLine(c.plot, 2, 10 + Number(f), 12, 10 + Number(f), BOUNDS);
    assert.ok(c.calls.length > 0 && c.calls.every(([, y]) => y === want), `y + ${f}`);
  }
  const columns = { 0: 10, 0.25: 10, 0.5: 10, 0.75: 11, [-0.25]: 10 };
  for (const [f, want] of Object.entries(columns)) {
    const c = collector();
    strokeLine(c.plot, 10 + Number(f), 2, 10 + Number(f), 12, BOUNDS);
    assert.ok(c.calls.length > 0 && c.calls.every(([x]) => x === want), `x + ${f}`);
  }
});

test("strokeLine: endpoints are snapped to 1/256px, so 1/1024 off a tie is the tie (D6)", () => {
  const e = 1 / 1024;
  for (const [a, b] of [[[10, 10.5, 14, 10.5], [10 + e, 10.5, 14 + e, 10.5]],
    [[10.5, 10, 10.5, 14], [10.5 + e, 10, 10.5 + e, 14]],
    [[10, 10, 10.5, 10], [10, 10, 10.5 - e, 10]]]) {
    const tie = collector(), near = collector();
    strokeLine(tie.plot, ...a, BOUNDS);
    strokeLine(near.plot, ...b, BOUNDS);
    assert.deepEqual(near.set, tie.set, `${b}`);
  }
});

test("strokeLine: the diamond owns some corners — top for x-major, top and right for y-major (D7)", () => {
  // Pixel (4,10)'s diamond has its top corner at (4, 9.5). A vertical line
  // leaving from there lights it; one leaving from the bottom corner doesn't.
  const up = collector();
  strokeLine(up.plot, 4, 9.5, 4, 5.5, BOUNDS);
  assert.ok(up.set.has("4,10"));
  const down = collector();
  strokeLine(down.plot, 4, 10.5, 4, 14.5, BOUNDS);
  assert.ok(!down.set.has("4,10"));
});

test("strokeLine: ending on a diamond's edge counts as leaving it (D4)", () => {
  // (12.25, 19.25) sits on the lower-right edge of pixel (12,19)'s diamond,
  // not on a corner: a line arriving there through the diamond lights it.
  const c = collector();
  strokeLine(c.plot, 11.5, 18.5, 12.25, 19.25, BOUNDS);
  assert.ok(c.set.has("12,19"));
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

test("circleSides: 8 up to r=17, one more per 2px, 16 from r=32 (C1-C8)", () => {
  const want = { 1: 8, 7: 8, 15.75: 8, 17: 8, 18: 9, 19: 9, 20: 10, 21: 10, 22: 11, 32: 16, 44: 16, 1e9: 16, [-19]: 9 };
  for (const [r, n] of Object.entries(want)) assert.equal(circleSides(Number(r)), n, `r=${r}`);
});

test("strokeCircle: a small circle is an octagon, and still draws (A3)", () => {
  // r=1: the octagon's edges are under a pixel each, and still light the
  // four-pixel diamond the game shows.
  const one = collector();
  strokeCircle(one.plot, 16, 16, 1, BOUNDS);
  assert.deepEqual(one.set, new Set(["16,15", "15,16", "17,16", "16,17"]));

  // Sixteen outline pixels at r=3, each lit once.
  const three = collector();
  strokeCircle(three.plot, 16, 16, 3, BOUNDS);
  assert.equal(three.calls.length, 16);
  assert.equal(three.set.size, 16);
});

test("circles: a negative radius draws the circle of its magnitude (E5-E7)", () => {
  // r=-22 is an 11-gon, so drawing it with vertices at -r would point it
  // left instead of right; the game draws it exactly like r=22.
  assert.equal(circleSides(-22), 11);
  const big = { width: 96, height: 96 };
  for (const r of [-22, -19, -3]) {
    const neg = collector(), pos = collector();
    strokeCircle(neg.plot, 48, 48, r, big);
    strokeCircle(pos.plot, 48, 48, -r, big);
    assert.deepEqual(neg.set, pos.set, `outline r=${r}`);
    const negF = runCollector(), posF = runCollector();
    fillCircle(negF.fillRun, 48, 48, r, big);
    fillCircle(posF.fillRun, 48, 48, -r, big);
    assert.deepEqual(negF.set, posF.set, `fill r=${r}`);
  }
});

test("strokeCircle: an absurd radius stays bounded", () => {
  const c = collector();
  strokeCircle(c.plot, 16, 16, 1e9, BOUNDS);
  // Every edge is off-screen, and the walk is capped by the screen either way.
  assert.ok(c.calls.length <= 16 * (BOUNDS.width + BOUNDS.height));
  for (const [x, y] of c.calls) {
    assert.ok(x < 0 || y < 0 || x >= BOUNDS.width || y >= BOUNDS.height);
  }
});

test("fillCircle: rows outside the screen are skipped", () => {
  const c = runCollector();
  fillCircle(c.fillRun, 16, 0, 8, BOUNDS);
  assert.ok(c.calls.length > 0);
  for (const [, y] of c.calls) assert.ok(y >= 0 && y < BOUNDS.height);
});

test("fillCircle: a horizontal edge on a sample row lights it at the bottom, not the top (F5, F6)", () => {
  // A 10-gon's edges between vertices 2-3 and 7-8 are horizontal. Put the
  // bottom one on row 44 and the top one on row 6: the game lights the whole
  // bottom edge (13 pixels) and none of the top one.
  const big = { width: 96, height: 96 };
  const s10 = Math.sin(0.4 * Math.PI);
  const bottom = runCollector();
  fillCircle(bottom.fillRun, 25, 44 - 20 * s10, 20, big);
  assert.deepEqual(cols(bottom, 44), Array.from({ length: 13 }, (_, i) => 19 + i));
  assert.deepEqual(cols(bottom, 45), []);
  const top = runCollector();
  fillCircle(top.fillRun, 70, 6 + 20 * s10, 20, big);
  assert.deepEqual(cols(top, 6), []);
  assert.equal(cols(top, 7).length > 13, true);
});

test("fillTriangle: samples the bottom-left corner, so the far edges come in (A6)", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, 4, 4, 12, 4, 4, 12, BOUNDS);
  // Exactly {x >= 4, y >= 4, x + y <= 14}: 7 rows, the top one 7 wide.
  let want = 0;
  for (let y = 4; y <= 10; y++) {
    assert.deepEqual(cols(c, y), Array.from({ length: 11 - y }, (_, i) => 4 + i), `row ${y}`);
    want += 11 - y;
  }
  assert.equal(c.set.size, want);
});

test("fillTriangle: a zero-area triangle covers nothing", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, 2, 6, 10, 6, 6, 6, BOUNDS);
  assert.equal(c.calls.length, 0);
});

test("fillTriangle: huge coordinates are clamped to the screen", () => {
  const c = runCollector();
  fillTriangle(c.fillRun, -1e6, -1e6, 1e6, -1e6, 0, 1e6, BOUNDS);
  assert.equal(c.calls.length, BOUNDS.width * BOUNDS.height);  // fills, doesn't hang
  for (const [, y] of c.calls) assert.ok(y >= 0 && y < BOUNDS.height);
});

test("strokeTriangle: draws the three edges, each corner once", () => {
  const c = collector();
  strokeTriangle(c.plot, 2, 2, 10, 2, 2, 10, BOUNDS);
  assert.ok(c.set.has("2,2") && c.set.has("10,2") && c.set.has("2,10"));
  assert.ok(c.set.has("6,2"));              // along the top edge
  assert.ok(!c.set.has("5,5"));             // interior stays empty
  assert.equal(c.calls.length, c.set.size); // no pixel twice
});

test("strokeRectangle: spans w+1 by h+1, and a zero width still draws (B5)", () => {
  const c = collector();
  strokeRectangle(c.plot, 2, 3, 5, 4, BOUNDS);
  assert.deepEqual(cols(c, 3), [2, 3, 4, 5, 6, 7].filter(x => c.set.has(`${x},3`)));
  assert.ok(c.set.has("2,3") && c.set.has("7,3") && c.set.has("7,7") && c.set.has("2,7"));
  assert.ok(!c.set.has("8,3") && !c.set.has("2,8"));
  assert.equal(c.set.size, 2 * (6 + 5) - 4);
  assert.equal(c.calls.length, c.set.size); // corners are not revisited

  // Zero width: the same line down and back up, rows 20..30.
  const z = collector();
  strokeRectangle(z.plot, 4, 20, 0, 10, { width: 32, height: 40 });
  assert.deepEqual([...z.set].map(k => Number(k.split(",")[1])).sort((a, b) => a - b),
    Array.from({ length: 11 }, (_, i) => 20 + i));
});

test("fillRectangle: rows floor(y)..floor(y+h)-1, like drawTriangleF (D7)", () => {
  for (const [y, h, want] of [[20, 6.5, [20, 25]], [20.25, 6.5, [20, 25]], [20.5, 6.5, [20, 26]],
    [20.75, 6.5, [20, 26]], [26, -6, [20, 25]]]) {
    const c = runCollector();
    fillRectangle(c.fillRun, 2, y, 3, h, { width: 32, height: 40 });
    const rows = [...new Set(c.calls.map(([, py]) => py))];
    assert.deepEqual([Math.min(...rows), Math.max(...rows)], want, `y=${y} h=${h}`);
  }
});

test("fillRectangle: columns ceil(x)..ceil(x+w)-1 (B6)", () => {
  const cases = [[20, 3, [20, 21, 22]], [20.25, 3, [21, 22, 23]], [20.5, 3.5, [21, 22, 23]],
    [19.5, 3, [20, 21, 22]], [-0.5, 4, [0, 1, 2, 3]], [7, 0.4, [7]], [7, 0, []], [23, -3, [20, 21, 22]]];
  for (const [x, w, want] of cases) {
    const c = runCollector();
    fillRectangle(c.fillRun, x, 5, w, 2, BOUNDS);
    assert.deepEqual(cols(c, 5), want, `x=${x} w=${w}`);
    assert.deepEqual(cols(c, 7), [], `x=${x} w=${w}: only rows 5..6`);
  }
});

test("every rasteriser plots whole pixels only", () => {
  const shapes = [
    c => strokeLine(c.plot, 1.4, 2.6, 27.2, 19.9, BOUNDS),
    c => strokeCircle(c.plot, 15.5, 16.25, 6.75, BOUNDS),
    c => fillCircle(c.fillRun, 15.5, 16.25, 5.5, BOUNDS),
    c => fillTriangle(c.fillRun, 3.5, 2.25, 20.75, 9.5, 8, 24.125, BOUNDS),
    c => strokeTriangle(c.plot, 2.5, 2.5, 10.25, 2.75, 2.5, 10.5, BOUNDS),
    c => strokeRectangle(c.plot, 2.25, 3.5, 10.75, 8.5, BOUNDS),
    c => fillRectangle(c.fillRun, 2.25, 3.5, 10.75, 8.5, BOUNDS)
  ];
  for (const shape of shapes) {
    const c = runCollector();
    shape(c);
    assert.ok(c.calls.length > 0);
    for (const [x, y] of c.calls) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `non-integer pixel ${x},${y}`);
    }
  }
});

test("absurd rectangles stay bounded", () => {
  const s = collector();
  strokeRectangle(s.plot, -1e9, -1e9, 2e9, 2e9, BOUNDS);
  // Every edge is off-screen; each still walks the screen along its major axis.
  assert.ok(s.calls.length <= 2 * (BOUNDS.width + BOUNDS.height));
  for (const [x, y] of s.calls) {
    assert.ok(x < 0 || y < 0 || x >= BOUNDS.width || y >= BOUNDS.height);
  }
  const f = runCollector();
  fillRectangle(f.fillRun, -1e9, -1e9, 2e9, 2e9, BOUNDS);
  assert.equal(f.calls.length, BOUNDS.width * BOUNDS.height);
});
