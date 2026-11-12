// src/agent/pixels.ts: the numeric questions an agent asks about a monitor
// frame. Every colour is the visible one (rgb × alpha / 255 over black).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  visibleColor, clipRect, regionStats, diffPictures, checkExpectations, textGrid, parseRgb,
  MAX_COLORS, MAX_EXAMPLES, MAX_GRID_CELLS, MAX_CHECKS
} = require("../out/agent/pixels.js");

/** A transparent-black picture; `set` paints one pixel (alpha defaults to 255). */
function picture(width, height) {
  const p = { width, height, pixels: new Uint8Array(width * height * 4) };
  p.set = (x, y, [r, g, b], a = 255) => {
    const i = (y * width + x) * 4;
    p.pixels[i] = r; p.pixels[i + 1] = g; p.pixels[i + 2] = b; p.pixels[i + 3] = a;
    return p;
  };
  p.fill = (x0, y0, w, h, c, a = 255) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p.set(x, y, c, a);
    return p;
  };
  return p;
}

const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], WHITE = [255, 255, 255];

// --- constants ------------------------------------------------------------------

test("the limits are the documented ones", () => {
  assert.equal(MAX_COLORS, 16);
  assert.equal(MAX_EXAMPLES, 20);
  assert.equal(MAX_GRID_CELLS, 4096);
  assert.equal(MAX_CHECKS, 64);
});

// --- visibleColor ---------------------------------------------------------------

test("visibleColor: opaque pixels are their own colour", () => {
  const p = picture(2, 1).set(1, 0, [12, 34, 56]);
  assert.deepEqual(visibleColor(p, 1, 0), [12, 34, 56]);
  assert.deepEqual(visibleColor(p, 0, 0), [0, 0, 0]);
});

test("visibleColor: composites over black, rgb × alpha / 255 rounded", () => {
  const p = picture(1, 1).set(0, 0, [255, 100, 3], 128);
  assert.deepEqual(visibleColor(p, 0, 0), [128, 50, 2]);   // 128, 50.196, 1.506
  p.set(0, 0, [200, 1, 255], 1);
  assert.deepEqual(visibleColor(p, 0, 0), [1, 0, 1]);      // 0.784, 0.0039, 1
});

test("visibleColor: alpha 0 is black whatever the rgb", () => {
  const p = picture(1, 1).set(0, 0, WHITE, 0);
  assert.deepEqual(visibleColor(p, 0, 0), [0, 0, 0]);
});

test("visibleColor reads row order: index (y * width + x) * 4", () => {
  const p = picture(3, 2).set(2, 0, RED).set(0, 1, GREEN);
  assert.deepEqual(visibleColor(p, 2, 0), RED);
  assert.deepEqual(visibleColor(p, 0, 1), GREEN);
  assert.deepEqual(visibleColor(p, 1, 1), [0, 0, 0]);
});

// --- clipRect -------------------------------------------------------------------

test("clipRect: no rectangle is the whole picture", () => {
  const p = picture(10, 6);
  assert.deepEqual(clipRect(p), { x: 0, y: 0, width: 10, height: 6 });
  assert.deepEqual(clipRect(p, {}), { x: 0, y: 0, width: 10, height: 6 });
});

test("clipRect: omitted width/height run to the edge", () => {
  const p = picture(10, 6);
  assert.deepEqual(clipRect(p, { x: 3 }), { x: 3, y: 0, width: 7, height: 6 });
  assert.deepEqual(clipRect(p, { y: 4 }), { x: 0, y: 4, width: 10, height: 2 });
  assert.deepEqual(clipRect(p, { x: 2, y: 1, width: 3 }), { x: 2, y: 1, width: 3, height: 5 });
});

test("clipRect: a rectangle inside is returned as is", () => {
  assert.deepEqual(clipRect(picture(10, 6), { x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
});

test("clipRect: partially outside is clipped on every side", () => {
  const p = picture(10, 6);
  assert.deepEqual(clipRect(p, { x: -2, y: -1, width: 5, height: 3 }), { x: 0, y: 0, width: 3, height: 2 });
  assert.deepEqual(clipRect(p, { x: 8, y: 4, width: 10, height: 10 }), { x: 8, y: 4, width: 2, height: 2 });
  assert.deepEqual(clipRect(p, { x: -5, y: -5, width: 100, height: 100 }), { x: 0, y: 0, width: 10, height: 6 });
  assert.deepEqual(clipRect(p, { x: -3 }), { x: 0, y: 0, width: 10, height: 6 });
});

test("clipRect: fractional coordinates are rounded", () => {
  assert.deepEqual(clipRect(picture(10, 6), { x: 1.4, y: 1.6, width: 2.5, height: 1.2 }), { x: 1, y: 2, width: 3, height: 1 });
});

test("clipRect: entirely outside throws", () => {
  const p = picture(10, 6);
  assert.throws(() => clipRect(p, { x: 10, y: 0, width: 2, height: 2 }), /outside the 10x6 monitor/);
  assert.throws(() => clipRect(p, { x: 0, y: 6, width: 2, height: 2 }), /outside/);
  assert.throws(() => clipRect(p, { x: -5, y: 0, width: 5, height: 2 }), /outside/);
  assert.throws(() => clipRect(p, { x: 0, y: -3, width: 2, height: 3 }), /outside/);
  // A start past the edge with the width left out is still "outside", not "empty".
  assert.throws(() => clipRect(p, { x: 12 }), /outside the 10x6 monitor/);
});

test("clipRect: an empty or negative rectangle throws", () => {
  const p = picture(10, 6);
  assert.throws(() => clipRect(p, { x: 0, y: 0, width: 0, height: 2 }), /empty/);
  assert.throws(() => clipRect(p, { x: 0, y: 0, width: 2, height: 0 }), /empty/);
  assert.throws(() => clipRect(p, { x: 0, y: 0, width: -1, height: 2 }), /empty/);
});

test("clipRect: a non-number field throws, naming it", () => {
  const p = picture(10, 6);
  assert.throws(() => clipRect(p, { x: NaN }), /x must be a number/);
  assert.throws(() => clipRect(p, { y: Infinity }), /y must be a number/);
  assert.throws(() => clipRect(p, { width: "3" }), /width must be a number/);
  assert.throws(() => clipRect(p, { height: null }), /height must be a number/);
});

// --- regionStats ----------------------------------------------------------------

test("regionStats: a black picture has nothing lit", () => {
  const s = regionStats(picture(4, 3));
  assert.deepEqual(s, { rect: { x: 0, y: 0, width: 4, height: 3 }, pixels: 12, lit: 0, litBounds: null, colors: [], moreColors: 0 });
});

test("regionStats: counts, bounds and colours, most pixels first", () => {
  const p = picture(10, 8)
    .fill(1, 1, 3, 2, RED)      // 6 red, x 1..3 y 1..2
    .fill(6, 5, 2, 2, GREEN)    // 4 green, x 6..7 y 5..6
    .set(9, 0, BLUE);           // 1 blue
  const s = regionStats(p);
  assert.equal(s.pixels, 80);
  assert.equal(s.lit, 11);
  assert.deepEqual(s.litBounds, { left: 1, top: 0, right: 9, bottom: 6 });
  assert.deepEqual(s.colors, [
    { color: RED, pixels: 6, bounds: { left: 1, top: 1, right: 3, bottom: 2 } },
    { color: GREEN, pixels: 4, bounds: { left: 6, top: 5, right: 7, bottom: 6 } },
    { color: BLUE, pixels: 1, bounds: { left: 9, top: 0, right: 9, bottom: 0 } }
  ]);
  assert.equal(s.moreColors, 0);
});

test("regionStats: ties are ordered by colour value (r, then g, then b)", () => {
  const p = picture(4, 1).set(0, 0, RED).set(1, 0, BLUE).set(2, 0, GREEN).set(3, 0, [0, 0, 1]);
  assert.deepEqual(regionStats(p).colors.map(c => c.color), [[0, 0, 1], BLUE, GREEN, RED]);
});

test("regionStats: colours are visible colours, and alpha 0 is unlit", () => {
  const p = picture(3, 1).set(0, 0, [255, 0, 0], 128).set(1, 0, [128, 0, 0]).set(2, 0, WHITE, 0);
  const s = regionStats(p);
  assert.equal(s.lit, 2);
  assert.deepEqual(s.colors, [{ color: [128, 0, 0], pixels: 2, bounds: { left: 0, top: 0, right: 1, bottom: 0 } }]);
  assert.deepEqual(s.litBounds, { left: 0, top: 0, right: 1, bottom: 0 });
});

test("regionStats: a dim pixel that rounds to black is unlit", () => {
  const p = picture(1, 1).set(0, 0, [1, 1, 1], 100);   // 0.39 → 0
  assert.equal(regionStats(p).lit, 0);
});

test("regionStats: a rectangle restricts the count and is reported clipped", () => {
  const p = picture(10, 8).fill(0, 0, 10, 8, RED);
  const s = regionStats(p, { x: 8, y: 6, width: 5, height: 5 });
  assert.deepEqual(s.rect, { x: 8, y: 6, width: 2, height: 2 });
  assert.equal(s.pixels, 4);
  assert.equal(s.lit, 4);
  assert.deepEqual(s.litBounds, { left: 8, top: 6, right: 9, bottom: 7 });
});

test("regionStats: more colours than MAX_COLORS are counted in moreColors", () => {
  const n = MAX_COLORS + 5;
  const p = picture(n, 1);
  for (let x = 0; x < n; x++) p.set(x, 0, [x + 1, 0, 0]);
  p.set(n - 1, 0, [n, 0, 0]);
  const s = regionStats(p);
  assert.equal(s.lit, n);
  assert.equal(s.colors.length, MAX_COLORS);
  assert.equal(s.moreColors, 5);
  // All tie at one pixel, so the lowest colour values are the ones listed.
  assert.deepEqual(s.colors.map(c => c.color[0]), Array.from({ length: MAX_COLORS }, (_, i) => i + 1));
});

test("regionStats: a frequent colour is listed even when it has the highest value", () => {
  const n = MAX_COLORS + 3;
  const p = picture(n + 4, 1);
  for (let x = 0; x < n; x++) p.set(x, 0, [x + 1, 0, 0]);
  p.fill(n, 0, 4, 1, WHITE);
  const s = regionStats(p);
  assert.deepEqual(s.colors[0], { color: WHITE, pixels: 4, bounds: { left: n, top: 0, right: n + 3, bottom: 0 } });
  assert.equal(s.colors.length, MAX_COLORS);
  assert.equal(s.moreColors, n + 1 - MAX_COLORS);
});

// --- diffPictures ---------------------------------------------------------------

test("diffPictures: pictures of different sizes are not comparable", () => {
  const d = diffPictures(picture(4, 3), picture(3, 4));
  assert.deepEqual(d, { comparable: false, before: { width: 4, height: 3 }, after: { width: 3, height: 4 } });
});

test("diffPictures: identical pictures have no changes", () => {
  const a = picture(4, 3).set(1, 1, RED), b = picture(4, 3).set(1, 1, RED);
  const d = diffPictures(a, b);
  assert.equal(d.comparable, true);
  assert.deepEqual(d.rect, { x: 0, y: 0, width: 4, height: 3 });
  assert.equal(d.pixels, 12);
  assert.equal(d.changed, 0);
  assert.equal(d.changedBounds, null);
  assert.deepEqual([d.appeared, d.disappeared, d.recolored], [0, 0, 0]);
  assert.deepEqual(d.examples, []);
});

test("diffPictures: appeared, disappeared and recolored are told apart", () => {
  const before = picture(6, 4).set(0, 0, RED).set(1, 1, GREEN).set(5, 3, BLUE);
  const after = picture(6, 4).set(0, 0, RED).set(1, 1, BLUE).set(3, 2, WHITE).set(4, 2, WHITE);
  const d = diffPictures(before, after);
  assert.equal(d.changed, 4);
  assert.equal(d.appeared, 2);       // (3,2), (4,2)
  assert.equal(d.disappeared, 1);    // (5,3)
  assert.equal(d.recolored, 1);      // (1,1)
  assert.deepEqual(d.changedBounds, { left: 1, top: 1, right: 5, bottom: 3 });
  assert.deepEqual(d.examples, [
    { x: 1, y: 1, before: GREEN, after: BLUE },
    { x: 3, y: 2, before: [0, 0, 0], after: WHITE },
    { x: 4, y: 2, before: [0, 0, 0], after: WHITE },
    { x: 5, y: 3, before: BLUE, after: [0, 0, 0] }
  ]);
});

test("diffPictures compares visible colours, not raw RGBA", () => {
  // Different raw bytes, same visible colour: no change.
  const a = picture(2, 1).set(0, 0, WHITE, 0).set(1, 0, [255, 0, 0], 128);
  const b = picture(2, 1).set(0, 0, RED, 0).set(1, 0, [128, 0, 0]);
  assert.equal(diffPictures(a, b).changed, 0);
});

test("diffPictures: examples are capped at MAX_EXAMPLES, in row order, but counts are exact", () => {
  const before = picture(10, 10), after = picture(10, 10).fill(0, 0, 10, 10, RED);
  const d = diffPictures(before, after);
  assert.equal(d.changed, 100);
  assert.equal(d.appeared, 100);
  assert.equal(d.examples.length, MAX_EXAMPLES);
  assert.deepEqual(d.examples.map(e => [e.x, e.y]), Array.from({ length: MAX_EXAMPLES }, (_, i) => [i % 10, Math.floor(i / 10)]));
});

test("diffPictures: a rectangle restricts the comparison", () => {
  const before = picture(8, 8);
  const after = picture(8, 8).set(0, 0, RED).set(5, 5, GREEN).set(7, 7, BLUE);
  const d = diffPictures(before, after, { x: 4, y: 4, width: 10, height: 10 });
  assert.deepEqual(d.rect, { x: 4, y: 4, width: 4, height: 4 });
  assert.equal(d.pixels, 16);
  assert.equal(d.changed, 2);
  assert.deepEqual(d.changedBounds, { left: 5, top: 5, right: 7, bottom: 7 });
  assert.throws(() => diffPictures(before, after, { x: 20, y: 0, width: 1, height: 1 }), /outside/);
});

// --- checkExpectations ----------------------------------------------------------

/** 6x4 with a 2x2 red square at (1,1) and one green pixel at (5,3). */
function scene() {
  return picture(6, 4).fill(1, 1, 2, 2, RED).set(5, 3, GREEN);
}
const one = (p, check) => checkExpectations(p, [check])[0];

test("empty: passes on black, fails on lit pixels and lists them", () => {
  const p = scene();
  const ok = one(p, { expect: "empty", rect: { x: 3, y: 0, width: 2, height: 4 }, label: "gap" });
  assert.deepEqual(ok, {
    label: "gap", expect: "empty", rect: { x: 3, y: 0, width: 2, height: 4 },
    pass: true, matching: 8, pixels: 8, offending: [], offendingCount: 0
  });
  const bad = one(p, { expect: "empty" });
  assert.equal(bad.pass, false);
  assert.equal(bad.matching, 24 - 5);
  assert.equal(bad.offendingCount, 5);
  assert.deepEqual(bad.offending, [
    { x: 1, y: 1, color: RED }, { x: 2, y: 1, color: RED },
    { x: 1, y: 2, color: RED }, { x: 2, y: 2, color: RED },
    { x: 5, y: 3, color: GREEN }
  ]);
});

test("empty: an alpha-0 pixel counts as empty", () => {
  const p = picture(2, 2).set(0, 0, WHITE, 0);
  assert.equal(one(p, { expect: "empty" }).pass, true);
});

test("filled without colour: every pixel lit, any colour", () => {
  const p = scene().set(3, 1, BLUE);
  assert.equal(one(p, { expect: "filled", rect: { x: 1, y: 1, width: 2, height: 2 } }).pass, true);
  const r = one(p, { expect: "filled", rect: { x: 1, y: 1, width: 3, height: 2 } });
  assert.equal(r.pass, false);
  assert.equal(r.matching, 5);
  assert.deepEqual(r.offending, [{ x: 3, y: 2, color: [0, 0, 0] }]);
  assert.equal(r.offendingCount, 1);
});

test("filled with colour: every pixel that colour", () => {
  const p = scene();
  assert.equal(one(p, { expect: "filled", color: RED, rect: { x: 1, y: 1, width: 2, height: 2 } }).pass, true);
  const r = one(p, { expect: "filled", color: GREEN, rect: { x: 1, y: 1, width: 2, height: 2 } });
  assert.equal(r.pass, false);
  assert.equal(r.offendingCount, 4);
  assert.equal(r.matching, 0);
});

test("filled with colour and tolerance: each channel within the tolerance", () => {
  const p = picture(3, 1).set(0, 0, [250, 5, 0]).set(1, 0, [255, 0, 3]).set(2, 0, [245, 0, 0]);
  assert.equal(one(p, { expect: "filled", color: RED, tolerance: 10 }).pass, true);
  const r = one(p, { expect: "filled", color: RED, tolerance: 5 });
  assert.equal(r.pass, false);
  assert.deepEqual(r.offending, [{ x: 2, y: 0, color: [245, 0, 0] }]);
  assert.equal(one(p, { expect: "filled", color: RED }).offendingCount, 3, "default tolerance is 0");
});

test("tolerance applies to the visible colour, not the raw one", () => {
  const p = picture(1, 1).set(0, 0, RED, 128);   // visible [128, 0, 0]
  assert.equal(one(p, { expect: "filled", color: RED, tolerance: 100 }).pass, false);
  assert.equal(one(p, { expect: "filled", color: [128, 0, 0] }).pass, true);
});

test("some without colour: at least one lit pixel; never lists offenders", () => {
  const p = scene();
  const r = one(p, { expect: "some" });
  assert.equal(r.pass, true);
  assert.equal(r.matching, 5);
  assert.deepEqual(r.offending, []);
  assert.equal(r.offendingCount, 0);
  const none = one(p, { expect: "some", rect: { x: 3, y: 0, width: 2, height: 3 } });
  assert.equal(none.pass, false);
  assert.equal(none.matching, 0);
  assert.deepEqual(none.offending, []);
  assert.equal(none.offendingCount, 0);
});

test("some with colour (and tolerance): at least one pixel of that colour", () => {
  const p = scene();
  assert.equal(one(p, { expect: "some", color: GREEN }).pass, true);
  assert.equal(one(p, { expect: "some", color: GREEN }).matching, 1);
  assert.equal(one(p, { expect: "some", color: BLUE }).pass, false);
  assert.equal(one(p, { expect: "some", color: [10, 245, 0] }).pass, false);
  assert.equal(one(p, { expect: "some", color: [10, 245, 0], tolerance: 10 }).pass, true);
});

test("only: every lit pixel is the colour, unlit pixels are fine", () => {
  const p = scene();
  const ok = one(p, { expect: "only", color: RED, rect: { x: 0, y: 0, width: 4, height: 4 } });
  assert.equal(ok.pass, true);
  assert.equal(ok.matching, 16);
  const bad = one(p, { expect: "only", color: RED });
  assert.equal(bad.pass, false);
  assert.equal(bad.matching, 23);
  assert.deepEqual(bad.offending, [{ x: 5, y: 3, color: GREEN }]);
  assert.equal(bad.offendingCount, 1);
  assert.equal(one(p, { expect: "only", color: [200, 0, 0], tolerance: 55 }).offendingCount, 1);
  assert.equal(one(p, { expect: "only", color: [200, 0, 0], tolerance: 54 }).offendingCount, 5);
});

test("only on an all-black area passes", () => {
  assert.equal(one(picture(3, 3), { expect: "only", color: BLUE }).pass, true);
});

test("offending pixels are capped at MAX_EXAMPLES in row order; offendingCount is exact", () => {
  const p = picture(10, 10).fill(0, 0, 10, 10, WHITE);
  const r = one(p, { expect: "empty" });
  assert.equal(r.offendingCount, 100);
  assert.equal(r.offending.length, MAX_EXAMPLES);
  assert.deepEqual(r.offending.map(o => [o.x, o.y]), Array.from({ length: MAX_EXAMPLES }, (_, i) => [i % 10, Math.floor(i / 10)]));
});

test("several checks are answered in order, labels echoed", () => {
  const p = scene();
  const rs = checkExpectations(p, [
    { label: "a", expect: "some" },
    { expect: "empty", rect: { x: 0, y: 0, width: 1, height: 1 } },
    { label: "c", expect: "only", color: GREEN }
  ]);
  assert.deepEqual(rs.map(r => [r.label, r.expect, r.pass]), [["a", "some", true], [undefined, "empty", true], ["c", "only", false]]);
  assert.deepEqual(checkExpectations(p, []), []);
});

test("checkExpectations: error cases", () => {
  const p = scene();
  assert.throws(() => checkExpectations(p, [{ expect: "only" }]), /"only" needs a color/);
  assert.throws(() => checkExpectations(p, [{ expect: "empty", color: RED }]), /"empty" takes no color/);
  assert.throws(() => checkExpectations(p, [{ expect: "some", tolerance: -1 }]), /tolerance must be 0 or more/);
  assert.throws(() => checkExpectations(p, [{ expect: "some", tolerance: NaN }]), /tolerance/);
  assert.throws(() => checkExpectations(p, [{ expect: "some", rect: { x: 99 } }]), /empty|outside/);
  const many = Array.from({ length: MAX_CHECKS + 1 }, () => ({ expect: "some" }));
  assert.throws(() => checkExpectations(p, many), new RegExp(`at most ${MAX_CHECKS} checks`));
  assert.equal(checkExpectations(p, many.slice(1)).length, MAX_CHECKS, "exactly MAX_CHECKS is allowed");
});

// --- parseRgb -------------------------------------------------------------------

test("parseRgb accepts three whole numbers 0..255", () => {
  assert.deepEqual(parseRgb([0, 128, 255], "color"), [0, 128, 255]);
  const v = [1, 2, 3];
  assert.notEqual(parseRgb(v, "c"), v, "a fresh array");
});

test("parseRgb rejects anything else, naming the field", () => {
  for (const bad of [undefined, null, "red", 0xff0000, [1, 2], [1, 2, 3, 4], [1.5, 2, 3], [-1, 0, 0], [0, 256, 0], [0, 0, NaN], ["1", 2, 3], {}]) {
    assert.throws(() => parseRgb(bad, "fillColor"), /fillColor must be \[r, g, b\]/, JSON.stringify(bad));
  }
});

// --- textGrid -------------------------------------------------------------------

test("textGrid: # lit, . unlit, one row per pixel row", () => {
  const p = picture(5, 3).set(0, 0, RED).fill(2, 1, 2, 1, GREEN).set(4, 2, WHITE).set(1, 2, WHITE, 0);
  const g = textGrid(p);
  assert.deepEqual(g.rect, { x: 0, y: 0, width: 5, height: 3 });
  assert.deepEqual(g.rows, ["#....", "..##.", "....#"]);
  assert.equal(g.legend, undefined);
});

test("textGrid: a rectangle picks the area, clipped", () => {
  const p = picture(5, 3).set(0, 0, RED).fill(2, 1, 2, 1, GREEN).set(4, 2, WHITE);
  const g = textGrid(p, { x: 2, y: 1, width: 10, height: 10 });
  assert.deepEqual(g.rect, { x: 2, y: 1, width: 3, height: 2 });
  assert.deepEqual(g.rows, ["##.", "..#"]);
});

test("textGrid byColor: a letter per colour, most pixels first, with a legend", () => {
  const p = picture(5, 2).fill(0, 0, 3, 1, BLUE).fill(3, 0, 2, 1, RED).set(0, 1, GREEN);
  const g = textGrid(p, undefined, true);
  assert.deepEqual(g.rows, ["AAABB", "C...."]);
  assert.deepEqual(g.legend, { A: BLUE, B: RED, C: GREEN });
  assert.deepEqual(Object.keys(g.legend), ["A", "B", "C"]);
});

test("textGrid byColor: letters count only the colours inside the rectangle", () => {
  const p = picture(6, 1).fill(0, 0, 4, 1, RED).fill(4, 0, 2, 1, GREEN);
  const g = textGrid(p, { x: 3, y: 0 }, true);
  assert.deepEqual(g.rows, ["BAA"]);   // inside: 2 green, 1 red
  assert.deepEqual(g.legend, { A: GREEN, B: RED });
});

test("textGrid byColor on a black area has an empty legend", () => {
  const g = textGrid(picture(2, 2), undefined, true);
  assert.deepEqual(g.rows, ["..", ".."]);
  assert.deepEqual(g.legend, {});
});

test("textGrid: up to MAX_GRID_CELLS pixels in any shape, more throws", () => {
  const p = picture(128, 64);
  assert.equal(textGrid(p, { x: 0, y: 0, width: 64, height: 64 }).rows.length, 64);
  const wide = textGrid(p, { x: 0, y: 0, width: 128, height: 32 });
  assert.equal(wide.rows.length, 32);
  assert.ok(wide.rows.every(r => r.length === 128));
  assert.throws(() => textGrid(p), /at most 4096 pixels/);
  assert.throws(() => textGrid(p, { x: 0, y: 0, width: 65, height: 64 }), /65x64 is 4160/);
});

test("textGrid byColor: all 26 letters are used before falling back to #", () => {
  // 28 colours, each with a distinct pixel count so the ranking is unambiguous.
  // More than MAX_COLORS of them: the letters do not stop where regionStats' list does.
  assert.ok(MAX_COLORS < 26);
  const p = picture(28, 28);
  for (let c = 0; c < 28; c++) for (let y = 0; y < 28 - c; y++) p.set(c, y, [10 + c * 8, 255 - c * 8, c]);
  const g = textGrid(p, { x: 0, y: 0, width: 28, height: 1 }, true);
  assert.equal(g.rows[0], "ABCDEFGHIJKLMNOPQRSTUVWXYZ##");
  assert.equal(Object.keys(g.legend).length, 26);
  assert.deepEqual(g.legend.Q, [10 + 16 * 8, 255 - 16 * 8, 16], "the 17th colour has a letter and a legend entry");
});
