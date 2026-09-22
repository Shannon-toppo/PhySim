// media/csv.js — the CSV log's column definition and row formatting. The
// point of these tests is that the header and the rows can never drift apart
// (a shifted column silently mislabels every plot made from the file), that
// the CH1-12 text matches the wire encoder byte-for-byte, and that no value
// can inject a separator into a record.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_COLUMNS, CSV_HEADER, fmtCsv, csvRow, createLog, tickRow, sendRow
} from "../media/csv.js";
import { deriveChannels } from "../media/channels.js";
import { fmt } from "../out/physServer.js";

/** @param {Partial<Record<string, number[]>>} o */
function state(o = {}) {
  return {
    position: o.position ?? [0, 0, 0],
    rotation: o.rotation ?? [0, 0, 0],
    velocity: o.velocity ?? [0, 0, 0],
    angularVelocity: o.angularVelocity ?? [0, 0, 0]
  };
}

// sample, time_s, game_time_s, time_scale — then CH1 onwards.
const CH1 = 4;

test("header names the sample/time columns plus CH1-17", () => {
  assert.equal(CSV_COLUMNS.length, 21);
  assert.deepEqual(CSV_COLUMNS.slice(0, CH1), ["sample", "time_s", "game_time_s", "time_scale"]);
  for (let ch = 1; ch <= 17; ch++) {
    assert.ok(
      CSV_COLUMNS[ch + CH1 - 1].startsWith(`ch${ch}_`),
      `column ${ch + CH1 - 1} should be CH${ch}, got ${CSV_COLUMNS[ch + CH1 - 1]}`
    );
  }
  assert.equal(CSV_HEADER, CSV_COLUMNS.join(","));
  assert.equal(CSV_HEADER.split(",").length, 21);
});

test("a row has exactly as many fields as the header", () => {
  const row = csvRow(7, 0.125, 0.1, 0.5, state({
    position: [1, 2, 3], rotation: [0.1, 0.2, 0.3],
    velocity: [0.4, 0.5, 0.6], angularVelocity: [0.01, 0.02, 0.03]
  }));
  assert.equal(row.split(",").length, CSV_HEADER.split(",").length);
});

test("CH1-12 are formatted exactly like the wire encoder", () => {
  const s = state({
    position: [1.23456789, -0.0000004, 1e7],
    rotation: [-3.14159265, 0.5, 0],
    velocity: [0.1234567, -2, 0],
    angularVelocity: [0.0001235, -0.05, 3]
  });
  const f = csvRow(0, 0, 0, 1, s).split(",");
  const wire = [
    ...s.position, ...s.rotation, ...s.velocity, ...s.angularVelocity
  ].map(fmt);
  assert.deepEqual(f.slice(CH1, CH1 + 12), wire);
});

test("CH13-17 come from deriveChannels", () => {
  const s = state({
    rotation: [0.3, -0.7, 1.1],
    velocity: [0.1, 0.2, 0.3],
    angularVelocity: [0.01, -0.02, 0.03]
  });
  const d = deriveChannels(s);
  const f = csvRow(0, 0, 0, 1, s).split(",");
  assert.deepEqual(f.slice(CH1 + 12), [d.linAbs, d.angAbs, d.tiltZ, d.tiltX, d.compass].map(fmtCsv));
});

test("golden row — a change here means every existing log is a different shape", () => {
  const s = state({
    position: [10, -2.5, 0.125],
    rotation: [0.25, -0.5, 1],
    velocity: [0.5, 0, -0.25],
    angularVelocity: [0.1, 0, 0]
  });
  assert.equal(
    csvRow(3, 1.5, 0.05, 0.25, s),
    "3,1.5,0.05,0.25,10,-2.5,0.125,0.25,-0.5,1,0.5,0,-0.25,0.1,0,0,"
    + "33.54102,0.95493,-0.034833,-0.135268,0.08171"
  );
});

test("fmtCsv rounds to six decimals and never emits a separator", () => {
  assert.equal(fmtCsv(0), "0");
  assert.equal(fmtCsv(-0), "0");
  assert.equal(fmtCsv(1.23456749), "1.234567");
  assert.equal(fmtCsv(1e-9), "0");        // rounds away, not "1e-9"
  assert.equal(fmtCsv(1234567.5), "1234567.5");
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(fmtCsv(bad), "0");
  for (const v of [0, -0, 1e-9, 1e20, -1.5, NaN, Infinity]) {
    const out = fmtCsv(v);
    assert.ok(!/[,\r\n"]/.test(out), `fmtCsv(${v}) = ${out} contains a CSV metacharacter`);
  }
});

test("a non-finite state still produces a well-formed row", () => {
  const row = csvRow(0, NaN, NaN, NaN, state({ position: [NaN, Infinity, 0] }));
  assert.equal(row.split(",").length, CSV_HEADER.split(",").length);
  assert.ok(!/NaN|Infinity/.test(row), row);
});


// --- Sample bookkeeping --------------------------------------------------------

/** The `sample` and `time_s` columns of a row. */
function head(row) {
  const f = row.split(",");
  return [Number(f[0]), Number(f[1])];
}

/** The `game_time_s` and `time_scale` columns of a row. */
function game(row) {
  const f = row.split(",");
  return [Number(f[2]), Number(f[3])];
}

test("the sample column counts up from zero across both row sources", () => {
  const log = createLog(1000);
  const s = state();
  assert.deepEqual(head(tickRow(log, 1000, 1, s)), [0, 0]);
  assert.deepEqual(head(tickRow(log, 1016, 1, s)), [1, 0.016]);
  assert.equal(sendRow(log, 1032, 1, s), null);                  // closes that frame
  assert.deepEqual(head(sendRow(log, 1048, 1, s)), [2, 0.048]);  // a drag while paused
  assert.equal(log.sample, 3);
});

test("a send right after a tick is dropped — that pair is one frame", () => {
  const log = createLog(0);
  const s = state();
  tickRow(log, 0, 1, s);
  assert.equal(sendRow(log, 1, 1, s), null, "the trailing send duplicates the tick");
  assert.equal(log.sample, 1);
  // and the drop is one-shot: the next send (a drag while paused) is kept
  assert.notEqual(sendRow(log, 2, 1, s), null);
  assert.equal(log.sample, 2);
});

test("several ticks in one frame each get a row, and still swallow one send", () => {
  const log = createLog(0);
  const s = state();
  for (let i = 0; i < 4; i++) tickRow(log, i, 1, s);
  assert.equal(sendRow(log, 4, 1, s), null);
  assert.equal(log.sample, 4);
});

test("time_s is measured from the log's start, not from zero", () => {
  const log = createLog(5000);
  const [, t] = head(tickRow(log, 6500, 1, state()));
  assert.equal(t, 1.5);
});

test("game_time_s counts ticks, not wall clock, and holds still for a drag", () => {
  const log = createLog(0);
  const s = state();
  // ×0.25: a tick every 66.7 ms of wall clock, still 1/60 s of game time
  assert.deepEqual(game(tickRow(log, 66.7, 0.25, s)), [fmtNum(1 / 60), 0.25]);
  assert.deepEqual(game(tickRow(log, 133.3, 0.25, s)), [fmtNum(2 / 60), 0.25]);
  assert.equal(Number(tickRow(log, 200, 0.25, s).split(",")[1]), 0.2, "time_s stays wall clock");
  sendRow(log, 200, 0.25, s);                                   // closes the frame
  assert.deepEqual(game(sendRow(log, 900, 1, s)), [fmtNum(3 / 60), 1]);
  assert.deepEqual(game(tickRow(log, 916, 1, s)), [fmtNum(4 / 60), 1]);
});

/** @param {number} n */
function fmtNum(n) { return Number(fmtCsv(n)); }
