// src/agent/motion.ts and its webview twin media/integrator.js (plus
// normalizeAngle in media/channels.js). The AI tools advance a pose with the
// TypeScript copy, the panel with the JS one; if they drift apart a script
// behaves differently under an agent than under the panel.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { integrateTick as jsIntegrate } from "../media/integrator.js";
import { normalizeAngle as jsNormalize } from "../media/channels.js";

const require = createRequire(import.meta.url);
const { integrateTick, normalizeAngle, NO_ACCELERATION } = require("../out/agent/motion.js");

const PI = Math.PI;

function state(position = [0, 0, 0], rotation = [0, 0, 0], velocity = [0, 0, 0], angularVelocity = [0, 0, 0]) {
  return { position, rotation, velocity, angularVelocity };
}
function accel(linear = [0, 0, 0], angular = [0, 0, 0]) {
  return { linear, angular };
}
function clone(s) {
  return JSON.parse(JSON.stringify(s));
}

/** One step down to the next representable double. */
function nextDown(x) {
  const f = new Float64Array([x]);
  const u = new BigInt64Array(f.buffer);
  if (x === 0) return -Number.MIN_VALUE;
  u[0] += x < 0 ? 1n : -1n;
  return f[0];
}

const VECTORS = [
  ["zero state, no acceleration", state(), NO_ACCELERATION],
  ["pure velocity", state([1, 2, 3], [0, 0, 0], [0.5, -0.25, 2]), NO_ACCELERATION],
  ["linear acceleration from rest", state(), accel([0.01, -0.0981, 0.002])],
  ["angular acceleration from rest", state(), accel([0, 0, 0], [0.001, -0.002, 0.003])],
  ["spin across +π", state([0, 0, 0], [3.1, -3.1, 3.14], [0, 0, 0], [0.1, -0.1, 0.01]), NO_ACCELERATION],
  ["spin across -π", state([0, 0, 0], [-3.1, 3.1, -3.14], [0, 0, 0], [-0.1, 0.1, -0.01]), NO_ACCELERATION],
  ["landing exactly on π", state([0, 0, 0], [PI / 2, 0, 0], [0, 0, 0], [PI / 2, 0, 0]), NO_ACCELERATION],
  ["large values", state([1e6, -2.5e7, 3e9], [100, -250, 1e4], [1e3, -1e4, 5e5], [7, -13, 29]), accel([1e2, -1e2, 3], [0.5, -0.5, 1])],
  ["negative everything", state([-1, -2, -3], [-1, -2, -3], [-0.1, -0.2, -0.3], [-0.01, -0.02, -0.03]), accel([-0.001, -0.002, -0.003], [-1e-4, -2e-4, -3e-4])],
  ["fractions that do not add exactly", state([0.1, 0.2, 0.3], [0.7, 0.1, -0.3], [0.1, 0.2, 0.3], [0.1, 0.2, 0.3]), accel([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])],
  ["mixed signs", state([5, -5, 0], [-2.9, 2.9, 0], [-1, 1, 0], [-0.4, 0.4, 0.2]), accel([0.3, -0.3, 0], [0.05, -0.05, -0.1])]
];

test("the TypeScript and webview integrators agree exactly on one tick", () => {
  for (const [name, s, a] of VECTORS) {
    assert.deepEqual(integrateTick(s, a), jsIntegrate(s, a), name);
  }
});

test("the two integrators agree exactly over 600 ticks fed back into themselves", () => {
  for (const [name, s0, a] of VECTORS) {
    let ts = s0, js = s0;
    for (let i = 0; i < 600; i++) {
      ts = integrateTick(ts, a);
      js = jsIntegrate(js, a);
      assert.deepEqual(ts, js, `${name}, tick ${i + 1}`);
    }
  }
});

test("normalizeAngle agrees exactly with media/channels.js", () => {
  const angles = [0, -0, 1, -1, PI, -PI, 2 * PI, -2 * PI, 3 * PI, -3 * PI, PI / 2, -PI / 2,
    3.14, -3.14, 3.15, -3.15, 7, -7, 100, -100, 1e6, -1e6, 1e-12, -1e-12,
    nextDown(PI), nextDown(-PI), Infinity, -Infinity, NaN];
  for (const a of angles) assert.deepEqual(normalizeAngle(a), jsNormalize(a), String(a));
});

test("NO_ACCELERATION is all zeros", () => {
  assert.deepEqual(NO_ACCELERATION, { linear: [0, 0, 0], angular: [0, 0, 0] });
});

test("zero state with no acceleration stays put", () => {
  assert.deepEqual(integrateTick(state(), NO_ACCELERATION), state());
});

test("semi-implicit Euler: velocity takes the acceleration first, position moves by the new velocity", () => {
  const s = state([10, 20, 30], [0, 0, 0], [1, 2, 3], [0.1, 0.2, 0.3]);
  const next = integrateTick(s, accel([0.5, -1, 2], [0.01, 0.02, -0.03]));
  assert.deepEqual(next.velocity, [1.5, 1, 5]);
  assert.deepEqual(next.position, [11.5, 21, 35], "moved by the new velocity, not the old one");
  assert.deepEqual(next.angularVelocity, [0.1 + 0.01, 0.2 + 0.02, 0.3 - 0.03]);
  // Wrapping goes through (a + π) - π, so compare to rounding error.
  const want = [0.1 + 0.01, 0.2 + 0.02, 0.3 - 0.03];
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(next.rotation[i] - want[i]) < 1e-15, `rotated by the new angular velocity: ${next.rotation[i]}`);
  }
});

test("from rest under constant acceleration the position after n ticks is a * n(n+1)/2", () => {
  let s = state();
  for (let n = 1; n <= 10; n++) {
    s = integrateTick(s, accel([1, -2, 4]));
    const k = n * (n + 1) / 2;
    assert.deepEqual(s.position, [k, -2 * k, 4 * k], `tick ${n}`);
    assert.deepEqual(s.velocity, [n, -2 * n, 4 * n], `tick ${n}`);
  }
});

test("rotation wraps across ±π and stays in [-π, π)", () => {
  const next = integrateTick(state([0, 0, 0], [3.1, -3.1, 0], [0, 0, 0], [0.1, -0.1, 0]), NO_ACCELERATION);
  assert.ok(Math.abs(next.rotation[0] - (3.2 - 2 * PI)) < 1e-12, String(next.rotation[0]));
  assert.ok(Math.abs(next.rotation[1] - (2 * PI - 3.2)) < 1e-12, String(next.rotation[1]));
  // Angular velocity is not wrapped: it is a rate, not an angle.
  assert.deepEqual(next.angularVelocity, [0.1, -0.1, 0]);

  let s = state([0, 0, 0], [0, 0, 0], [0, 0, 0], [0.37, -0.53, 1.9]);
  for (let i = 0; i < 600; i++) {
    s = integrateTick(s, accel([0, 0, 0], [0.001, -0.002, 0.0005]));
    for (const r of s.rotation) assert.ok(r >= -PI && r < PI, `tick ${i + 1}: ${r}`);
  }
});

test("exactly +π normalises to -π, -π stays -π", () => {
  assert.equal(normalizeAngle(PI), -PI);
  assert.equal(normalizeAngle(-PI), -PI);
  assert.equal(normalizeAngle(3 * PI), -PI);
  const next = integrateTick(state([0, 0, 0], [PI / 2, 0, 0], [0, 0, 0], [PI / 2, 0, 0]), NO_ACCELERATION);
  assert.equal(next.rotation[0], -PI);
});

test("normalizeAngle leaves angles inside the range alone and wraps whole turns", () => {
  for (const a of [0, 1, -1, 3, -3, 3.14159]) assert.ok(Math.abs(normalizeAngle(a) - a) < 1e-15, String(a));
  assert.ok(Math.abs(normalizeAngle(2 * PI + 1) - 1) < 1e-12);
  assert.ok(Math.abs(normalizeAngle(-2 * PI - 1) - -1) < 1e-12);
  assert.ok(Math.abs(normalizeAngle(4 * PI + 0.5) - 0.5) < 1e-12);
});

test("normalizeAngle is idempotent", () => {
  for (const a of [0.3, -0.3, 3.5, -3.5, 10, -10, 1e5, PI, -PI]) {
    const once = normalizeAngle(a);
    assert.equal(normalizeAngle(once), once, String(a));
  }
});

test("normalizeAngle passes non-finite values through", () => {
  assert.ok(Number.isNaN(normalizeAngle(NaN)));
  assert.equal(normalizeAngle(Infinity), Infinity);
  assert.equal(normalizeAngle(-Infinity), -Infinity);
});

test("normalizeAngle stays in [-π, π) for the double just below -π", () => {
  // (a + π) is a tiny negative number here, and adding 2π to it rounds to
  // exactly 2π — so the result would come out as +π, outside the range.
  const a = nextDown(-PI);
  const r = normalizeAngle(a);
  assert.ok(r >= -PI && r < PI, `normalizeAngle(${a}) = ${r}`);
});

test("integrateTick does not modify its arguments", () => {
  const s = state([1, 2, 3], [3, -3, 1], [0.1, 0.2, 0.3], [0.5, -0.5, 0.25]);
  const a = accel([0.01, 0.02, 0.03], [0.1, 0.2, 0.3]);
  const sCopy = clone(s), aCopy = clone(a);
  const next = integrateTick(s, a);
  assert.deepEqual(s, sCopy);
  assert.deepEqual(a, aCopy);
  assert.notEqual(next.position, s.position);
  assert.notEqual(next.velocity, s.velocity);
});
