// Card G (tools/ingame/verifyG_ties.lua) and the tool that reads it back
// (tools/ingame/analysis/ties.mjs) must agree on where every probe is.
//
// The card is rendered through media/raster.js — every probe at once, so a
// probe that spills onto another's pixel shows up too — with its tie t
// pushed 1/4096px up and then down (for G2, whose ties are at k - t, the
// other way round). The decoder must read all-up and all-down. With t exactly on the tie, raster.js's Math.round rounds up, as
// the Apple M5 does (doc/ingame-findings.md section 9).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardCalls } from "./helpers/cardRunner.mjs";
import { fillCircle, fillTriangle, fillRectangle } from "../media/raster.js";
import { probes, decode, RULES } from "../tools/ingame/analysis/ties.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARD = path.join(ROOT, "tools/ingame/verifyG_ties.lua");
const SIZES = [[32, 32], [96, 32], [64, 64], [96, 96], [160, 96], [288, 160]];

/** The card with its tie moved by `nudge` px (0 = the card as shot). */
function cardWith(nudge) {
  if (nudge === 0) return CARD;
  const src = fs.readFileSync(CARD, "utf8");
  assert.match(src, /^t=1\/512$/m);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "physim-g-")), "card.lua");
  fs.writeFileSync(file, src.replace(/^t=1\/512$/m, `t=1/512+(${nudge})`));
  return file;
}

/** Bright pixels of one page, drawn the way ingame.test.mjs draws them. */
function render(file, page, width, height) {
  const SCREEN = { width, height };
  const lit = new Set();
  let bright = true;
  const run = (x, y, w) => {
    for (let i = 0; i < w; i++) if (bright) lit.add(`${x + i},${y}`);
  };
  for (const [name, ...a] of cardCalls(file, page, SCREEN)) {
    const n = /** @type {number[]} */ (a);
    switch (name) {
      case "setColor": bright = n[0] >= 200 && n[1] >= 200 && n[2] >= 200; break;
      case "drawRectF": fillRectangle(run, n[0], n[1], n[2], n[3], SCREEN); break;
      case "drawTriangleF": fillTriangle(run, n[0], n[1], n[2], n[3], n[4], n[5], SCREEN); break;
      case "drawCircleF": fillCircle(run, n[0], n[1], n[2], SCREEN); break;
      case "drawClear": case "drawText": break;   // black clear; the label is green
      default: throw new Error(`page G${page}: unhandled ${name}`);
    }
  }
  return lit;
}

const pagesFor = (h) => h >= 64 ? [1, 2, 3] : [1, 2];

for (const [w, h] of SIZES) {
  for (const page of pagesFor(h)) {
    test(`card G${page} on ${w}x${h}: every probe reads back the direction it was drawn with`, () => {
      const list = probes(page, w, h);
      assert.ok(list.length > 0);
      // G2's ties are at k - t, so a larger t pushes them down.
      const flip = page === 2 ? { up: "down", down: "up" } : { up: "up", down: "down" };
      for (const [nudge, want] of [[1 / 4096, flip.up], [-1 / 4096, flip.down], [0, "up"]]) {
        const lit = render(cardWith(nudge), page, w, h);
        const got = decode(list, (x, y) => lit.has(`${x},${y}`));
        const wrong = got.filter(r => r.answer !== want).map(r => `${r.probe}@${r.value}:${r.answer}`);
        assert.deepEqual(wrong, [], `t nudged by ${nudge}`);
      }
    });
  }
}

test("card G: every probe pixel is on screen and clear of the rulers and label", () => {
  for (const [w, h] of SIZES) {
    for (const page of pagesFor(h)) {
      for (const p of probes(page, w, h)) {
        for (const [x, y] of p.pixels) {
          assert.ok(x >= 2 && x < w && y >= 2 && y < h - 2, `G${page} ${w}x${h} ${p.probe} (${x},${y})`);
          assert.ok(!(x >= 4 && x <= 11 && y >= 3 && y <= 7), `G${page} ${p.probe} on the label`);
        }
      }
    }
  }
});

test("card G: G1 and G2 test every whole value in range, G3 all but the last few", () => {
  const values = (page, w, h, probe) => new Set(probes(page, w, h).filter(p => p.probe === probe).map(p => Math.round(p.value)));
  for (const probe of ["a", "b", "c", "d"]) assert.equal(values(1, 96, 96, probe).size, 96 - 5);
  for (const probe of ["a", "b", "c", "d"]) assert.equal(values(2, 96, 96, probe).size, 96 - 13);
  const g3 = new Set([...values(3, 96, 96, "L"), ...values(3, 96, 96, "R")]);
  for (let v = 3; v <= 96 - 7; v++) assert.ok(g3.has(v), `G3 misses ${v}`);
});

test("card G: half-to-even says down for x = k + 1/512 and up for y = k - 1/512", () => {
  const even = RULES["half to even"];
  for (const p of probes(1, 96, 96)) assert.equal(even(p), "down");
  for (const p of probes(2, 96, 96)) assert.equal(even(p), "up");
});
