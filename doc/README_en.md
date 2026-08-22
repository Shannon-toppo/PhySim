# Stormworks Physics Sensor Sim (PhySim)

### [日本語版](https://github.com/Shannon-toppo/PhySim/blob/main/README.md)

A VSCode extension that runs alongside **Stormworks Lua with LifeBoatAPI** and
lets you drive a virtual `physics sensor` from a 3D gizmo window — so you can
test PID controllers, INS, autopilot logic etc. without having to launch the
game.

When you press **F6** to start the LifeBoatAPI simulator, this extension
automatically opens a panel containing:

- a 3D viewport with a translate / rotate gizmo (right-mouse-drag to orbit)
- sliders for linear and angular velocity, and for linear and angular acceleration
- a **Simulate** toggle (Space) that integrates velocity and acceleration into
  position and rotation each tick, so the gizmo moves on its own
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
       phys:injectAsInputs(simulator, 1)   -- writes input.getNumber(1..17)
   end

   function onTick()
       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
       local rx, ry, rz = input.getNumber(4), input.getNumber(5), input.getNumber(6)
       -- ... use values as if they came from a real physics sensor block ...
   end
   ```

## Platform support

- **Windows** — uses LifeBoatAPI's own simulator UI (`STORMWORKS_Simulator.exe`) unmodified.
  PhySim's own monitor view can be switched on instead — see
  [Built-in monitors on Windows](#built-in-monitors-on-windows-experimental) below.
- **macOS** — LifeBoatAPI is Windows-only, so PhySim supplies the missing pieces
  itself, including its own monitor simulation (**beta**). See below.

### macOS — PhySim provides its own monitor simulation

> **This is a beta feature.** The monitor simulation is written and maintained
> here rather than coming from upstream, so its rendering, protocol handling and
> UI may still change in breaking ways between releases — including in ways that
> require changes on your side.

LifeBoatAPI (`NameousChangey.lifeboatapi` 0.0.33) ships Windows binaries only, and
without help its debug session does not start on macOS at all. PhySim works around
that:

- **luasocket** — LifeBoatAPI only ships Windows `.dll`s, so PhySim bundles
  universal (arm64 + x86_64) luasocket binaries built for Lua 5.3 and puts them on
  the Lua `cpath`.
- **The simulator window** — `STORMWORKS_Simulator.exe` is a Windows executable and
  cannot run on macOS at all, so **PhySim implements the monitor simulation itself**.
  It listens on port 14238 speaking the same protocol the exe does, renders the
  microcontroller's draw calls onto `<canvas>` inside the PhySim panel, and sends
  touch input back. Shapes are rasterised onto the pixel grid rather than drawn as
  anti-aliased paths, so they stay hard-edged like an in-game monitor. The monitor
  scale follows the Zoom dropdown, a trackpad pinch, or Ctrl/Cmd + wheel.
- **Colours** — LifeBoatAPI gamma-corrects every colour in Lua to replicate what the
  game does to monitors, which lifts dark tones a lot: a `setColor` of 30 arrives as
  112, and anything from 217 up clips to white. PhySim draws the values as they
  arrive, exactly as the exe would. Tick **True colour** in the Monitors header to
  undo that correction and see the raw `setColor` values instead — off by default,
  since the washed-out look is the faithful one.

Since that rendering is an independent reimplementation and not the game's own, it
differs from the real simulator in a few ways:

- text uses a hand-made 4x5 bitmap font, so glyphs are close to — but not identical
  to — the in-game font
- there is no terrain data behind `screen.drawMap`, which paints a flat ocean fill
  as a placeholder
- touch is primary-touch only (the "alt" touch values are always 0)
- the exe's input/output panels are not reproduced — drive the channels from the
  PhySim panel instead

Verified against LifeBoatAPI 0.0.33. The full investigation is in
[`doc/macos-support.md`](macos-support.md).

### Built-in monitors on Windows (experimental)

Set `physim.monitors.useBuiltInOnWindows` to `true` to render the microcontroller's
monitors inside the PhySim panel on Windows too, instead of launching
`STORMWORKS_Simulator.exe`. PhySim then suppresses the exe (through LifeBoatAPI's own
`attachToExistingProcess` path) and answers on port 14238 in its place, so the two
never compete for it. The setting takes effect on the next **F6** — no reload needed.

If it doesn't seem to do anything, run **PhySim: Show Log** from the command palette
— the log says which renderer each F6 chose, whether port 14238 was actually claimed,
and whether the `_simulator.lua` patches applied.

Off by default, and worth keeping off unless you want the panel: on Windows the real
exe is the faithful renderer, and switching means accepting the same
reimplementation caveats listed above — bitmap-font text, no terrain behind
`screen.drawMap`, primary-touch only — plus the loss of the exe's input/output
panels, which PhySim does not reproduce. Drive the channels from the PhySim panel
instead.

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

Rotations are reported in radians using Three.js' Euler XYZ order, normalized
to **[-π, π)** — a full spin wraps instead of accumulating.

## Channel layout

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels
starting at `startCh` (default `1`):

| CH  | Quantity              | Unit        | Notes                                          |
|-----|-----------------------|-------------|------------------------------------------------|
| 1   | position X            | m (East)    |                                                |
| 2   | position Y            | m (Up)      |                                                |
| 3   | position Z            | m (North)   |                                                |
| 4   | rotation X            | rad         | Euler XYZ (intrinsic), normalized to [-π, π)   |
| 5   | rotation Y            | rad         | ″                                              |
| 6   | rotation Z            | rad         | ″                                              |
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
4. Add the following to your `Mymicrocontroller.lua`:

   ```lua
   -- LifeBoatAPI's sandbox require() discards return values, so modules expose
   -- themselves as globals. Use the pair below — NOT `phys = require("PhySim"):new()`.
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- writes input.getNumber(1..17)
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
| `phys:injectAsInputs(simulator, n?)`  | Write CH `n..n+16` into `input.getNumber(...)`.   |
| `phys:close()`                        | Close socket.                                     |

## Extension settings

| Setting                              | Default | Description                                                    |
|--------------------------------------|---------|----------------------------------------------------------------|
| `physim.port`                        | 14239   | TCP port the extension listens on.                             |
| `physim.autoOpenOnSimulate`          | true    | Open the panel when LifeBoatAPI's "Run Simulator" starts.      |
| `physim.panel.openLocation`          | beside  | Where to place the panel when it opens. `beside` = split beside the active editor; `newWindow` = open in a separate floating window (requires VSCode 1.85+). |
| `physim.autoInjectLibraryPath`       | true    | Add `<extension>/lua/` to `lifeboatapi.stormworks.libs.libraryPaths`. |
| `physim.monitors.useBuiltInOnWindows` | false  | **Experimental, Windows only.** Draw the monitors in the PhySim panel instead of launching `STORMWORKS_Simulator.exe`. Ignored on macOS, where the built-in monitors are the only option. |

## Development & tests

```bash
npm install          # also vendors three.js into media/three/
npm run compile      # extension host (tsc → out/)
npm run lint         # eslint
npm run check:media  # strict JSDoc typecheck of the webview modules
npm test             # node:test suites in test/
```

The test suite covers the wire protocol (encode → real `PhySim.lua` parser
round-trip, running Lua 5.3 via [fengari](https://fengari.io/)) and the
CH13–17 derived-channel math, including a **JS⇄Lua parity test** that keeps
`media/channels.js` and `PhySim.lua:injectAsInputs` in agreement.

## Out of scope (v0.1)

- Scripted sensor manipulation
- Multiple microcontroller debug sessions sharing one panel

## Planned features

The following are under consideration. None are implemented yet — listed order does not imply priority.

1. ~~**Direct numeric input for position / rotation + preset save/recall**~~

   ~~Today position and rotation can only be set by dragging the gizmo. Adding numeric input fields (like the velocity sliders already have) and the ability to save named states such as "level flight" or "45° bank" would remove the need to manually re-align the gizmo for repeated tests.~~ → Implemented in v0.2.0

2. ~~**Continuous physics mode (integrate velocity into position)**~~

   ~~Currently velocity and position are independent: setting a velocity does not move the gizmo. A toggle that adds `velocity * dt` to position each tick would let PID controllers and attitude-stabilization MCs be debugged against time-varying CH1–3, much closer to in-game behavior.~~ → Implemented in v0.2.0

3. **Trail / velocity-vector visualization**
   Render the last N ticks of the object's path as a trail in the 3D scene, plus an arrow showing the current velocity vector. Especially useful in combination with the continuous physics mode above.

4. **Multiple physics sensor support**
   Some microcontrollers use more than one physics sensor block. Allowing multiple gizmo targets, each mapped to its own channel range, would cover this use case.

5. **Gamepad input**
   Drive the gizmo with an attached gamepad / joystick. More fluid than mouse dragging for dynamic scenarios.

6. **CSV logging of channel values**
   Stream CH1–17 values to a CSV file for offline analysis or graph plotting.
