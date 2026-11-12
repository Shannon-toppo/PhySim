// lua/PhySim.lua on the real engine, through VehicleRunner: the pose the host
// reports (`__physim_host.phys()`) arrives in a script as getters and as input
// channels, exactly as `require("PhySim")` users see it.
//
// (Requiring PhySim outside the extension host's callbacks is not covered: the
// module prints a notice and returns, which the engine's environment gives no
// way to observe from here.) Channels are read back from composite input
// numbers, which the engine stores as float32.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deriveChannels, normalizeAngle } from "../media/channels.js";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../out/engine/loadEngine.js");
const { VehicleRunner } = require("../out/engine/runner.js");

const LUA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lua");
const engine = await loadEngine();
const files = {
  isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
  read: f => readFileSync(f)
};

/** A runner for `source`, with the repo's lua/ directory on the require path. */
function script(source, t) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-roundtrip-"));
  const entry = path.join(dir, "main.lua");
  writeFileSync(entry, source);
  const runner = new VehicleRunner(engine, { entry, roots: [dir, LUA_DIR], files });
  t.after(() => runner.dispose());
  assert.equal(runner.start(), "completed");
  return runner;
}

const POSE = {
  position: [12.5, -3.25, 100.125],
  rotation: [0.1, -1.5, 2.7],
  velocity: [0.5, 0, -9.99],
  angularVelocity: [-0.001, 0.0314, 0.02]
};

const rawChannels = s => [...s.position, ...s.rotation, ...s.velocity, ...s.angularVelocity];
const derived = s => {
  const d = deriveChannels(s);
  return [d.linAbs, d.angAbs, d.tiltZ, d.tiltX, d.compass];
};

/** float32 storage: relative 1e-6 with an absolute floor. */
function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} !~ ${expected}`);
}

const INJECT = startCh => `
  require("PhySim")
  phys = PhySim:new()
  function onLBSimulatorTick(simulator, ticks)
    phys:update()
    phys:injectAsInputs(simulator, ${startCh})
  end
  function onTick()
    for i = 0, 16 do output.setNumber(i + 1, input.getNumber(${startCh} + i)) end
  end`;

test("injectAsInputs puts all 17 channels on input.getNumber, at startCh 1", t => {
  const runner = script(INJECT(1), t);
  runner.setPhysState(POSE);
  runner.tick();
  const expected = [...rawChannels(POSE), ...derived(POSE)];
  const { outputNumbers, inputNumbers } = runner.readIo();
  expected.forEach((e, i) => {
    close(outputNumbers[i], e, `output ${i + 1}`);
    close(inputNumbers[i], e, `input ${i + 1}`);
  });
});

test("injectAsInputs honours another startCh, and leaves the channels below it alone", t => {
  const runner = script(INJECT(9), t);
  runner.setPhysState(POSE);
  runner.tick();
  const expected = [...rawChannels(POSE), ...derived(POSE)];
  const { outputNumbers, inputNumbers } = runner.readIo();
  expected.forEach((e, i) => {
    close(outputNumbers[i], e, `output ${i + 1}`);
    close(inputNumbers[8 + i], e, `input ${9 + i}`);
  });
  // 7 and 8 were not touched by PhySim; 1-6 hold the monitor defaults (3x3 = 96 px).
  assert.equal(inputNumbers[0], 96);
  assert.equal(inputNumbers[6], 0);
  assert.equal(inputNumbers[7], 0);
});

test("a new pose is picked up on the next update, not retroactively", t => {
  const runner = script(INJECT(1), t);
  runner.setPhysState(POSE);
  runner.tick();
  runner.setPhysState({ ...POSE, position: [1, 2, 3] });
  assert.equal(runner.readIo().inputNumbers[0], POSE.position[0], "nothing changes until the script updates");
  runner.tick();
  assert.deepEqual(runner.readIo().inputNumbers.slice(0, 3), [1, 2, 3]);
});

test("rotation is normalised to [-π, π) and agrees with normalizeAngle", t => {
  const runner = script(`
    require("PhySim")
    function onTick()
      PhySim:update()
      local rx, ry, rz = PhySim:rotation()
      output.setNumber(1, rx) output.setNumber(2, ry) output.setNumber(3, rz)
    end`, t);
  const cases = [
    [0, 0, 0], [0.5, -0.5, 3], [7, -4, 3.5], [100, -100, 6.283185307179586],
    [Math.PI, -Math.PI, 2 * Math.PI], [-3 * Math.PI, 3 * Math.PI, 1e3]
  ];
  for (const rotation of cases) {
    runner.setPhysState({ ...POSE, rotation });
    runner.tick();
    const out = runner.readIo().outputNumbers.slice(0, 3);
    rotation.forEach((r, i) => {
      assert.ok(out[i] >= -Math.PI - 1e-6 && out[i] < Math.PI + 1e-6, `axis ${i} of ${rotation}: ${out[i]}`);
      // Compare as angles: float32 storage can land ±π on either side of the seam.
      const e = normalizeAngle(r);
      const diff = Math.abs(out[i] - e);
      assert.ok(diff <= 1e-5 || Math.abs(diff - 2 * Math.PI) <= 1e-5, `axis ${i} of ${rotation}: lua ${out[i]} js ${e}`);
    });
  }
});

test("exactly +π wraps to -π, as in the webview", t => {
  const runner = script(`
    require("PhySim")
    function onTick() PhySim:update(); output.setNumber(1, (PhySim:rotation())) end`, t);
  runner.setPhysState({ ...POSE, rotation: [Math.PI, 0, 0] });
  runner.tick();
  assert.ok(runner.readIo().outputNumbers[0] < 0);
  assert.equal(normalizeAngle(Math.PI), -Math.PI);
});

test("position(), rotation(), velocity() and angularVelocity() return three values each", t => {
  const runner = script(`
    require("PhySim")
    function onTick()
      PhySim:update()
      local out = 0
      for k, name in ipairs({ "position", "rotation", "velocity", "angularVelocity" }) do
        local a, b, c, extra = PhySim[name](PhySim)
        output.setNumber(out + 1, a) output.setNumber(out + 2, b) output.setNumber(out + 3, c)
        output.setBool(k, extra == nil)
        out = out + 3
      end
    end`, t);
  runner.setPhysState(POSE);
  runner.tick();
  const { outputNumbers, outputBooleans } = runner.readIo();
  rawChannels(POSE).forEach((e, i) => close(outputNumbers[i], e, `getter value ${i}`));
  assert.deepEqual(outputBooleans.slice(0, 4), [true, true, true, true], "each getter returns exactly three values");
});

test("before the first update() the getters read zero", t => {
  const runner = script(`
    require("PhySim")
    function onTick()
      local px, py, pz = PhySim:position()
      local rx = PhySim:rotation()
      output.setNumber(1, px + py + pz + rx + PhySim:tickRate())
    end`, t);
  runner.setPhysState(POSE);
  runner.tick();
  assert.equal(runner.readIo().outputNumbers[0], 60);
});

test("tickRate() follows runner.setTickRate after update()", t => {
  const runner = script(`
    require("PhySim")
    function onTick() PhySim:update(); output.setNumber(1, PhySim:tickRate()) end`, t);
  runner.tick();
  assert.equal(runner.readIo().outputNumbers[0], 60, "real time by default");
  for (const rate of [30, 15, 6, 60]) {
    runner.setTickRate(rate);
    runner.tick();
    assert.equal(runner.readIo().outputNumbers[0], rate);
  }
});

test("PhySim:new(host, port) ignores its old arguments and resets the pose; close() is callable", t => {
  const runner = script(`
    require("PhySim")
    local a = PhySim:new("127.0.0.1", 55555)
    local b = PhySim:new()
    function onTick()
      PhySim:update()
      local px = PhySim:position()
      output.setNumber(1, px)
      PhySim:new("localhost", 1)
      output.setNumber(2, (PhySim:position()))
      output.setNumber(3, PhySim:tickRate())
      output.setBool(1, a == PhySim and b == PhySim and PhySim.isAlive == true)
      PhySim:close()
      output.setBool(2, true)
    end`, t);
  runner.setPhysState(POSE);
  runner.setTickRate(24);
  runner.tick();
  const io = runner.readIo();
  assert.equal(io.outputNumbers[0], POSE.position[0]);
  assert.equal(io.outputNumbers[1], 0, "new() clears the pose");
  assert.equal(io.outputNumbers[2], 60, "and the tick rate");
  assert.deepEqual(io.outputBooleans.slice(0, 2), [true, true], "singleton, and close() ran");
});

test("a pose with a 2π-periodic rotation gives the same tilt and compass as its wrapped twin", t => {
  const runner = script(INJECT(1), t);
  const turn = 2 * Math.PI;
  runner.setPhysState({ ...POSE, rotation: [0.3, -0.7, 1.1] });
  runner.tick();
  const a = runner.readIo().inputNumbers.slice(14, 17);
  runner.setPhysState({ ...POSE, rotation: [0.3 + 5 * turn, -0.7 - 3 * turn, 1.1 + turn] });
  runner.tick();
  const b = runner.readIo().inputNumbers.slice(14, 17);
  a.forEach((v, i) => close(b[i], v, `channel ${15 + i}`));
});

test("the double just below -π does not come out as +π", t => {
  // (a + π) is a tiny negative number there; the modulo rounds it to exactly
  // 2π, and without the fold the result is +π — outside [-π, π). The check is
  // made in Lua, on the f64 the script holds, not on a float32 output.
  const runner = script(`
    require("PhySim")
    function onTick()
      PhySim:update()
      local rx = PhySim:rotation()
      output.setBool(1, rx >= -math.pi and rx < math.pi)
    end`, t);
  const below = -3.1415926535897936;
  assert.ok(below < -Math.PI);
  runner.setPhysState({ ...POSE, rotation: [below, 0, 0] });
  runner.tick();
  assert.equal(runner.readIo().outputBooleans[0], true);
  const js = normalizeAngle(below);
  assert.ok(js >= -Math.PI && js < Math.PI);
});
