// Print a rectified screenshot as text: # lit, + dim (rulers, labels), . off.
//   node show.mjs <shot.png> [threshold=90] [fromRow] [toRow]
// The monitor's size comes from the file name, as in rectify.mjs.
import { rectify } from "./rectify.mjs";
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const th = +(process.argv[3] ?? 90);
const g = rectify(process.argv[2], false);
const rows = [];
for (let y = 0; y < g.height; y++) {
  let s = "";
  for (let x = 0; x < g.width; x++) s += lum(g[y][x]) > th ? "#" : (lum(g[y][x]) > 25 ? "+" : ".");
  rows.push(s);
}
const from = +(process.argv[4] ?? 0), to = +(process.argv[5] ?? g.height - 1);
const pad = String(g.height - 1).length;
console.log(" ".repeat(pad + 1) + "0123456789".repeat(Math.ceil(g.width / 10)).slice(0, g.width));
rows.slice(from, to + 1).forEach((r, i) => console.log(String(from + i).padStart(pad) + " " + r));
