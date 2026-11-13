// src/agent/scenario.ts: a panel CSV log read back as one pose per tick.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CSV_COLUMNS, CSV_HEADER, csvRow } from "../media/csv.js";

const require = createRequire(import.meta.url);
const { parseScenario, SCENARIO_COLUMNS, MAX_SCENARIO_ROWS } = require("../out/agent/scenario.js");

const POSES = [
  { position: [1, 2, 3], rotation: [0.1, -0.2, 0.3], velocity: [0.5, 0, -0.25], angularVelocity: [0.01, 0.02, -0.03] },
  { position: [-1000.123456, 0, 1e5], rotation: [-3.141592, 3.141592, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
  { position: [0.000001, -0.000001, 0], rotation: [0, 0, 0], velocity: [16.666667, 0, 0], angularVelocity: [0, 0.104720, 0] }
];

const log = (poses, eol = "\r\n") => [CSV_HEADER, ...poses.map((p, i) => csvRow(i, i / 60, i / 60, 1, p))].join(eol) + eol;

const HEADER = SCENARIO_COLUMNS.join(",");
const ROW = "1,2,3,4,5,6,7,8,9,10,11,12";

test("the scenario columns are the log's CH1–12 columns, in order", () => {
  assert.deepEqual([...SCENARIO_COLUMNS], CSV_COLUMNS.filter(c => /^ch([1-9]|1[0-2])_/.test(c)));
  assert.equal(SCENARIO_COLUMNS.length, 12);
});

test("a log written by the panel's own row formatter reads back as its poses", () => {
  assert.deepEqual(parseScenario(log(POSES)), POSES);
});

test("CRLF, LF and lone CR all end a line; a BOM and trailing blank lines are ignored", () => {
  for (const eol of ["\r\n", "\n", "\r"]) assert.deepEqual(parseScenario(log(POSES, eol)), POSES);
  assert.deepEqual(parseScenario("\uFEFF" + log(POSES) + "\r\n\r\n  \r\n"), POSES);
});

test("a blank line in the middle is skipped", () => {
  assert.equal(parseScenario(`${HEADER}\n${ROW}\n\n${ROW}\n`).length, 2);
});

test("columns are found by name: any order, extra columns ignored, cells trimmed", () => {
  const names = ["note", ...[...SCENARIO_COLUMNS].reverse(), "ch13_speed_mps"];
  const cells = ["hello", ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n => ` ${n} `), "not a number"];
  assert.deepEqual(parseScenario(`${names.join(" , ")}\n${cells.join(",")}\n`), [
    { position: [1, 2, 3], rotation: [4, 5, 6], velocity: [7, 8, 9], angularVelocity: [10, 11, 12] }
  ]);
});

test("a missing column is an error naming it", () => {
  const without = SCENARIO_COLUMNS.filter(c => c !== "ch8_vel_y").join(",");
  assert.throws(() => parseScenario(`${without}\n1,2,3,4,5,6,7,8,9,10,11\n`), /no column "ch8_vel_y"/);
  assert.throws(() => parseScenario("a,b,c\n1,2,3\n"), /no column "ch1_pos_x".*PhySim CSV log/);
});

test("a cell that is not a finite number is an error naming the line and the column", () => {
  const withCell = (i, cell) => { const c = ROW.split(","); c[i] = cell; return `${HEADER}\n${ROW}\n${c.join(",")}\n`; };
  for (const cell of ["abc", "", "  ", "NaN", "Infinity", "-Infinity", "1e999", "1.2.3"]) {
    assert.throws(() => parseScenario(withCell(4, cell)), /scenario line 3: column "ch5_rot_y" is not a number/, `cell "${cell}"`);
  }
  assert.throws(() => parseScenario(`${HEADER}\n1,2,3\n`), /scenario line 2: column "ch4_rot_x"/, "a short row");
});

test("an empty file, and a header with no rows, are errors", () => {
  assert.throws(() => parseScenario(""), /empty/);
  assert.throws(() => parseScenario("\n\n"), /empty/);
  assert.throws(() => parseScenario(`${HEADER}\n`), /header but no rows/);
  assert.throws(() => parseScenario(`${HEADER}\n\n\n`), /header but no rows/);
});

test("exactly MAX_SCENARIO_ROWS rows load; one more is refused whole", () => {
  const rows = (n) => `${HEADER}\n${`${ROW}\n`.repeat(n)}`;
  assert.equal(parseScenario(rows(MAX_SCENARIO_ROWS)).length, MAX_SCENARIO_ROWS);
  assert.throws(() => parseScenario(rows(MAX_SCENARIO_ROWS + 1)), new RegExp(`${MAX_SCENARIO_ROWS + 1} rows; the limit is ${MAX_SCENARIO_ROWS}`));
});
