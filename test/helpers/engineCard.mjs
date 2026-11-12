// Runs one page of an in-game verification card (tools/ingame/verify*.lua)
// on Storm Lua Engine — the engine the extension runs microcontrollers on —
// and returns the frame it rasterised. The card is the same file pasted into
// the game, so the test replays exactly what was photographed rather than a
// hand-copied transcription of it.
//
// Every card reads `input.getNumber(32)` in onTick() as "jump to this page",
// so a page is one tick with that input set, then one onDraw at the monitor's
// size. Needs `npm run compile` (out/engine/loadEngine.js).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../../out/engine/loadEngine.js");

const engine = await loadEngine();

/**
 * @param {string} file path to the card's .lua
 * @param {number} page
 * @param {{ width: number, height: number }} size the monitor
 * @param {string} [source] the card's text, when a test has edited it
 * @returns {Uint8Array} the "game-rgba8" frame, width*height*4 bytes
 */
export function cardFrame(file, page, { width, height }, source) {
  const vm = engine.createVehicle();
  try {
    const step = (what, outcome) => {
      if (outcome !== "completed") throw new Error(`${path.basename(file)} page ${page}: ${what} ${outcome}`);
    };
    step("load", vm.load(source ?? readFileSync(file), path.basename(file)));
    vm.io.inputNumbers[31] = page;
    step("onTick", vm.tick());
    step("onDraw", vm.draw(width, height));
    return vm.frame().copy();
  } finally {
    vm.dispose();
  }
}

/**
 * Where to binarise a frame the way the fixture binarised the screenshots
 * (test/fixtures/ingame-raster.json, luminance over 150 on the photo). The
 * photo's luminance went through the game's tone curve and scene lighting,
 * so it has no exact counterpart on frame values; what has to hold is that
 * the dim green rulers and labels (0,90,0 — luminance 52.8) stay dark and the
 * dimmest white that the screenshots show lit stays lit: B5's a=128 outline
 * over opaque black, which the game shows as 128 × 191/255 = 95.9. Every
 * value from 53 to 95 gives the same result on all fixture pages; this is
 * the middle of that window, not a fitted constant.
 */
export const LIT_LUMINANCE = 74;

/**
 * The pixels of a frame the monitor shows bright: luminance of rgb × alpha,
 * which is what the game displays (doc/ingame-findings.md, D9 and B4) and
 * what the panel shows over its black canvas background.
 * @param {Uint8Array} px
 * @param {number} width @param {number} height
 * @returns {Set<string>} "x,y"
 */
export function litPixels(px, width, height) {
  const lit = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * px[i + 3] / 255;
      if (lum > LIT_LUMINANCE) lit.add(`${x},${y}`);
    }
  }
  return lit;
}
