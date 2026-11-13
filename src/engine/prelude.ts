// The Lua that runs before the user's script: LifeBoatAPI's `simulator` object,
// rebuilt on the engine's host controls.
//
// Derived from Stormworks Lua with LifeBoatAPI by Nameous Changey
// (Boost Software License 1.0; see THIRD_PARTY_NOTICES.md).
//
// Scripts written for LifeBoatAPI's simulator configure it through a global
// `simulator` (`simulator:setScreen(1, "3x3")`, `simulator:setProperty(...)`)
// and feed inputs from `onLBSimulatorTick(simulator, ticks)`. Keeping that
// surface is what lets an existing project run unchanged.
//
// Two tables come from the host (see runner.ts):
//   __physim       the engine's control namespace: setInputNumber/Bool,
//                  getInputNumber/Bool, setProperty. Changes are visible to
//                  input.* / property.* immediately, within the same tick.
//   __physim_host  PhySim's own synchronous callbacks: screens, touch, pose.
//
// Behaviour kept from LifeBoatAPI's Simulator.lua:
//   - every tick, monitor 1's touch state is written to bool 1-2 / number 1-6
//     first, then onLBSimulatorTick runs, then onTick;
//   - a channel the script has set itself is never overwritten by those
//     defaults again (the override is sticky for the whole run);
//   - setInput* with nil is ignored; an index outside 1..32 is an error.
//
// One thing LifeBoatAPI had no counterpart for: inputs held by the host (the
// AI tools set composite channels from outside the script). They are written
// after the touch defaults and before onLBSimulatorTick, and like the defaults
// they never touch a channel the script has set itself — the script wins.
//
// The buttons, toggles and sliders of STORMWORKS_Simulator.exe's window are
// kept as state the host holds (engine/controls.ts): the three getters ask the
// host, which is also how the panel learns which controls a script uses.

export const PRELUDE_CHUNK = "@physim:prelude";

/** Called by the host once per tick, before onTick. */
export const PRELUDE_TICK = "__physim_tick";

export const PRELUDE_SOURCE = String.raw`
local ctl, host = __physim, __physim_host
local overriddenNumbers, overriddenBools = {}, {}

local function checkIndex(index, kind)
    if type(index) ~= "number" then
        error("Input index must be a number, setting " .. kind, 3)
    end
    if index > 32 then error("Index > 32 for input " .. tostring(index) .. " setting " .. kind, 3) end
    if index < 1 then error("Index < 1 for input " .. tostring(index) .. " setting " .. kind, 3) end
end

local function touchScreen(screenNumber)
    screenNumber = screenNumber or 1
    local poweredOn, portrait, width, height, isTouched, isTouchedAlt, x, y, xAlt, yAlt = host.screen(screenNumber)
    return {
        screenNumber = screenNumber,
        poweredOn    = poweredOn,
        portrait     = portrait,
        width        = width,
        height       = height,
        isTouched    = isTouched,
        isTouchedAlt = isTouchedAlt,
        touchX       = x,
        touchY       = y,
        touchAltX    = xAlt,
        touchAltY    = yAlt,
    }
end

-- The game's map.* helpers, which the engine leaves to its host. The formulas
-- (and the rounding down to whole units) are LifeBoatAPI's, so a script reads
-- the same numbers here as it did in that simulator.
if map == nil then
    local function numbers(...)
        if select("#", ...) < 7 then return false end
        for i = 1, 7 do
            local v = select(i, ...)
            if type(v) ~= "number" or v ~= v then return false end
        end
        return true
    end
    map = {
        screenToMap = function(...)
            if not numbers(...) then return end
            local mapX, mapY, zoom, screenWidth, screenHeight, pixelX, pixelY = ...
            local metersPerPixel = (zoom * 1000) / screenWidth
            return math.floor(mapX + metersPerPixel * (pixelX - screenWidth / 2)),
                   math.floor(mapY + metersPerPixel * (pixelY - screenHeight / 2))
        end,
        mapToScreen = function(...)
            if not numbers(...) then return end
            local mapX, mapY, zoom, screenWidth, screenHeight, worldX, worldY = ...
            local pixelsPerMeter = screenWidth / (zoom * 1000)
            return math.floor(screenWidth / 2 + pixelsPerMeter * (worldX - mapX)),
                   math.floor(screenHeight / 2 + pixelsPerMeter * (worldY - mapY))
        end,
    }
end

simulator = {
    getTouchScreen = function(self, screenNumber) return touchScreen(screenNumber) end,
    getIsClicked   = function(self, buttonNumber) return host.control(0, buttonNumber) end,
    getIsToggled   = function(self, buttonNumber) return host.control(1, buttonNumber) end,
    getSlider      = function(self, sliderNumber) return host.control(2, sliderNumber) end,

    -- The tick rate belongs to the panel's speed control, and every tick is drawn.
    setFrameRate   = function(self, frameSkip, tickRate, sendOutputSkip) end,

    setInputBool = function(self, index, value)
        checkIndex(index, "bool")
        overriddenBools[index] = true
        if value ~= nil then ctl.setInputBool(index, value and true or false) end
    end,

    setInputNumber = function(self, index, value)
        checkIndex(index, "number")
        overriddenNumbers[index] = true
        if value ~= nil then
            if type(value) ~= "number" then
                error("Input " .. tostring(index) .. " must be set to a number, got " .. type(value), 2)
            end
            ctl.setInputNumber(index, value)
        end
    end,

    setProperty = function(self, label, value)
        local kind = type(value)
        if kind ~= "string" and kind ~= "boolean" and kind ~= "number" then
            error("Stormworks properties must be Numbers, Strings or Booleans, when you tried to set property: " .. tostring(label), 2)
        end
        ctl.setProperty(tostring(label), value)
    end,

    setScreen = function(self, screenNumber, screenSize, poweredOn, portrait)
        return host.setScreen(screenNumber or 1, tostring(screenSize), poweredOn ~= false, portrait and true or false)
    end,

    exit = function(self) host.exit() end,
}

-- Calls in the wrong phase stop the script, as they do in the game (card H,
-- doc/ingame-findings.md §11): input.* / output.* inside onDraw, screen.*
-- inside onTick. The engine itself reads 0 / ignores them there. Wrapping the
-- functions in the tables also catches an alias the script takes at its top
-- level (S = screen), which the game catches too. The phase is read from the
-- engine: screen.getWidth() is a monitor's width (at least 32) while drawing
-- and 0 anywhere else. The top level is left alone (unmeasured in the game).
local ticked = false
do
    local getWidth = screen.getWidth
    -- The check is written out in each wrapper rather than called: every
    -- API call pays for it against the instruction budget.
    local function each(t, wrap)
        local names = {}
        for name, f in pairs(t) do
            if type(f) == "function" then names[#names + 1] = name end
        end
        for _, name in ipairs(names) do t[name] = wrap(t[name]) end
    end
    local function outsideTick(message)
        return function(f)
            return function(...)
                if getWidth() > 0 then error(message, 2) end
                return f(...)
            end
        end
    end
    each(input, outsideTick("attempting to use input function outside onTick"))
    each(output, outsideTick("attempting to use output function outside onTick"))
    each(screen, function(f)
        return function(...)
            if ticked and getWidth() == 0 then error("attempting to use screen function outside onDraw", 2) end
            return f(...)
        end
    end)
end

function ${PRELUDE_TICK}(ticks)
    ticked = true
    local s = touchScreen(1)
    if not overriddenBools[1] then ctl.setInputBool(1, s.isTouched) end
    if not overriddenBools[2] then ctl.setInputBool(2, s.isTouchedAlt) end
    if not overriddenNumbers[1] then ctl.setInputNumber(1, s.width) end
    if not overriddenNumbers[2] then ctl.setInputNumber(2, s.height) end
    if not overriddenNumbers[3] then ctl.setInputNumber(3, s.touchX) end
    if not overriddenNumbers[4] then ctl.setInputNumber(4, s.touchY) end
    if not overriddenNumbers[5] then ctl.setInputNumber(5, s.touchAltX) end
    if not overriddenNumbers[6] then ctl.setInputNumber(6, s.touchAltY) end

    -- Inputs the host holds: (isBool, index, value) triples.
    local held = { host.inputs() }
    for i = 1, #held, 3 do
        local index, value = held[i + 1], held[i + 2]
        if held[i] then
            if not overriddenBools[index] then ctl.setInputBool(index, value) end
        elseif not overriddenNumbers[index] then
            ctl.setInputNumber(index, value)
        end
    end

    local onSimulate = onLBSimulatorTick
    if onSimulate then onSimulate(simulator, ticks) end
end
`;
