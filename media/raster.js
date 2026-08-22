// Integer-grid rasterisers for the microcontroller monitors.
//
// Canvas path drawing anti-aliases: a diagonal LINE, a CIRCLE or a TRIANGLE
// comes out as a spray of partial-intensity pixels, and the integer CSS upscale
// then magnifies that haze into visible blocks. Stormworks monitors have no
// anti-aliasing — a pixel is lit or it isn't — so those shapes are rasterised
// here by hand and painted as 1x1 fills / horizontal runs instead.
//
// Pure module: the drawing target is a callback, so test/raster.test.mjs can
// exercise these without a canvas. Everything is snapped to whole pixels, and
// every loop is bounded by the screen size (or MAX_RADIUS) — a microcontroller
// is free to pass ±1e9 coordinates and must not be able to hang the panel.

/** Plot one pixel. Coordinates are always integers. @typedef {(x: number, y: number) => void} Plot */
/** Fill `w` pixels starting at (x, y). @typedef {(x: number, y: number, w: number) => void} FillRun */

/**
 * Screen extent in logical (Stormworks) pixels.
 * @typedef {object} Bounds
 * @property {number} width
 * @property {number} height
 */

/**
 * A circle bigger than this can't show anything meaningful on a monitor (the
 * largest is 9x5 blocks = 288x160 px), and rasterising it would cost O(r).
 */
const MAX_RADIUS = 4096;

/**
 * Emit one horizontal run, clipped to the screen. Runs are clipped here rather
 * than in the caller so a shape spanning ±1e6 costs the screen width, not the
 * coordinate range.
 * @param {FillRun} fillRun
 * @param {number} x @param {number} y @param {number} w
 * @param {Bounds} bounds
 */
function emitRun(fillRun, x, y, w, bounds) {
  if (y < 0 || y >= bounds.height) return;
  const from = Math.max(0, x);
  const to = Math.min(bounds.width, x + w);
  if (to > from) fillRun(from, y, to - from);
}

/**
 * Liang-Barsky clip against the screen rect. Returns null when the segment
 * misses the screen entirely.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Bounds} bounds
 * @returns {{x1:number, y1:number, x2:number, y2:number} | null}
 */
export function clipSegment(x1, y1, x2, y2, bounds) {
  const dx = x2 - x1, dy = y2 - y1;
  const maxX = bounds.width - 1, maxY = bounds.height - 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1, maxX - x1, y1, maxY - y1];
  let t0 = 0, t1 = 1;

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;   // parallel to this edge and outside it
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    x1: x1 + t0 * dx, y1: y1 + t0 * dy,
    x2: x1 + t1 * dx, y2: y1 + t1 * dy
  };
}

/**
 * Bresenham line. The segment is clipped to the screen first, so a far
 * off-screen endpoint costs nothing.
 * @param {Plot} plot
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Bounds} bounds
 */
export function strokeLine(plot, x1, y1, x2, y2, bounds) {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
      !Number.isFinite(x2) || !Number.isFinite(y2)) return;

  const seg = clipSegment(x1, y1, x2, y2, bounds);
  if (!seg) return;

  let x = Math.round(seg.x1), y = Math.round(seg.y1);
  const ex = Math.round(seg.x2), ey = Math.round(seg.y2);
  const dx = Math.abs(ex - x), sx = x < ex ? 1 : -1;
  const dy = -Math.abs(ey - y), sy = y < ey ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    plot(x, y);
    if (x === ex && y === ey) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * Midpoint circle outline. Plots the eight-way symmetry points, so the axis and
 * diagonal pixels repeat — the caller's Plot is expected to de-duplicate if it
 * draws with alpha (see mcScreen.js:plotter).
 * @param {Plot} plot
 * @param {number} cx @param {number} cy @param {number} r
 */
export function strokeCircle(plot, cx, cy, r) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || r < 0 || r > MAX_RADIUS) return;
  if (r === 0) { plot(cx, cy); return; }

  let x = r, y = 0, err = 1 - r;
  while (x >= y) {
    plot(cx + x, cy + y); plot(cx - x, cy + y);
    plot(cx + x, cy - y); plot(cx - x, cy - y);
    plot(cx + y, cy + x); plot(cx - y, cy + x);
    plot(cx + y, cy - x); plot(cx - y, cy - x);
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
}

/**
 * Filled circle, one horizontal run per scanline. Rows outside the screen are
 * skipped rather than emitted.
 * @param {FillRun} fillRun
 * @param {number} cx @param {number} cy @param {number} r
 * @param {Bounds} bounds
 */
export function fillCircle(fillRun, cx, cy, r, bounds) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || r < 0 || r > MAX_RADIUS) return;

  const from = Math.max(-r, -cy);
  const to = Math.min(r, bounds.height - 1 - cy);
  for (let dy = from; dy <= to; dy++) {
    const dx = Math.floor(Math.sqrt(r * r - dy * dy));
    emitRun(fillRun, cx - dx, cy + dy, 2 * dx + 1, bounds);
  }
}

/**
 * @param {Plot} plot
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} x3 @param {number} y3
 * @param {Bounds} bounds
 */
export function strokeTriangle(plot, x1, y1, x2, y2, x3, y3, bounds) {
  strokeLine(plot, x1, y1, x2, y2, bounds);
  strokeLine(plot, x2, y2, x3, y3, bounds);
  strokeLine(plot, x3, y3, x1, y1, bounds);
}

/**
 * Scanline triangle fill. Each row takes the min/max of the edge intersections
 * with endpoints included, so the outline pixels are part of the fill and a
 * degenerate (zero-area) triangle still draws as its longest edge instead of
 * vanishing.
 * @param {FillRun} fillRun
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {number} x3 @param {number} y3
 * @param {Bounds} bounds
 */
export function fillTriangle(fillRun, x1, y1, x2, y2, x3, y3, bounds) {
  const xs = [Math.round(x1), Math.round(x2), Math.round(x3)];
  const ys = [Math.round(y1), Math.round(y2), Math.round(y3)];
  if (xs.some(v => !Number.isFinite(v)) || ys.some(v => !Number.isFinite(v))) return;

  // Clamping to the screen keeps the loop bounded no matter what the
  // microcontroller passes.
  const top = Math.max(0, Math.min(...ys));
  const bottom = Math.min(bounds.height - 1, Math.max(...ys));

  for (let y = top; y <= bottom; y++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const ya = ys[i], yb = ys[j], xa = xs[i], xb = xs[j];
      if (ya === yb) {
        if (ya !== y) continue;                 // horizontal edge on this row
        lo = Math.min(lo, xa, xb);
        hi = Math.max(hi, xa, xb);
        continue;
      }
      if (y < Math.min(ya, yb) || y > Math.max(ya, yb)) continue;
      const x = xa + (y - ya) * (xb - xa) / (yb - ya);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    if (lo > hi) continue;
    const left = Math.round(lo), right = Math.round(hi);
    emitRun(fillRun, left, y, right - left + 1, bounds);
  }
}
