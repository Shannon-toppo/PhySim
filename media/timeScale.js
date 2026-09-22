// Simulation speed — pure module, no DOM imports, so test/timeScale.test.mjs
// can import it in Node.
//
// A time scale stretches the real time a tick takes; it never changes what a
// tick contains. Velocities stay m/tick and rad/tick, CH13/14 keep their ×60
// (that is game seconds), and the microcontroller simply sees the game run
// slower. Both clocks are scaled together: simulation.js's integrator here,
// and LifeBoatAPI's Lua tick loop via the RATE message (src/physServer.ts →
// lua/PhySim.lua). Scaling only one of them would hand the microcontroller a
// position that moves at a different rate than the velocity channels claim.
//
// Slow-down only: above 60 Hz LifeBoatAPI's main loop falls behind silently
// when the user's code is heavy (it resets its timer instead of catching up).
//
// src/physServer.ts keeps its own copy of the list to validate webview
// messages; test/timeScale.test.mjs asserts the two agree.

/** Offered speeds, fastest first. 1 is real time. */
export const TIME_SCALES = [1, 0.5, 0.25, 0.1];

/**
 * @param {unknown} v
 * @returns {number} v if it is one of TIME_SCALES, otherwise 1
 */
export function sanitizeTimeScale(v) {
  const n = Number(v);
  return TIME_SCALES.includes(n) ? n : 1;
}

/** @param {number} scale */
export function formatTimeScale(scale) {
  return "×" + String(scale);
}

let current = 1;

/** The speed the panel is running at now. Read by simulation.js and logging.js. */
export function getTimeScale() { return current; }

/** @param {unknown} scale */
export function setCurrentTimeScale(scale) { current = sanitizeTimeScale(scale); }
