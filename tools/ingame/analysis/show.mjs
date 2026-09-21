import { rectify } from "./rectify.mjs";
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const th = +(process.argv[3] ?? 90);
const g = rectify(process.argv[2], false);
const rows = [];
for (let y = 0; y < 96; y++) {
  let s = "";
  for (let x = 0; x < 96; x++) s += lum(g[y][x]) > th ? "#" : (lum(g[y][x]) > 25 ? "+" : ".");
  rows.push(s);
}
const from = +(process.argv[4] ?? 0), to = +(process.argv[5] ?? 95);
console.log("   " + "0123456789".repeat(10).slice(0, 96));
rows.slice(from, to + 1).forEach((r, i) => console.log(String(from + i).padStart(2) + " " + r));
