// Rectified screenshot vs canon render: binarise both, print the diff.
import { rectify } from "./rectify.mjs";
import fs from "node:fs";

function loadPPM(p) {
  const b = fs.readFileSync(p);
  let i = 0, f = [], t = "";
  while (f.length < 4) { const c = String.fromCharCode(b[i++]); if (/\s/.test(c)) { if (t) { f.push(t); t = ""; } } else t += c; }
  const w = +f[1], h = +f[2], d = b.subarray(i);
  const g = [];
  for (let y = 0; y < h; y++) { const r = []; for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; r.push([d[o], d[o + 1], d[o + 2]]); } g.push(r); }
  return g;
}

const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
// The screenshot has bloom and JPEG ringing; the canon is exact. A lit pixel
// on the monitor is far brighter than the black background either way.
const on = (p, th) => lum(p) > th;
// Ignore the rulers (top and bottom two rows, left two columns) and the page label.
const isRuler = (x, y) => x < 2 || y < 2 || y >= 94 || (y >= 3 && y <= 8 && x >= 3 && x <= 16);

const shot = rectify(process.argv[2], true);
const canon = loadPPM(process.argv[3]);
const TH = +(process.argv[4] ?? 90);

let diff = 0, shotOn = 0, canonOn = 0;
const rows = [];
for (let y = 0; y < 96; y++) {
  let r = "";
  for (let x = 0; x < 96; x++) {
    if (isRuler(x, y)) { r += " "; continue; }
    const a = on(shot[y][x], TH), b = on(canon[y][x], TH);
    if (a) shotOn++;
    if (b) canonOn++;
    if (a && b) r += "#";
    else if (a) r += "G";        // game only
    else if (b) r += "C";        // canon only
    else r += ".";
    if (a !== b) diff++;
  }
  rows.push(r);
}
console.log(`実機点灯=${shotOn}  正典点灯=${canonOn}  不一致=${diff}`);
console.log("凡例: # 一致(点灯)  G 実機のみ  C 正典のみ  . 一致(消灯)");
const from = rows.findIndex(r => /[#GC]/.test(r));
const to = rows.length - 1 - [...rows].reverse().findIndex(r => /[#GC]/.test(r));
rows.slice(Math.max(0, from - 1), to + 2).forEach((r, i) => console.log(String(Math.max(0, from - 1) + i).padStart(2) + " " + r));
