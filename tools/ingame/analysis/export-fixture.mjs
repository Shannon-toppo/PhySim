// Screenshots -> test/fixtures/ingame-raster.json: the lit pixels of every
// page whose content is white shapes or text, as horizontal runs.
// test/ingame.test.mjs runs the same card page through media/raster.js and
// media/pixelFont.js and compares.
//
//   node tools/ingame/analysis/export-fixture.mjs <macPngDir> <winPngDir> <out.json>
//
// Where both platforms were shot they must agree pixel for pixel; a page whose
// calibration residual is above 0.05px is refused rather than exported.
import { rectify } from "./rectify.mjs";
import fs from "node:fs";
import path from "node:path";

// C5/C6 are left out: on the day they were shot the in-game script showed
// C6's radii on C5 and C9's fills on C6 (see doc/ingame-findings.md); D1
// retakes C5. B1-B4 and D9 are colour pages. The D card was shot on Windows
// only — shapes are known to be identical on both.
const PAGES = ["A1", "A2", "A3", "A4", "A5", "A6", "B5", "B6", "B7",
  "C1", "C2", "C3", "C4", "C7", "C8", "C9",
  "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D10", "D11", "D12"];
const TH = 150;
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
// ruler ticks (top, bottom, left) and the "A1" page label
const masked = (x, y) => x < 2 || y < 2 || y >= 94 || (x >= 3 && x <= 16 && y >= 3 && y <= 8);

function runs(png) {
  const g = rectify(png, false);
  if (!(g.residual <= 0.05)) throw new Error(`${png}: residual ${g.residual.toFixed(3)}px — calibration not trusted`);
  const out = [];
  for (let y = 0; y < 96; y++) {
    let start = -1;
    for (let x = 0; x <= 96; x++) {
      const on = x < 96 && !masked(x, y) && lum(g[y][x]) > TH;
      if (on && start < 0) start = x;
      if (!on && start >= 0) { out.push([y, start, x - 1]); start = -1; }
    }
  }
  return out;
}

const [macDir, winDir, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: export-fixture.mjs <macPngDir> <winPngDir> <out.json>");
  process.exit(1);
}
const pages = {};
for (const p of PAGES) {
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
  mask: "x<2 || y<2 || y>=94 || (3<=x<=16 && 3<=y<=8)",
  runs: "[y, x0, x1] inclusive",
  pages
};
fs.writeFileSync(outPath, JSON.stringify(fixture, null, 0).replace(/\],\[/g, "],\n[") + "\n");
console.error(`wrote ${outPath}: ${PAGES.length} pages`);
