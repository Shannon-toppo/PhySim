// JS⇄Lua parity for the derived channels CH13–17.
//
// The formulas exist twice by necessity: media/channels.js (webview display)
// and lua/PhySim.lua:injectAsInputs (sandbox — cannot share code with JS).
// This suite runs both implementations over the same input vectors and
// asserts the outputs agree. fengari computes with JS doubles, so the two
// sides should agree to ~1e-9 comfortably.
//
// Extend VECTORS whenever the CH13–17 math changes.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveChannels } from "../media/channels.js";
import { LuaPhySim } from "./helpers/luaRunner.mjs";

const TOL = 1e-9;
const HALF_PI = Math.PI / 2;
const QUARTER_PI = Math.PI / 4;

/** @type {Array<{name: string, rotation: number[], velocity: number[], angularVelocity: number[]}>} */
const VECTORS = [
  { name: "all zeros",            rotation: [0, 0, 0],                      velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "unit velocity x",      rotation: [0, 0, 0],                      velocity: [1, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "mixed velocity",       rotation: [0, 0, 0],                      velocity: [3, -4, 12],     angularVelocity: [0, 0, 0] },
  { name: "unit angular y",       rotation: [0, 0, 0],                      velocity: [0, 0, 0],       angularVelocity: [0, 1, 0] },
  { name: "mixed angular",        rotation: [0, 0, 0],                      velocity: [0, 0, 0],       angularVelocity: [-0.1, 0.2, 0.3] },
  { name: "pitch up 45°",         rotation: [-QUARTER_PI, 0, 0],            velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "pitch down 45°",       rotation: [QUARTER_PI, 0, 0],             velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "yaw east (ry=+90°)",   rotation: [0, HALF_PI, 0],                velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "yaw west (ry=-90°)",   rotation: [0, -HALF_PI, 0],               velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "yaw south (ry=180°)",  rotation: [0, Math.PI, 0],                velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "roll right 45°",       rotation: [0, 0, -QUARTER_PI],            velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "roll left 45°",        rotation: [0, 0, QUARTER_PI],             velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "gimbal rx=+90°",       rotation: [HALF_PI, 0, 0],                velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "gimbal rx=-90°",       rotation: [-HALF_PI, 0, 0],               velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "gimbal rx=ry=+90°",    rotation: [HALF_PI, HALF_PI, 0],          velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "gimbal ry=+90 rz=45",  rotation: [0, HALF_PI, QUARTER_PI],       velocity: [0, 0, 0],       angularVelocity: [0, 0, 0] },
  { name: "mixed pose A",         rotation: [0.3, -1.2, 0.7],               velocity: [2.5, -0.5, 4],  angularVelocity: [0.01, -0.02, 0.03] },
  { name: "mixed pose B",         rotation: [-2.9, 0.6180339887, 1.41421],  velocity: [-7.25, 3.5, 0], angularVelocity: [0.25, 0.125, -0.0625] },
  { name: "mixed pose C",         rotation: [1.0471975512, 2.0943951024, -0.5235987756], velocity: [10, 10, 10], angularVelocity: [-3.1, 3.1, -3.1] },
  { name: "large everything",     rotation: [123.456, -654.321, 42.42],     velocity: [1000, -2000, 3000], angularVelocity: [50, -60, 70] }
];

test("CH13–17: JS deriveChannels matches Lua injectAsInputs", () => {
  const sim = new LuaPhySim();
  for (const v of VECTORS) {
    const state = { position: [0, 0, 0], ...v };
    const js = deriveChannels(state);

    sim.setState(state);
    const ch = sim.injectAsInputs(1);

    const pairs = [
      ["CH13 linAbs", js.linAbs, ch[13]],
      ["CH14 angAbs", js.angAbs, ch[14]],
      ["CH15 tiltZ", js.tiltZ, ch[15]],
      ["CH16 tiltX", js.tiltX, ch[16]],
      ["CH17 compass", js.compass, ch[17]]
    ];
    for (const [label, a, b] of pairs) {
      assert.ok(
        Number.isFinite(b) && Math.abs(a - b) <= TOL,
        `${v.name} / ${label}: js=${a} lua=${b}`
      );
    }
  }
});

test("CH1–12 raw passthrough honours startCh offset", () => {
  const sim = new LuaPhySim();
  const state = {
    position: [1, 2, 3],
    rotation: [0.1, 0.2, 0.3],
    velocity: [4, 5, 6],
    angularVelocity: [0.4, 0.5, 0.6]
  };
  sim.setState(state);
  const ch = sim.injectAsInputs(5); // startCh = 5 → raw values live at 5..16
  const raw = [...state.position, ...state.rotation, ...state.velocity, ...state.angularVelocity];
  raw.forEach((v, i) => {
    assert.ok(Math.abs(ch[5 + i] - v) <= TOL, `startCh offset: ch${5 + i}=${ch[5 + i]} != ${v}`);
  });
});
