// src/agent/png.ts: the monitor picture as a PNG. The test decodes the file
// itself — signature, chunk CRCs, IHDR, the inflated scanlines — rather than
// trusting a decoder that might forgive what a strict one would not.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { crc32, inflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { encodePng, fitPngScale, MAX_PNG_SCALE } = require("../out/agent/png.js");

function picture(width, height, fill = () => [0, 0, 0, 0]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(fill(x, y), (y * width + x) * 4);
  return { width, height, pixels };
}

/** Walk the chunks, checking each CRC; returns IHDR's fields and the RGB rows. */
function decode(png) {
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const length = png.readUInt32BE(o);
    const type = png.toString("latin1", o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + length);
    assert.equal(png.readUInt32BE(o + 8 + length), crc32(png.subarray(o + 4, o + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, data });
    o += 12 + length;
  }
  assert.deepEqual(chunks.map(c => c.type), ["IHDR", "IDAT", "IEND"]);
  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  assert.deepEqual([ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]], [8, 2, 0, 0, 0], "8-bit truecolour, no interlace");
  assert.equal(chunks[2].data.length, 0);
  const raw = inflateSync(chunks[1].data);
  const stride = 1 + width * 3;
  assert.equal(raw.length, stride * height);
  const rows = [];
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, `row ${y} uses filter 0`);
    const row = [];
    for (let x = 0; x < width; x++) row.push(Array.from(raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)));
    rows.push(row);
  }
  return { width, height, rows };
}

const COLORS = (x, y) => [x * 80, y * 100, 255 - x * 40, 255];

test("scale 1: one image pixel per monitor pixel, in row order", () => {
  const p = picture(3, 2, COLORS);
  const png = decode(encodePng(p, 1));
  assert.deepEqual([png.width, png.height], [3, 2]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) assert.deepEqual(png.rows[y][x], COLORS(x, y).slice(0, 3));
});

test("scale 3 on a non-square picture: every pixel becomes a 3x3 block", () => {
  const p = picture(4, 2, COLORS);
  const png = decode(encodePng(p, 3));
  assert.deepEqual([png.width, png.height], [12, 6]);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 12; x++) {
      assert.deepEqual(png.rows[y][x], COLORS(Math.floor(x / 3), Math.floor(y / 3)).slice(0, 3), `image pixel ${x},${y}`);
    }
  }
});

test("the picture is composited over black: rgb × alpha / 255, rounded", () => {
  const p = picture(4, 1, x => [[200, 100, 50, 255], [200, 100, 50, 128], [255, 255, 255, 0], [255, 255, 255, 1]][x]);
  const png = decode(encodePng(p, 1));
  assert.deepEqual(png.rows[0], [[200, 100, 50], [100, 50, 25], [0, 0, 0], [1, 1, 1]]);
});

test("a real monitor size encodes and decodes", () => {
  const p = picture(288, 160, (x, y) => (x + y) % 7 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]);
  const png = decode(encodePng(p, 2));
  assert.deepEqual([png.width, png.height], [576, 320]);
  assert.deepEqual(png.rows[0][0], [255, 255, 255], "(0 + 0) % 7 is 0: lit");
  assert.deepEqual(png.rows[319][575], [0, 0, 0], "(287 + 159) % 7 is 5: unlit");
});

test("fitPngScale: whole, at least 1, at most MAX_PNG_SCALE, and the longer side stays within 2304", () => {
  const small = picture(32, 32), wide = picture(288, 160);
  assert.equal(fitPngScale(small, 4), 4);
  assert.equal(fitPngScale(small, 4.9), 4);
  assert.equal(fitPngScale(small, 0), 1);
  assert.equal(fitPngScale(small, -3), 1);
  assert.equal(fitPngScale(small, 1000), MAX_PNG_SCALE);
  assert.equal(fitPngScale(wide, 16), 8, "288 × 8 = 2304");
  assert.equal(fitPngScale(picture(160, 288), 16), 8, "the longer side counts, whichever it is");
  assert.equal(fitPngScale(wide, 3), 3);
});

test("encodePng applies the same fit, so an oversized request still yields a bounded image", () => {
  const png = decode(encodePng(picture(288, 160), 16));
  assert.deepEqual([png.width, png.height], [2304, 1280]);
});
