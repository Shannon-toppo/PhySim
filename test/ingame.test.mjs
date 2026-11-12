// The monitor, page by page, against the real game.
//
// test/fixtures/ingame-raster.json holds the lit pixels of Stormworks monitor
// screenshots (tools/ingame/, Apple M5 and RTX 4070Ti — identical wherever
// both were shot). A page's key names the monitor too: "D4" is a 3x3
// (96x96), "E2_5x3" page E2 on a 5x3 (160x96) — see
// tools/ingame/analysis/screen.mjs. Each test runs the same page of the same
// card script (tools/ingame/verify*.lua) on Storm Lua Engine at that size —
// the engine and rasteriser the extension uses — and demands an exact match
// with the frame binarised the way the screenshots were (helpers/engineCard.mjs).
// Regenerate the fixture with tools/ingame/analysis/export-fixture.mjs;
// doc/ingame-findings.md explains the rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cardFrame, litPixels } from "./helpers/engineCard.mjs";
import { parsePage } from "../tools/ingame/analysis/screen.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARDS = {
  A: "tools/ingame/verifyA_shapes.lua",
  B: "tools/ingame/verifyB_color.lua",
  C: "tools/ingame/verifyC_circle.lua",
  D: "tools/ingame/verifyD_open.lua",
  E: "tools/ingame/verifyE_sizes.lua",
  F: "tools/ingame/verifyF_gaps.lua",
  G: "tools/ingame/verifyG_ties.lua",
};
// The cards are pasted into the in-game editor as they are, and the game
// can't take multi-byte characters.
for (const [card, file] of Object.entries(CARDS)) {
  test(`card ${card} is ASCII only`, () => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const bad = text.split("\n").flatMap((l, i) => /[^\p{ASCII}]/u.test(l) ? [`${file}:${i + 1}`] : []);
    assert.deepEqual(bad, []);
  });
}

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/ingame-raster.json"), "utf8"));

/**
 * Pixels a page lights brightly. The cards' rulers, labels and reference
 * dots are dim green, under the threshold the
 * same way they were under the screenshots' — nothing is masked, so a white
 * pixel drawn over a ruler tick counts like any other.
 * @param {string} page e.g. "D4", "E2_5x3"
 */
function render(page) {
  const { card, page: pageNo, width, height } = parsePage(page);
  const px = cardFrame(path.join(ROOT, CARDS[card]), pageNo, { width, height });
  return litPixels(px, width, height);
}

for (const [page, runs] of Object.entries(fixture.pages)) {
  test(`in game: page ${page} matches the screenshot pixel for pixel`, () => {
    const want = new Set();
    for (const [y, x0, x1] of runs) for (let x = x0; x <= x1; x++) want.add(`${x},${y}`);
    const got = render(page);
    const missing = [...want].filter(k => !got.has(k));
    const extra = [...got].filter(k => !want.has(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });
}
