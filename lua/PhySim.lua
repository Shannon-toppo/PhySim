-- PhySim.lua — Lua side of the Stormworks Physics Sensor Sim VSCode extension.
--
-- The extension runs your microcontroller script itself (on Storm Lua Engine)
-- and keeps the pose of the panel's gizmo next to it. This module reads that
-- pose and writes it to input channels, the way a physics sensor wired to the
-- microcontroller would.
--
-- Coordinates are Stormworks left-handed: +X East, +Y Up, +Z North. Rotations
-- are Euler XYZ in radians, normalized to [-π, π). Velocities are per tick.
--
-- Typical usage in a microcontroller script:
--
--   require("PhySim")           -- defines global `PhySim`
--   phys = PhySim:new()         -- phys IS PhySim
--
--   function onLBSimulatorTick(simulator, ticks)
--       phys:update()                                       -- pull latest values
--       phys:injectAsInputs(simulator, 1)                   -- write to input.getNumber(1..17)
--   end
--
--   function onTick()
--       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
--       -- or via the module:
--       local rx, ry, rz = phys:rotation()
--   end
--
-- Wrap the PhySim lines in a simulator-only section when the script is also
-- built for the game: none of this exists there.
--
-- Module style. `require` here is include-once and discards return values
-- (LifeBoatAPI's convention, which the engine's development loader keeps), so
-- the module publishes itself as the global `PhySim`. It is a singleton —
-- `PhySim:new()` re-initialises the same table and returns it — and uses no
-- metatables, pcall or error, so it stays valid in the game's own restricted
-- environment even though it is never shipped there.

-- The extension's synchronous callbacks; see src/engine/runner.ts.
--   phys()      -> the 12 pose numbers below, in wire order
--   tickRate()  -> ticks per second the panel is running at
local _host = __physim_host
if not _host then
    print("[PhySim] This script is not running inside the PhySim VSCode extension. "
        .. "Start it with the \"PhySim: Run\" command.")
    return
end

-- Module / singleton.
PhySim = {
    -- Kept for scripts that test it: the pose is always available now.
    isAlive         = true,
    _tps            = 60,
    _state          = {
        position        = { 0, 0, 0 },
        rotation        = { 0, 0, 0 },
        velocity        = { 0, 0, 0 },
        angularVelocity = { 0, 0, 0 }
    }
}

---The arguments are accepted and ignored: earlier versions connected to the
---panel over TCP and took a host and port here.
---@return table the PhySim singleton, ready to use
function PhySim:new(host, port)
    self.isAlive = true
    self._tps    = 60
    self._state.position[1],        self._state.position[2],        self._state.position[3]        = 0, 0, 0
    self._state.rotation[1],        self._state.rotation[2],        self._state.rotation[3]        = 0, 0, 0
    self._state.velocity[1],        self._state.velocity[2],        self._state.velocity[3]        = 0, 0, 0
    self._state.angularVelocity[1], self._state.angularVelocity[2], self._state.angularVelocity[3] = 0, 0, 0
    return self
end

-- Normalize an angle to [-π, π). The panel's rotation inputs accept ±2π, but
-- each axis' rotation is 2π-periodic. Lua's `%` is floor-modulo, so this needs
-- no sign fix-up — the JS twin is normalizeAngle() in media/channels.js.
-- A hair below -π the modulo rounds to exactly 2π and the result would be +π,
-- the one value the range excludes; it is folded back to -π, as the JS twin does.
local function _normAngle(a)
    local r = (a + math.pi) % (2 * math.pi) - math.pi
    if r >= math.pi then return -math.pi end
    return r
end

---Read the panel's current pose. Call once per tick, before using the values.
function PhySim:update()
    local s = self._state
    local px, py, pz, rx, ry, rz, vx, vy, vz, ax, ay, az = _host.phys()
    s.position[1],        s.position[2],        s.position[3]        = px, py, pz
    s.rotation[1],        s.rotation[2],        s.rotation[3]        = _normAngle(rx), _normAngle(ry), _normAngle(rz)
    s.velocity[1],        s.velocity[2],        s.velocity[3]        = vx, vy, vz
    s.angularVelocity[1], s.angularVelocity[2], s.angularVelocity[3] = ax, ay, az
    self._tps = _host.tickRate()
end

---Ticks per second the panel is running at (60 = real time).
function PhySim:tickRate() return self._tps end

function PhySim:position()        return self._state.position[1],        self._state.position[2],        self._state.position[3]        end
function PhySim:rotation()        return self._state.rotation[1],        self._state.rotation[2],        self._state.rotation[3]        end
function PhySim:velocity()        return self._state.velocity[1],        self._state.velocity[2],        self._state.velocity[3]        end
function PhySim:angularVelocity() return self._state.angularVelocity[1], self._state.angularVelocity[2], self._state.angularVelocity[3] end

-- Stormworks runs at 60 ticks/sec, so m/tick * 60 = m/s, rad/tick * 60 = rad/s.
local _TICKS_PER_SEC = 60
local _TWO_PI        = 2 * math.pi

---Write the 17 channels into the simulator's input numbers.
---Call from onLBSimulatorTick(simulator, ticks) so the values are visible to
---onTick() via the standard input.getNumber(N) API.
---
---Channel layout (relative to startCh, 1-based):
---    1-3  : position X/Y/Z          [m]
---    4-6  : rotation X/Y/Z (Euler XYZ) [rad, normalized to -π..π)
---    7-9  : linear velocity X/Y/Z   [m/tick]
---   10-12 : angular velocity X/Y/Z  [rad/tick]
---   13    : |linear velocity|       [m/s]    (slider value × 60)
---   14    : |angular velocity|      [RPS]    (slider value × 60 / 2π)
---   15    : Tilt.z — tilt of local +Z (forward) from horizontal [rotations]
---   16    : Tilt.x — tilt of local +X (right)   from horizontal [rotations]
---   17    : compass bearing of local +Z (N=0, W=+0.25, S=±0.5, E=-0.25) [rotations]
---
---@param simulator table the `simulator` object (the first arg of onLBSimulatorTick)
---@param startCh number|nil starting channel (default 1; consumes startCh..startCh+16)
function PhySim:injectAsInputs(simulator, startCh)
    startCh = startCh or 1
    local s = self._state

    -- raw state (CH 1-12)
    simulator:setInputNumber(startCh + 0,  s.position[1])
    simulator:setInputNumber(startCh + 1,  s.position[2])
    simulator:setInputNumber(startCh + 2,  s.position[3])
    simulator:setInputNumber(startCh + 3,  s.rotation[1])
    simulator:setInputNumber(startCh + 4,  s.rotation[2])
    simulator:setInputNumber(startCh + 5,  s.rotation[3])
    simulator:setInputNumber(startCh + 6,  s.velocity[1])
    simulator:setInputNumber(startCh + 7,  s.velocity[2])
    simulator:setInputNumber(startCh + 8,  s.velocity[3])
    simulator:setInputNumber(startCh + 9,  s.angularVelocity[1])
    simulator:setInputNumber(startCh + 10, s.angularVelocity[2])
    simulator:setInputNumber(startCh + 11, s.angularVelocity[3])

    -- derived values (CH 13-17)
    local vx, vy, vz = s.velocity[1],        s.velocity[2],        s.velocity[3]
    local ax, ay, az = s.angularVelocity[1], s.angularVelocity[2], s.angularVelocity[3]
    local rx, ry, rz = s.rotation[1],        s.rotation[2],        s.rotation[3]

    -- CH13: |linear velocity| in m/s
    local linAbs = math.sqrt(vx*vx + vy*vy + vz*vz) * _TICKS_PER_SEC
    simulator:setInputNumber(startCh + 12, linAbs)

    -- CH14: |angular velocity| in RPS (revolutions per second)
    local angAbs = math.sqrt(ax*ax + ay*ay + az*az) * _TICKS_PER_SEC / _TWO_PI
    simulator:setInputNumber(startCh + 13, angAbs)

    -- Local-axis decomposition under Three.js intrinsic Euler XYZ
    -- (M = Rx(rx) * Ry(ry) * Rz(rz) acting on column vectors).
    --   forward = M * (0,0,1) = ( sin ry,  -sin rx * cos ry,  cos rx * cos ry )
    --   right   = M * (1,0,0) = ( cos ry * cos rz,  sin rz * cos rx + cos rz * sin ry * sin rx,  ... )
    local cosrx, sinrx = math.cos(rx), math.sin(rx)
    local cosry, sinry = math.cos(ry), math.sin(ry)
    local cosrz, sinrz = math.cos(rz), math.sin(rz)

    local fwd_x = sinry
    local fwd_y = -sinrx * cosry
    local fwd_z =  cosrx * cosry
    local rgt_y =  sinrz * cosrx + cosrz * sinry * sinrx

    -- clamp tilt components for asin domain
    if fwd_y >  1 then fwd_y =  1 elseif fwd_y < -1 then fwd_y = -1 end
    if rgt_y >  1 then rgt_y =  1 elseif rgt_y < -1 then rgt_y = -1 end

    -- CH15: Tilt of local +Z (forward) from horizontal, in rotations
    simulator:setInputNumber(startCh + 14, math.asin(fwd_y) / _TWO_PI)

    -- CH16: Tilt of local +X (right) from horizontal, in rotations
    -- sign inverted: roll-right (right wing down) reads positive
    simulator:setInputNumber(startCh + 15, -math.asin(rgt_y) / _TWO_PI)

    -- CH17: compass bearing of forward direction in horizontal plane.
    -- Convention: N=0, W=+0.25, S=±0.5, E=-0.25 (CCW positive, viewed from +Y above).
    -- atan(fx, fz) gives CW-from-+Z; negate for CCW. math.atan accepts (y,x) in Lua 5.3.
    simulator:setInputNumber(startCh + 16, -math.atan(fwd_x, fwd_z) / _TWO_PI)
end

---Nothing to release any more; kept so existing scripts that call it still run.
function PhySim:close()
end
