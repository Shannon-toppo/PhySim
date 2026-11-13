// Card G (tools/ingame/verifyG_ties.lua) and the tool that reads it back
// (tools/ingame/analysis/ties.mjs) must agree on where every probe is.
//
// The card is rendered on Storm Lua Engine — every probe at once, so a probe
// that spills onto another's pixel shows up too — with its tie t pushed
// 1/4096px up and then down (for G2, whose ties are at k - t, the other way
// round). The decoder must read all-up and all-down. With t exactly on the
// tie it must read what the reader's RTX 4070Ti model predicts (snapUnits in
// ties.mjs), which is how the RTX 4070Ti rounded every tie on the card
// (doc/ingame-findings.md section 10) and what the engine's screen contract
// follows.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardFrame, litPixels } from "./helpers/engineCard.mjs";
import { probes, decode, RULES } from "../tools/ingame/analysis/ties.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARD = path.join(ROOT, "tools/ingame/verifyG_ties.lua");
const SIZES = [[32, 32], [96, 32], [64, 64], [96, 96], [160, 96], [288, 160]];

/** The card's text with its tie moved by `nudge` px (0 = the card as shot). */
function cardWith(nudge) {
  const src = fs.readFileSync(CARD, "utf8");
  if (nudge === 0) return src;
  assert.match(src, /^t=1\/512$/m);
  return src.replace(/^t=1\/512$/m, `t=1/512+(${nudge})`);
}

/** Bright pixels of one page, binarised the way ingame.test.mjs does it. */
function render(source, page, width, height) {
  const px = cardFrame(CARD, page, { width, height }, source);
  return litPixels(px, width, height);
}

const pagesFor = (h) => h >= 64 ? [1, 2, 3] : [1, 2];

for (const [w, h] of SIZES) {
  for (const page of pagesFor(h)) {
    test(`card G${page} on ${w}x${h}: every probe reads back the direction it was drawn with`, () => {
      const list = probes(page, w, h);
      assert.ok(list.length > 0);
      // G2's ties are at k - t, so a larger t pushes them down.
      const flip = page === 2 ? { up: "down", down: "up" } : { up: "up", down: "down" };
      const model = RULES["RTX 4070Ti model"];
      for (const [nudge, want] of [[1 / 4096, () => flip.up], [-1 / 4096, () => flip.down], [0, model]]) {
        const lit = render(cardWith(nudge), page, w, h);
        const got = decode(list, (x, y) => lit.has(`${x},${y}`));
        const wrong = got.filter(r => r.answer !== want(r)).map(r => `${r.probe}@${r.value}:${r.answer}`);
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
