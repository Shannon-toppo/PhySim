// Unit tests for the 4x5 bitmap monitor font in media/pixelFont.js.
// The font replaces canvas fillText on the MC monitor canvases, so the pixel
// output has to be exact — anything off-grid shows up magnified 2–16x.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GLYPHS, TOFU_GLYPH, glyphFor, drawPixelText, measurePixelText,
  measurePixelBlockHeight, GLYPH_WIDTH, GLYPH_HEIGHT, GLYPH_ADVANCE, LINE_HEIGHT,
  wrapTextBox, layoutTextBox
} from "../media/pixelFont.js";

/**
 * Render text into an array of "#"/"." rows, offset so (0,0) is the origin.
 */
function render(text, rows, cols) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill("."));
  drawPixelText((px, py) => {
    if (py >= 0 && py < rows && px >= 0 && px < cols) grid[py][px] = "#";
  }, text, 0, 0);
  return grid.map(r => r.join(""));
}

test("metrics constants", () => {
  assert.equal(GLYPH_WIDTH, 4);
  assert.equal(GLYPH_HEIGHT, 5);
  assert.equal(GLYPH_ADVANCE, 5);
  assert.equal(LINE_HEIGHT, 6);
});

test("every declared glyph is 5 rows and fits 4 columns", () => {
  const entries = Object.entries(GLYPHS);
  assert.ok(entries.length > 60, `expected a full font, got ${entries.length} glyphs`);
  for (const [ch, rows] of entries) {
    assert.equal(rows.length, GLYPH_HEIGHT, `glyph ${JSON.stringify(ch)} row count`);
    for (const bits of rows) {
      assert.ok(Number.isInteger(bits), `glyph ${JSON.stringify(ch)} row not an int`);
      assert.ok(bits >= 0 && bits < (1 << GLYPH_WIDTH),
        `glyph ${JSON.stringify(ch)} row ${bits} exceeds ${GLYPH_WIDTH} columns`);
    }
  }
  assert.equal(TOFU_GLYPH.length, GLYPH_HEIGHT);
});

test("font covers digits, A-Z and the punctuation used by labels", () => {
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?'\"+-*/\\=%()[]<>_|#°") {
    assert.ok(GLYPHS[ch], `missing glyph for ${JSON.stringify(ch)}`);
  }
});

test("measurePixelText: len*5-1, empty is 0, widest line wins", () => {
  assert.equal(measurePixelText(""), 0);
  assert.equal(measurePixelText("A"), 4);
  assert.equal(measurePixelText("AB"), 9);
  assert.equal(measurePixelText("CH1: 0.00"), 9 * GLYPH_ADVANCE - 1);
  assert.equal(measurePixelText("AB\nABCD"), 4 * GLYPH_ADVANCE - 1);
});

test("measurePixelBlockHeight", () => {
  assert.equal(measurePixelBlockHeight(0), 0);
  assert.equal(measurePixelBlockHeight(1), 5);
  assert.equal(measurePixelBlockHeight(3), 17);
});

test("lowercase maps to the uppercase glyph", () => {
  assert.deepEqual(glyphFor("a"), GLYPHS["A"]);
  assert.deepEqual(glyphFor("z"), GLYPHS["Z"]);
  assert.deepEqual(render("abc", 5, 14), render("ABC", 5, 14));
});

test("unknown characters render as the tofu outline box", () => {
  assert.deepEqual(glyphFor("あ"), TOFU_GLYPH);
  assert.deepEqual(render("あ", 5, 4), ["####", "#..#", "#..#", "#..#", "####"]);
});

// The glyph tests below are read off the in-game screenshot (page B7).
test("exact pixel pattern for \"1\" (in game)", () => {
  assert.deepEqual(render("1", 5, 4), [
    "..#.",
    ".##.",
    "..#.",
    "..#.",
    "..#."
  ]);
});

test("exact pixel pattern for \"T\" (in game: 3 columns wide)", () => {
  assert.deepEqual(render("T", 5, 4), [
    "###.",
    ".#..",
    ".#..",
    ".#..",
    ".#.."
  ]);
});

test("adjacent glyphs are separated by a 1px gap", () => {
  // "II" — the 1-wide I sits in column 1, and the advance moves 5 columns.
  assert.deepEqual(render("II", 5, 9), [
    ".#....#..",
    ".#....#..",
    ".#....#..",
    ".#....#..",
    ".#....#.."
  ]);
});

test("newline starts a fresh line LINE_HEIGHT lower at the original x", () => {
  const one = ["..#.", ".##.", "..#.", "..#.", "..#."];
  const grid = render("1\n1", 11, 4);
  assert.deepEqual(grid.slice(0, 5), one);
  assert.deepEqual(grid[5], "....");
  assert.deepEqual(grid.slice(6, 11), one);
});

test("space draws nothing but still advances", () => {
  assert.deepEqual(render(" 1", 5, 9), [
    ".......#.",
    "......##.",
    ".......#.",
    ".......#.",
    ".......#."
  ]);
});

test("fractional x/y are floored, as in game (B7: 0.5 -> 0, 42.5 -> 42)", () => {
  /** @type {number[][]} */
  const pts = [];
  drawPixelText((px, py) => pts.push([px, py]), ".", 2.6, 3.6);
  // "." is a single pixel at column 1, row 4 of its cell.
  assert.deepEqual(pts, [[3, 7]]);
});

test("backslash and backtick have the game's shapes (D10)", () => {
  assert.deepEqual(render("\\", 5, 4), ["#...", "#...", ".#..", "..#.", "..#."]);
  assert.deepEqual(render("`", 5, 4), [".#..", "..#.", "....", "....", "...."]);
});

test("wrapTextBox: counts characters and keeps the spaces (B7)", () => {
  // w=44 holds 8 characters. The game's lines keep their spaces — that is
  // what moves "wrap" and " now " to where the screenshot has them.
  assert.deepEqual(wrapTextBox("wrap this box now please", 44), ["wrap ", "this box", " now ", "please"]);
  assert.deepEqual(wrapTextBox("centred text box", 44), ["centred ", "text box"]);
  assert.deepEqual(wrapTextBox("short", 44), ["short"]);
  assert.deepEqual(wrapTextBox("abcdefghijk", 20), ["abcd", "efgh", "ijk"]);
  assert.deepEqual(wrapTextBox("ab\ncd", 44), ["ab", "cd"]);
  assert.deepEqual(wrapTextBox("", 44), [""]);
});

test("layoutTextBox: B7's centred boxes land where the game drew them", () => {
  const left = layoutTextBox("wrap this box now please", 0, 58, 44, 22, 0, 0);
  // Pen x of each line; "wrap " draws its W at 10, " now " its N at 15.
  assert.deepEqual(left.map(l => [l.x, l.y]), [[10, 57], [2, 63], [10, 69], [7, 75]]);
  const right = layoutTextBox("centred text box", 50, 58, 44, 22, 0, 0);
  assert.deepEqual(right.map(l => [l.x, l.y]), [[52, 63], [52, 69]]);
});

test("layoutTextBox: -1 / 1 align to the box's edges", () => {
  const tl = layoutTextBox("ab", 10, 20, 44, 22, -1, -1);
  assert.deepEqual(tl.map(l => [l.x, l.y]), [[10, 20]]);
  const br = layoutTextBox("ab", 10, 20, 44, 22, 1, 1);
  assert.deepEqual(br.map(l => [l.x, l.y]), [[10 + 44 - 9, 20 + 22 - 5]]);
});
