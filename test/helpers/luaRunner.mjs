// Runs lua/PhySim.lua inside fengari (Lua 5.3 semantics in pure JS, f64 like
// the engine's Lua numbers, including two-arg math.atan).
//
// PhySim.lua reads the pose from the host callbacks `__physim_host.phys()` and
// `__physim_host.tickRate()` and bails out at the top if that global is
// missing, so a stub is installed before the chunk loads. The stub's phys()
// returns whatever setState() last stored; tests then call PhySim:update() and
// injectAsInputs() as a script would.
//
// All fengari stack juggling is confined to this file; tests interact through
// plain-JS helpers that exchange numbers as `%.17g`-formatted strings (exact
// double round-trip).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring } = require("fengari");

const PHYSIM_LUA = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lua", "PhySim.lua"
);

export class LuaPhySim {
  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    this.run(`
      _pose, _tickRate = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, 60
      __physim_host = {
        phys     = function() return table.unpack(_pose, 1, 12) end,
        tickRate = function() return _tickRate end
      }
    `);
    this.run(readFileSync(PHYSIM_LUA, "utf8"));
  }

  /** Execute a chunk of Lua; throws on Lua errors. */
  run(code) {
    const L = this.L;
    const status = lauxlib.luaL_dostring(L, to_luastring(code));
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      throw new Error("Lua error: " + err);
    }
    lua.lua_settop(L, 0);
  }

  /** Execute `return <expr>` and read the single result as a JS string. */
  evalString(expr) {
    const L = this.L;
    const status = lauxlib.luaL_dostring(L, to_luastring("return " + expr));
    if (status !== lua.LUA_OK) {
      const err = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      throw new Error("Lua error: " + err);
    }
    const out = lua.lua_tojsstring(L, -1);
    lua.lua_settop(L, 0);
    return out;
  }

  /** Store the pose `phys()` will report and pull it in with PhySim:update(). */
  feedAndUpdate(state, tickRate = 60) {
    this.setState(state);
    this.run(`_tickRate = ${String(tickRate)}`);
    this.run(`PhySim:update()`);
  }

  /** Read the parsed state back via the public getters. */
  getState() {
    const line = this.evalString(`(function()
      local px, py, pz = PhySim:position()
      local rx, ry, rz = PhySim:rotation()
      local vx, vy, vz = PhySim:velocity()
      local ax, ay, az = PhySim:angularVelocity()
      return string.format("%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g|%.17g",
        px, py, pz, rx, ry, rz, vx, vy, vz, ax, ay, az)
    end)()`);
    const n = line.split("|").map(Number);
    return {
      position: n.slice(0, 3),
      rotation: n.slice(3, 6),
      velocity: n.slice(6, 9),
      angularVelocity: n.slice(9, 12)
    };
  }

  /** Set what the stubbed `__physim_host.phys()` returns (no update() yet). */
  setState(state) {
    // String(number) round-trips JS doubles exactly and is a valid Lua 5.3
    // numeric literal for all finite values (e.g. "1e+21", "-0.25").
    const n = [...state.position, ...state.rotation, ...state.velocity, ...state.angularVelocity];
    this.run(`_pose = { ${n.map(String).join(", ")} }`);
  }

  /**
   * Call PhySim:injectAsInputs with a fake simulator and return the captured
   * channel writes as a JS object { [ch]: value }.
   */
  injectAsInputs(startCh = 1) {
    const line = this.evalString(`(function()
      local captured = {}
      local fakeSim = { setInputNumber = function(self, ch, v) captured[ch] = v end }
      PhySim:injectAsInputs(fakeSim, ${startCh})
      local parts = {}
      local i = 1
      for ch, v in pairs(captured) do
        parts[i] = string.format("%d=%.17g", ch, v)
        i = i + 1
      end
      return table.concat(parts, "|")
    end)()`);
    const channels = {};
    if (line) {
      for (const pair of line.split("|")) {
        const [ch, v] = pair.split("=");
        channels[Number(ch)] = Number(v);
      }
    }
    return channels;
  }
}
