// Full protocol round-trip: Node-side encode() bytes are fed into
// PhySim.lua's update() (running under fengari, Lua 5.3) and read back via
// the public getters. Tolerance 1e-6 = the fmt() 6-decimal rounding.
import test from "node:test";
import assert from "node:assert/strict";
import { encode } from "../out/physServer.js";
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

test("corrupt prefix bytes are dropped until a valid frame parses", () => {
  const sim = new LuaPhySim();
  const bytes = encode(SAMPLE).toString("latin1");
  sim.feedAndUpdate("@@@@" + bytes);
  assertStateClose(sim.getState(), SAMPLE);
});
