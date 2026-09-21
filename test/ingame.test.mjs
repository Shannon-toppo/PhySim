// The monitor, page by page, against the real game.
//
// test/fixtures/ingame-raster.json holds the lit pixels of Stormworks monitor
// screenshots (tools/ingame/, Apple M5 and RTX 4070Ti — identical wherever
// both were shot). Each test runs the same page of the same card script
// (tools/ingame/verify*.lua, in fengari) and draws its white calls through
// media/raster.js and media/pixelFont.js — the code the panel uses — and
// demands an exact match. Regenerate the fixture with
// tools/ingame/analysis/export-fixture.mjs; doc/ingame-findings.md explains
// the rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cardCalls } from "./helpers/cardRunner.mjs";
import {
  strokeLine, strokeCircle, fillCircle, strokeTriangle, fillTriangle,
  strokeRectangle, fillRectangle
} from "../media/raster.js";
import { drawPixelText, layoutTextBox } from "../media/pixelFont.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARDS = {
  A: "tools/ingame/verifyA_shapes.lua",
  B: "tools/ingame/verifyB_color.lua",
  C: "tools/ingame/verifyC_circle.lua",
  D: "tools/ingame/verifyD_open.lua",
};
const SCREEN = { width: 96, height: 96 };
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/ingame-raster.json"), "utf8"));

// The screenshot can't see under the ruler ticks or the page label.
const masked = (x, y) => x < 2 || y < 2 || y >= 94 || (x >= 3 && x <= 16 && y >= 3 && y <= 8);

/**
 * Pixels a page lights in a bright colour. The rulers, labels and reference
 * dots are dim green, below the fixture's brightness threshold, so they are
 * skipped here the same way.
 * @param {string} page e.g. "D4"
 */
function render(page) {
  const lit = new Set();
  let bright = true;
  const plot = (x, y) => {
    if (bright && x >= 0 && y >= 0 && x < SCREEN.width && y < SCREEN.height && !masked(x, y)) lit.add(`${x},${y}`);
  };
  const run = (x, y, w) => { for (let i = 0; i < w; i++) plot(x + i, y); };
  for (const [name, ...a] of cardCalls(path.join(ROOT, CARDS[page[0]]), Number(page.slice(1)))) {
    const n = /** @type {number[]} */ (a);
    switch (name) {
      case "setColor": bright = n[0] >= 200 && n[1] >= 200 && n[2] >= 200; break;
      case "drawLine": strokeLine(plot, n[0], n[1], n[2], n[3], SCREEN); break;
      case "drawCircle": strokeCircle(plot, n[0], n[1], n[2], SCREEN); break;
      case "drawCircleF": fillCircle(run, n[0], n[1], n[2], SCREEN); break;
      case "drawTriangle": strokeTriangle(plot, n[0], n[1], n[2], n[3], n[4], n[5], SCREEN); break;
      case "drawTriangleF": fillTriangle(run, n[0], n[1], n[2], n[3], n[4], n[5], SCREEN); break;
      case "drawRect": strokeRectangle(plot, n[0], n[1], n[2], n[3], SCREEN); break;
      case "drawRectF": fillRectangle(run, n[0], n[1], n[2], n[3], SCREEN); break;
      case "drawText": drawPixelText(plot, String(a[2]), n[0], n[1]); break;
      case "drawTextBox":
        for (const l of layoutTextBox(String(a[4]), n[0], n[1], n[2], n[3], n[5], n[6])) {
          drawPixelText(plot, l.text, l.x, l.y);
        }
        break;
      case "drawClear": break;          // every card clears to black
      default: throw new Error(`page ${page}: unhandled ${name}`);
    }
  }
  return lit;
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
