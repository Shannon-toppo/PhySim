# Stormworks Physics Sensor Sim (PhySim)

### [日本語](https://github.com/Shannon-toppo/PhySim/blob/main/README.md)

A VSCode extension for Stormworks microcontroller development that lets you feed `physics sensor` block values from a 3D gizmo.
It works together with the **Stormworks Lua with LifeBoatAPI** simulator, so you can test PID controllers,
INS, autopilot logic and the like without launching the game.

![PhySim in action](https://raw.githubusercontent.com/Shannon-toppo/PhySim/main/Animation.gif)

- Move the aircraft's position and attitude with the 3D gizmo, and the values arrive directly in `input.getNumber(1..17)`
- **Simulate** mode that moves it on its own from velocity and acceleration, plus recording and playback
- Switchable simulation speed (×1 / ×0.5 / ×0.25 / ×0.1) and CSV logging
- Works on macOS too. The microcontroller's monitor view is PhySim's own implementation, checked pixel-by-pixel against in-game screenshots

## Requirements

| Item | Requirement |
|------|-------------|
| VSCode | 1.62 or later (`newWindow` for `physim.panel.openLocation` needs 1.85 or later) |
| LifeBoatAPI | [Stormworks Lua with LifeBoatAPI](https://marketplace.visualstudio.com/items?itemName=NameousChangey.lifeboatapi). Tested with 0.0.33. Installed automatically along with PhySim |
| OS | Windows / macOS (Apple Silicon and Intel). Linux is not supported |

## Installation

Search for "**Stormworks Physics Sensor Sim**" in VSCode's Extensions view and install it, or run the following
in Quick Open (Ctrl+P / Cmd+P):

```
ext install shannon-toppo.physim
```

### Installing from a .vsix on GitHub Releases

For environments that cannot use the Marketplace, the same build is also distributed as a `.vsix` on
[GitHub Releases](https://github.com/Shannon-toppo/PhySim/releases). Drag and drop the downloaded `.vsix` onto the
Extensions view, or use **Install from VSIX...** in the Extensions view's "…" menu.

- It is treated as the same extension as the Marketplace version (`shannon-toppo.physim`), so you do not need to install both.
- Even when installed from a `.vsix`, VSCode's auto-update replaces it once a newer version is published on the Marketplace.
  To stay on a specific version, turn off auto-update for PhySim in the Extensions view.
- LifeBoatAPI is installed automatically from the Marketplace with a `.vsix` as well (in an offline environment, install it first).

## Quick start

1. Open a Stormworks microcontroller project (a LifeBoatAPI project).
   The library path for autocompletion is added to `lifeboatapi.stormworks.libs.libraryPaths` automatically
   (you can disable this with `physim.autoInjectLibraryPath`).
2. Add the following to `MyMicrocontroller.lua`:

   ```lua
   -- LifeBoatAPI's sandboxed require() discards return values, so the
   -- module publishes itself as a global.
   -- Use the pair below instead of `phys = require("PhySim"):new()`.
   require("PhySim")
   phys = PhySim:new()

   function onLBSimulatorTick(simulator, ticks)
       phys:update()
       phys:injectAsInputs(simulator, 1)   -- writes input.getNumber(1..17)
   end

   function onTick()
       local px, py, pz = input.getNumber(1), input.getNumber(2), input.getNumber(3)
       local rx, ry, rz = input.getNumber(4), input.getNumber(5), input.getNumber(6)
       -- ... use them as if they came from a real physics sensor block ...
   end
   ```

   If you also use monitor touch input, set the starting channel to something other than 1 (see "Touch input and channel conflicts" below).

3. Press **F6** to start the LifeBoatAPI simulator. The PhySim panel opens beside it
   (set `physim.panel.openLocation` to `newWindow` to open it in a separate window).
   Drag the gizmo and Lua receives the changing values in real time.

## Features

- 3D viewport with a translate / rotate gizmo
- Sliders for linear and angular velocity, and for linear and angular acceleration. Position and rotation can also be entered as numbers, and attitudes can be saved and recalled as presets
- **Simulate** toggle — integrates velocity and acceleration into position / rotation every tick, so the gizmo moves on its own
- **Simulation speed** — slows the panel's Simulate / Play and the microcontroller's ticks by the same factor (see "Simulation speed" below)
- **Trail and velocity arrow** — draws the positions passed through over the last N ticks as a line in the 3D scene,
  and shows the current linear velocity as an arrow. Toggle them in the sidebar's "Visualization" section;
  the trail length can be 2/5/10/30 seconds
- **CSV logging** — writes CH1–17 to a CSV file (see "CSV logging" below)
- **Resizable layout** — drag the border between the 3D viewport and the monitor view
  to change the height of the monitor area
- **Sidebar toggle** — the toolbar's "◫ Values" hides the sliders, number inputs and channel table on the right,
  so the 3D viewport and monitor view can use the full panel width
- Live display of all 17 channels

Values are streamed over a local TCP socket to a small Lua helper (`PhySim.lua`) and can be used either as:

- injections into the standard `input.getNumber(N)` table
- direct queries such as `phys:position()` and `phys:rotation()`

## Controls

### Commands

Run these from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P).

| Command | Description |
|---------|-------------|
| `PhySim: Open Physics Sensor Panel` | Opens the panel (for when it did not open automatically) |
| `PhySim: Reset Gizmo` | Stops Simulate and resets position, rotation, velocity and acceleration to 0 |
| `PhySim: Show Log` | Shows PhySim's log (for investigating problems) |

### Shortcuts in the panel

Disabled while a number input has focus.

| Key / action | Description |
|--------------|-------------|
| **Space** | Toggle Simulate |
| **W** / **E** | Switch the gizmo to translate / rotate mode |
| **R** | Reset the gizmo |
| **H** | Toggle the sidebar |
| Left-drag (away from the gizmo) | Orbit the view |
| Right-drag / wheel-drag | Pan the view |
| Wheel | Zoom |

On the border between the 3D view and the monitor view, drag to change the height, use the arrow keys (larger steps with Shift) to fine-tune,
and double-click or press Home / End to return to the automatic size that fits the content.

## Coordinate system

Stormworks uses a **left-handed** world coordinate system:

| Axis | Direction          |
|------|--------------------|
| X+   | East               |
| Y+   | Up (vertical)      |
| Z+   | North              |

The gizmo viewport is rendered in Three.js's right-handed coordinates, with the camera placed so that
+Z extends **into the screen** (away from the viewer).
This gives an intuitive "north is forward" layout.

Rotations are output as radians in Three.js Euler XYZ order and normalized to **[-π, π)**.
They wrap around instead of accumulating past one full turn.

## Channel layout

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels
starting at `startCh` (default: `1`):

| CH  | Quantity              | Unit        | Notes                                          |
|-----|-----------------------|-------------|------------------------------------------------|
| 1   | Position X            | m (east)    |                                                |
| 2   | Position Y            | m (up)      |                                                |
| 3   | Position Z            | m (north)   |                                                |
| 4   | Rotation X            | rad         | Euler XYZ (intrinsic), normalized to [-π, π)   |
| 5   | Rotation Y            | rad         | 〃                                             |
| 6   | Rotation Z            | rad         | 〃                                             |
| 7   | Linear velocity X     | m/tick      |                                                |
| 8   | Linear velocity Y     | m/tick      |                                                |
| 9   | Linear velocity Z     | m/tick      |                                                |
| 10  | Angular velocity X    | rad/tick    |                                                |
| 11  | Angular velocity Y    | rad/tick    |                                                |
| 12  | Angular velocity Z    | rad/tick    |                                                |
| 13  | Linear speed (abs)    | m/s         | √(vx²+vy²+vz²) × 60                           |
| 14  | Angular speed (abs)   | RPS         | √(ax²+ay²+az²) × 60 / 2π                      |
| 15  | Tilt.z                | rotation    | Tilt of local +Z (forward) from the horizontal plane |
| 16  | Tilt.x                | rotation    | Tilt of local -X (left) from the horizontal plane    |
| 17  | Compass               | rotation    | North=0, West=+0.25, South=±0.5, East=-0.25 (CCW seen from above) |

"rotation" unit: 1.0 = one full turn (2π rad). Tilt ranges over [-0.25, +0.25] (±90° from horizontal).
The compass wraps at ±0.5.

### Touch input and channel conflicts

Every tick, LifeBoatAPI writes the screen width, height, touch X, touch Y,
alt touch X and alt touch Y into `input.getNumber(1..6)` (`Simulator._simulateDefaultInputs`).
`phys:injectAsInputs(simulator, 1)` runs right after that and overwrites CH1-6, so
**the monitor's touch coordinates never reach the microcontroller**. LifeBoatAPI gives
priority to channels set from outside, so touch values no longer overwrite them afterwards.
If you use touch coordinates, shift the starting channel.

```lua
phys:injectAsInputs(simulator, 7)   -- CH7-23. Leaves CH1-6 free for touch
```

`input.getBool(1)` (whether it is pressed) still works with a starting channel of 1, because PhySim
does not write bools. Also, `_simulateDefaultInputs` only reads screen 1, so read touches on
the second and later monitors yourself with `simulator:getTouchScreen(2)`
(the same applies with `STORMWORKS_Simulator.exe`). Alt touch is not implemented in PhySim and is always 0.

## Simulation speed

The toolbar dropdown (×1 / ×0.5 / ×0.25 / ×0.1) lets you watch motion slowly.
Two things slow down, both by the same factor:

- Panel side: **Simulate** integration and **Play** playback
- Microcontroller side: LifeBoatAPI's main loop (the interval between `onLBSimulatorTick` / `onTick` / `onDraw` calls)

The amount advanced per tick stays at the slider values (m/tick, rad/tick), and the "×60" in CH13/14
remains correct as one in-game second. To the microcontroller, it is the same as the game running slowly.
Neither side is slowed alone, to keep the change in position and the velocity channels from disagreeing.

The selected speed is saved per workspace and used in the next debug session as well.
The dropdown turns yellow when it is not ×1, so you can tell if a previous setting is still in effect.

Notes:

- The speed reaches the microcontroller through `phys:injectAsInputs(simulator, …)`. If you only use
  `phys:update()` without calling it, only the panel side slows down.
- Closing the panel, calling `phys:close()`, or losing the connection to PhySim returns
  the microcontroller side to 60 ticks/s.
- On Windows, if you also change the tick rate from `STORMWORKS_Simulator.exe`, whichever
  was changed last takes effect. PhySim only writes it when you change the speed and when it connects.
- Pausing and single-stepping are not supported.

## CSV logging

Pressing **⬇ CSV Log** in the toolbar opens a dialog asking where to save, and recording starts
as soon as you choose. Press it again to stop; you can open the file directly from the notification's **Open**.
While recording, the row count is shown next to the button.

Rows are written at two times. While **Simulate** / **Play** is running, one row per tick (1/60 s);
while stopped, one row each time a sensor value changes through dragging the gizmo or entering a number.
The sample interval is therefore not constant, so use the `time_s` or `game_time_s` column as the time axis.
If you record at a reduced simulation speed, `game_time_s` is the one that matches the velocity columns.

There are 21 columns: `sample,time_s,game_time_s,time_scale,ch1_pos_x,…,ch17_compass`.

| Column    | Content                                          |
|-----------|--------------------------------------------------|
| `sample`  | Row number within the log (starting at 0)        |
| `time_s`  | Seconds since recording started (real time)      |
| `game_time_s` | In-game seconds since recording started (ticks ÷ 60). Does not advance while dragging when stopped |
| `time_scale`  | Simulation speed when the row was recorded (1 = normal speed) |
| `ch1`–`ch17` | Channel values. Same units and rounding (6 decimal places) as the table above |

Line endings are CRLF and numbers use the same format as the values sent to Lua, so the file loads
directly into Excel, pandas, gnuplot and so on.

## Lua API

After `require("PhySim")`, the global `PhySim` is the class table.

| Method                                | Returns / effect                                     |
|---------------------------------------|------------------------------------------------------|
| `PhySim:new(host?, port?)`            | Construct and connect. Default: `127.0.0.1:14239`    |
| `phys:update()`                       | Reads the socket. Call once per tick                 |
| `phys:position()`                     | `x, y, z` (m)                                        |
| `phys:rotation()`                     | `rx, ry, rz` (rad)                                   |
| `phys:velocity()`                     | `vx, vy, vz` (m/tick)                                |
| `phys:angularVelocity()`              | `ax, ay, az` (rad/tick)                              |
| `phys:injectAsInputs(simulator, n?)`  | Writes CH `n..n+16` to `input.getNumber(...)`. The panel's simulation speed is also applied here |
| `phys:tickRate()`                     | The panel's simulation speed (ticks/s, 60 = normal speed) |
| `phys:close()`                        | Closes the socket and resets the tick rate to 60     |

## Extension settings

| Setting                              | Default    | Description                                                            |
|--------------------------------------|------------|------------------------------------------------------------------------|
| `physim.port`                        | 14239      | TCP port the extension listens on. If you change it, match it on the Lua side with `PhySim:new("127.0.0.1", port)` |
| `physim.autoOpenOnSimulate`          | true       | Automatically open the panel when LifeBoatAPI's "Run Simulator" starts |
| `physim.panel.openLocation`          | beside     | Where to open the panel. `beside` = split beside the active editor, `newWindow` = open in a separate window (requires VSCode 1.85 or later) |
| `physim.autoInjectLibraryPath`       | true       | Add `<extension>/lua/` to `lifeboatapi.stormworks.libs.libraryPaths`   |
| `physim.monitors.useBuiltInOnWindows` | false     | **Experimental, Windows only.** Draw the monitors in the PhySim panel instead of launching `STORMWORKS_Simulator.exe`. Ignored on macOS, where the built-in implementation is the only option |

## Supported platforms

- **Windows** — Uses LifeBoatAPI's own simulator UI (`STORMWORKS_Simulator.exe`) as is.
  A setting lets you switch to PhySim's monitor view instead (see "Using PhySim's monitor view on Windows" below).
- **macOS** — LifeBoatAPI is built for Windows. PhySim provides what is needed on macOS, so it can be used on macOS too.
  The monitor view is PhySim's own implementation.

### PhySim's monitor view

On macOS, `STORMWORKS_Simulator.exe` cannot run, so the microcontroller's monitors are drawn inside the PhySim panel.
Touch input can also be sent from the panel's monitors. Change the zoom with the Zoom dropdown,
a trackpad pinch, or Ctrl/Cmd + wheel.

**Rendering accuracy** — The drawing rules are derived from screenshots of verification scripts
shown on in-game monitors (Stormworks v1.15.23). Tests confirm that lines, circles, fills, rectangles, text,
`drawTextBox` wrapping and translucent colour blending reproduce every captured page
(each size from 1x1 to 9x5) pixel for pixel.

- Circles are drawn as 8- to 16-sided polygons depending on the radius, just as in the game
- Text matches the game's font (all 95 characters of ASCII 32–126)
- There is no anti-aliasing, so it shows the same blocky pixels as the game

Details of the verification are in [`doc/ingame-findings.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/ingame-findings.md) (Japanese).

> **This is a beta.** The monitor view is implemented and maintained by PhySim rather than LifeBoatAPI,
> so its UI and behaviour may change between releases.

**Colour** — To match the game's look, LifeBoatAPI gamma-corrects every colour on the Lua side.
Darker colours are shown brighter (a `setColor` of 30 becomes 112,
and anything from 217 up becomes white). Like the exe, PhySim draws the values it receives as is.
Turning on **True colour** in the Monitors header cancels this correction and shows the raw values
passed to `setColor`. It is OFF by default (because the brighter look is the correct
reproduction of the game).

Compared with `STORMWORKS_Simulator.exe`, the following are not reproduced:

- `screen.drawMap` has no terrain data behind it, so it fills with plain sea colour instead
- Touch is primary only (alt touch values are always 0)
- The exe's input/output panels. Drive the channels from the PhySim panel instead
- Portrait monitors have not yet been checked against the game

How macOS support works is described in [`doc/macos-support.md`](https://github.com/Shannon-toppo/PhySim/blob/main/doc/macos-support.md) (Japanese).

### Multiple monitors

A microcontroller wired to several monitors in the game can be reproduced as is in the panel.

Add a screen with **+ Monitor** in the Monitors header, and in each monitor's caption row use the
dropdown for the size (`1x1` to `9x5`), **Portrait** for vertical orientation, and **✕** to remove it.
The simulator calls `onDraw` once for each active monitor, and inside it
`screen.getWidth()` / `getHeight()` return the size of "the screen currently being drawn", so
the microcontroller code can tell the screens apart the same way it does in the game. Touch input is
also sent separately for each monitor, but only screen 1 flows into the composite inputs automatically
(see "Touch input and channel conflicts" above).

- Screens the microcontroller script declares with `simulator:setScreen(...)` take precedence.
  The panel's settings only apply to screen numbers the script does not touch.
- Screen 1 cannot be removed. It is LifeBoatAPI's default screen and the only screen whose size and touch
  flow into the composite inputs.
- Removal is sent as a power-off. Lua has no way to delete a screen, so it comes back
  if you add it again or if the script calls `setScreen`.
- The layout is saved per workspace and restored in the next debug session.
- The zoom is shared by all monitors. Fitting each screen separately would draw a 1x1 larger than a 3x3,
  and you could no longer tell their relative sizes.

This feature is only available when PhySim's monitor view is in use (always on macOS; on Windows with
`physim.monitors.useBuiltInOnWindows`). In a normal Windows setup using `STORMWORKS_Simulator.exe`,
configure the monitors from the script with `simulator:setScreen` as before.

### Using PhySim's monitor view on Windows (experimental)

Setting `physim.monitors.useBuiltInOnWindows` to `true` makes Windows skip launching
`STORMWORKS_Simulator.exe` as well and draw the microcontroller's monitors inside the PhySim panel.
It uses LifeBoatAPI's own setting for connecting to an already-running simulator,
so the exe is not launched. The setting takes effect from the next **F6**; no window reload is needed.

If nothing changes after turning it ON, run **PhySim: Show Log** from the Command Palette.
For each F6 the log shows which renderer was chosen, whether port 14238 was actually acquired, and whether
the patch to `_simulator.lua` was applied.

It is OFF by default. Choose between them based on the following:

- **When PhySim's view suits you** — when you want to check shapes and text with rules fitted to in-game screenshots.
- **When the exe suits you** — when you want `screen.drawMap` maps, alt touch, or the exe's input/output panels.

### Tip: using only the monitor simulation

If all you want is the monitors, you don't need to add `require("PhySim")`,
`PhySim:new()`, `phys:update()` or `phys:injectAsInputs()` to your script. The
monitor view only listens for LifeBoatAPI's own draw commands on port 14238 and
is independent of `PhySim.lua`. Press **F6** as usual and your existing project's
monitors appear in the PhySim panel, touch input included (always on macOS; on
Windows when `physim.monitors.useBuiltInOnWindows` is on).

The physics sensor channels (CH1–17) then never reach the microcontroller, so
moving the gizmo has no effect on your script — but neither does the CH1-6
overwrite described in "Touch input and channel conflicts" above.

## Network use

To exchange values with LifeBoatAPI's simulator, PhySim listens on TCP ports only within your own PC (`127.0.0.1`).
It never communicates with any external server.

| Port | When | Purpose |
|------|------|---------|
| 14239 (changeable with `physim.port`) | Always while the simulator is running | Sending sensor values from the panel to `PhySim.lua` |
| 14238 | When PhySim's monitor view is used (macOS / the experimental Windows setting) | Receiving monitor drawing in place of `STORMWORKS_Simulator.exe` |

Both are opened when the debug session starts and closed when it ends.

### Additions to the file LifeBoatAPI generates

On every F6, PhySim adds a few lines for the connection to `_build/_simulator.lua`, which LifeBoatAPI
generates in your workspace. It does not modify any of LifeBoatAPI's own files.

## Troubleshooting

**The panel does not open when I press F6**
- Check that `physim.autoOpenOnSimulate` is not `false`.
  You can also open it manually with **PhySim: Open Physics Sensor Panel** from the Command Palette.
- PhySim only reacts to the "Run Simulator" session that LifeBoatAPI's F6 starts.
  Launching Lua from your own launch configuration is not covered.
- **PhySim: Show Log** shows whether the session was detected and whether the patch was applied.

**"failed to bind TCP port 14239" is shown**
- Another process (such as a leftover previous simulator) is using the port. Restart VSCode, or
  set `physim.port` to a different number and match it on the Lua side with `PhySim:new("127.0.0.1", port)`.

**`phys = require("PhySim"):new()` raises an error**
- In LifeBoatAPI's sandbox, `require` does not return a value.
  Split it into the two lines `require("PhySim")` and `phys = PhySim:new()` (see Quick start).

**Monitor touches do not reach the microcontroller**
- `injectAsInputs(simulator, 1)` overwrites the touch values in CH1-6.
  Shift the starting channel to 7 or similar (see "Touch input and channel conflicts").

**The monitor stays black on macOS**
- If "could not listen on port 14238" is shown, a previous simulator is still holding
  the port. Stop the debug session and press F6 again.

**Lua cannot find `require("PhySim")` / autocompletion does not work**
- At run time PhySim adds the path automatically, so no setup is needed. If only autocompletion fails,
  check that `physim.autoInjectLibraryPath` is enabled and reload the window.

## Known limitations

- Linux is not supported
- Operating the sensor cannot be automated from a script
- One panel cannot be shared between several microcontroller debug sessions
- Pausing and single-stepping the simulation are not supported
- For features PhySim's monitor view does not reproduce, see "PhySim's monitor view"

## Planned features

The following features are under consideration. None are implemented yet, and the order does not indicate priority.
For features implemented so far, see the [CHANGELOG](https://github.com/Shannon-toppo/PhySim/blob/main/CHANGELOG.md) (Japanese).

- **Multiple physics sensors** —
  Supports using several physics sensor blocks in one MC. Place several gizmo targets and
  map each to its own channel range.
- **Gamepad input** —
  Operate the gizmo with a connected gamepad / joystick. Allows smoother input than mouse dragging
  in dynamic scenarios.

## Feedback

Please send bug reports and requests to [GitHub Issues](https://github.com/Shannon-toppo/PhySim/issues).
For bugs, including the output of **PhySim: Show Log** and your OS and LifeBoatAPI versions speeds up the investigation.

If a problem occurs while PhySim is installed, please report it to PhySim's Issues first, not to LifeBoatAPI.

To contribute, including how to build and run the tests, see [CONTRIBUTING.md](https://github.com/Shannon-toppo/PhySim/blob/main/CONTRIBUTING.md) (Japanese).

## License

PhySim is released under the [MIT License](https://github.com/Shannon-toppo/PhySim/blob/main/LICENSE).

### Third-party software

PhySim bundles the following software.

| Software | Purpose | License |
|----------|---------|---------|
| [three.js](https://threejs.org/) r160 (`three.module.js`, `OrbitControls`, `TransformControls`) | The panel's 3D view and gizmo | MIT License — Copyright © 2010-2023 three.js authors |
| [LuaSocket](https://github.com/lunarmodules/luasocket) 3.0 (macOS binaries) | TCP communication from Lua on macOS | MIT License — Copyright © 2004-2013 Diego Nehab |

The full LuaSocket license is bundled in the extension at `luasocket/darwin/LICENSE`.
For the full three.js license, see [the three.js repository](https://github.com/mrdoob/three.js/blob/r160/LICENSE).

### Disclaimer

PhySim is an unofficial extension developed by an individual. It is not affiliated with Geometa, the developer of
Stormworks: Build and Rescue, or with the author of Stormworks Lua with LifeBoatAPI.
Stormworks is a trademark of Geometa.
