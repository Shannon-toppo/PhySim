// A monitor frame as a PNG, for a person (or a vision model) to look at.
// Pure module apart from node:zlib.
//
// The picture is what the panel shows: the engine's frame composited over
// black (see CLAUDE.md "Monitor display"), so the file is opaque RGB. Each
// monitor pixel becomes scale×scale image pixels, unsmoothed — a 96x96 monitor
// is too small to read at 1:1.

import { crc32, deflateSync } from "zlib";
import { Picture, visibleColor } from "./pixels";

export const MAX_PNG_SCALE = 16;
/** Bound on the image's longer side, whatever the scale asked for. */
const MAX_PNG_SIDE = 2304;

/** The largest whole scale ≤ `wanted` that keeps the image within bounds; at least 1. */
export function fitPngScale(picture: Picture, wanted: number): number {
  const longer = Math.max(picture.width, picture.height);
  const cap = Math.max(1, Math.floor(MAX_PNG_SIDE / longer));
  return Math.max(1, Math.min(Math.floor(wanted), MAX_PNG_SCALE, cap));
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(picture: Picture, scale: number): Buffer {
  const k = fitPngScale(picture, scale);
  const width = picture.width * k, height = picture.height * k;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < picture.height; y++) {
    const rowStart = y * k * stride;
    let o = rowStart + 1;                       // byte 0 of a row is the filter type: 0, none
    for (let x = 0; x < picture.width; x++) {
      const [r, g, b] = visibleColor(picture, x, y);
      for (let i = 0; i < k; i++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; }
    }
    for (let i = 1; i < k; i++) raw.copy(raw, rowStart + i * stride, rowStart, rowStart + stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bit depth
  header[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0))
  ]);
}
