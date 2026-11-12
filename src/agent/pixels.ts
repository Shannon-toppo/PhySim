// Questions an agent can ask about a monitor's picture, answered in numbers.
// Pure module.
//
// A language model misreads a 96x96 image easily, and never misreads "12 lit
// pixels, bounds x 4..9 y 10..16". So the picture is not handed over as an
// image but queried: what is in this rectangle, what changed, does it match
// what I expect, show me this corner as characters.
//
// Every colour here is the colour a person sees — the engine's frame
// composited over the monitor's black (rgb × alpha / 255, CLAUDE.md "Monitor
// display"), not the frame's raw RGBA. A pixel is "lit" when that colour is
// anything but black.

export interface Picture {
  width: number;
  height: number;
  /** The engine's "game-rgba8" frame: straight RGBA, row order, width*height*4 bytes. */
  pixels: Uint8Array;
}

export type Rgb = [number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle as inclusive pixel coordinates, the form the answers use. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Colours listed per answer; the rest are counted, not named. */
export const MAX_COLORS = 16;
/** Individual pixels listed per answer. */
export const MAX_EXAMPLES = 20;
/** Characters in one text grid (64x64, or any shape of that area). */
export const MAX_GRID_CELLS = 4096;
/** Checks in one expectation request. */
export const MAX_CHECKS = 64;

export function visibleColor(p: Picture, x: number, y: number): Rgb {
  const i = (y * p.width + x) * 4;
  const a = p.pixels[i + 3];
  if (a === 255) return [p.pixels[i], p.pixels[i + 1], p.pixels[i + 2]];
  return [
    Math.round(p.pixels[i] * a / 255),
    Math.round(p.pixels[i + 1] * a / 255),
    Math.round(p.pixels[i + 2] * a / 255)
  ];
}

function key(c: Rgb): number { return (c[0] << 16) | (c[1] << 8) | c[2]; }
function fromKey(k: number): Rgb { return [(k >> 16) & 255, (k >> 8) & 255, k & 255]; }

/**
 * The part of a requested rectangle that lies on the picture. Omitted fields
 * mean "to the edge", so no rectangle at all is the whole picture. Throws when
 * nothing of it is on the picture — an answer about zero pixels would read as
 * "empty" and hide a wrong coordinate.
 */
export function clipRect(p: Picture, r?: Partial<Rect>): Rect {
  const whole = (v: number | undefined, fallback: number, name: string): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
    return Math.round(v);
  };
  const x = whole(r?.x, 0, "x"), y = whole(r?.y, 0, "y");
  // "To the edge" from a start beyond the edge is not an empty rectangle the
  // caller asked for; it is a start that is off the monitor, and is said so below.
  const width = whole(r?.width, Math.max(1, p.width - x), "width");
  const height = whole(r?.height, Math.max(1, p.height - y), "height");
  if (width <= 0 || height <= 0) throw new Error(`the rectangle is empty (width ${width}, height ${height})`);
  const left = Math.max(0, x), top = Math.max(0, y);
  const right = Math.min(p.width, x + width), bottom = Math.min(p.height, y + height);
  if (right <= left || bottom <= top) {
    throw new Error(`the rectangle x ${x} y ${y} ${width}x${height} is outside the ${p.width}x${p.height} monitor`);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

class BoundsBuilder {
  private left = Infinity; private top = Infinity; private right = -1; private bottom = -1;
  add(x: number, y: number): void {
    if (x < this.left) this.left = x;
    if (x > this.right) this.right = x;
    if (y < this.top) this.top = y;
    if (y > this.bottom) this.bottom = y;
  }
  get(): Bounds | null {
    return this.right < 0 ? null : { left: this.left, top: this.top, right: this.right, bottom: this.bottom };
  }
}

// --- Region ------------------------------------------------------------------

export interface ColorCount {
  color: Rgb;
  pixels: number;
  /** Where this colour sits. */
  bounds: Bounds;
}

export interface RegionStats {
  /** The rectangle actually examined (the request clipped to the monitor). */
  rect: Rect;
  pixels: number;
  lit: number;
  /** The smallest rectangle holding every lit pixel, or null when none is lit. */
  litBounds: Bounds | null;
  /** Lit colours, most pixels first; at most MAX_COLORS. */
  colors: ColorCount[];
  /** How many more distinct lit colours there are than `colors` lists. */
  moreColors: number;
}

export function regionStats(p: Picture, rect?: Partial<Rect>): RegionStats {
  const r = clipRect(p, rect);
  const all = new BoundsBuilder();
  const byColor = new Map<number, { pixels: number; bounds: BoundsBuilder }>();
  let lit = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const k = key(visibleColor(p, x, y));
      if (k === 0) continue;
      lit++;
      all.add(x, y);
      let entry = byColor.get(k);
      if (!entry) byColor.set(k, entry = { pixels: 0, bounds: new BoundsBuilder() });
      entry.pixels++;
      entry.bounds.add(x, y);
    }
  }
  // Ties broken by colour value, so the same picture always lists the same order.
  const sorted = Array.from(byColor).sort((a, b) => b[1].pixels - a[1].pixels || a[0] - b[0]);
  return {
    rect: r,
    pixels: r.width * r.height,
    lit,
    litBounds: all.get(),
    colors: sorted.slice(0, MAX_COLORS).map(([k, e]) => ({ color: fromKey(k), pixels: e.pixels, bounds: e.bounds.get()! })),
    moreColors: Math.max(0, sorted.length - MAX_COLORS)
  };
}

// --- Difference ----------------------------------------------------------------

export interface PixelChange {
  x: number;
  y: number;
  before: Rgb;
  after: Rgb;
}

export type PictureDiff =
  | { comparable: false; before: { width: number; height: number }; after: { width: number; height: number } }
  | {
    comparable: true;
    rect: Rect;
    pixels: number;
    changed: number;
    /** The smallest rectangle holding every changed pixel, or null when nothing changed. */
    changedBounds: Bounds | null;
    /** Pixels that went from black to lit, and from lit to black. */
    appeared: number;
    disappeared: number;
    /** Lit before and after, in a different colour. */
    recolored: number;
    /** The first changes in row order; at most MAX_EXAMPLES. */
    examples: PixelChange[];
  };

/** Compare two pictures of one monitor. Pictures of different sizes are not compared pixel by pixel. */
export function diffPictures(before: Picture, after: Picture, rect?: Partial<Rect>): PictureDiff {
  if (before.width !== after.width || before.height !== after.height) {
    return {
      comparable: false,
      before: { width: before.width, height: before.height },
      after: { width: after.width, height: after.height }
    };
  }
  const r = clipRect(after, rect);
  const bounds = new BoundsBuilder();
  const examples: PixelChange[] = [];
  let changed = 0, appeared = 0, disappeared = 0, recolored = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const a = visibleColor(before, x, y), b = visibleColor(after, x, y);
      const ka = key(a), kb = key(b);
      if (ka === kb) continue;
      changed++;
      bounds.add(x, y);
      if (ka === 0) appeared++; else if (kb === 0) disappeared++; else recolored++;
      if (examples.length < MAX_EXAMPLES) examples.push({ x, y, before: a, after: b });
    }
  }
  return {
    comparable: true, rect: r, pixels: r.width * r.height,
    changed, changedBounds: bounds.get(), appeared, disappeared, recolored, examples
  };
}

// --- Expectations --------------------------------------------------------------

/**
 * empty   no pixel in the rectangle is lit
 * filled  every pixel is lit — and, with `color`, is that colour
 * some    at least one pixel is lit — with `color`, at least one is that colour
 * only    every lit pixel is `color` (unlit pixels are fine); `color` is required
 */
export type Expectation = "empty" | "filled" | "some" | "only";

export interface Check {
  /** Echoed back, so the answers can be told apart. */
  label?: string;
  rect?: Partial<Rect>;
  expect: Expectation;
  color?: Rgb;
  /** How far each of r, g, b may be from `color` and still count as it. Default 0. */
  tolerance?: number;
}

export interface CheckResult {
  label?: string;
  expect: Expectation;
  rect: Rect;
  pass: boolean;
  /** Pixels that satisfy the expectation's condition, and the pixels examined. */
  matching: number;
  pixels: number;
  /** Pixels that break the expectation, in row order; at most MAX_EXAMPLES. Empty when it passed. */
  offending: Array<{ x: number; y: number; color: Rgb }>;
  offendingCount: number;
}

export function parseRgb(v: unknown, name: string): Rgb {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${name} must be [r, g, b] with whole numbers from 0 to 255`);
  }
  return [v[0], v[1], v[2]];
}

function near(c: Rgb, target: Rgb, tolerance: number): boolean {
  return Math.abs(c[0] - target[0]) <= tolerance
    && Math.abs(c[1] - target[1]) <= tolerance
    && Math.abs(c[2] - target[2]) <= tolerance;
}

export function checkExpectations(p: Picture, checks: readonly Check[]): CheckResult[] {
  if (checks.length > MAX_CHECKS) throw new Error(`at most ${MAX_CHECKS} checks per request, got ${checks.length}`);
  return checks.map(check => {
    const r = clipRect(p, check.rect);
    const tolerance = check.tolerance ?? 0;
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("tolerance must be 0 or more");
    if (check.expect === "only" && !check.color) throw new Error('expect "only" needs a color');
    if (check.expect === "empty" && check.color) throw new Error('expect "empty" takes no color');
    const color = check.color;
    // `ok` is the per-pixel condition; which pixels count as offending depends
    // on whether the expectation is about all of them or about one of them.
    const ok = (c: Rgb): boolean => {
      const lit = key(c) !== 0;
      switch (check.expect) {
        case "empty": return !lit;
        case "filled": return color ? near(c, color, tolerance) : lit;
        case "some": return color ? near(c, color, tolerance) : lit;
        case "only": return !lit || near(c, color!, tolerance);
      }
    };
    const everyPixel = check.expect !== "some";
    const offending: CheckResult["offending"] = [];
    let matching = 0, offendingCount = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const c = visibleColor(p, x, y);
        if (ok(c)) { matching++; continue; }
        if (!everyPixel) continue;
        offendingCount++;
        if (offending.length < MAX_EXAMPLES) offending.push({ x, y, color: c });
      }
    }
    const pixels = r.width * r.height;
    const pass = everyPixel ? offendingCount === 0 : matching > 0;
    return { label: check.label, expect: check.expect, rect: r, pass, matching, pixels, offending, offendingCount };
  });
}

// --- Text grid -----------------------------------------------------------------

export interface TextGrid {
  rect: Rect;
  /** One string per pixel row; `.` is an unlit pixel. */
  rows: string[];
  /** Character → colour, when the grid was asked to tell colours apart. */
  legend?: Record<string, Rgb>;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * A small area as characters, one per pixel: `#` lit, `.` unlit. With
 * `byColor`, each colour gets its own letter (most pixels first) so two shapes
 * drawn over each other can be told apart; past the 26 most common colours the
 * rest are drawn as `#`.
 */
export function textGrid(p: Picture, rect?: Partial<Rect>, byColor = false): TextGrid {
  const r = clipRect(p, rect);
  if (r.width * r.height > MAX_GRID_CELLS) {
    throw new Error(
      `a text grid holds at most ${MAX_GRID_CELLS} pixels (64x64); ${r.width}x${r.height} is ${r.width * r.height}. Ask for a smaller rectangle.`
    );
  }
  const letters = new Map<number, string>();
  let legend: Record<string, Rgb> | undefined;
  if (byColor) {
    // Counted here rather than taken from regionStats, whose list stops at
    // MAX_COLORS — short of the alphabet.
    const counts = new Map<number, number>();
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const k = key(visibleColor(p, x, y));
        if (k !== 0) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const ranked = Array.from(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, LETTERS.length);
    legend = {};
    for (const [i, [k]] of ranked.entries()) {
      letters.set(k, LETTERS[i]);
      legend[LETTERS[i]] = fromKey(k);
    }
  }
  const rows: string[] = [];
  for (let y = r.y; y < r.y + r.height; y++) {
    let row = "";
    for (let x = r.x; x < r.x + r.width; x++) {
      const k = key(visibleColor(p, x, y));
      row += k === 0 ? "." : (letters.get(k) ?? "#");
    }
    rows.push(row);
  }
  return { rect: r, rows, legend };
}
