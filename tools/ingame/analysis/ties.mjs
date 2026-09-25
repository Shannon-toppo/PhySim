// Card G (tools/ingame/verifyG_ties.lua) -> which way each 1/512px tie
// rounded. Every probe on the card lights a known pixel (or a short run of
// them) for one direction and nothing for the other, so a shot reads back as
// one up/down answer per probe.
//
//   node tools/ingame/analysis/ties.mjs <G1.png> [G2.png G3.png ...]
//
// Prints, per page, the answers by value and probe, and how far they are
// from three rules: every tie up (the Apple M5's x ties), round-half-to-even
// (x = k + 1/512 always down, y = k - 1/512 always up), and media/raster.js,
// whose snapUnits() models the RTX 4070Ti's vertex path and was fitted to
// this card (doc/ingame-findings.md section 10).
//
// test/ties.test.mjs renders the card through media/raster.js with the ties
// pushed up and then down and checks this file reads back all-up and
// all-down, so the layout here and in the Lua can't drift apart.
import { rectify } from "./rectify.mjs";
import { parsePage } from "./screen.mjs";
import { snapUnits } from "../../../media/raster.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} Probe
 * @property {string} probe  a, b, ... as in the card's comments
 * @property {"x"|"y"} axis
 * @property {number} value  the tie, in script coordinates
 * @property {number} size   the monitor's width for x, height for y
 * @property {"up"|"down"} litWhen
 * @property {[number, number][]} pixels
 */

const T = 1 / 512;

/**
 * The probes one page of card G draws, for a monitor of the given size.
 * @param {number} page 1..3 @param {number} W @param {number} H
 * @returns {Probe[]}
 */
export function probes(page, W, H) {
  /** @type {Probe[]} */
  const out = [];
  const add = (probe, axis, value, litWhen, pixels) =>
    out.push({ probe, axis, value, size: axis === "x" ? W : H, litWhen, pixels });
  const rows = (x, y0, n) => Array.from({ length: n }, (_, i) => /** @type {[number, number]} */ ([x, y0 + i]));
  const cols = (x0, y, n) => Array.from({ length: n }, (_, i) => /** @type {[number, number]} */ ([x0 + i, y]));
  if (page === 1) {
    for (let k = 3; k <= W - 3; k++) {
      add("a", "x", k + T, "down", rows(k, 8, 3));
      add("b", "x", k + T, "up", rows(k, 12, 3));
      add("c", "x", k + T, "down", rows(k, 16, 3));
      add("d", "x", k + T, "down", rows(k, H - 7, 3));
    }
    for (let k = 7; k <= W - 3; k++) {
      add("eL", "x", k - 4 + T, "down", [[k - 4, 20 + k % 5]]);
      add("eR", "x", k + T, "up", [[k, 20 + k % 5]]);
    }
  } else if (page === 2) {
    for (let k = 11; k <= H - 3; k++) {
      add("a", "y", k - T, "down", cols(4, k - 1, 3));
      add("b", "y", k - T, "up", cols(8, k - 1, 3));
      add("c", "y", k - T, "up", cols(12, k - 1, 3));
      add("d", "y", k - T, "down", cols(W - 6, k - 1, 3));
    }
    for (let k = 15; k <= H - 3; k++) {
      add("eT", "y", k - 4 - T, "down", [[17 + k % 5, k - 5]]);
      add("eB", "y", k - T, "up", [[17 + k % 5, k - 1]]);
    }
  } else if (page === 3) {
    for (let b = 0; b <= 5; b++) {
      const cy = 13 + b * 8;
      for (let k = 3 + b; k <= W - 7; k += 12) {
        add("L", "x", k + T, "down", [[k, cy]]);
        add("R", "x", k + 6 + T, "up", [[k + 6, cy]]);
      }
    }
  } else throw new Error(`card G has no page ${page}`);
  return out;
}

/**
 * Read the answers off a lit-pixel predicate. A probe whose pixels disagree
 * among themselves comes back as "mixed" rather than being outvoted.
 * @param {Probe[]} list
 * @param {(x: number, y: number) => boolean} lit
 */
export function decode(list, lit) {
  return list.map(p => {
    const on = p.pixels.map(([x, y]) => lit(x, y));
    const all = on.every(Boolean), none = !on.some(Boolean);
    const other = p.litWhen === "up" ? "down" : "up";
    return { ...p, answer: all ? p.litWhen : none ? other : "mixed" };
  });
}

/** What each candidate rule says for one tie. */
export const RULES = {
  "raster.js (RTX 4070Ti model)": (/** @type {Probe} */ p) => snapUnits(p.value, p.size) / 256 > p.value ? "up" : "down",
  "all up": () => "up",
  "half to even": (/** @type {Probe} */ p) => {
    const s = p.value * 256, f = Math.floor(s);
    return f % 2 === 0 ? "down" : "up";
  },
};

const TH = 150;
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

function report(file) {
  const name = path.basename(file).replace(/\.png$/, "");
  const { card, page, width, height } = parsePage(name);
  if (card !== "G") throw new Error(`${name}: not a card G page`);
  const g = rectify(file, false);
  const list = probes(page, width, height);
  const res = decode(list, (x, y) => lum(g[y][x]) > TH);
  // How clean the threshold was: the dimmest pixel read as lit and the
  // brightest read as dark, over every probe pixel.
  let minOn = 255, maxOff = 0;
  for (const p of list) for (const [x, y] of p.pixels) {
    const v = lum(g[y][x]);
    if (v > TH) minOn = Math.min(minOn, v); else maxOff = Math.max(maxOff, v);
  }
  console.log(`${name}: ${width}x${height}, residual ${g.residual.toFixed(3)}px, ` +
    `probe pixels lit >= ${minOn.toFixed(0)}, dark <= ${maxOff.toFixed(0)}`);

  const names = [...new Set(res.map(r => r.probe))];
  const byValue = new Map();
  for (const r of res) {
    if (!byValue.has(r.value)) byValue.set(r.value, {});
    byValue.get(r.value)[r.probe] = r.answer;
  }
  const sym = (a) => a === "up" ? "U" : a === "down" ? "D" : a ? "?" : " ";
  const fmt = (v) => (res[0].axis === "x" ? `${Math.round(v - T)}+1/512` : `${Math.round(v + T)}-1/512`).padStart(10);
  console.log(`  ${"value".padStart(10)}  ${names.map(n => n.padEnd(2)).join(" ")}`);
  for (const [v, a] of [...byValue].sort((p, q) => p[0] - q[0])) {
    const cells = names.map(n => sym(a[n]).padEnd(2));
    const answers = Object.values(a);
    const flag = answers.every(x => x === answers[0]) ? "" : "  <- probes disagree";
    console.log(`  ${fmt(v)}  ${cells.join(" ")}${flag}`);
  }
  for (const [rule, f] of Object.entries(RULES)) {
    const off = res.filter(r => r.answer !== f(r));
    console.log(`  ${rule}: ${off.length} of ${res.length} probes differ`);
  }
  const mixed = res.filter(r => r.answer === "mixed");
  if (mixed.length) console.log(`  mixed (pixels of one probe disagree): ${mixed.map(r => `${r.probe}@${fmt(r.value).trim()}`).join(" ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: ties.mjs <G1.png> [G2.png ...]");
    process.exit(1);
  }
  for (const f of files) report(f);
}
