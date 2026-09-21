// Integer-grid rasterisers for the microcontroller monitors.
//
// Canvas path drawing anti-aliases: a diagonal LINE, a CIRCLE or a TRIANGLE
// comes out as a spray of partial-intensity pixels, and the integer CSS upscale
// then magnifies that haze into visible blocks. Stormworks monitors have no
// anti-aliasing — a pixel is lit or it isn't — so those shapes are rasterised
// here by hand and painted as 1x1 fills / horizontal runs instead.
//
// The rules are fitted to screenshots of the real game (Stormworks v1.15.23,
// Apple M5 and RTX 4070Ti give identical pixels) — see doc/ingame-findings.md.
// They are GPU rasterisation rules, and three of them look like bugs:
//
// - A line is drawn with the diamond-exit rule on a half-open diamond (edges
//   outside, only some corners inside), after snapping to 1/256px. Its end
//   pixel is not lit, a 0.5px line lights one pixel and a 0.3px one none,
//   and which pixel a half-integer coordinate lands on depends on the axis.
// - A circle is an N-gon with N = clamp(floor(r/2), 8, 16). Small circles are
//   octagons, which is why r=3 happens to look like a midpoint circle.
// - drawTriangleF and drawRectF sample each pixel at its bottom-left corner,
//   drawCircleF at its top-left one — so a triangle and the same shape as a
//   circle don't cover the same bottom row.
//
// test/ingame.test.mjs replays the verification cards against screenshots;
// every rule here is pinned there, pixel for pixel.
//
// Pure module: the drawing target is a callback, so test/raster.test.mjs can
// exercise these without a canvas. Everything is snapped to whole pixels, and
// every loop is bounded by the screen size — a microcontroller is free to pass
// ±1e9 coordinates and must not be able to hang the panel.

/** Plot one pixel. Coordinates are always integers. @typedef {(x: number, y: number) => void} Plot */
/** Fill `w` pixels starting at (x, y). @typedef {(x: number, y: number, w: number) => void} FillRun */

/**
 * Screen extent in logical (Stormworks) pixels.
 * @typedef {object} Bounds
 * @property {number} width
 * @property {number} height
 */

/**
 * The GPU's vertex snap: 8 bits of sub-pixel precision. Lines whose endpoints
 * sit 1/1024px off a tie draw as the tie does (D6 in doc/ingame-findings.md).
 * The game's half-pixel offset is a whole number of 1/256ths, so snapping
 * script coordinates gives the same grid.
 * @param {number} v
 */
function snap(v) {
  return Math.round(v * 256) / 256;
}

/** @param {...number} v */
function finite(...v) {
  return v.every(Number.isFinite);
}

/**
 * Emit one horizontal run [x0, x1), clipped to the screen. Runs are clipped
 * here rather than in the caller so a shape spanning ±1e6 costs the screen
 * width, not the coordinate range.
 * @param {FillRun} fillRun
 * @param {number} x0 @param {number} x1 @param {number} y
 * @param {Bounds} bounds
 */
function emitRun(fillRun, x0, x1, y, bounds) {
  if (y < 0 || y >= bounds.height) return;
  const from = Math.max(0, x0);
  const to = Math.min(bounds.width, x1);
  if (to > from) fillRun(from, y, to - from);
}

// --- Lines -----------------------------------------------------------------
//
// Worked on an integer grid of 1/256px (after the GPU's snap), so every
// comparison below is exact. Pixel (px, py) owns the diamond around the
// integer point (px, py) of script coordinates — the game's half-pixel offset
// puts pixel centres there.

/** Units per pixel, and half a pixel, on the snapped grid. */
const SUB = 256, HALF = 128;
/** Beyond this many pixels an endpoint is clipped first, to keep products exact. */
const EXACT_LIMIT = 65536;

/**
 * Corners of a diamond that belong to it, as [dx, dy] from its centre in
 * 1/256 units (y grows down the screen). Edges never do. Fitted to the game:
 * an x-major line owns only the top corner, a y-major one the right and top
 * corners (45° counts as x-major).
 */
const X_MAJOR_CORNERS = [[0, -HALF]];
const Y_MAJOR_CORNERS = [[HALF, 0], [0, -HALF]];

/**
 * Does the segment meet the open diamond |x−cx| + |y−cy| < HALF? Solved as
 * the t-interval inside all four half-planes, compared as exact fractions.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} cx @param {number} cy
 */
function meetsInterior(x1, y1, x2, y2, cx, cy) {
  const dx = x2 - x1, dy = y2 - y1;
  // t in [lo, hi], each a fraction n/d with d > 0; `open` once a bound is strict
  let loN = 0, loD = 1, hiN = 1, hiD = 1, loOpen = false, hiOpen = false;
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = sx * (x1 - cx) + sy * (y1 - cy), b = sx * dx + sy * dy;   // a + b·t < HALF
    if (b === 0) {
      if (a >= HALF) return false;
      continue;
    }
    const n = b > 0 ? HALF - a : a - HALF, d = Math.abs(b);
    if (b > 0) {
      if (n * hiD <= hiN * d) { hiN = n; hiD = d; hiOpen = true; }
    } else if (n * loD >= loN * d) { loN = n; loD = d; loOpen = true; }
  }
  const order = loN * hiD - hiN * loD;
  return order < 0 || (order === 0 && !loOpen && !hiOpen);
}

/**
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} px @param {number} py
 */
function onSegment(x1, y1, x2, y2, px, py) {
  return (x2 - x1) * (py - y1) === (y2 - y1) * (px - x1) &&
    Math.min(x1, x2) <= px && px <= Math.max(x1, x2) &&
    Math.min(y1, y2) <= py && py <= Math.max(y1, y2);
}

/**
 * Clip a segment to a box, returning null when nothing is left. Only used to
 * bring ±1e9 endpoints close enough for the exact arithmetic; the box is far
 * enough outside the screen that no on-screen diamond can tell.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} lo @param {number} hiX @param {number} hiY
 * @returns {[number, number, number, number] | null}
 */
function clipSegment(x1, y1, x2, y2, lo, hiX, hiY) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - lo], [dx, hiX - x1], [-dy, y1 - lo], [dy, hiY - y1]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [x1 + dx * t0, y1 + dy * t0, x1 + dx * t1, y1 + dy * t1];
}

/** Floor division of integers held in doubles, exact. @param {number} n @param {number} d d > 0 */
function floorDiv(n, d) {
  const r = ((n % d) + d) % d;
  return (n - r) / d;
}

/**
 * Diamond-exit line. A pixel is lit when the segment meets its diamond and
 * does not end inside it — so the pixel the line ends in is never lit, a
 * 0.5px line lights one pixel (it ends on the diamond's corner, which an
 * x-major line's diamond doesn't own) and a 0.3px one none.
 *
 * The diamond is half-open (see X_MAJOR_CORNERS): its edges are outside, and
 * only some corners are inside. That one rule is why a half-integer y lands
 * on the lower row but a half-integer x on the left column, and why a circle
 * vertex snapped onto a diamond's edge still lights that pixel (D4, D7 in
 * doc/ingame-findings.md). Endpoints are snapped to 1/256px first, as the GPU
 * does (D6).
 *
 * Only the major axis is walked, over the screen: with |slope| <= 1 the line
 * can only touch one diamond per step, and `plot` drops whatever lands
 * off-screen on the minor axis.
 * @param {Plot} plot
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Bounds} bounds
 */
export function strokeLine(plot, x1, y1, x2, y2, bounds) {
  if (!finite(x1, y1, x2, y2)) return;
  if (Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) > EXACT_LIMIT) {
    const c = clipSegment(x1, y1, x2, y2, -64, bounds.width + 64, bounds.height + 64);
    if (!c) return;
    [x1, y1, x2, y2] = c;
  }
  // Snapped integer coordinates, 1/256px units.
  const X1 = Math.round(x1 * SUB), Y1 = Math.round(y1 * SUB);
  const X2 = Math.round(x2 * SUB), Y2 = Math.round(y2 * SUB);
  if (X1 === X2 && Y1 === Y2) return;

  const xMajor = Math.abs(X2 - X1) >= Math.abs(Y2 - Y1);
  const corners = xMajor ? X_MAJOR_CORNERS : Y_MAJOR_CORNERS;
  // major axis a, minor axis b
  const A1 = xMajor ? X1 : Y1, B1 = xMajor ? Y1 : X1;
  const A2 = xMajor ? X2 : Y2, B2 = xMajor ? Y2 : X2;
  const sign = A2 > A1 ? 1 : -1, dA = (A2 - A1) * sign, dB = (B2 - B1) * sign;

  /** @param {number} X @param {number} Y @param {number} cx @param {number} cy */
  const owns = (X, Y, cx, cy) => {
    const f = Math.abs(X - cx) + Math.abs(Y - cy);
    return f < HALF || (f === HALF && corners.some(([ox, oy]) => X - cx === ox && Y - cy === oy));
  };

  const limit = (xMajor ? bounds.width : bounds.height) - 1;
  const lo = Math.max(0, Math.floor(Math.min(A1, A2) / SUB) - 1);
  const hi = Math.min(limit, Math.ceil(Math.max(A1, A2) / SUB) + 1);
  for (let p = lo; p <= hi; p++) {
    // The minor coordinate at a = p is n/dA; the one diamond it can touch is
    // the nearest, with a tie going to the side whose corner is owned — the
    // top (lower q) for x-major, the right (higher q) for y-major.
    const n = B1 * dA + (p * SUB - A1) * dB;
    const q = xMajor ? floorDiv(n + HALF * dA, SUB * dA) : -floorDiv(-(n - HALF * dA), SUB * dA);
    const cx = (xMajor ? p : q) * SUB, cy = (xMajor ? q : p) * SUB;
    if (owns(X2, Y2, cx, cy)) continue;                      // ends inside
    if (meetsInterior(X1, Y1, X2, Y2, cx, cy) ||
        corners.some(([ox, oy]) => onSegment(X1, Y1, X2, Y2, cx + ox, cy + oy))) {
      if (xMajor) plot(p, q); else plot(q, p);
    }
  }
}

/**
 * How many sides the game gives a circle of radius r: 8 up to r=17, one more
 * per 2px of radius, capped at 16 from r=32. Fitted over r=1..22, 32 and 44;
 * the cap is 16 (D2: r=34/38/42 are all 16-gons) and a fractional radius is
 * floored (D3: r=17.5 and 19.5 give 8 and 9 sides).
 * @param {number} r
 */
export function circleSides(r) {
  return Math.min(16, Math.max(8, Math.floor(r / 2)));
}

/**
 * The circle's polygon, starting at angle 0 (due right). `Math.fround`
 * mirrors the game's 32-bit vertices.
 * @param {number} cx @param {number} cy @param {number} r
 * @returns {[number, number][]}
 */
function circlePolygon(cx, cy, r) {
  const n = circleSides(r);
  const pts = /** @type {[number, number][]} */ ([]);
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n;
    pts.push([Math.fround(cx + r * Math.cos(a)), Math.fround(cy + r * Math.sin(a))]);
  }
  return pts;
}

/**
 * Draw a closed polygon's edges in order. Diamond-exit lines leave each
 * vertex to the edge that starts there, so a closed outline lights no pixel
 * twice unless its edges overlap.
 * @param {Plot} plot
 * @param {[number, number][]} pts
 * @param {Bounds} bounds
 */
function strokeLoop(plot, pts, bounds) {
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    strokeLine(plot, ax, ay, bx, by, bounds);
  }
}

/**
 * Circle outline: the polygon's edges, drawn as lines.
 * @param {Plot} plot
 * @param {number} cx @param {number} cy @param {number} r
 * @param {Bounds} bounds
 */
export function strokeCircle(plot, cx, cy, r, bounds) {
  if (!finite(cx, cy, r)) return;
  strokeLoop(plot, circlePolygon(cx, cy, r), bounds);
}

/**
 * Scanline fill of a convex polygon by point sampling: pixel (px, py) is lit
 * when (px + ε, py + yOff + ySign·ε²) is strictly inside. The x nudge is the
 * larger one, so it alone decides a pixel whose sample sits on a slanted
 * edge; the y nudge only decides rows that sit exactly on a vertex or a
 * horizontal edge. Adjacent triangles of a fan would share their edges
 * without overlap under this rule, so filling the whole polygon at once
 * covers the same pixels, each once.
 * @param {FillRun} fillRun
 * @param {[number, number][]} pts
 * @param {number} yOff 0 samples at the pixel's top edge, 1 at its bottom
 * @param {number} ySign +1 nudges the sample down, -1 up
 * @param {Bounds} bounds
 */
function fillConvex(fillRun, pts, yOff, ySign, bounds) {
  pts = pts.map(([x, y]) => [snap(x), snap(y)]);
  let yMin = Infinity, yMax = -Infinity;
  for (const [, y] of pts) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const top = Math.max(0, Math.floor(yMin - yOff));
  const bot = Math.min(bounds.height - 1, Math.ceil(yMax - yOff));

  for (let py = top; py <= bot; py++) {
    const y = py + yOff;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      if (lo === hi) continue;               // a horizontal edge bounds no row
      if (y < lo || y > hi || (y === lo && ySign < 0) || (y === hi && ySign > 0)) continue;
      const x = ax + (bx - ax) * ((y - ay) / (by - ay));
      if (x < xl) xl = x;
      if (x > xr) xr = x;
    }
    // px + ε in (xl, xr)  ⇔  ceil(xl) <= px < ceil(xr)
    if (xl < xr) emitRun(fillRun, Math.ceil(xl), Math.ceil(xr), py, bounds);
  }
}

/**
 * Filled circle: the same polygon, sampled at each pixel's top-left corner.
 * @param {FillRun} fillRun
 * @param {number} cx @param {number} cy @param {number} r
 * @param {Bounds} bounds
 */
export function fillCircle(fillRun, cx, cy, r, bounds) {
  if (!finite(cx, cy, r)) return;
  fillConvex(fillRun, circlePolygon(cx, cy, r), 0, 1, bounds);
}

/**
 * @param {Plot} plot
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} x3 @param {number} y3
 * @param {Bounds} bounds
 */
export function strokeTriangle(plot, x1, y1, x2, y2, x3, y3, bounds) {
  if (!finite(x1, y1, x2, y2, x3, y3)) return;
  strokeLoop(plot, [[x1, y1], [x2, y2], [x3, y3]], bounds);
}

/**
 * Filled triangle, sampled at each pixel's *bottom*-left corner. That is not
 * a typo for the top-left rule the other fills use: it is the only offset
 * that reproduces the game's integer, half-integer and fractional triangles
 * (A6), and it makes (50,68)-(70,68)-(50,88) cover rows 68..86, not 68..87.
 * A zero-area triangle covers nothing.
 * @param {FillRun} fillRun
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} x3 @param {number} y3
 * @param {Bounds} bounds
 */
export function fillTriangle(fillRun, x1, y1, x2, y2, x3, y3, bounds) {
  if (!finite(x1, y1, x2, y2, x3, y3)) return;
  fillConvex(fillRun, [[x1, y1], [x2, y2], [x3, y3]], 1, -1, bounds);
}

/**
 * Rectangle outline: four lines round the corners (x, y) → (x+w, y) →
 * (x+w, y+h) → (x, y+h), so it spans w+1 by h+1 pixels. A zero width or
 * height still draws — it is two lines on top of each other, and a
 * translucent colour shows them double-blended.
 * @param {Plot} plot
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {Bounds} bounds
 */
export function strokeRectangle(plot, x, y, w, h, bounds) {
  if (!finite(x, y, w, h)) return;
  strokeLoop(plot, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], bounds);
}

/**
 * Filled rectangle, sampled like drawTriangleF — at each pixel's bottom-left
 * corner: columns ceil(x)..ceil(x+w)−1, rows floor(y)..floor(y+h)−1. So
 * x = 20.25 starts at column 21 but y = 20.25 at row 20 (B6, D7), and a
 * width of 0.4 still lights one column. A negative size covers the same
 * pixels as its positive mirror (D7).
 * @param {FillRun} fillRun
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {Bounds} bounds
 */
export function fillRectangle(fillRun, x, y, w, h, bounds) {
  if (!finite(x, y, w, h)) return;
  const x0 = snap(x), x1 = snap(x + w), y0 = snap(y), y1 = snap(y + h);
  const left = Math.ceil(Math.min(x0, x1)), right = Math.ceil(Math.max(x0, x1));
  const top = Math.max(0, Math.floor(Math.min(y0, y1)));
  const bot = Math.min(bounds.height, Math.floor(Math.max(y0, y1)));
  for (let py = top; py < bot; py++) emitRun(fillRun, left, right, py, bounds);
}
