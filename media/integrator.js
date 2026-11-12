// One tick of the panel's Simulate mode — pure module (no DOM/three imports),
// so Node tests import it directly.
//
// Its TypeScript twin is src/agent/motion.ts: the AI tools advance a pose
// without a webview, and the two must move it identically or a script would
// behave differently under an agent than under the panel.
// test/motion.test.mjs asserts they agree — extend it when this changes.

import { normalizeAngle } from "./channels.js";

/**
 * @typedef {Object} Acceleration
 * @property {number[]} linear   m/tick², added to the velocity every tick
 * @property {number[]} angular  rad/tick², added to the angular velocity every tick
 */

/**
 * Semi-implicit Euler: bump the velocities by the accelerations, then advance
 * the pose by the new velocities. Rotation is wrapped to [-π, π), so a long
 * spin doesn't leave the pose reading 40 rad while CH4–6 read something else.
 *
 * @param {import("./channels.js").PhysStateLike} s  not modified
 * @param {Acceleration} a
 * @returns {import("./channels.js").PhysStateLike} the state after the tick
 */
export function integrateTick(s, a) {
  const v = [s.velocity[0] + a.linear[0], s.velocity[1] + a.linear[1], s.velocity[2] + a.linear[2]];
  const w = [
    s.angularVelocity[0] + a.angular[0],
    s.angularVelocity[1] + a.angular[1],
    s.angularVelocity[2] + a.angular[2]
  ];
  return {
    position: [s.position[0] + v[0], s.position[1] + v[1], s.position[2] + v[2]],
    rotation: [
      normalizeAngle(s.rotation[0] + w[0]),
      normalizeAngle(s.rotation[1] + w[1]),
      normalizeAngle(s.rotation[2] + w[2])
    ],
    velocity: v,
    angularVelocity: w
  };
}
