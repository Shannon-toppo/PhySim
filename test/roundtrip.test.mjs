// Full protocol round-trip: Node-side encode() bytes are fed into
// PhySim.lua's update() (running under fengari, Lua 5.3) and read back via
// the public getters. Tolerance 1e-6 = the fmt() 6-decimal rounding.
import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "../out/physServer.js";
import { normalizeAngle } from "../media/channels.js";
import { LuaPhySim } from "./helpers/luaRunner.mjs";

const TOL = 1e-6;

function assertStateClose(actual, expected) {
  for (const field of ["position", "rotation", "velocity", "angularVelocity"]) {
    for (let i = 0; i < 3; i++) {
      const a = actual[field][i], e = expected[field][i];
      assert.ok(Math.abs(a - e) <= TOL, `${field}[${i}]: ${a} !~ ${e}`);
    }
  }
}

const SAMPLE = {
  position: [12.5, -3.25, 100.125],
  rotation: [0.1, -1.5707963, 2.71828],
  velocity: [0.5, 0, -9.99],
  angularVelocity: [-0.001, 0.0314, 0]
};

test("encode → Lua update → getters round-trips within fmt precision", () => {
  const sim = new LuaPhySim();
  sim.feedAndUpdate(encode(SAMPLE).toString("latin1"));
  assertStateClose(sim.getState(), SAMPLE);
});

test("two concatenated frames: the last one wins", () => {
  const sim = new LuaPhySim();
  const first = encode(SAMPLE).toString("latin1");
  const second = encode({
    position: [-1, -2, -3],
    rotation: [0, 0, 0],
    velocity: [1, 1, 1],
    angularVelocity: [0, 0, 0.5]
  }).toString("latin1");
  sim.feedAndUpdate(first + second);
  assertStateClose(sim.getState(), {
    position: [-1, -2, -3],
    rotation: [0, 0, 0],
    velocity: [1, 1, 1],
    angularVelocity: [0, 0, 0.5]
  });
});

test("a frame split across two feeds parses once complete", () => {
  const sim = new LuaPhySim();
  const bytes = encode(SAMPLE).toString("latin1");
  const cut = 10; // inside the body
  sim.feedAndUpdate(bytes.slice(0, cut));
  // incomplete frame — state must still be all zeros
  assertStateClose(sim.getState(), {
    position: [0, 0, 0], rotation: [0, 0, 0],
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0]
  });
  sim.feedAndUpdate(bytes.slice(cut));
  assertStateClose(sim.getState(), SAMPLE);
});

// CH4–6 normalization: the webview wraps in readState(), PhySim.lua wraps
// again on parse. This pins the Lua half — and that it agrees with the JS
// normalizeAngle() twin (within the fmt() 6-decimal wire rounding).
test("rotation is normalized into [-π, π) on parse", () => {
  const sim = new LuaPhySim();
  // ≤6 decimals so encode()'s toFixed(6) is lossless and only the wrap is under test
  const UNWRAPPED = [
    [0, 0, 0],
    [3.141592, -3.141592, 3.141592],   // just inside the bounds — unchanged
    [7, -7, 12.566370],                // >1 turn, both signs, ~4π
    [123.456, -654.321, 42.42],        // the parity.test.mjs "large everything" pose
    [1000, -1000, 6.283185]
  ];
  for (const rotation of UNWRAPPED) {
    sim.feedAndUpdate(encode({
      position: [0, 0, 0], rotation, velocity: [0, 0, 0], angularVelocity: [0, 0, 0]
    }).toString("latin1"));
    const got = sim.getState().rotation;
    got.forEach((a, i) => {
      assert.ok(a >= -Math.PI - TOL && a < Math.PI, `rot[${i}]=${a} outside [-π, π)`);
      const want = normalizeAngle(rotation[i]);
      assert.ok(Math.abs(a - want) <= TOL, `rot[${i}]: lua=${a} js=${want}`);
    });
  }
});

test("corrupt prefix bytes are dropped until a valid frame parses", () => {
  const sim = new LuaPhySim();
  const bytes = encode(SAMPLE).toString("latin1");
  sim.feedAndUpdate("@@@@" + bytes);
  assertStateClose(sim.getState(), SAMPLE);
});
