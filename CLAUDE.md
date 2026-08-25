# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VSCode extension that simulates Stormworks' in-game *physics sensor* block from a 3D gizmo, and feeds the values into `Stormworks Lua with LifeBoatAPI` (`NameousChangey.lifeboatapi`) microcontroller debug sessions. It runs alongside LifeBoatAPI's existing simulator (which already binds `127.0.0.1:14238`), so PhySim uses port **14239**.

See `doc/worklog.md` for the iteration history — the sandbox-limitation discoveries there are still load-bearing context for any Lua-side change. `doc/macos-support.md` records why the extension cannot run on macOS (upstream LifeBoatAPI is Windows-only) — read it before attempting any cross-platform work.

## Commands

```bash
npm install                # also runs scripts/copy-three.js (postinstall) — copies three.js & controls into media/three/
npm run compile            # tsc -p ./  →  out/
npm run watch              # tsc --watch
npm run lint               # eslint . (flat config, correctness rules only — no formatter)
npm run check:media        # tsc -p tsconfig.media.json — strict checkJs over media/*.js (JSDoc types)
npm test                   # compile + node --test test/**/*.test.mjs
npx vsce package           # build physim-x.y.z.vsix for distribution
scripts/build-luasocket-macos.sh  # rebuilds the committed universal (arm64+x86_64) luasocket/darwin/*.so — only needed when changing luasocket/Lua versions
```

Debugging the extension itself: open the folder in VSCode and press **F5**. `.vscode/launch.json` is already wired (Extension Development Host, preLaunchTask = `npm: compile`).

### Tests

`test/` uses Node's built-in `node:test` runner (no framework dependency):

- `protocol.test.mjs` — `physServer.encode()` wire format (4-digit prefix, field order, `fmt` rounding).
- `channels.test.mjs` — known-value + golden-regression tests for `media/channels.js` (CH13–17 math).
- `roundtrip.test.mjs` — Node `encode()` bytes fed through `PhySim.lua`'s real `update()` parser and read back (frame splits, concatenation, corrupt-prefix resync).
- `parity.test.mjs` — **the CH13–17 desync guard**: runs `media/channels.js` and `PhySim.lua:injectAsInputs` over the same vectors and asserts agreement to 1e-9. Extend its vector table whenever the derived-channel math changes.
- Lua runs inside **fengari** (Lua 5.3 semantics in pure JS — same major version as lua-debug) via `test/helpers/luaRunner.mjs`, which stubs `_physim_socket` and drives `PhySim._buf` directly. No system Lua install needed.
- `simulatorLuaPatch.test.mjs` — the `_simulator.lua` surgery: injection order (FS shim before `createSandbox`, socket after), the exe-launch suppression, idempotence, and the "upstream changed the template" cases that must warn instead of guessing.
- `trail.test.mjs` — `media/trail.js`: the trail buffer keeps the newest points in draw order, drops sub-millimetre samples, survives a capacity change, and the velocity-arrow length stays inside the scene for any speed.
- `blend.test.mjs` — `media/blend.js`: packed words really are R,G,B,A in memory order (get this backwards and every monitor colour comes out with red and blue swapped), and blending is an exact lerp that doesn't drift over repeated draws.
- `raster.test.mjs` — `media/raster.js`: exact pixel sets for axis-aligned and 45° lines, circle symmetry, triangle coverage, and the clipping/guard cases (off-screen endpoints, absurd radii) that keep the loops bounded.
- `csv.test.mjs` — `media/csv.js`: header/row width agreement, a golden row, CH1–12 formatted byte-for-byte like `physServer.fmt()`, and the tick/send de-duplication.
- `csvLogger.test.mjs` — `src/csvLogger.ts`: CRLF records, rows arriving with no log open, a row smuggling its own newline, truncate-on-start, and an end-to-end pass where webview-shaped batches parse back as one table.
- `simstub.test.mjs` — the shared `frame.ts` framing (prefix encode/decode, split/concat/corrupt-prefix resync) plus `simStubServer.ts`'s protocol handling: `SCREENCONFIG` → `SCREENSIZE`, portrait swap, `TICKEND` buffering/flush, draw-command parsing, and `sendTouch()`'s wire shape.

## Architecture — three boundaries, three runtimes

Data flows through three independent runtimes that the design has to keep in sync:

```
WebView (browser JS, Three.js)
       │  postMessage  {type:"state", position, rotation, velocity, angularVelocity}
       ▼
Extension host (Node, TypeScript)  ──  TCP 14239 (length-prefixed text)  ──  Lua-debug process (Lua 5.3)
                                                                              │
                                                                              ▼
                                                                          LifeBoatAPI sandbox
                                                                          (user microcontroller code)
```

A second TCP server — `SimStubServer` on port 14238 (`src/simStubServer.ts`) — stands in for LifeBoatAPI's Windows-only `STORMWORKS_Simulator.exe`, which the sandboxed Lua otherwise connects to directly. It runs whenever `useBuiltInMonitors()` (in `debugConfigPatcher.ts`) is true: always on macOS, and on Windows only with the experimental `physim.monitors.useBuiltInOnWindows` setting. It answers the same `SimulatorConnection.lua` protocol and forwards parsed screen config/draw commands to the WebView, where `media/mcScreen.js` renders the microcontroller's monitors on `<canvas>`. `src/frame.ts` holds the `%04d`-length-prefixed framing shared by both TCP servers.

1. **`media/`** — the WebView, split into ES modules loaded via relative imports from the entry `panel.js` (the CSP nonce on the entry `<script type="module">` propagates to the whole module graph — no `buildHtml` changes needed when adding a module):
   - `panel.js` — entry point; wires toolbar/keyboard/message events and the render loop only.
   - `vscodeApi.js` — `acquireVsCodeApi()` singleton (may only be called once).
   - `channels.js` — **CH13–17 derived math, pure module** (no DOM/three imports) so Node tests import it directly. Its Lua twin is `PhySim.lua:injectAsInputs`, guarded by `test/parity.test.mjs`.
   - `dom.js` — element registry, slider⇄number sync, channel table, and the **single shared `syncGuard`** re-entry flag (also used by `pose.js` — keep it one flag).
   - `scene.js` — Three.js scene, airplane mesh, Orbit/TransformControls, resize, axis labels.
   - `pose.js` — pose number inputs ⇄ gizmo sync.
   - `messaging.js` — `readState()` / `sendState()` / rAF-debounced `scheduleSend()`.
   - `simulation.js` — fixed-timestep integration (60 Hz accumulator) + recording/playback.
   - `presets.js` — preset save/load/delete UI intents.
   - `logging.js` — CSV channel logging: owns the toolbar button, batches rows over `postMessage`, and reflects the host's authoritative `csvState` (starting is a round trip — the save dialog can be cancelled).
   - `csv.js` — **column set, row formatting and sample bookkeeping, pure module** (no DOM) so `test/csv.test.mjs` runs it in Node. Owns `CSV_HEADER`, which the webview sends as the log's first row — the host never learns what a channel is. `tickRow`/`sendRow` implement the one-row-per-frame handshake: `stepSimulation()` calls `sendState()` after its tick loop, and without it every simulated frame would end with a duplicate of its last tick.
   - `visuals.js` — the path trail (a `THREE.Line` with an age-faded vertex colour) and the world-frame velocity arrow, plus the sidebar toggles that own them. Samples per **tick** (called from `simulation.js`'s fixed-timestep loop) as well as per rAF, so a throttled panel still records the path at full resolution.
   - `trail.js` — **trail ring buffer + arrow scaling, pure module** (no DOM/three) so `test/trail.test.mjs` runs it in Node. The buffer shifts rather than wraps: the vertex order must equal the draw order or the line draws a stray segment across the seam.
   - `mcScreen.js` — microcontroller monitor rendering (always on macOS, opt-in on Windows); draws `SimStubServer`'s forwarded screen config/draw commands and relays touch input back. See "Monitor colours" below before touching `makeColour()`, and "Monitor rendering cost" before making it draw through the canvas 2D API again.
   - `blend.js` — **colour packing + source-over blending, pure module** (no DOM/canvas) so `test/blend.test.mjs` runs it in Node. Owns the endianness probe that decides how RGBA bytes pack into an ImageData word.
   - `pixelFont.js` — the hand-drawn 4x5 bitmap font TEXT/TEXTBOX are rasterised with (`fillText` at 5px would anti-alias into unreadable mush).
   - `raster.js` — **integer-grid line/circle/triangle rasterisers, pure module** (no DOM/canvas — the target is a `plot`/`fillRun` callback) so `test/raster.test.mjs` can run them in Node. Canvas path drawing anti-aliases, which the integer CSS upscale magnifies into a visible haze; Stormworks monitors have no AA. Every rasteriser clips to the screen, so a microcontroller passing ±1e9 coordinates can't hang the panel.
   Coordinate convention is **Stormworks left-handed (X+ East, Y+ Up, Z+ North)** — three.js itself is right-handed, so the camera is positioned to make `+Z` look like "into the screen / north" without any scene-level flipping. The modules are vanilla JS with JSDoc types, checked by `npm run check:media` (strict).

2. **`src/`** — the extension host.
   - `extension.ts` activates on `onStartupFinished`, listens for `vscode.debug.onDidStartDebugSession` filtered by `session.type === "lua" && session.name === "Run Simulator"` (the exact config LifeBoatAPI produces in its `runSimulator.js`). On match it starts `PhysServer` and opens the panel.
   - `physServer.ts` is a single-client `net.createServer` on `127.0.0.1:<port>` using the **same length-prefix protocol as LifeBoatAPI's `SimulatorConnection.lua`**: `sprintf("%04d", body.length) + body`. Don't reorder the 12 fields — `PhySim.lua` parses positionally.
   - `physSimPanel.ts` serves `media/panel.html` (the **authoritative** markup template) after substituting the `{{…}}` placeholders — CSP, nonce, webview-resource URIs, slider bounds. `substituteTemplate` throws if a placeholder is left unresolved. Note: an HTML comment in the template must never contain a literal double-brace token, or the leftover check trips.
   - `debugConfigPatcher.ts` is the **critical glue**: see "LifeBoatAPI integration" below.
   - `libraryPathInjector.ts` writes the bundled `lua/` path into `lifeboatapi.stormworks.libs.libraryPaths` for editor autocompletion. Re-run on `onDidChangeWorkspaceFolders`. The **runtime** does not depend on this setting — only autocomplete does.
   - `pathUtils.ts` — shared `normalize()` for Windows-safe path comparison (used by both files above).
   - `simStubServer.ts` — the port-14238 stand-in for `STORMWORKS_Simulator.exe`; started from `debugConfigPatcher.ts` before `lua-debug` spawns Lua, whenever `useBuiltInMonitors()` says PhySim is drawing the monitors.
   - `simulatorLuaPatch.ts` — the `_simulator.lua` text surgery (socket injection, POSIX file-scan shim, exe-launch suppression) as a **pure, `vscode`-free module** so `test/simulatorLuaPatch.test.mjs` can run it in Node.
   - `frame.ts` — the `%04d`-length-prefixed framing shared by `physServer.ts` and `simStubServer.ts`.
   - `csvLogger.ts` — the CSV log file: open/append/close plus row sanitising, as a **pure, `vscode`-free module** so `test/csvLogger.test.mjs` can run it in Node. It appends whatever lines it is handed and counts them; the column set lives in `media/csv.js`.

3. **`lua/PhySim.lua`** — runs inside LifeBoatAPI's sandbox.

## LifeBoatAPI integration (read before touching `debugConfigPatcher.ts` or `PhySim.lua`)

`assets/lua/Common/LifeBoatAPI/Tools/Simulator/SimulatorSandbox.lua` in the LifeBoatAPI extension builds an extremely restricted `_ENV` for user scripts. Things that are NOT available inside the sandbox:

- C modules — including `socket`. `require("socket")` from sandboxed code **always fails**.
- `setmetatable`, `getmetatable`, `pcall`, `error`, `assert`, `select`, `_G`, `io`, `package`, `loadstring`, `load`, `rawget`/`rawset`, …
- `require` returns nothing — its custom implementation calls the loaded chunk but discards the return value. Modules must publish themselves as globals.

We solve both barriers in `debugConfigPatcher.ts`'s `resolveDebugConfigurationWithSubstitutedVariables`, which VSCode calls during `vscode.debug.startDebugging` AFTER LifeBoatAPI has written `_build/_simulator.lua` but BEFORE `lua-debug` spawns Lua:

1. **Append the bundled `lua/` dir to `config.arg`.** LifeBoatAPI's `_simulator.lua` does `for i=3, #arg do rootDirs[...] = arg[i] end`, so anything we push gets indexed by `SimulatorSandbox`'s require map. This is why PhySim works in any LifeBoatAPI project without per-project setup — do NOT replace this with a settings-file approach.
2. **Patch `_simulator.lua`** to insert `sandboxEnv._physim_socket = require("socket")` right after the `createSandbox(rootDirs)` line. The regex `SANDBOX_LINE_RE` matches that line; the `_physim_socket` marker prevents double-patching. All of the `_simulator.lua` text surgery lives in `simulatorLuaPatch.ts`, which imports no `vscode` so the tests can drive it directly.
3. **Flip `_beginSimulation(false, …)` to `true`** whenever `useBuiltInMonitors()` is true. That `false` is LifeBoatAPI's own `attachToExistingProcess` flag, and the `true` path skips the `io.popen` that launches `STORMWORKS_Simulator.exe` — the Lua then connects to whatever already holds 14238, which is `SimStubServer`. Without this the real exe would fight us for the port on Windows (on macOS the launch just fails harmlessly, but there is no reason to attempt it). `Simulator.lua` only ever *assigns* `_simulatorProcess`, so nothing downstream misses the handle.

On `process.platform === "darwin"`, two more patches apply:

4. **Prepend `luasocket/darwin/?.so` to `config.cpath`.** LifeBoatAPI's own cpath entries are literal `.dll` file paths with no `?` template, and Lua's `package.searchpath` returns the first *readable* file regardless of module name — so our entry must be prepended, never appended, or it's never tried. See `doc/macos-support.md` for the discovery.
5. **Override `config.luaArch`** to the native arch (`arm64` or `x86_64`) — LifeBoatAPI hardcodes `"x86"`, which would otherwise run Lua under Rosetta instead of natively.
6. **Replace `FileSystemUtils.findPathsInDir`** (injected into `_simulator.lua` right *before* the `createSandbox` line, while the socket line goes after). LifeBoatAPI enumerates files with Windows `dir "..." /b`, which returns nothing on macOS — the sandbox's require map ends up empty and the user's script fails with "Could not find require". The shim uses POSIX `find -mindepth 1 -maxdepth 1 -type f|d` and returns bare names, matching the original contract. See `doc/macos-support.md` blocker 4.

Constraints this puts on `lua/PhySim.lua`:

- **No metatables.** `PhySim` is a singleton — `PhySim:new()` re-initialises the same global table and returns it.
- **No `pcall`/`error`.** Bail out by `print` + `return` at the top level.
- **Publish as a global**, don't return from the chunk (return is harmless but useless inside the sandbox).
- Read `_physim_socket` from the chunk's `_ENV` — that's the injected `socket`.
- `math.atan` is Lua 5.3 form `math.atan(y, x)`; `math.atan2` doesn't exist.

## Channel layout (CH1–17)

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels via `simulator:setInputNumber`. CH1–12 are the raw 12 floats from the wire protocol; CH13–17 are derived locally with trig on the rotation values. On the JS side this math is single-sourced in `media/channels.js:deriveChannels`; the Lua side stays hand-written in `injectAsInputs` (the sandbox cannot share code with JS) and `test/parity.test.mjs` asserts the two agree — extend its vector table when changing the math.

The Stormworks tick rate (60 Hz) is baked into the m/tick → m/s and rad/tick → RPS conversions for CH13 and CH14.

CH4–6 are normalized to **[-π, π)**. That math is also doubled: `normalizeAngle()` in `media/channels.js` (applied in `readState()` and in the integrator so the pose inputs stay wrapped too) and `_normAngle` in `lua/PhySim.lua` (applied when `update()` parses a frame, so `phys:rotation()` and CH4–6 always agree). Lua's `%` is floor-modulo and JS' is a remainder — the JS side needs the sign fix-up, the Lua side doesn't. Wrapping is idempotent, so applying it on both sides is harmless. `test/roundtrip.test.mjs` pins the Lua half against the JS twin.

## Monitor colours (macOS panel)

LifeBoatAPI gamma-corrects every colour **in Lua** before it reaches us —
`Simulator_ScreenAPI.lua`'s `_setColorBase` does `255 * ((c/255)/0.85)^(1/2.4)`
— to replicate what the game does to monitors. It lifts dark tones hard: a
`setColor` of 30 arrives as 112, and anything from 217 up clips to white. The
washed-out result is *correct*; don't "fix" it by changing `rgba()`.

The correction is applied unclamped (255 leaves as 272.9), so the panel's
optional **True colour** toggle (`unGamma`, off by default) inverts it
losslessly back to the original `setColor` values.

## Monitor rendering cost

`mcScreen.js` draws into an `ImageData` through a `Uint32Array` view and
uploads each monitor with one `putImageData` at the end of the frame. Do not
"simplify" this back into canvas 2D calls: `ctx.fillRect(x, y, 1, 1)` per
pixel measured **6-7x slower** on the same frames (a 500-command frame went
from 0.45 ms to 2.9 ms in an A/B on one page), which is what made the panel
eat a core during monitor simulation. Everything the rasterisers and the
bitmap font hand back is a pixel or a run, so the buffer is the natural
target; the canvas is only the upload surface.

Two consequences to keep in mind:

- The buffer writers clip themselves. The canvas used to do that for free, and
  a raw write at x = -1 lands on the *previous row* instead of being dropped.
- Repaints are coalesced into one `requestAnimationFrame` (`scheduleRepaint`).
  Frames arrive at the simulator's cadence, not the display's, and only the
  newest matters. This is also what keeps a hidden panel from painting:
  `retainContextWhenHidden` means the webview still receives every frame
  message while hidden, but rAF doesn't run, so nothing is drawn until it
  comes back.

## Coordinate / sign conventions

- Stormworks world: **left-handed**, X+ East / Y+ Up / Z+ North. Stored in `memory/MEMORY.md` because it's easy to get wrong.
- Rotations are Three.js `Euler XYZ` intrinsic, in radians. CH4-6 expose these directly. The local-axis decomposition formulas in `PhySim.lua` and `panel.js` assume this order — changing it breaks tilt and compass.
- The airplane mesh's wing-tip lights are placed by visual convention (red on +X), not strict aviation port=red. Variable names are `redTip`/`greenTip` to reflect this.

## When changing the protocol or channels

Touch all of these in lockstep, or things will silently desync:
1. `media/messaging.js` — `readState()`; `media/channels.js` — `deriveChannels()`; `media/dom.js` — `refreshChannelTable()`; table rows in `media/panel.html` if adding a CH
2. `src/physServer.ts` — `encode()` field order, `PhysState` type
3. `lua/PhySim.lua` — message parsing in `update()`, channel writes in `injectAsInputs()`
4. `test/` — `protocol.test.mjs` (field order), `channels.test.mjs` (golden vectors), `parity.test.mjs` (JS⇄Lua vectors)

5. `media/csv.js` — `CSV_COLUMNS` and `csvRow()` (the CSV log's shape; `test/csv.test.mjs` pins the width and a golden row)

`README.md` (Japanese, the one GitHub shows) / `doc/README_en.md` also need updating for any new CH.

## Distribution

The extension is distributed as a `.vsix` produced by `npx vsce package` (private channel; LifeBoatAPI is pulled from the public marketplace via `extensionDependencies`). Bump `version` in `package.json` for each rebuild — VSCode uses it to detect updates on re-install.
