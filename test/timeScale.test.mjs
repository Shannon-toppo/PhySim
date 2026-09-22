// media/timeScale.js and its host-side twin in src/physServer.ts. The host
// validates the webview's timeScale message on its own, so the two lists must
// agree — otherwise a speed the dropdown offers would silently run Lua at ×1.
import test from "node:test";
import assert from "node:assert/strict";
import { TIME_SCALES, sanitizeTimeScale, formatTimeScale } from "../media/timeScale.js";
import * as host from "../out/physServer.js";

test("the host accepts exactly the speeds the dropdown offers", () => {
  assert.deepEqual(host.TIME_SCALES, TIME_SCALES);
  for (const s of TIME_SCALES) assert.equal(host.sanitizeTimeScale(s), s);
});

test("real time is offered and nothing is faster than it", () => {
  assert.ok(TIME_SCALES.includes(1));
  for (const s of TIME_SCALES) assert.ok(s > 0 && s <= 1, String(s));
});

test("sanitizeTimeScale takes the dropdown's string values and rejects the rest", () => {
  assert.equal(sanitizeTimeScale("0.25"), 0.25);
  for (const bad of [2, 0, -0.5, NaN, "", "fast", null, undefined, {}]) {
    assert.equal(sanitizeTimeScale(bad), 1, String(bad));
    assert.equal(host.sanitizeTimeScale(bad), 1, String(bad));
  }
});

test("every offered speed is a whole number of ticks per second", () => {
  // RATE carries ticks/s through fmt(); a fraction would still work, but the
  // label and the Lua rate are easiest to check against each other this way.
  for (const s of TIME_SCALES) assert.ok(Number.isInteger(60 * s), String(s));
  assert.equal(formatTimeScale(0.25), "×0.25");
});
