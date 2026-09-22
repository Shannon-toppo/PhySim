// CSV row formatting and sample bookkeeping for the channel logger — pure
// module, no DOM imports, so test/csv.test.mjs can import it directly in Node.
//
// The column set is the authoritative definition of the log's shape: the
// header row is produced here and shipped to the extension host as the first
// line of the file, so the host never has to know what a channel is (see
// src/csvLogger.ts — it only appends lines).
//
// Add a channel? Extend CSV_COLUMNS and csvRow() together, and bump the
// golden row in test/csv.test.mjs.

import { deriveChannels, TICKS_PER_SEC } from "./channels.js";

/**
 * Column names, in file order. `sample` is the row index within the log and
 * `time_s` is seconds since logging started (wall clock — a row is written
 * per simulated tick, but also whenever the gizmo is dragged while paused,
 * so the sample rate is not fixed). `game_time_s` counts ticks instead
 * (ticks / 60), so it stays the time axis the velocity channels agree with
 * when the panel runs in slow motion; `time_scale` is the speed the row was
 * taken at (see timeScale.js).
 */
export const CSV_COLUMNS = [
  "sample", "time_s", "game_time_s", "time_scale",
  "ch1_pos_x", "ch2_pos_y", "ch3_pos_z",
  "ch4_rot_x", "ch5_rot_y", "ch6_rot_z",
  "ch7_vel_x", "ch8_vel_y", "ch9_vel_z",
  "ch10_angvel_x", "ch11_angvel_y", "ch12_angvel_z",
  "ch13_speed_mps", "ch14_angspeed_rps",
  "ch15_tilt_z", "ch16_tilt_x", "ch17_compass"
];

export const CSV_HEADER = CSV_COLUMNS.join(",");

/**
 * Same rounding as src/physServer.ts:fmt(), so CH1–12 in the CSV read exactly
 * like the values that went out on the wire. Non-finite is written as 0 for
 * the same reason the wire encoder does it — a NaN in the file would break
 * whatever plots it.
 *
 * @param {number} n
 * @returns {string}
 */
export function fmtCsv(n) {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)).toString();
}

/**
 * One data row. Column order must match CSV_COLUMNS.
 *
 * @param {number} sample row index within this log
 * @param {number} timeS seconds since logging started (wall clock)
 * @param {number} gameTimeS ticks since logging started / 60
 * @param {number} timeScale simulation speed (1 = real time)
 * @param {import("./channels.js").PhysStateLike} s
 * @returns {string} the row, without a line terminator
 */
export function csvRow(sample, timeS, gameTimeS, timeScale, s) {
  const d = deriveChannels(s);
  return [
    String(sample), fmtCsv(timeS), fmtCsv(gameTimeS), fmtCsv(timeScale),
    fmtCsv(s.position[0]), fmtCsv(s.position[1]), fmtCsv(s.position[2]),
    fmtCsv(s.rotation[0]), fmtCsv(s.rotation[1]), fmtCsv(s.rotation[2]),
    fmtCsv(s.velocity[0]), fmtCsv(s.velocity[1]), fmtCsv(s.velocity[2]),
    fmtCsv(s.angularVelocity[0]), fmtCsv(s.angularVelocity[1]), fmtCsv(s.angularVelocity[2]),
    fmtCsv(d.linAbs), fmtCsv(d.angAbs),
    fmtCsv(d.tiltZ), fmtCsv(d.tiltX), fmtCsv(d.compass)
  ].join(",");
}


// --- Sample bookkeeping --------------------------------------------------------
//
// Rows come from two places: one per simulated tick, and one per state send
// while nothing is ticking (a gizmo drag, a typed pose). stepSimulation()
// calls sendState() after its tick loop, so without the `tickLogged`
// handshake below every simulated frame would end with a duplicate of the row
// its last tick already wrote.

/**
 * @typedef {Object} CsvLog
 * @property {number} sample     rows emitted so far (the `sample` column)
 * @property {number} startMs    performance.now() when logging started
 * @property {number} ticks      ticks logged so far (the `game_time_s` clock)
 * @property {boolean} tickLogged a tick has already written a row this frame
 */

/**
 * @param {number} nowMs
 * @returns {CsvLog}
 */
export function createLog(nowMs) {
  return { sample: 0, startMs: nowMs, ticks: 0, tickLogged: false };
}

/**
 * Row for one simulated tick (or one played-back frame). Advances game time
 * by one tick first: the row holds the state *after* that tick.
 * @param {CsvLog} log
 * @param {number} nowMs
 * @param {number} timeScale
 * @param {import("./channels.js").PhysStateLike} s
 * @returns {string}
 */
export function tickRow(log, nowMs, timeScale, s) {
  log.tickLogged = true;
  log.ticks++;
  return csvRow(log.sample++, (nowMs - log.startMs) / 1000, log.ticks / TICKS_PER_SEC, timeScale, s);
}

/**
 * Row for a state about to go on the wire, or null when a tick already
 * covered it. No tick passes for a drag, so game time holds still.
 * @param {CsvLog} log
 * @param {number} nowMs
 * @param {number} timeScale
 * @param {import("./channels.js").PhysStateLike} s
 * @returns {string | null}
 */
export function sendRow(log, nowMs, timeScale, s) {
  if (log.tickLogged) { log.tickLogged = false; return null; }
  return csvRow(log.sample++, (nowMs - log.startMs) / 1000, log.ticks / TICKS_PER_SEC, timeScale, s);
}
