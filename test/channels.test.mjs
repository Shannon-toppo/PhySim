// Unit tests for the CH13–17 derived-channel math in media/channels.js.
// Known-value cases pin the semantics; the golden table pins the exact
// pre-refactor behaviour (values captured from the original panel.js
// formulas before extraction).
import test from "node:test";
import assert from "node:assert/strict";
import { deriveChannels, TICKS_PER_SEC, TWO_PI } from "../media/channels.js";

const TOL = 1e-12;
const HALF_PI = Math.PI / 2;

function derive(rotation, velocity, angularVelocity) {
  return deriveChannels({ position: [0, 0, 0], rotation, velocity, angularVelocity });
}

function close(a, b, tol = TOL) {
  assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);
}

test("constants", () => {
  assert.equal(TICKS_PER_SEC, 60);
  assert.equal(TWO_PI, Math.PI * 2);
});

test("zero state derives all zeros", () => {
  const d = derive([0, 0, 0], [0, 0, 0], [0, 0, 0]);
  for (const k of ["linAbs", "angAbs", "tiltZ", "tiltX", "compass"]) {
    close(d[k], 0); // tolerance-based: -0 counts as 0
  }
});

test("CH13: |velocity| in m/s = magnitude × 60", () => {
  close(derive([0, 0, 0], [1, 0, 0], [0, 0, 0]).linAbs, 60);
  close(derive([0, 0, 0], [3, -4, 12], [0, 0, 0]).linAbs, 13 * 60); // 3-4-12-13 quadruple
});

test("CH14: |angular velocity| in RPS = magnitude × 60 / 2π", () => {
  close(derive([0, 0, 0], [0, 0, 0], [0, 1, 0]).angAbs, 60 / TWO_PI);
  close(derive([0, 0, 0], [0, 0, 0], [0, TWO_PI / 60, 0]).angAbs, 1); // exactly 1 RPS
});

test("CH15: pitch up (rx=-90°) → tiltZ +0.25, pitch down → -0.25", () => {
  close(derive([-HALF_PI, 0, 0], [0, 0, 0], [0, 0, 0]).tiltZ, 0.25);
  close(derive([HALF_PI, 0, 0], [0, 0, 0], [0, 0, 0]).tiltZ, -0.25);
});

test("CH16: roll right (rz=-90°) → tiltX +0.25", () => {
  close(derive([0, 0, -HALF_PI], [0, 0, 0], [0, 0, 0]).tiltX, 0.25);
  close(derive([0, 0, HALF_PI], [0, 0, 0], [0, 0, 0]).tiltX, -0.25);
});

test("CH17: compass N=0, E=-0.25, W=+0.25, S=±0.5", () => {
  close(derive([0, 0, 0], [0, 0, 0], [0, 0, 0]).compass, 0);
  close(derive([0, HALF_PI, 0], [0, 0, 0], [0, 0, 0]).compass, -0.25);
  close(derive([0, -HALF_PI, 0], [0, 0, 0], [0, 0, 0]).compass, 0.25);
  close(Math.abs(derive([0, Math.PI, 0], [0, 0, 0], [0, 0, 0]).compass), 0.5, 1e-9);
});

test("asin inputs are clamped at the gimbal poles (no NaN)", () => {
  // rx = ±90° puts fwd_y at ±1 exactly; fp noise beyond 1 must not yield NaN.
  for (const rx of [HALF_PI, -HALF_PI]) {
    for (const ry of [0, HALF_PI, -HALF_PI]) {
      const d = derive([rx, ry, 0], [0, 0, 0], [0, 0, 0]);
      for (const k of ["tiltZ", "tiltX", "compass"]) {
        assert.ok(Number.isFinite(d[k]), `rx=${rx} ry=${ry} ${k} is ${d[k]}`);
      }
    }
  }
});

// Golden regression table — captured from the pre-extraction implementation.
const GOLDEN = [
  { r: [0.3, -1.2, 0.7], v: [2.5, -0.5, 4], a: [0.01, -0.02, 0.03],
    out: { linAbs: 284.60498941515414, angAbs: 0.3573019610768259, tiltZ: -0.017075695184635833, tiltX: -0.06632582650020334, compass: 0.19340064598545623 } },
  { r: [-2.9, 0.618, 1.414], v: [-7.25, 3.5, 0], a: [0.25, 0.125, -0.0625],
    out: { linAbs: 483.03726564313854, angAbs: 2.735023402293748, tiltZ: 0.031234939217452833, tiltX: 0.2186753011805925, compass: -0.39941669324545137 } },
  { r: [1.047, 2.094, -0.524], v: [10, 10, 10], a: [-3.1, 3.1, -3.1],
    out: { linAbs: 1039.2304845413262, angAbs: 51.273587274226664, tiltZ: 0.07121370214485379, tiltX: -0.06535313098941153, compass: -0.29470390187620094 } },
  { r: [0.1, 0.2, 0.3], v: [1, 2, 3], a: [0.1, 0.2, 0.3],
    out: { linAbs: 224.49944320643647, angAbs: 3.573019610768259, tiltZ: -0.015597214013597097, tiltX: -0.05066562398915262, compass: -0.0319865506146771 } },
  { r: [-0.7, 1.9, -2.3], v: [0, 0.5, -0.5], a: [0, 0, 0.01],
    out: { linAbs: 42.42640687119285, angAbs: 0.0954929658551372, tiltZ: -0.033391450311157374, tiltX: 0.02624719307410789, compass: -0.29067724576114023 } },
  { r: [3.14159, -3.14159, 3.14159], v: [5, 0, 0], a: [0, 0.5, 0],
    out: { linAbs: 300, angAbs: 4.7746482927568605, tiltZ: 4.2233193254929675e-7, tiltX: 4.2233081185359113e-7, compass: 4.223319325522706e-7 } },
  { r: [0.5, 0, 0], v: [0, 1, 0], a: [1, 0, 0],
    out: { linAbs: 60, angAbs: 9.549296585513721, tiltZ: -0.07957747154594767, tiltX: 0, compass: 0 } },
  { r: [0, 0, 1.5707963267948966], v: [0, 0, 2], a: [0, 0, 0],
    out: { linAbs: 120, angAbs: 0, tiltZ: 0, tiltX: -0.25, compass: 0 } },
  { r: [123.456, -654.321, 42.42], v: [1000, -2000, 3000], a: [50, -60, 70],
    out: { linAbs: 224499.44320643647, angAbs: 1001.5386752687805, tiltZ: 0.08676720532829296, tiltX: -0.10239922239132347, compass: 0.3240472303597561 } },
  { r: [-0.001, 0.002, -0.003], v: [0.0001, 0, 0], a: [0, 0.0001, 0],
    out: { linAbs: 0.006, angAbs: 0.000954929658551372, tiltZ: 0.00015915462478200914, tiltX: 0.0004777829001644545, compass: -0.00031831004533837567 } }
];

test("golden regression vectors (pre-extraction behaviour)", () => {
  for (const g of GOLDEN) {
    const d = derive(g.r, g.v, g.a);
    for (const k of Object.keys(g.out)) {
      close(d[k], g.out[k]);
    }
  }
});
