// Colour packing and source-over blending for the monitor pixel buffers —
// pure module (no DOM, no canvas) so test/blend.test.mjs can run it in Node.
//
// media/mcScreen.js draws into an ImageData through a Uint32Array view rather
// than issuing one canvas fillRect per pixel: a fillRect(x, y, 1, 1) measured
// ~0.5 us in the live panel against ~11 ns for a word store, which is the
// difference between a 500-command frame costing 11.6 ms and costing 3 ms.
//
// ImageData bytes are R, G, B, A in memory order, so how those four land in
// one 32-bit word depends on the platform's endianness. It is probed once
// here instead of being assumed little-endian.

const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array([0x11223344]);
  return new Uint8Array(probe.buffer)[0] === 0x44;
})();

const R_SHIFT = LITTLE_ENDIAN ? 0  : 24;
const G_SHIFT = LITTLE_ENDIAN ? 8  : 16;
const B_SHIFT = LITTLE_ENDIAN ? 16 : 8;
const A_SHIFT = LITTLE_ENDIAN ? 24 : 0;

/**
 * Pack one opaque-or-not colour into an ImageData word.
 * @param {number} r 0-255 @param {number} g 0-255
 * @param {number} b 0-255 @param {number} a 0-255
 * @returns {number}
 */
export function packColour(r, g, b, a) {
  return (((a << A_SHIFT) | (b << B_SHIFT) | (g << G_SHIFT) | (r << R_SHIFT)) >>> 0);
}

/**
 * Read one channel back out of a packed word. Only the tests and debugging
 * need this — the drawing paths keep the channels they started from.
 * @param {number} word
 * @param {"r"|"g"|"b"|"a"} channel
 * @returns {number}
 */
export function unpackChannel(word, channel) {
  const shift = channel === "r" ? R_SHIFT : channel === "g" ? G_SHIFT
              : channel === "b" ? B_SHIFT : A_SHIFT;
  return (word >>> shift) & 255;
}

/**
 * Source-over blend of a translucent colour onto an opaque destination.
 *
 * The monitor buffer is cleared to opaque black every frame and only ever
 * written by this module, so the destination alpha is always 255 and the
 * result stays opaque — which reduces the general source-over formula to a
 * plain lerp per channel. `+ 127` rounds instead of truncating, so a stack of
 * translucent draws doesn't drift dark.
 *
 * @param {number} dst packed destination pixel
 * @param {number} r 0-255 @param {number} g 0-255 @param {number} b 0-255
 * @param {number} a source alpha, 0-255
 * @returns {number} packed result
 */
export function blendPixel(dst, r, g, b, a) {
  const ia = 255 - a;
  const dr = (dst >>> R_SHIFT) & 255;
  const dg = (dst >>> G_SHIFT) & 255;
  const db = (dst >>> B_SHIFT) & 255;
  return packColour(
    (r * a + dr * ia + 127) / 255 | 0,
    (g * a + dg * ia + 127) / 255 | 0,
    (b * a + db * ia + 127) / 255 | 0,
    255
  );
}
