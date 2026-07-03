// Derived-channel math for CH13–17 — pure module, no DOM / three.js imports,
// so it is importable both from the webview (via relative import) and from
// the Node test suite.
//
// The same formulas are hand-written on the Lua side in
// lua/PhySim.lua:injectAsInputs (the sandbox cannot share code with us);
// test/parity.test.mjs runs both implementations over the same input vectors
// and asserts the outputs match. Extend the vector table there whenever this
// math changes.

/**
 * @typedef {Object} PhysStateLike
 * @property {number[]} position         x/y/z in metres (Stormworks: +X East, +Y Up, +Z North)
 * @property {number[]} rotation         Euler XYZ intrinsic, radians
 * @property {number[]} velocity         m/tick
 * @property {number[]} angularVelocity  rad/tick
 */

// Stormworks tick rate — slider values are per-tick; CH13/14 convert to per-second.
export const TICKS_PER_SEC = 60;
export const TWO_PI = Math.PI * 2;

/**
 * Compute the derived channels CH13–17 from a raw state.
 *
 * @param {PhysStateLike} s
 * @returns {{linAbs: number, angAbs: number, tiltZ: number, tiltX: number, compass: number}}
 *   linAbs  — CH13: |linear velocity| in m/s
 *   angAbs  — CH14: |angular velocity| in RPS
 *   tiltZ   — CH15: tilt of local +Z (forward) from horizontal, in rotations
 *   tiltX   — CH16: tilt of local +X (right) from horizontal, in rotations
 *   compass — CH17: compass bearing of local +Z (N=0, W=+0.25, S=±0.5, E=-0.25), in rotations
 */
export function deriveChannels(s) {
  const vx = s.velocity[0], vy = s.velocity[1], vz = s.velocity[2];
  const ax = s.angularVelocity[0], ay = s.angularVelocity[1], az = s.angularVelocity[2];
  const rx = s.rotation[0], ry = s.rotation[1], rz = s.rotation[2];

  const linAbs = Math.hypot(vx, vy, vz) * TICKS_PER_SEC;
  const angAbs = Math.hypot(ax, ay, az) * TICKS_PER_SEC / TWO_PI;

  // Local-axis decomposition under Three.js intrinsic Euler XYZ
  // (M = Rx(rx) * Ry(ry) * Rz(rz) acting on column vectors).
  const cosrx = Math.cos(rx), sinrx = Math.sin(rx);
  const cosry = Math.cos(ry), sinry = Math.sin(ry);
  const cosrz = Math.cos(rz), sinrz = Math.sin(rz);

  const fwd_x = sinry;
  const fwd_y = -sinrx * cosry;
  const fwd_z =  cosrx * cosry;
  const rgt_y =  sinrz * cosrx + cosrz * sinry * sinrx;

  const clamp = (/** @type {number} */ v) => v > 1 ? 1 : (v < -1 ? -1 : v);
  const tiltZ = Math.asin(clamp(fwd_y)) / TWO_PI;
  const tiltX = -Math.asin(clamp(rgt_y)) / TWO_PI;   // sign matches PhySim.lua CH16
  const compass = -Math.atan2(fwd_x, fwd_z) / TWO_PI;

  return { linAbs, angAbs, tiltZ, tiltX, compass };
}
