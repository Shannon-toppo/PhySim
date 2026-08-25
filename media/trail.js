// Trail ring buffer and velocity-arrow scaling — pure module (no DOM, no
// three.js imports) so test/trail.test.mjs can run it in Node. The three.js
// side lives in media/visuals.js, which owns the Line/ArrowHelper objects and
// feeds this buffer from the render loop.
//
// Positions are stored flat (x, y, z, x, y, z, …) oldest-first, in the same
// world units as the gizmo (metres, Stormworks left-handed axes). When the
// buffer is full the oldest point is dropped: the array is shifted rather
// than wrapped, so the Line's vertex order always matches draw order and no
// stray segment appears across the wrap seam. Shifting ~1800 floats on the
// ticks that actually add a point is far cheaper than the bookkeeping a true
// ring buffer would need on the three.js side.

/**
 * Minimum squared distance (m²) between consecutive samples. A stationary
 * gizmo would otherwise fill the whole buffer with the same point and hide
 * the real path once it starts moving; 1e-6 m² = 1 mm.
 */
export const MIN_STEP_SQ = 1e-6;

/** Selectable trail lengths, in samples (one sample per tick at 60 Hz). */
export const TRAIL_CAPACITIES = [120, 300, 600, 1800];
export const DEFAULT_CAPACITY = 300;

/**
 * @typedef {object} Trail
 * @property {Float32Array} positions flat xyz, length = capacity * 3
 * @property {number} capacity maximum number of points
 * @property {number} count points currently stored (<= capacity)
 */

/**
 * @param {number} capacity
 * @returns {Trail}
 */
export function createTrail(capacity) {
  const cap = Math.max(2, Math.floor(capacity));
  return { positions: new Float32Array(cap * 3), capacity: cap, count: 0 };
}

/** @param {Trail} t */
export function clearTrail(t) {
  t.count = 0;
}

/**
 * Resize in place, keeping the newest points (a shrink drops the oldest).
 * Allocates a fresh Float32Array, so callers holding a three.js
 * BufferAttribute over `positions` must rebuild it afterwards.
 * @param {Trail} t
 * @param {number} capacity
 */
export function setCapacity(t, capacity) {
  const cap = Math.max(2, Math.floor(capacity));
  if (cap === t.capacity) return;
  const keep = Math.min(t.count, cap);
  const next = new Float32Array(cap * 3);
  next.set(t.positions.subarray((t.count - keep) * 3, t.count * 3));
  t.positions = next;
  t.capacity = cap;
  t.count = keep;
}

/**
 * Append a point unless it is closer than MIN_STEP_SQ to the previous one.
 * @param {Trail} t
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {boolean} true if the point was stored
 */
export function pushPoint(t, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (t.count > 0) {
    const i = (t.count - 1) * 3;
    const dx = x - t.positions[i];
    const dy = y - t.positions[i + 1];
    const dz = z - t.positions[i + 2];
    if (dx * dx + dy * dy + dz * dz < MIN_STEP_SQ) return false;
  }
  if (t.count === t.capacity) {
    t.positions.copyWithin(0, 3);
    t.count--;
  }
  const w = t.count * 3;
  t.positions[w]     = x;
  t.positions[w + 1] = y;
  t.positions[w + 2] = z;
  t.count++;
  return true;
}

// Age gradient: the oldest end fades toward the background so the recent path
// reads as the bright one. Values are linear 0-1 RGB, what three.js vertex
// colours want.
const TRAIL_OLD = [0.14, 0.20, 0.30];
const TRAIL_NEW = [0.35, 0.90, 1.00];

/**
 * Colour for point `i` of `count` (0 = oldest).
 * @param {number} i
 * @param {number} count
 * @returns {[number, number, number]}
 */
export function trailColorAt(i, count) {
  const f = count > 1 ? i / (count - 1) : 1;
  return [
    TRAIL_OLD[0] + (TRAIL_NEW[0] - TRAIL_OLD[0]) * f,
    TRAIL_OLD[1] + (TRAIL_NEW[1] - TRAIL_OLD[1]) * f,
    TRAIL_OLD[2] + (TRAIL_NEW[2] - TRAIL_OLD[2]) * f
  ];
}

// Velocity is in m/tick, so 1.0 is already 60 m/s — a literal 1:1 arrow would
// dwarf the 20-unit grid. The gain keeps typical speeds inside the scene and
// the clamp keeps a crawling target's arrow visible without letting a fast
// one shoot off past the axis labels.
export const ARROW_GAIN = 4;
export const ARROW_MIN_LEN = 1;
export const ARROW_MAX_LEN = 12;
/** Below this speed (m/tick) the arrow is hidden rather than drawn as a dot. */
export const ARROW_EPS = 1e-6;

/**
 * Display length for a speed in m/tick. Returns 0 when the arrow should be
 * hidden entirely.
 * @param {number} speed
 * @returns {number}
 */
export function arrowLength(speed) {
  if (!Number.isFinite(speed) || speed < ARROW_EPS) return 0;
  return Math.min(ARROW_MAX_LEN, Math.max(ARROW_MIN_LEN, speed * ARROW_GAIN));
}
