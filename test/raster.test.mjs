// media/raster.js — the integer-grid rasterisers that replace Canvas' anti-
// aliased path drawing.
//
// The reference is the game itself. test/fixtures/ingame-raster.json holds the
// lit pixels of Stormworks monitor screenshots (tools/ingame/, Apple M5 and
// RTX 4070Ti — identical to the pixel), and the first test replays the same
// draw calls through raster.js and demands an exact match. Regenerate it with
// tools/ingame/analysis/export-fixture.mjs; doc/ingame-findings.md explains
// the rules.
//
// The smaller tests below pin one rule each, so a regression names the rule
// it broke instead of just "page A4 differs". The rest check that every shape
// lands on whole pixels, stays inside the screen whatever the microcontroller
// passes, and never loops unboundedly on absurd input.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

// --- The game, page by page -------------------------------------------------

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/ingame-raster.json", import.meta.url), "utf8"));
const SCREEN = { width: 96, height: 96 };

/**
 * The draw calls of tools/ingame/verify{A,B,C}_*.lua, page by page. `p` plots
 * a pixel, `r` fills a run.
 * @type {Record<string, (p: (x: number, y: number) => void, r: (x: number, y: number, w: number) => void) => void>}
 */
const PAGES = {
  A1: (p) => strokeCircle(p, 48, 52, 22, SCREEN),
  A2: (p) => strokeCircle(p, 48.5, 52.5, 22, SCREEN),
  A3: (p, r) => {
    let x = 5;
    for (let rad = 1; rad <= 7; rad++) {
      strokeCircle(p, x, 20, rad, SCREEN);
      fillCircle(r, x, 44, rad, SCREEN);
      x += rad * 2 + 3;
    }
    [2.4, 2.5, 2.6, 2.7, 3].forEach((rad, i) => strokeCircle(p, (i + 1) * 14 - 4, 70, rad, SCREEN));
  },
  A4: (p) => {
    const f = [0, 0.25, 0.5, 0.75, -0.25];
    f.forEach((d, i) => { const b = (i + 1) * 16 - 8; strokeLine(p, b + d, 30, b + d, 56, SCREEN); });
    f.forEach((d, i) => { const b = (i + 1) * 6 + 54; strokeLine(p, 20, b + d, 60, b + d, SCREEN); });
  },
  A5: (p) => {
    [0, 0.3, 0.5, 0.7, 0.9, 1, 1.1, 1.5, 2].forEach((len, i) => {
      const y = (i + 1) * 6 + 10;
      strokeLine(p, 12, y, 12 + len, y, SCREEN);
    });
    [[0.8, 0.8], [0.6, 0.6], [0.9, 0.4], [1.2, 0], [0.7, 0.7]].forEach(([dx, dy], i) => {
      const y = (i + 1) * 8 + 16;
      strokeLine(p, 62, y, 62 + dx, y + dy, SCREEN);
    });
  },
  A6: (p, r) => {
    fillTriangle(r, 6.5, 12.25, 46.75, 26.5, 18, 60.125, SCREEN);
    strokeTriangle(p, 52, 12, 92, 26, 64, 60, SCREEN);
    fillTriangle(r, 50, 68, 70, 68, 50, 88, SCREEN);
    fillTriangle(r, 10.5, 68.5, 30.5, 68.5, 10.5, 88.5, SCREEN);
  },
  B5: (p) => {
    for (const [x, y, w, h] of [[6, 12, 40, 30], [56, 12, 1, 30], [62, 12, 30, 1], [62, 20, 0, 10],
      [62, 26, 1, 1], [6, 52, 20, 20], [40.5, 52.5, 20, 20], [70.25, 52, 20, 20]]) {
      strokeRectangle(p, x, y, w, h, SCREEN);
    }
  },
  B6: (_, r) => {
    [[20, 3], [20.5, 3], [20.5, 3.5], [20.25, 3], [20.75, 3], [19.5, 3]].forEach(([x, w], i) =>
      fillRectangle(r, x, (i + 1) * 13 + 2, w, 7, SCREEN));
    fillRectangle(r, -0.5, 86, 4, 7, SCREEN);
    fillRectangle(r, 60, 86, 0, 7, SCREEN);
    fillRectangle(r, 70, 86, 0.4, 7, SCREEN);
  },
};
/** The C card: one circle per quadrant. */
const quad = (radii, fill) => (p, r) => [[25, 25], [70, 25], [25, 70], [70, 70]].forEach(([x, y], i) =>
  fill ? fillCircle(r, x, y, radii[i], SCREEN) : strokeCircle(p, x, y, radii[i], SCREEN));
Object.assign(PAGES, {
  C1: quad([8, 9, 10, 11]), C2: quad([12, 13, 14, 15]), C3: quad([16, 17, 18, 19]),
  C4: quad([20, 21, 22, 22]),
  C7: (p) => strokeCircle(p, 48, 48, 32, SCREEN),
  C8: (p) => strokeCircle(p, 48, 48, 44, SCREEN),
  C9: quad([12, 13, 14, 15], true),
});

// The screenshot can't see under the ruler ticks or the page label.
const masked = (x, y) => x < 2 || y < 2 || y >= 94 || (x >= 3 && x <= 16 && y >= 3 && y <= 8);

for (const [page, runs] of Object.entries(fixture.pages)) {
  test(`in game: page ${page} matches the screenshot pixel for pixel`, () => {
    assert.ok(PAGES[page], `no draw calls for page ${page}`);
    const want = new Set();
    for (const [y, x0, x1] of runs) for (let x = x0; x <= x1; x++) want.add(`${x},${y}`);
    const got = new Set();
    const plot = (x, y) => {
      if (x >= 0 && y >= 0 && x < SCREEN.width && y < SCREEN.height && !masked(x, y)) got.add(`${x},${y}`);
    };
    PAGES[page](plot, (x, y, w) => { for (let i = 0; i < w; i++) plot(x + i, y); });
    const missing = [...want].filter(k => !got.has(k));
    const extra = [...got].filter(k => !want.has(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });
}

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
  const want = { 1: 8, 7: 8, 15.75: 8, 17: 8, 18: 9, 19: 9, 20: 10, 21: 10, 22: 11, 32: 16, 44: 16, 1e9: 16 };
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
