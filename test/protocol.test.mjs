// Wire-protocol encoding: "%04d" length prefix + "PHYS|" + 12 positional
// floats. PhySim.lua parses these positionally — field order is load-bearing.
import test from "node:test";
import assert from "node:assert/strict";
import { encode, fmt, ZERO_STATE } from "../out/physServer.js";

test("fmt rounds to 6 decimals and normalises", () => {
  assert.equal(fmt(1.23456789), "1.234568");
  assert.equal(fmt(0), "0");
  assert.equal(fmt(-0), "0");
  assert.equal(fmt(1.5), "1.5");        // no trailing zeros
  assert.equal(fmt(-2.000001), "-2.000001");
});

test("fmt maps non-finite values to 0", () => {
  assert.equal(fmt(NaN), "0");
  assert.equal(fmt(Infinity), "0");
  assert.equal(fmt(-Infinity), "0");
});

test("encode: 4-digit zero-padded prefix equals body byte length", () => {
  const buf = encode(ZERO_STATE);
  const text = buf.toString("utf8");
  const prefix = text.slice(0, 4);
  const body = text.slice(4);
  assert.match(prefix, /^\d{4}$/);
  assert.equal(Number(prefix), Buffer.byteLength(body, "utf8"));
});

test("encode: 12 fields in documented order (pos, rot, vel, angVel)", () => {
  const state = {
    position: [1, 2, 3],
    rotation: [4, 5, 6],
    velocity: [7, 8, 9],
    angularVelocity: [10, 11, 12]
  };
  const body = encode(state).toString("utf8").slice(4);
  assert.equal(body, "PHYS|1|2|3|4|5|6|7|8|9|10|11|12");
});

test("encode: zero state body", () => {
  const body = encode(ZERO_STATE).toString("utf8").slice(4);
  assert.equal(body, "PHYS|0|0|0|0|0|0|0|0|0|0|0|0");
});
