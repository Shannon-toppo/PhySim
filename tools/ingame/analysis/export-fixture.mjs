// Screenshots -> test/fixtures/ingame-raster.json: the lit pixels of every
// page whose content is white shapes or text, as horizontal runs.
// test/ingame.test.mjs runs the same card page through media/raster.js and
// media/pixelFont.js and compares.
//
//   node tools/ingame/analysis/export-fixture.mjs <macPngDir> <winPngDir> <out.json>
//
// Where both platforms were shot they must agree pixel for pixel; a page whose
// mean calibration residual is above RESIDUAL_LIMIT is refused rather than
// exported.
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
// F3 is left out: Apple M5 and RTX 4070Ti disagree on its exact 1/512px ties
// (17 pixels, doc/ingame-findings.md section 9), and which one the panel
// should follow is still being investigated.
const OPTIONAL = /^(E[1-7]|F[124569])$/;
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
const list = pageList([macDir, winDir]);
for (const p of list) {
  const shots = [macDir, winDir].map(d => path.join(d, `${p}.png`)).filter(f => fs.existsSync(f));
  if (!shots.length) throw new Error(`${p}: no screenshot`);
  const all = shots.map(runs);
  if (all.some(r => JSON.stringify(r) !== JSON.stringify(all[0]))) throw new Error(`${p}: Apple M5 and RTX 4070Ti disagree`);
  pages[p] = all[0];
}
const fixture = {
  source: "Stormworks v1.15.23 monitor screenshots (tools/ingame/image/{appleM5,RTX4070Ti}), " +
    "rectified by tools/ingame/analysis/rectify.mjs; identical wherever both platforms were shot",
  threshold: TH,
  size: "from the page key (tools/ingame/analysis/screen.mjs): D4 is 96x96, E2_5x3 is 160x96",
  runs: "[y, x0, x1] inclusive",
  pages
};
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 0).replace(/\],\[/g, "],\n[") + "\n");
console.error(`wrote ${outPath}: ${list.length} pages`);
