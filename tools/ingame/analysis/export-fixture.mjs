// Screenshots -> test/fixtures/ingame-raster.json: the lit pixels of every
// page whose content is white shapes or text, as horizontal runs.
// test/ingame.test.mjs runs the same card page through media/raster.js and
// media/pixelFont.js and compares.
//
//   node tools/ingame/analysis/export-fixture.mjs <macPngDir> <winPngDir> <out.json>
//
// Where both platforms were shot they must agree pixel for pixel — except on
// the TIE_PAGES, see below; a page whose mean calibration residual is above
// RESIDUAL_LIMIT is refused rather than exported.
//
// A page's key is its screenshot's name, which also gives the monitor it was
// shot on (screen.mjs): "D4" is a 3x3, "E2_5x3" page E2 on a 5x3 (160x96).
//
// Nothing is masked. The green rulers and page labels peak at luminance ~137,
// under the threshold, and a white pixel drawn over a tick is lit like any
// other (B6, B7, D10 and D12 draw on the ruler rows and columns).
import { rectify } from "./rectify.mjs";
import { parsePage, isPageName } from "./screen.mjs";
import fs from "node:fs";
import path from "node:path";

// Pages every export must include. C5/C6 are left out: on the day they were
// shot the in-game script showed C6's radii on C5 and C9's fills on C6 (see
// doc/ingame-findings.md); D1 retakes C5. B1-B4 and D9 are colour pages. The
// D card was shot on Windows only — shapes are known to be identical on both.
const PAGES = ["A1", "A2", "A3", "A4", "A5", "A6", "B5", "B6", "B7",
  "C1", "C2", "C3", "C4", "C7", "C8", "C9",
  "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D10", "D11", "D12"];
// Card E is taken as it comes: E1-E4 on whatever monitors were shot
// ("E2_2x1.png", "E2_9x5.png", ...; a bare "E2.png" is a 3x3), E5-E7 on a 3x3.
// Card F likewise, whichever pages were shot; F7 and F8 are colour pages.
// Card G too (G1 and G2 on any monitor, G3 on a 3x3).
const OPTIONAL = /^(E[1-7]|F[1-69]|G[1-3])$/;
// Pages that put vertices exactly on a 1/512px tie. The Apple M5 and the
// RTX 4070Ti round those differently (doc/ingame-findings.md sections 9 and
// 10) and PhySim follows the RTX 4070Ti, so these take the Windows shot and
// only report how far the Mac one is from it.
const TIE_PAGES = /^(F3|G[1-3])$/;
const TH = 150;
// rectify.mjs samples the middle half of each logical pixel (0.25..0.75), so
// a fit off by well under 0.25px cannot pull a sample into the neighbour.
// 3x3 shots come in at 0.01-0.035px; a 9x5 (about 5 screen px per logical
// px) at 0.06px, worst tick 0.135px, and still matches pixel for pixel.
const RESIDUAL_LIMIT = 0.1;
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

function runs(png) {
  const g = rectify(png, false);
  if (!(g.residual <= RESIDUAL_LIMIT)) throw new Error(`${png}: residual ${g.residual.toFixed(3)}px — calibration not trusted`);
  const out = [];
  for (let y = 0; y < g.height; y++) {
    let start = -1;
    for (let x = 0; x <= g.width; x++) {
      const on = x < g.width && lum(g[y][x]) > TH;
      if (on && start < 0) start = x;
      if (!on && start >= 0) { out.push([y, start, x - 1]); start = -1; }
    }
  }
  return out;
}

/** Pages to export: the required list, then every card-E/F shot found. */
function pageList(dirs) {
  const found = new Set();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const name = f.replace(/\.png$/, "");
      if (f.endsWith(".png") && isPageName(name) && OPTIONAL.test(name.replace(/_.*/, ""))) found.add(name);
    }
  }
  const order = (a, b) => {
    const p = parsePage(a), q = parsePage(b);
    return p.card.localeCompare(q.card) || p.page - q.page || p.width * p.height - q.width * q.height;
  };
  return [...PAGES, ...[...found].sort(order)];
}

const [macDir, winDir, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: export-fixture.mjs <macPngDir> <winPngDir> <out.json>");
  process.exit(1);
}
const pages = {};
const isTie = (p) => TIE_PAGES.test(p.replace(/_.*/, ""));
// A 3x3 page may be named with or without its size ("G1" / "G1_3x3").
const aliases = (p) => p.endsWith("_3x3") ? [p, p.replace(/_3x3$/, "")] : [p, `${p}_3x3`];
const shotIn = (d, p) => aliases(p).map(n => path.join(d, `${n}.png`)).find(f => fs.existsSync(f));
const pixels = (r) => new Set(r.flatMap(([y, x0, x1]) => Array.from({ length: x1 - x0 + 1 }, (_, i) => `${x0 + i},${y}`)));
// One key per page: a 3x3 found under both names ("G1" on the Mac, "G1_3x3"
// on Windows) is exported once, under the Windows name.
const has = (d, n) => fs.existsSync(path.join(d, `${n}.png`));
const keyOf = (p) => aliases(p).find(n => has(winDir, n)) ?? aliases(p).find(n => has(macDir, n)) ?? p;
const list = [...new Set(pageList([macDir, winDir]).map(keyOf))];
for (const p of list) {
  const mac = shotIn(macDir, p), win = shotIn(winDir, p);
  if (isTie(p)) {
    if (!win) { console.error(`${p}: tie page with no RTX 4070Ti shot, skipped`); continue; }
    pages[p] = runs(win);
    if (mac) {
      const a = pixels(runs(mac)), b = pixels(pages[p]);
      const off = [...a].filter(k => !b.has(k)).length + [...b].filter(k => !a.has(k)).length;
      console.error(`${p}: tie page, the Apple M5 shot differs by ${off} pixels; using the RTX 4070Ti one`);
    }
    continue;
  }
  const all = [mac, win].filter(Boolean).map(runs);
  if (!all.length) throw new Error(`${p}: no screenshot`);
  if (all.some(r => JSON.stringify(r) !== JSON.stringify(all[0]))) throw new Error(`${p}: Apple M5 and RTX 4070Ti disagree`);
  pages[p] = all[0];
}
const fixture = {
  source: "Stormworks v1.15.23 monitor screenshots (tools/ingame/image/{appleM5,RTX4070Ti}), " +
    "rectified by tools/ingame/analysis/rectify.mjs; identical wherever both platforms were shot, " +
    "except the 1/512px tie pages (F3, G), which are the RTX 4070Ti's",
  threshold: TH,
  size: "from the page key (tools/ingame/analysis/screen.mjs): D4 is 96x96, E2_5x3 is 160x96",
  runs: "[y, x0, x1] inclusive",
  pages
};
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 0).replace(/\],\[/g, "],\n[") + "\n");
console.error(`wrote ${outPath}: ${Object.keys(pages).length} pages`);
