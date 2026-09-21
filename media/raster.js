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
// - A line is drawn with the diamond-exit rule. Its end pixel is not lit, a
//   0.5px line lights one pixel and a 0.3px one none, and which pixel a
//   half-integer coordinate lands on depends on the axis.
// - A circle is an N-gon with N = clamp(floor(r/2), 8, 16). Small circles are
//   octagons, which is why r=3 happens to look like a midpoint circle.
// - drawTriangleF samples each pixel at its bottom-left corner, every other
//   fill at its top-left one — so a triangle and the same shape as a circle
//   or rectangle don't cover the same bottom row.
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

/**
 * The smaller of two values that each carry an infinitesimal term
 * (`value + coef·ε`), returned as `[value, coef]`. Exact ties go to whichever
 * the infinitesimal makes smaller.
 * @param {number} a @param {number} ca @param {number} b @param {number} cb
 * @returns {[number, number]}
 */
function minEps(a, ca, b, cb) {
  if (a < b) return [a, ca];
  if (b < a) return [b, cb];
  return ca <= cb ? [a, ca] : [b, cb];
}

/**
 * Diamond-exit line. Pixel (px, py) owns the open diamond |x−px| + |y−py| <
 * 1/2 in script coordinates (the game's half-pixel offset puts pixel centres
 * on the integers), and is lit when the segment leaves that diamond — so the
 * pixel the line ends in is never lit, and a line too short to leave its first
 * diamond draws nothing.
 *
 * A point exactly on a diamond's edge is decided by nudging the whole line an
 * infinitesimal step along its minor axis: down for an x-major line, left for
 * a y-major one (45° counts as x-major; the game hasn't shown which). That one
 * rule is why a half-integer y rounds down the screen and a half-integer x
 * rounds left. The nudge is carried symbolically, not added to the
 * coordinates, so it still works at ±1e9.
 *
 * Only the major axis is walked, over the screen: at most one pixel per step
 * can be lit (|slope| <= 1), and `plot` drops whatever lands off-screen on
 * the minor axis.
 * @param {Plot} plot
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {Bounds} bounds
 */
export function strokeLine(plot, x1, y1, x2, y2, bounds) {
  if (!finite(x1, y1, x2, y2)) return;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return;

  const xMajor = Math.abs(dx) >= Math.abs(dy);
  const a1 = xMajor ? x1 : y1, b1 = xMajor ? y1 : x1;
  const a2 = xMajor ? x2 : y2, b2 = xMajor ? y2 : x2;
  const s = xMajor ? 1 : -1;               // direction of the minor-axis nudge
  const m = (b2 - b1) / (a2 - a1);         // |m| <= 1
  const rising = a2 > a1;

  // A diamond is at most half a pixel wide, so no exit lies further out.
  const limit = (xMajor ? bounds.width : bounds.height) - 1;
  const lo = Math.max(0, Math.floor(Math.min(a1, a2)) - 1);
  const hi = Math.min(limit, Math.ceil(Math.max(a1, a2)) + 1);

  for (let p = lo; p <= hi; p++) {
    // Interpolate from the nearer endpoint: at ±1e9 the far one has no
    // precision left for a tie.
    const b = Math.abs(p - a1) <= Math.abs(p - a2) ? b1 + (p - a1) * m : b2 + (p - a2) * m;
    // The one diamond in this column the (nudged) line passes through.
    const q = s > 0 ? Math.floor(b + 0.5) : Math.ceil(b - 0.5);
    const d = b - q;                         // plus s·ε

    // Where the line leaves diamond (p, q), as p + u + coef·s·ε along the
    // major axis. |u| + |d + m·u| = 1/2 has one root each side of the centre.
    let u, c;
    if (rising) {
      [u, c] = minEps((0.5 - d) / (1 + m), -1 / (1 + m), (0.5 + d) / (1 - m), 1 / (1 - m));
    } else {
      [u, c] = minEps((0.5 - d) / (1 - m), -1 / (1 - m), (0.5 + d) / (1 + m), 1 / (1 + m));
      u = -u; c = -c;
    }
    const exit = p + u, ce = s * c;          // ce is never 0
    // Lit when the exit lies strictly after the start and at or before the end.
    const lit = rising
      ? (a1 < exit || (a1 === exit && ce > 0)) && (exit < a2 || (exit === a2 && ce < 0))
      : (exit < a1 || (exit === a1 && ce < 0)) && (a2 < exit || (a2 === exit && ce > 0));
    if (lit) {
      if (xMajor) plot(p, q); else plot(q, p);
    }
  }
}

/**
 * How many sides the game gives a circle of radius r: 8 up to r=17, one more
 * per 2px of radius, capped at 16 from r=32. Fitted over r=1..22, 32 and 44;
 * the cap sits somewhere in 16..21 — 16 is the natural reading.
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
 * Filled rectangle, sampled at each pixel's top-left corner like the circle
 * fill: columns ceil(x)..ceil(x+w)−1, so x = 20.25 starts at column 21 and a
 * width of 0.4 still lights one column. Rows follow the same rule, which the
 * game has only confirmed for whole-pixel y. A negative size covers the same
 * pixels as its positive mirror.
 * @param {FillRun} fillRun
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {Bounds} bounds
 */
export function fillRectangle(fillRun, x, y, w, h, bounds) {
  if (!finite(x, y, w, h)) return;
  const left = Math.ceil(Math.min(x, x + w)), right = Math.ceil(Math.max(x, x + w));
  const top = Math.max(0, Math.ceil(Math.min(y, y + h)));
  const bot = Math.min(bounds.height, Math.ceil(Math.max(y, y + h)));
  for (let py = top; py < bot; py++) emitRun(fillRun, left, right, py, bounds);
}
