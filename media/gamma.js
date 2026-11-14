// LifeBoatAPI's colour lift, shown when the monitors' "True colour" is off.
//
// LifeBoatAPI's simulator raised every screen.setColor channel in Lua before
// drawing: 255 * ((c / 255) / 0.85) ^ (1 / 2.4), alpha left alone. PhySim 1.x
// showed that lift (and had a "True colour" toggle to undo it). 2.x shows the
// setColor values themselves, because the curve was LifeBoatAPI's model, not
// something measured on the game's monitor (CLAUDE.md, "Monitor display").
// Turning "True colour" off (it is on by default) brings the 1.x look back,
// for people used to it. 1.x had the same checkbox the other way round: off
// by default, and on it undid the lift.
//
// It is applied to the finished frame in the webview, not to setColor in Lua,
// so the engine's frames — and everything the AI tools read from them — stay
// unchanged. For opaque drawing that is the same picture LifeBoatAPI drew.
// Where translucent colours overlap it can differ slightly, because LifeBoatAPI
// lifted each colour before blending and this lifts the blended result.
//
// Pure module (no DOM), so test/gamma.test.mjs runs it in Node.

export const GAMMA_A = 0.85;
export const GAMMA_Y = 2.4;

/**
 * One channel through LifeBoatAPI's lift, rounded and clamped to a byte. The
 * curve reaches 255 at c = 0.85 * 255 = 216.75, so 216 and above are white.
 * @param {number} c 0..255
 * @returns {number}
 */
export function lift(c) {
  if (!(c > 0)) return 0;
  return Math.min(255, Math.round(255 * Math.pow(c / 255 / GAMMA_A, 1 / GAMMA_Y)));
}

/** lift() for every byte value. */
export const LIFT = Uint8Array.from({ length: 256 }, (_, c) => lift(c));

/**
 * Copy an RGBA frame into `dst`, lifting r, g and b and keeping alpha.
 * @param {Uint8Array} src
 * @param {Uint8Array | Uint8ClampedArray} dst same length as src
 */
export function liftFrame(src, dst) {
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = LIFT[src[i]];
    dst[i + 1] = LIFT[src[i + 1]];
    dst[i + 2] = LIFT[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
}
