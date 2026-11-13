// A recorded motion to play back, one pose per tick. Pure module.
//
// The format is the panel's own CSV log (media/csv.js): a motion flown by hand
// in the panel and logged there is a scenario as it stands. Only the twelve
// raw channels are read, by column name — the log's other columns (sample
// numbers, clocks, the derived CH13–17) are ignored, and so is their order.

import type { PhysState, Triple } from "../engine/physState";

/** CH1–12 as media/csv.js names them, in PhysState order. */
export const SCENARIO_COLUMNS = [
  "ch1_pos_x", "ch2_pos_y", "ch3_pos_z",
  "ch4_rot_x", "ch5_rot_y", "ch6_rot_z",
  "ch7_vel_x", "ch8_vel_y", "ch9_vel_z",
  "ch10_angvel_x", "ch11_angvel_y", "ch12_angvel_z"
] as const;

/** Half an hour of game time; a longer file is refused rather than loaded in part. */
export const MAX_SCENARIO_ROWS = 108_000;

/**
 * Parse a CSV log into poses. Throws with the line number on anything that is
 * not a number where one is needed — a scenario with a hole in it would feed
 * the script a pose nobody recorded.
 */
export function parseScenario(text: string): PhysState[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) throw new Error("the scenario file is empty");

  const header = lines[0].split(",").map(c => c.trim());
  const index = SCENARIO_COLUMNS.map(name => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`the scenario's header has no column "${name}" (expected a PhySim CSV log)`);
    return i;
  });
  if (lines.length - 1 > MAX_SCENARIO_ROWS) {
    throw new Error(`the scenario has ${lines.length - 1} rows; the limit is ${MAX_SCENARIO_ROWS}`);
  }

  const states: PhysState[] = [];
  for (let n = 1; n < lines.length; n++) {
    if (lines[n].trim() === "") continue;
    const cells = lines[n].split(",");
    const v = index.map((i, k) => {
      const cell = (cells[i] ?? "").trim();
      const value = cell === "" ? NaN : Number(cell);
      if (!Number.isFinite(value)) {
        throw new Error(`scenario line ${n + 1}: column "${SCENARIO_COLUMNS[k]}" is not a number ("${cell}")`);
      }
      return value;
    });
    states.push({
      position: v.slice(0, 3) as Triple,
      rotation: v.slice(3, 6) as Triple,
      velocity: v.slice(6, 9) as Triple,
      angularVelocity: v.slice(9, 12) as Triple
    });
  }
  if (states.length === 0) throw new Error("the scenario has a header but no rows");
  return states;
}
