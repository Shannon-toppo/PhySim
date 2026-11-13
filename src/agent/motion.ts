// One tick of motion for the AI tools: the panel's Simulate mode without a
// webview. Pure module.
//
// The TypeScript twin of media/integrator.js (and of normalizeAngle in
// media/channels.js) — the webview is ESM, this is CommonJS, so the math is
// written twice. test/motion.test.mjs asserts the two agree; change them
// together.

import type { PhysState, Triple } from "../engine/physState";

export interface Acceleration {
  /** m/tick², added to the velocity every tick. */
  linear: Triple;
  /** rad/tick², added to the angular velocity every tick. */
  angular: Triple;
}

export const NO_ACCELERATION: Acceleration = { linear: [0, 0, 0], angular: [0, 0, 0] };

const TWO_PI = Math.PI * 2;

/** The same angle in [-π, π). */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return a;
  const w = (a + Math.PI) % TWO_PI;
  const r = (w < 0 ? w + TWO_PI : w) - Math.PI;
  // Rounding can land a value a hair below -π on +π; the range excludes it.
  return r >= Math.PI ? -Math.PI : r;
}

/**
 * Semi-implicit Euler: the velocities take the accelerations first, then the
 * pose advances by the new velocities. Rotation is wrapped to [-π, π).
 */
export function integrateTick(s: PhysState, a: Acceleration): PhysState {
  const v: Triple = [s.velocity[0] + a.linear[0], s.velocity[1] + a.linear[1], s.velocity[2] + a.linear[2]];
  const w: Triple = [
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
