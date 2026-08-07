// 4x5 bitmap pixel font — pure module, no DOM / canvas / three.js imports, so
// it is importable both from the webview (media/mcScreen.js) and from the Node
// test suite (test/pixelFont.test.mjs).
//
// Why a hand-drawn font at all: the monitor canvases live at *logical*
// Stormworks resolution (e.g. 96x96) and are CSS-upscaled by 2–16x with
// image-rendering:pixelated. Canvas fillText at "5px monospace" produces
// anti-aliased sub-pixel grey mush at that size, which the upscale then blows
// up into illegible blobs. Every glyph here is a hard on/off pixel mask, drawn
// one 1x1 fillRect at a time, so text stays perfectly crisp at any integer
// upscale — the same way the real Stormworks monitor font behaves.
//
// Metrics match Stormworks: glyphs are 4 px wide and 5 px tall on a 5 px
// horizontal advance (4 + 1 px gap) and a 6 px line pitch (5 + 1 px gap).
//
// Case: Stormworks renders monitor text uppercase, so lowercase input is
// mapped to the uppercase glyph. Characters with no glyph render as a 4x5
// outline box (a visible "tofu"), which makes a missing glyph obvious on
// screen instead of silently swallowing text.

/** Glyph cell width in pixels. */
export const GLYPH_WIDTH = 4;
/** Glyph cell height in pixels. */
export const GLYPH_HEIGHT = 5;
/** Horizontal pen advance per character: GLYPH_WIDTH + 1 px inter-glyph gap. */
export const GLYPH_ADVANCE = 5;
/** Vertical pitch between text baselines: GLYPH_HEIGHT + 1 px inter-line gap. */
export const LINE_HEIGHT = 6;

/**
 * Readable source form of the font: each entry is 5 strings of 4 columns,
 * '#' = lit pixel, anything else = off. Compiled into bitmasks below.
 * @type {Record<string, string[]>}
 */
const GLYPH_SOURCE = {
  " ": ["....", "....", "....", "....", "...."],

  "A": [".##.", "#..#", "####", "#..#", "#..#"],
  "B": ["###.", "#..#", "###.", "#..#", "###."],
  "C": [".###", "#...", "#...", "#...", ".###"],
  "D": ["###.", "#..#", "#..#", "#..#", "###."],
  "E": ["####", "#...", "###.", "#...", "####"],
  "F": ["####", "#...", "###.", "#...", "#..."],
  "G": [".###", "#...", "#.##", "#..#", ".###"],
  "H": ["#..#", "#..#", "####", "#..#", "#..#"],
  "I": ["###.", ".#..", ".#..", ".#..", "###."],
  "J": ["..##", "...#", "...#", "#..#", ".##."],
  "K": ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  "L": ["#...", "#...", "#...", "#...", "####"],
  "M": ["#..#", "####", "#..#", "#..#", "#..#"],
  "N": ["#..#", "##.#", "#.##", "#..#", "#..#"],
  "O": [".##.", "#..#", "#..#", "#..#", ".##."],
  "P": ["###.", "#..#", "###.", "#...", "#..."],
  "Q": [".##.", "#..#", "#..#", "#.#.", ".#.#"],
  "R": ["###.", "#..#", "###.", "#.#.", "#..#"],
  "S": [".###", "#...", ".##.", "...#", "###."],
  "T": ["####", ".#..", ".#..", ".#..", ".#.."],
  "U": ["#..#", "#..#", "#..#", "#..#", ".##."],
  // V is drawn 3 columns wide so it stays distinct from U at this size.
  "V": ["#.#.", "#.#.", "#.#.", "#.#.", ".#.."],
  "W": ["#..#", "#..#", "#..#", "####", "#..#"],
  "X": ["#..#", "#..#", ".##.", "#..#", "#..#"],
  "Y": ["#..#", "#..#", ".##.", ".#..", ".#.."],
  "Z": ["####", "...#", ".##.", "#...", "####"],

  // 0 carries a diagonal so it cannot be confused with O.
  "0": [".##.", "#.##", "##.#", "#..#", ".##."],
  "1": [".#..", "##..", ".#..", ".#..", "###."],
  "2": ["###.", "...#", ".##.", "#...", "####"],
  "3": ["###.", "...#", ".##.", "...#", "###."],
  "4": ["#..#", "#..#", "####", "...#", "...#"],
  "5": ["####", "#...", "###.", "...#", "###."],
  "6": [".##.", "#...", "###.", "#..#", ".##."],
  "7": ["####", "...#", "..#.", ".#..", ".#.."],
  "8": [".##.", "#..#", ".##.", "#..#", ".##."],
  "9": [".##.", "#..#", ".###", "...#", ".##."],

  ".": ["....", "....", "....", "....", ".#.."],
  ",": ["....", "....", "....", ".#..", "#..."],
  ":": ["....", ".#..", "....", ".#..", "...."],
  ";": ["....", ".#..", "....", ".#..", "#..."],
  "!": [".#..", ".#..", ".#..", "....", ".#.."],
  "?": ["###.", "...#", ".##.", "....", ".#.."],
  "'": [".#..", ".#..", "....", "....", "...."],
  "\"": ["#.#.", "#.#.", "....", "....", "...."],
  "+": ["....", ".#..", "###.", ".#..", "...."],
  "-": ["....", "....", "###.", "....", "...."],
  "*": ["....", "#.#.", ".#..", "#.#.", "...."],
  "/": ["...#", "..#.", ".#..", "#...", "...."],
  "\\": ["#...", ".#..", "..#.", "...#", "...."],
  "=": ["....", "###.", "....", "###.", "...."],
  "%": ["#..#", "...#", ".##.", "#...", "#..#"],
  "(": ["..#.", ".#..", ".#..", ".#..", "..#."],
  ")": [".#..", "..#.", "..#.", "..#.", ".#.."],
  "[": [".##.", ".#..", ".#..", ".#..", ".##."],
  "]": [".##.", "..#.", "..#.", "..#.", ".##."],
  "{": ["..##", ".#..", "##..", ".#..", "..##"],
  "}": ["##..", "..#.", "..##", "..#.", "##.."],
  "<": ["..#.", ".#..", "#...", ".#..", "..#."],
  ">": ["#...", ".#..", "..#.", ".#..", "#..."],
  "_": ["....", "....", "....", "....", "####"],
  "|": [".#..", ".#..", ".#..", ".#..", ".#.."],
  "#": ["#.#.", "####", "#.#.", "####", "#.#."],
  "^": [".#..", "#.#.", "....", "....", "...."],
  "~": ["....", ".#.#", "#.#.", "....", "...."],
  "@": [".##.", "#..#", "#.##", "#...", ".##."],
  "$": [".###", "##..", ".##.", "..##", "###."],
  "°": [".##.", "#..#", ".##.", "....", "...."]
};

/** Drawn in place of any character with no glyph (a visible "tofu" box). */
const TOFU = ["####", "#..#", "#..#", "#..#", "####"];

/**
 * Compile one readable glyph into 5 row bitmasks. Bit 3 (value 8) is the
 * leftmost column, bit 0 (value 1) the rightmost.
 * @param {string[]} rows
 * @returns {number[]}
 */
function compile(rows) {
  return rows.map(row => {
    let bits = 0;
    for (let col = 0; col < GLYPH_WIDTH; col++) {
      if (row[col] === "#") bits |= 1 << (GLYPH_WIDTH - 1 - col);
    }
    return bits;
  });
}

/**
 * The font: character → GLYPH_HEIGHT row bitmasks, MSB-first within
 * GLYPH_WIDTH columns. Uppercase keys only.
 * @type {Readonly<Record<string, readonly number[]>>}
 */
export const GLYPHS = Object.freeze(
  /** @type {Record<string, readonly number[]>} */ (
    Object.fromEntries(
      Object.entries(GLYPH_SOURCE).map(([ch, rows]) => [ch, Object.freeze(compile(rows))])
    )
  )
);

/** Row bitmasks used for characters missing from {@link GLYPHS}. */
export const TOFU_GLYPH = Object.freeze(compile(TOFU));

/**
 * Look up one character's row bitmasks, mapping lowercase to uppercase and
 * unknown characters to the tofu box.
 * @param {string} ch single character
 * @returns {readonly number[]} GLYPH_HEIGHT row bitmasks
 */
export function glyphFor(ch) {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? TOFU_GLYPH;
}

/**
 * Width in pixels of a single rendered line: every character occupies
 * GLYPH_ADVANCE, minus the trailing inter-glyph gap. Empty string → 0.
 * For multi-line text (with "\n") the widest line wins.
 * @param {string} text
 * @returns {number}
 */
export function measurePixelText(text) {
  let widest = 0;
  for (const line of String(text).split("\n")) {
    if (line.length === 0) continue;
    const w = line.length * GLYPH_ADVANCE - 1;
    if (w > widest) widest = w;
  }
  return widest;
}

/**
 * Total height in pixels of a rendered block: LINE_HEIGHT per line minus the
 * trailing inter-line gap.
 * @param {number} lineCount
 * @returns {number}
 */
export function measurePixelBlockHeight(lineCount) {
  return lineCount > 0 ? lineCount * LINE_HEIGHT - 1 : 0;
}

/**
 * Rasterise text by calling setPixel once per lit pixel. Canvas-agnostic on
 * purpose: the webview passes a fillRect(px, py, 1, 1) closure, tests pass a
 * collector. (x, y) is the top-left of the first glyph cell; "\n" starts a new
 * line LINE_HEIGHT lower, back at x.
 * @param {(px: number, py: number) => void} setPixel
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @returns {void}
 */
export function drawPixelText(setPixel, text, x, y) {
  const ox = Math.round(x);
  let penX = ox;
  let penY = Math.round(y);

  for (const ch of String(text)) {
    if (ch === "\n") {
      penX = ox;
      penY += LINE_HEIGHT;
      continue;
    }
    const rows = glyphFor(ch);
    for (let r = 0; r < rows.length; r++) {
      const bits = rows[r];
      if (bits === 0) continue;
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (bits & (1 << (GLYPH_WIDTH - 1 - col))) setPixel(penX + col, penY + r);
      }
    }
    penX += GLYPH_ADVANCE;
  }
}
