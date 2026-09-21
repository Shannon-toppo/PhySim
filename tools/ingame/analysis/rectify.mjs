// Screenshot -> 96x96 logical grid, using the green ruler as the calibration
// target: the ticks sit at known logical coordinates, so a homography fitted
// to them undoes the monitor's perspective exactly.
//
// The cards carry different rulers — A: top + left, B: top + bottom,
// C: top + bottom + left — so nothing here assumes which ones are present.
// Each ruler is found as a line of evenly spaced green clusters, its ticks
// are numbered along it, and every tick that is found goes into one fit.
import { readPNG } from "./png.mjs";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const N = 96;

export function greenClusters(im) {
  const { w, h, d } = im;
  const isG = (i) => {
    const r = d[i * 3], g = d[i * 3 + 1], b = d[i * 3 + 2];
    return g > 100 && r < g * 0.65 && b < g * 0.65;
  };
  const seen = new Uint8Array(w * h), out = [];
  for (let i = 0; i < w * h; i++) {
    if (!isG(i) || seen[i]) continue;
    const st = [i]; seen[i] = 1; const pts = [];
    while (st.length) {
      const p = st.pop(); pts.push(p);
      const x = p % w, y = (p / w) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!seen[q] && isG(q)) { seen[q] = 1; st.push(q); }
      }
    }
    out.push({
      cx: pts.reduce((s, p) => s + (p % w), 0) / pts.length,
      cy: pts.reduce((s, p) => s + ((p / w) | 0), 0) / pts.length,
      n: pts.length
    });
  }
  return out;
}

/** Least-squares homography (DLT) from logical (u,v) to image (X,Y). */
function fitHomography(pairs) {
  const A = [], b = [];
  for (const [u, v, X, Y] of pairs) {
    A.push([u, v, 1, 0, 0, 0, -u * X, -v * X]); b.push(X);
    A.push([0, 0, 0, u, v, 1, -u * Y, -v * Y]); b.push(Y);
  }
  // normal equations, Gaussian elimination
  const n = 8, M = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (let i = 0; i < A.length; i++)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) M[r][c] += A[i][r] * A[i][c];
      M[r][n] += A[i][r] * b[i];
    }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const h = M.map((row, i) => row[n] / row[i]);
  return { a: h[0], b: h[1], c: h[2], d: h[3], e: h[4], f: h[5], g: h[6], h: h[7] };
}

const map = (H, u, v) => {
  const w = H.g * u + H.h * v + 1;
  return [(H.a * u + H.b * v + H.c) / w, (H.d * u + H.e * v + H.f) / w];
};

// Tick k of each ruler (5k along it) is 2 logical px deep when 5k is a
// multiple of 10, otherwise 1. Centres in logical coordinates:
const depth = (k) => (k % 2 === 0 ? 2 : 1);
const RULERS = {
  top: (k) => [5 * k + 0.5, depth(k) / 2],
  bottom: (k) => [5 * k + 0.5, N - 2 + depth(k) / 2],
  left: (k) => [depth(k) / 2, 5 * k + 0.5],
};

/**
 * Lines of evenly spaced clusters, strongest first. A ruler is 20 ticks on
 * one line; the zigzag of 1px/2px ticks is half a logical pixel, so the
 * tolerance has to clear that and stay under the ~3px gap to a page mark.
 */
export function findLines(cl, tol) {
  const lines = [];
  let pool = cl.slice();
  for (let round = 0; round < 3; round++) {
    let best = [];
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++) {
        const dx = pool[j].cx - pool[i].cx, dy = pool[j].cy - pool[i].cy;
        const len = Math.hypot(dx, dy);
        if (len < tol * 3) continue;
        const inl = pool.filter(o => Math.abs((o.cx - pool[i].cx) * dy - (o.cy - pool[i].cy) * dx) / len < tol);
        if (inl.length > best.length) best = inl;
      }
    if (best.length < 8) break;
    lines.push(best);
    pool = pool.filter(c => !best.includes(c));
  }
  return lines;
}

/** Number the clusters of one line 0.. by position, allowing for gaps. */
export function numberAlong(line) {
  // principal direction
  const mx = line.reduce((s, c) => s + c.cx, 0) / line.length;
  const my = line.reduce((s, c) => s + c.cy, 0) / line.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const c of line) { sxx += (c.cx - mx) ** 2; syy += (c.cy - my) ** 2; sxy += (c.cx - mx) * (c.cy - my); }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(th), uy = Math.sin(th);
  const horizontal = Math.abs(ux) > Math.abs(uy);
  // orient: left-to-right for horizontal lines, top-to-bottom for vertical
  if ((horizontal && ux < 0) || (!horizontal && uy < 0)) { ux = -ux; uy = -uy; }
  const s = line.map(c => ({ c, t: (c.cx - mx) * ux + (c.cy - my) * uy })).sort((a, b) => a.t - b.t);
  const gaps = s.slice(1).map((e, i) => e.t - s[i].t);
  const med = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
  let k = 0;
  const out = [{ c: s[0].c, k: 0 }];
  for (let i = 1; i < s.length; i++) { k += Math.max(1, Math.round(gaps[i - 1] / med)); out.push({ c: s[i].c, k }); }
  return { horizontal, ticks: out, my, mx, step: med };
}

export function calibrate(path, verbose) {
  const im = readPNG(path);
  // The "A<n>" label glyphs are far larger than any tick; drop them first.
  const all = greenClusters(im).filter(c => c.n >= 12);
  const sizes = all.map(c => c.n).sort((a, b) => a - b);
  const typ = sizes[sizes.length >> 1];
  const cl = all.filter(c => c.n <= typ * 4);
  const tol = 0.6 * Math.sqrt(typ);
  const lines = findLines(cl, tol).map(numberAlong);

  // Classify. Horizontal lines: the upper one is `top`, a lower one `bottom`.
  const hz = lines.filter(l => l.horizontal).sort((a, b) => a.my - b.my);
  const vt = lines.filter(l => !l.horizontal).sort((a, b) => a.mx - b.mx);
  const found = {};
  if (hz.length) found.top = hz[0];
  if (hz.length > 1 && hz[hz.length - 1].my - hz[0].my > 10 * hz[0].step) found.bottom = hz[hz.length - 1];
  if (vt.length) found.left = vt[0];

  // A ruler's first tick is k=0 unless the screen edge hid it. Try small
  // offsets per ruler and keep the combination with the lowest residual.
  const cands = Object.entries(found);
  const offs = [0, 1, 2];
  let best = null;
  const combos = cands.reduce((acc) => acc.flatMap(a => offs.map(o => [...a, o])), [[]]);
  for (const combo of combos) {
    const pairs = [];
    cands.forEach(([name, l], i) => {
      for (const { c, k } of l.ticks) {
        const kk = k + combo[i];
        if (kk < 1 || kk > 19) continue;       // corners merge with the other ruler
        pairs.push([...RULERS[name](kk), c.cx, c.cy]);
      }
    });
    if (pairs.length < 8) continue;
    const H = fitHomography(pairs);
    const err = pairs.reduce((s, [u, v, X, Y]) => { const [x, y] = map(H, u, v); return s + Math.hypot(x - X, y - Y); }, 0) / pairs.length;
    if (!best || err < best.err) best = { H, err };
  }
  if (!best) throw new Error(`${path}: no ruler found`);
  let H = best.H;

  // Second pass: match every expected tick to the nearest cluster by predicted
  // position. Drop ticks the screen edge clipped (their centroid is pulled
  // inwards) and clusters claimed by two ticks (a corner where two rulers
  // touch and merge into one blob — its centroid belongs to neither).
  let pairs = [];
  for (let pass = 0; pass < 2; pass++) {
    const scale = Math.hypot(...[0, 1].map(i => map(H, 1, 0)[i] - map(H, 0, 0)[i]));
    const claims = new Map();
    for (const name of Object.keys(found)) {
      for (let k = 0; k <= 19; k++) {
        // Ticks at a screen corner: top/left k=0 share the origin, and left
        // k=19 (y=95) touches bottom k=0 (y=94..95). Whichever of them is
        // drawn, the blob is the other ruler's as much as this one's.
        if (k === 0 || (name === "left" && k === 19)) continue;
        const [u, v] = RULERS[name](k);
        const [X, Y] = map(H, u, v);
        let hit = null, bd = 1.5 * scale;
        for (const c of cl) {
          const dd = Math.hypot(c.cx - X, c.cy - Y);
          if (dd < bd) { bd = dd; hit = c; }
        }
        if (!hit) continue;
        const area = depth(k) * scale * scale;
        if (!claims.has(hit)) claims.set(hit, []);
        claims.get(hit).push([u, v, hit.cx, hit.cy, hit.n >= 0.6 * area && hit.n <= 1.6 * area]);
      }
    }
    pairs = [...claims.values()].filter(p => p.length === 1 && p[0][4]).map(p => p[0].slice(0, 4));
    H = fitHomography(pairs);
  }
  const scale = Math.hypot(...[0, 1].map(i => map(H, 1, 0)[i] - map(H, 0, 0)[i]));
  let worst = 0, sum = 0;
  for (const [u, v, X, Y] of pairs) {
    const [x, y] = map(H, u, v);
    const e = Math.hypot(x - X, y - Y);
    worst = Math.max(worst, e); sum += e;
    if (process.env.RECTIFY_DEBUG && e / scale > 0.1) console.error(`  tick (${u},${v}) off by ${(e / scale).toFixed(3)}px`);
  }
  const residual = sum / pairs.length / scale;
  if (verbose) {
    console.error(`rulers=${Object.keys(found).join("+")}  ticks=${pairs.length}  residual mean=${residual.toFixed(3)}px ` +
      `worst=${(worst / scale).toFixed(3)}px  (logical px = ${scale.toFixed(1)} screen px)`);
  }
  return { im, H, ticks: pairs.length, residual, worst: worst / scale };
}

/** Median of a patch covering the middle ~60% of one logical pixel. */
function sample(im, H, px, py) {
  const pts = [];
  for (let sy = 0.25; sy <= 0.75; sy += 0.25)
    for (let sx = 0.25; sx <= 0.75; sx += 0.25) {
      const [X, Y] = map(H, px + sx, py + sy);
      const x = Math.round(X), y = Math.round(Y);
      if (x < 0 || y < 0 || x >= im.w || y >= im.h) continue;
      pts.push([im.d[(y * im.w + x) * 3], im.d[(y * im.w + x) * 3 + 1], im.d[(y * im.w + x) * 3 + 2]]);
    }
  const med = (k) => {
    const v = pts.map(p => p[k]).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 0;
  };
  return [med(0), med(1), med(2)];
}

export function rectify(path, verbose) {
  const { im, H, residual } = calibrate(path, verbose);
  const grid = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) row.push(sample(im, H, x, y));
    grid.push(row);
  }
  grid.residual = residual;
  return grid;
}

// CLI only when run directly — importing this module must not write files.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2]) {
  const grid = rectify(process.argv[2], true);
  const buf = Buffer.alloc(N * N * 3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    for (let c = 0; c < 3; c++) buf[(y * N + x) * 3 + c] = grid[y][x][c];
  fs.writeFileSync(process.argv[3], Buffer.concat([Buffer.from(`P6\n${N} ${N}\n255\n`), buf]));
  console.error("wrote", process.argv[3]);
}
