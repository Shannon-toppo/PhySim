# Stormworks Physics Sensor Sim (PhySim)

### [日本語版](https://github.com/Shannon-toppo/PhySim/blob/main/README_jp.md)

A VSCode extension that runs alongside **Stormworks Lua with LifeBoatAPI** and
lets you drive a virtual `physics sensor` from a 3D gizmo window — so you can
test PID controllers, INS, autopilot logic etc. without having to launch the
game.

When you press **F6** to start the LifeBoatAPI simulator, this extension
automatically opens a panel containing:

- a 3D viewport with a translate / rotate gizmo (right-mouse-drag to orbit)
- sliders for linear and angular velocity
- a live readout of all 17 channels

The values are streamed over a local TCP socket to a small Lua helper
(`PhySim.lua`) which can either:

- inject them into the standard `input.getNumber(N)` table, or
- be queried directly via `phys:position()`, `phys:rotation()` etc.

## QuickStart
1. Install [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi).
2. Download the `.vsix` file from the [Release](https://github.com/Shannon-toppo/PhySim/releases) page and drag and drop it into VS Code.
3. Open your Stormworks microcontroller project. The extension will offer to add `PhySim/lua/` to `lifeboatapi.stormworks.libs.libraryPaths` automatically.
4. Add the following to your `Mymicrocontroller.lua`:

   ```lua
   -- LifeBoatAPI's sandbox require() discards return values, so modules expose
   -- themselves as globals. Use the pair below — NOT `phys = require("PhySim"):new()`.
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- writes input.getNumber(1..12)
   end

   function onTick()
       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
       local rx, ry, rz = input.getNumber(4), input.getNumber(5), input.getNumber(6)
       -- ... use values as if they came from a real physics sensor block ...
   end
   ```

## Coordinate system

Stormworks uses a **left-handed** world coordinate system:

| Axis | Direction          |
|------|--------------------|
| X+   | East               |
| Y+   | Up (vertical)      |
| Z+   | North              |

The gizmo viewport renders Three.js' right-handed coordinates with the camera
placed so that +Z visually extends **into the screen** (away from the viewer),
matching the intuitive "north is forward" layout.

Rotations are reported in radians using Three.js' Euler XYZ order.

## Channel layout

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels
starting at `startCh` (default `1`):

| CH  | Quantity              | Unit        | Notes                                          |
|-----|-----------------------|-------------|------------------------------------------------|
| 1   | position X            | m (East)    |                                                |
| 2   | position Y            | m (Up)      |                                                |
| 3   | position Z            | m (North)   |                                                |
| 4   | rotation X            | rad         | Euler XYZ (intrinsic)                          |
| 5   | rotation Y            | rad         |                                                |
| 6   | rotation Z            | rad         |                                                |
| 7   | linear vel. X         | m/tick      |                                                |
| 8   | linear vel. Y         | m/tick      |                                                |
| 9   | linear vel. Z         | m/tick      |                                                |
| 10  | angular vel. X        | rad/tick    |                                                |
| 11  | angular vel. Y        | rad/tick    |                                                |
| 12  | angular vel. Z        | rad/tick    |                                                |
| 13  | LinearVelocityABS     | m/s         | √(vx²+vy²+vz²) × 60                            |
| 14  | AngularVelocityABS    | RPS         | √(ax²+ay²+az²) × 60 / 2π                       |
| 15  | Tilt.z                | rotation    | tilt of local +Z (forward) from horizontal     |
| 16  | Tilt.x                | rotation    | tilt of local -X (Left) from horizontal       |
| 17  | compassBearing        | rotation    | N=0, W=+0.25, S=±0.5, E=-0.25 (CCW from above) |

"Rotation" unit: 1.0 = one full revolution (2π rad). Tilt ranges [-0.25, +0.25]
(±90° from horizontal). Compass wraps at ±0.5.

## Build and Use

1. Install [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi).
2. Build & launch PhySim (Extension Development Host: open this folder in VSCode and press **F5**, or `npx vsce package` and install the produced `.vsix`).
3. Open your Stormworks microcontroller project. The extension will offer to add `PhySim/lua/` to `lifeboatapi.stormworks.libs.libraryPaths` automatically.
4. Add the following to your `script.lua`:

   ```lua
   -- LifeBoatAPI's sandbox require() discards return values, so modules expose
   -- themselves as globals. Use the pair below — NOT `phys = require("PhySim"):new()`.
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- writes input.getNumber(1..12)
   end

   function onTick()
       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
       local rx, ry, rz = input.getNumber(4), input.getNumber(5), input.getNumber(6)
       -- ... use values as if they came from a real physics sensor block ...
   end
   ```

5. Press **F6** to start the LifeBoatAPI simulator. The PhySim panel opens
   beside it (or in a separate window if `physim.panel.openLocation` is set to
   `newWindow`). Drag the gizmo — your Lua sees the values change live.

## Lua API

After `require("PhySim")`, the global `PhySim` is the class table.

| Method                                | Returns / Effect                                  |
|---------------------------------------|---------------------------------------------------|
| `PhySim:new(host?, port?)`            | Construct & connect. Defaults: `127.0.0.1:14239`. |
| `phys:update()`                       | Drain socket. Call once per tick.                 |
| `phys:position()`                     | `x, y, z` (m)                                     |
| `phys:rotation()`                     | `rx, ry, rz` (rad)                                |
| `phys:velocity()`                     | `vx, vy, vz` (m/tick)                             |
| `phys:angularVelocity()`              | `ax, ay, az` (rad/tick)                           |
| `phys:injectAsInputs(simulator, n?)`  | Write CH `n..n+11` into `input.getNumber(...)`.   |
| `phys:close()`                        | Close socket.                                     |

## Extension settings

| Setting                              | Default | Description                                                    |
|--------------------------------------|---------|----------------------------------------------------------------|
| `physim.port`                        | 14239   | TCP port the extension listens on.                             |
| `physim.autoOpenOnSimulate`          | true    | Open the panel when LifeBoatAPI's "Run Simulator" starts.      |
| `physim.panel.openLocation`          | beside  | Where to place the panel when it opens. `beside` = split beside the active editor; `newWindow` = open in a separate floating window (requires VSCode 1.85+). |
| `physim.channelOffset`               | 1       | Starting CH for `injectAsInputs` (purely advisory).            |
| `physim.autoInjectLibraryPath`       | true    | Add `<extension>/lua/` to `lifeboatapi.stormworks.libs.libraryPaths`. |

## Out of scope (v0.1)

- Scripted sensor manipulation
- Multiple microcontroller debug sessions sharing one panel
