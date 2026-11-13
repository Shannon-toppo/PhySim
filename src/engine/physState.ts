// The pose the panel's gizmo reports, and the simulation speeds it may ask for.
// Pure module shared by the extension host and the engine worker.

export type Triple = [number, number, number];

/**
 * Stormworks left-handed coordinates: +X East, +Y Up, +Z North. Rotations are
 * Euler XYZ in radians; velocities are per tick.
 */
export interface PhysState {
  position: Triple;
  rotation: Triple;
  velocity: Triple;
  angularVelocity: Triple;
}

export const ZERO_STATE: PhysState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0]
};

function isTriple(v: unknown): v is Triple {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
}

/** A state crossing from the webview is untrusted: anything malformed is dropped. */
export function sanitizePhysState(s: unknown): PhysState | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (!isTriple(o.position) || !isTriple(o.rotation) || !isTriple(o.velocity) || !isTriple(o.angularVelocity)) return null;
  return {
    position: [...o.position], rotation: [...o.rotation],
    velocity: [...o.velocity], angularVelocity: [...o.angularVelocity]
  };
}

export const TICKS_PER_SEC = 60;

/**
 * Simulation speeds the panel may ask for. A copy of media/timeScale.js's
 * TIME_SCALES (the webview is ESM, the host CommonJS) — a webview message is
 * untrusted, so the host validates on its own; test/timeScale.test.mjs keeps
 * the two lists equal.
 */
export const TIME_SCALES = [1, 0.5, 0.25, 0.1];

export function sanitizeTimeScale(v: unknown): number {
  const n = Number(v);
  return TIME_SCALES.includes(n) ? n : 1;
}
