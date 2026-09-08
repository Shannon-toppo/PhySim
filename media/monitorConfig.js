// Monitor layout rules for the panel's multi-monitor support.
//
// LifeBoatAPI's Simulator keeps its screens in a plain `_screens` table keyed
// by screen number, and its render loop walks *every* powered-on entry calling
// onDraw() once per screen. Nothing about that is limited to one monitor — the
// only reason a session normally shows a single 3x3 is that `_beginSimulation`
// does `setScreen(1, "3x3")` and nobody adds more. So the panel can declare
// extra monitors itself: `SCREENSIZE|n|w|h` creates screen n in Lua (its
// handler does `_screens[n] = _screens[n] or SimulatorScreen:new(n)`), and
// `SCREENPOWER|n|0|1` switches one off and on. src/simStubServer.ts sends
// those; this module owns the rules both sides agree on.
//
// Pure — no DOM, no three, no vscode — so test/monitorConfig.test.mjs can run
// it in Node, and test/simstub.test.mjs can check the host's copy of the size
// table against SCREEN_SIZES here.

/** Pixels per Stormworks monitor block. */
export const PX_PER_BLOCK = 32;

/**
 * The monitor blocks the game actually has. Portrait is a separate flag
 * rather than extra entries here — that is how `simulator:setScreen` models
 * it, and it keeps "2x1 rotated" from being a different size to "1x2".
 */
export const SCREEN_SIZES = ["1x1", "2x1", "2x2", "3x2", "3x3", "5x3", "9x5"];

/** What "Add monitor" starts a new screen at — big enough to draw on, small
 *  enough that a second one still fits next to the first. */
export const DEFAULT_SIZE = "2x2";

/**
 * Panel cap on how many monitors can be declared at once. Neither Stormworks
 * nor LifeBoatAPI enforces a number; this only keeps the panel (and the Lua
 * render loop, which runs onDraw once per screen per frame) from being handed
 * something absurd.
 */
export const MAX_SCREENS = 8;

/**
 * @typedef {object} ScreenRequest
 * @property {number} number 1..MAX_SCREENS
 * @property {string} size one of SCREEN_SIZES
 * @property {boolean} poweredOn
 * @property {boolean} portrait
 */

/**
 * @param {unknown} size
 * @returns {{blocksW: number, blocksH: number} | null} null when unparseable
 */
export function parseSize(size) {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(size ?? ""));
  if (!m) return null;
  const blocksW = Number(m[1]);
  const blocksH = Number(m[2]);
  if (!blocksW || !blocksH) return null;
  return { blocksW, blocksH };
}

/**
 * Blocks to canvas pixels. Portrait stands the monitor on its end, which swaps
 * the two — the same swap `SimStubServer.applyScreenConfig` does for the size
 * LifeBoatAPI sends.
 * @param {string} size
 * @param {boolean} portrait
 * @returns {{width: number, height: number}}
 */
export function sizePixels(size, portrait) {
  const b = parseSize(size) ?? parseSize(DEFAULT_SIZE);
  const w = (b ? b.blocksW : 1) * PX_PER_BLOCK;
  const h = (b ? b.blocksH : 1) * PX_PER_BLOCK;
  return portrait ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Inverse of sizePixels, for filling the size dropdown from a screen the
 * microcontroller declared (we only ever see its pixel dimensions back).
 * @param {number} width @param {number} height @param {boolean} portrait
 * @returns {string} e.g. "3x3"
 */
export function pixelsToSize(width, height, portrait) {
  const w = portrait ? height : width;
  const h = portrait ? width : height;
  const bw = Math.max(1, Math.round(w / PX_PER_BLOCK));
  const bh = Math.max(1, Math.round(h / PX_PER_BLOCK));
  return `${bw}x${bh}`;
}

/**
 * Lowest free screen number, so "Add monitor" fills the gap left by a removed
 * screen instead of climbing past MAX_SCREENS.
 * @param {Iterable<number>} used
 * @returns {number} 0 when every slot is taken
 */
export function nextScreenNumber(used) {
  const taken = new Set();
  for (const n of used) taken.add(Math.round(Number(n)));
  for (let i = 1; i <= MAX_SCREENS; i++) if (!taken.has(i)) return i;
  return 0;
}

/**
 * The integer CSS upscale shared by every monitor in "fit" mode.
 *
 * One factor for all of them, not one each: at different scales two monitors
 * of different sizes look the same size, which is exactly the thing a
 * multi-monitor layout has to get right. The first choice is the largest
 * factor that still lets them sit in a single row; if even 1x doesn't fit
 * they wrap, and the factor is then whatever the widest one can take.
 *
 * @param {number[]} widths logical widths, one per monitor
 * @param {number} avail    the monitor column's clientWidth
 * @param {object} [opts]
 * @param {number} [opts.gap]    flex gap between monitors, px
 * @param {number} [opts.chrome] non-pixel width per canvas (its border), px
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @returns {number}
 */
export function fitScale(widths, avail, opts = {}) {
  const gap = opts.gap ?? 10;
  const chrome = opts.chrome ?? 2;
  const min = opts.min ?? 1;
  const max = opts.max ?? 16;
  /** @param {number} s */
  const clamp = s => Math.max(min, Math.min(max, Number.isFinite(s) ? s : min));

  const list = widths.filter(w => Number.isFinite(w) && w > 0);
  if (list.length === 0) return clamp(min);

  const total = list.reduce((a, b) => a + b, 0);
  const oneRow = Math.floor((avail - chrome * list.length - gap * (list.length - 1)) / total);
  if (oneRow >= min) return clamp(oneRow);

  const widest = Math.max.apply(null, list);
  return clamp(Math.floor((avail - chrome) / widest));
}
