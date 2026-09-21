// Runs one page of an in-game verification card (tools/ingame/verify*.lua)
// inside fengari and returns the screen calls it made, in order. The card is
// the same file pasted into the game, so the test replays exactly what was
// photographed rather than a hand-copied transcription of it.
//
// `screen` records its calls and reports the monitor's size (96x96 unless
// told otherwise); `input.getNumber(32)` returns the page number, which
// every card treats as "jump to this page" in onTick().

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

const PRELUDE = `
OUT = {}
local function hex(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end
local function rec(name)
  return function(...)
    local t = { name }
    for i = 1, select("#", ...) do
      local v = select(i, ...)
      t[#t + 1] = type(v) == "number" and ("n" .. string.format("%.17g", v)) or ("s" .. hex(tostring(v)))
    end
    OUT[#OUT + 1] = table.concat(t, " ")
  end
end
screen = { getWidth = function() return WIDTH end, getHeight = function() return HEIGHT end }
for _, n in ipairs({ "setColor", "drawClear", "drawRect", "drawRectF", "drawCircle", "drawCircleF",
  "drawLine", "drawText", "drawTextBox", "drawTriangle", "drawTriangleF" }) do screen[n] = rec(n) end
input = { getBool = function() return false end,
  getNumber = function(c) if c == 32 then return PAGE end return 0 end }
`;

/**
 * @param {string} file path to the card's .lua
 * @param {number} page
 * @param {{ width: number, height: number }} [size] the monitor, 96x96 by default
 * @returns {(string | number)[][]} [name, ...args] per screen call
 */
export function cardCalls(file, page, size = { width: 96, height: 96 }) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const src = `PAGE = ${page} WIDTH = ${size.width} HEIGHT = ${size.height}\n${PRELUDE}\n${readFileSync(file, "utf8")}\nonTick() onDraw()\nRESULT = table.concat(OUT, "\\n")`;
  if (lauxlib.luaL_dostring(L, to_luastring(src)) !== 0) {
    throw new Error(`${file} page ${page}: ${to_jsstring(lua.lua_tostring(L, -1))}`);
  }
  lua.lua_getglobal(L, to_luastring("RESULT"));
  const out = to_jsstring(lua.lua_tostring(L, -1));
  return out.split("\n").filter(Boolean).map(line => {
    const [name, ...args] = line.split(" ");
    return [name, ...args.map(a => a[0] === "n" ? Number(a.slice(1))
      : Buffer.from(a.slice(1), "hex").toString("latin1"))];
  });
}
