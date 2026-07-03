// Runs lua/PhySim.lua inside fengari (Lua 5.3 semantics in pure JS — matches
// the lua-debug runtime LifeBoatAPI uses, including two-arg math.atan).
//
// PhySim.lua bails out at the top if the global `_physim_socket` is missing,
// so we install a stub before loading the chunk. The stub's select() returns
// an empty table, which makes PhySim:update()'s socket-drain loop exit
// immediately — tests then feed bytes by writing PhySim._buf directly.
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

/** Escape arbitrary bytes into a Lua short-string literal ("\ddd" escapes). */
function luaStringLiteral(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    out += "\\" + s.charCodeAt(i);
  }
  return out + '"';
}

export class LuaPhySim {
  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    // Stub socket + load PhySim.lua. `client = {}` is truthy, so update()
    // skips reconnecting; select() returning {} breaks the drain loop.
    this.run(`
      _physim_socket = {
        tcp    = function() return nil, "phySim test stub" end,
        select = function() return {} end
      }
    `);
    const src = readFileSync(PHYSIM_LUA, "utf8");
    this.run(src);
    this.run(`PhySim.client = {}`);
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

  /** Append raw bytes (a JS binary string) to PhySim._buf and run update(). */
  feedAndUpdate(bytes) {
    this.run(`PhySim._buf = PhySim._buf .. ${luaStringLiteral(bytes)}`);
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

  /** Overwrite PhySim._state directly (bypasses the wire protocol). */
  setState(state) {
    // String(number) round-trips JS doubles exactly and is a valid Lua 5.3
    // numeric literal for all finite values (e.g. "1e+21", "-0.25").
    const set = (field, arr) =>
      `PhySim._state.${field}[1], PhySim._state.${field}[2], PhySim._state.${field}[3] = ${String(arr[0])}, ${String(arr[1])}, ${String(arr[2])}`;
    this.run([
      set("position", state.position),
      set("rotation", state.rotation),
      set("velocity", state.velocity),
      set("angularVelocity", state.angularVelocity)
    ].join("\n"));
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
