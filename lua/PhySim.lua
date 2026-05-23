-- PhySim.lua — Lua side of the Stormworks Physics Sensor Sim VSCode extension.
--
-- The extension hosts a TCP server (default 127.0.0.1:14239) that streams the
-- current state of the panel gizmo as length-prefixed text messages:
--   "%04d" .. "PHYS|posX|posY|posZ|rotX|rotY|rotZ|velX|velY|velZ|angVelX|angVelY|angVelZ"
--
-- Coordinates are Stormworks left-handed: +X East, +Y Up, +Z North. Rotations
-- are Euler XYZ in radians. Velocities are per tick.
--
-- LifeBoatAPI's sandbox does NOT expose `setmetatable` (in-game runtime
-- doesn't have it either), and its `require` discards return values. So this
-- module:
--   * publishes itself as the global `PhySim` (sandbox-friendly module style),
--   * uses a singleton pattern — `PhySim:new()` (re)initialises the same table
--     and returns it, so no metatable is needed.
--
-- Typical usage in a microcontroller script:
--
--   require("PhySim")           -- defines global `PhySim`
--   phys = PhySim:new()         -- (re)connect; phys IS PhySim
--
--   function onLBSimulatorTick(simulator, ticks)
--       phys:update()                                       -- pull latest values
--       phys:injectAsInputs(simulator, 1)                   -- write to input.getNumber(1..12)
--   end
--
--   function onTick()
--       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
--       -- or via the module:
--       local rx, ry, rz = phys:rotation()
--   end

-- Pick up the socket library that the VSCode extension injected from outside
-- the sandbox (see debugConfigPatcher.ts). `_physim_socket` is a sandbox-env
-- global written by the patched _build/_simulator.lua.
--
-- NOTE: the LifeBoatAPI sandbox does NOT expose `pcall`, `error`, `assert`,
-- `setmetatable`, etc. — we can only rely on the tiny set in
-- SimulatorSandbox.lua's env table. So we just print a clear message and let
-- the user retry; no exceptions, no metatables.
local _socket = _physim_socket
if not _socket then
    print("[PhySim] 'socket' is not available inside the LifeBoatAPI sandbox. "
        .. "The PhySim VSCode extension should patch _build/_simulator.lua to "
        .. "expose it. Make sure the extension is installed and active, then "
        .. "re-run F6.")
    return
end

-- Module / singleton. Published as a global so the sandboxed require() (which
-- discards return values) still gives the user access.
PhySim = {
    host            = "127.0.0.1",
    port            = 14239,
    client          = nil,
    isAlive         = false,
    _buf            = "",
    _state          = {
        position        = { 0, 0, 0 },
        rotation        = { 0, 0, 0 },
        velocity        = { 0, 0, 0 },
        angularVelocity = { 0, 0, 0 }
    }
}

---@param host string|nil host the panel listens on (default "127.0.0.1")
---@param port number|nil port the panel listens on (default 14239)
---@return table the PhySim singleton, ready to use
function PhySim:new(host, port)
    self.host    = host or "127.0.0.1"
    self.port    = port or 14239
    self._buf    = ""
    self.client  = nil
    self.isAlive = false
    self._state.position[1],        self._state.position[2],        self._state.position[3]        = 0, 0, 0
    self._state.rotation[1],        self._state.rotation[2],        self._state.rotation[3]        = 0, 0, 0
    self._state.velocity[1],        self._state.velocity[2],        self._state.velocity[3]        = 0, 0, 0
    self._state.angularVelocity[1], self._state.angularVelocity[2], self._state.angularVelocity[3] = 0, 0, 0
    PhySim._tryConnect(self)
    return self
end

function PhySim:_tryConnect()
    local sock, err = _socket.tcp()
    if not sock then return false end
    sock:settimeout(0)                      -- non-blocking everything
    local ok, cerr = sock:connect(self.host, self.port)
    -- on Windows a non-blocking connect returns "timeout" until ready, but we
    -- proceed regardless and just feed the socket through select() each tick
    if not ok and cerr ~= "timeout" and cerr ~= "already connected" then
        sock:close()
        return false
    end
    self.client  = sock
    self.isAlive = true
    return true
end

local function _split(s, sep)
    local t, i = {}, 1
    for part in string.gmatch(s, "([^" .. sep .. "]+)") do
        t[i] = part; i = i + 1
    end
    return t
end

---Drain any messages waiting on the socket and update internal state.
---Safe to call every tick; non-blocking.
function PhySim:update()
    if not self.client then
        if not PhySim._tryConnect(self) then return end
    end

    -- pull bytes until select() says nothing is ready
    while true do
        local readable = _socket.select({ self.client }, nil, 0)
        if not readable or #readable == 0 then break end

        local chunk, err, partial = self.client:receive(4096)
        local data = chunk or partial
        if (not data) or #data == 0 then
            if err == "closed" then
                self.isAlive = false
                self.client:close()
                self.client = nil
            end
            break
        end
        self._buf = self._buf .. data
    end

    -- parse all complete frames out of the buffer
    while #self._buf >= 4 do
        local sz = tonumber(self._buf:sub(1, 4))
        if not sz then
            -- corrupt; resync by dropping a byte
            self._buf = self._buf:sub(2)
        elseif #self._buf < 4 + sz then
            break
        else
            local body = self._buf:sub(5, 4 + sz)
            self._buf  = self._buf:sub(5 + sz)
            local v = _split(body, "|")
            if v[1] == "PHYS" and #v >= 13 then
                self._state.position[1]        = tonumber(v[2])  or 0
                self._state.position[2]        = tonumber(v[3])  or 0
                self._state.position[3]        = tonumber(v[4])  or 0
                self._state.rotation[1]        = tonumber(v[5])  or 0
                self._state.rotation[2]        = tonumber(v[6])  or 0
                self._state.rotation[3]        = tonumber(v[7])  or 0
                self._state.velocity[1]        = tonumber(v[8])  or 0
                self._state.velocity[2]        = tonumber(v[9])  or 0
                self._state.velocity[3]        = tonumber(v[10]) or 0
                self._state.angularVelocity[1] = tonumber(v[11]) or 0
                self._state.angularVelocity[2] = tonumber(v[12]) or 0
                self._state.angularVelocity[3] = tonumber(v[13]) or 0
            end
        end
    end
end

function PhySim:position()        return self._state.position[1],        self._state.position[2],        self._state.position[3]        end
function PhySim:rotation()        return self._state.rotation[1],        self._state.rotation[2],        self._state.rotation[3]        end
function PhySim:velocity()        return self._state.velocity[1],        self._state.velocity[2],        self._state.velocity[3]        end
function PhySim:angularVelocity() return self._state.angularVelocity[1], self._state.angularVelocity[2], self._state.angularVelocity[3] end

-- Stormworks runs at 60 ticks/sec, so m/tick * 60 = m/s, rad/tick * 60 = rad/s.
local _TICKS_PER_SEC = 60
local _TWO_PI        = 2 * math.pi

---Write the 17 channels into the LifeBoatAPI simulator's input number table.
---Call from onLBSimulatorTick(simulator, ticks) so the values are visible to
---onTick() via the standard input.getNumber(N) API.
---
---Channel layout (relative to startCh, 1-based):
---    1-3  : position X/Y/Z          [m]
---    4-6  : rotation X/Y/Z (Euler XYZ) [rad]
---    7-9  : linear velocity X/Y/Z   [m/tick]
---   10-12 : angular velocity X/Y/Z  [rad/tick]
---   13    : |linear velocity|       [m/s]    (slider value × 60)
---   14    : |angular velocity|      [RPS]    (slider value × 60 / 2π)
---   15    : Tilt.z — tilt of local +Z (forward) from horizontal [rotations]
---   16    : Tilt.x — tilt of local +X (right)   from horizontal [rotations]
---   17    : compass bearing of local +Z (N=0, W=+0.25, S=±0.5, E=-0.25) [rotations]
---
---@param simulator table LifeBoatAPI.Tools.Simulator instance (the first arg of onLBSimulatorTick)
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

function PhySim:close()
    if self.client then
        self.client:close()
        self.client = nil
    end
    self.isAlive = false
end
