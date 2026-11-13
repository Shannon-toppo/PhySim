# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VSCode extension that runs Stormworks microcontroller Lua itself and feeds it the values of an in-game *physics sensor* block, driven from a 3D gizmo. The Lua runs on the npm package `@stormcat-works/storm-lua-engine` (Storm Lua Engine, pinned at 0.4.1; WebAssembly, MIT) in a worker thread of the extension host. Every run is a VSCode debug session of type `physim`. The engine also rasterises the microcontroller's monitors and does the build (`buildLifeboat`: link `require`s, strip simulator-only sections, minify).

Up to 1.2.1 PhySim depended on `Stormworks Lua with LifeBoatAPI` (`NameousChangey.lifeboatapi`): it patched LifeBoatAPI's `_build/_simulator.lua`, streamed the pose over TCP 14239, stood in for `STORMWORKS_Simulator.exe` on TCP 14238, and shipped luasocket for macOS. All of that is gone in 2.0.0 — no `extensionDependencies`, no ports, no tokens, no luasocket. What remains of LifeBoatAPI is a compatibility surface for scripts written against it (see "LifeBoatAPI compatibility"). `doc/worklog.md` and `doc/macos-support.md` record the 1.x design; read them as history, not as a description of the code.

## Commands

```bash
npm install                # also runs scripts/copy-three.js (postinstall) — copies three.js & controls into media/three/
npm run compile            # tsc -p ./  →  out/  (module Node16: the engine is ESM-only, loaded with a real import())
npm run watch              # tsc --watch
npm run lint               # eslint . (flat config, correctness rules only — no formatter)
npm run check:media        # tsc -p tsconfig.media.json — strict checkJs over media/*.js (JSDoc types)
npm test                   # compile + node --test test/**/*.test.mjs
npm run check:package      # vsce ls piped into scripts/check-package.mjs — the .vsix has every runtime file (out/, media/, lua/, the engine's dist/) and no dev-only directory
npx vsce package           # build physim-x.y.z.vsix for distribution (1.x)
npm run package:preview    # the 2.x preview .vsix: doc/next/README.md as its README, marked pre-release
```

Node: the engine package declares `node >= 22.18`; npm test hands its glob to `node --test` (Node 21+); ESLint 10 needs 20.19+. CI uses Node 24.

Debugging the extension itself: open the folder in VSCode and press **F5**. `.vscode/launch.json` is already wired (Extension Development Host, preLaunchTask = `npm: watch`). It is `watch` rather than `compile` on purpose: a one-shot build only runs on F5, so a Reload Window in the dev host would leave the host on a stale `out/` while `media/` — read from disk on every load — moves on. In the dev host, open a folder with a microcontroller `.lua` and press F6.

### Tests

`test/` uses Node's built-in `node:test` runner (no framework dependency). Most suites run the real engine (WASM) from `out/`, so `npm test` compiles first; the worker-based suites start real `worker_threads`.

- `engineRunner.test.mjs` — `src/engine/runner.ts` on the real engine: tick order (touch defaults → `onLBSimulatorTick` → `onTick` → `onDraw` per powered monitor), sticky channel overrides, `require` (dotted names, `init.lua`, include-once, shared globals, missing module), Lua errors naming file and line, `print`/`debug.log` with call site, default 3x3 / `setScreen` / one frame per powered monitor / repeats skipped, blank frame without `onDraw`, `setProperty` / `getTouchScreen(n)` / host pose / `simulator:exit()`, bad `setScreen` size and out-of-range `setInputNumber` as Lua errors, `input`/`output` in `onDraw` and `screen` in `onTick` (also through a top-level alias, also in `onLBSimulatorTick`) as Lua errors with the game's messages while the top level is left alone, a breakpoint mid-tick resuming the same tick exactly once, step-over staying suspended until the phase ends.
- `engineSession.test.mjs` — `src/engine/session.ts` with a real worker: ~60 Hz ticking, slow motion proportionally slower, logs/frames/layout events, Lua error and `exit()` endings, breakpoint stop/inspect/step/continue over the request channel, panel inputs reaching the script, `replay`, a missing entry file being an error rather than a hang.
- `simulation.test.mjs` — `src/simulation.ts`: panel state set before a run is what the first tick sees; defaults (origin, ×1, one 3x3); live pose/speed changes; `setTimeScale` sanitising; `start()` replacing a run (also one suspended at a breakpoint) without the old run's events leaking; `stop()` blanking and reporting `stopped`; errors keeping the last pictures and layout; `exit()`; the wanted layout (configure/remove, restore, sorted, not applied to a live run); script `setScreen` landing on top; a pose/speed/monitor sent right after `start()` not lost while the engine loads.
- `debugSession.test.mjs` — `src/debugSession.ts` driven as VSCode drives it, against a real run: `formatValue` reads like Lua; breakpoint → stack → scopes → variables → table expansion → evaluate → step → continue; a breakpoint added while running binds; `noDebug` ignores breakpoints; `pause` is refused and inspection while running fails cleanly; a Lua error goes to stderr and terminates; launch without `program` fails; disconnect stops the script.
- `build.test.mjs` — `src/build.ts` through a real build worker: `requiredNames` (call forms, quotes), `collectProject` (transitive, unresolved names skipped), minified and non-minified builds that link, strip `__LB_SIMULATOR_ONLY__` and unused `---@section`, and still run in the game environment; a really-required missing module, a syntax error and a missing entry file fail with a message; an output over 8192 characters builds with a warning.
- `runTarget.test.mjs` — `src/runTarget.ts`: the `require` root order (workspace folder or the script's directory, then `physim.libraryPaths`, then bundled `lua/`, then the legacy LifeBoatAPI setting — a 1.x `PhySim.lua` listed there must not hide the bundled one — then `_build/libs`), relative paths, blank/non-string entries, de-duplication, shadowing, no mutation of input.
- `sourceRoots.test.mjs` — `src/engine/sourceRoots.ts`: `a.b` → `a/b.lua` / `a/b/init.lua` / `a/b.luah` and their precedence, earlier root wins, names that could escape the roots refused without touching the file system, `chunkName`/`chunkFile` round trip (backslashes, drive-letter case).
- `screens.test.mjs` — `src/engine/screens.ts`: the host accepts every size the panel offers (against `media/monitorConfig.js`), request sanitising, 32 px blocks and the portrait swap, LifeBoatAPI's `setScreen` numbering rule, `MAX_SCREENS`, per-monitor touch (dropped on power-off), `onChange` firing only on real changes.
- `roundtrip.test.mjs` — `lua/PhySim.lua` on the real engine through `VehicleRunner`: all 17 channels on `input.getNumber` at startCh 1 and another startCh, a new pose picked up on the next `update()`, rotation normalised to [-π, π) (exactly +π → -π) in agreement with `normalizeAngle`, getters, zero before the first update, `tickRate()` following the runner, `PhySim:new(host, port)` / `close()` compatibility. Channels come back as float32 (composite inputs are stored that way).
- `parity.test.mjs` — **the CH13–17 desync guard**: runs `media/channels.js` and `PhySim.lua:injectAsInputs` over the same vectors and asserts agreement to 1e-9. Extend its vector table whenever the derived-channel math changes. Lua runs in **fengari** (pure-JS Lua 5.3, f64 — a devDependency, never shipped) via `test/helpers/luaRunner.mjs`, which stubs `__physim_host.phys()` / `tickRate()` and captures `injectAsInputs`' writes with a fake `simulator`.
- `ingame.test.mjs` — **the monitor against the real game**: runs each page of `tools/ingame/verify*.lua` on the engine at the page's monitor size (`test/helpers/engineCard.mjs`) and demands an exact match with `test/fixtures/ingame-raster.json` (lit pixels of 86 Stormworks screenshot pages). Also checks each card is ASCII only. See "Monitor rasterising".
- `ties.test.mjs` — card G (`tools/ingame/verifyG_ties.lua`, the 1/512px tie probes) against its reader `tools/ingame/analysis/ties.mjs`: rendered on the engine with the tie nudged up and then down it must decode all-up and all-down, and exactly on the tie to what `snapUnits()` predicts, on six monitor sizes; plus probe layout sanity.
- `phaseCard.test.mjs` — card H (`tools/ingame/verifyH_phase.lua`), which asked the real game what `input.*`/`output.*` do inside `onDraw` and `screen.*` inside `onTick`. It is not a pixel card: the test checks the card itself works (paging on the bottom half, FIRE on the top, the one-frame `FIRING` announcement, H1 reaching `OK`, text fitting a 3x3) and **pins PhySim to what the game answered** (2026-11-13): H2–H7 stop the script with the game's message at the card's line, and the monitor keeps `FIRING`.
- `monitorConfig.test.mjs` — `media/monitorConfig.js`: the size table round-trips through pixels in both orientations, `nextScreenNumber` reuses a removed slot, and `fitScale` picks one factor for all monitors (and never 0).
- `channels.test.mjs` — known-value + golden-regression tests for `media/channels.js` (CH13–17 math, angle wrap, gimbal-pole clamping).
- `csv.test.mjs` — `media/csv.js`: header/row width agreement, a golden row, CH1–12 text pinned to the 1.x encoder's format (six decimals, non-finite → 0) so old and new logs match, the tick/send de-duplication, and `game_time_s` counting ticks rather than wall clock.
- `csvLogger.test.mjs` — `src/csvLogger.ts`: CRLF records, rows arriving with no log open, a row smuggling its own newline, truncate-on-start, and an end-to-end pass where webview-shaped batches parse back as one table.
- `timeScale.test.mjs` — `media/timeScale.js` and the host's copy of the speed list (`src/engine/physState.ts`) agree, and anything else sanitises to ×1.
- `trail.test.mjs` — `media/trail.js`: the trail buffer keeps the newest points in draw order, drops sub-millimetre samples, survives a capacity change, and the velocity-arrow length stays inside the scene for any speed.
- `agentSession.test.mjs` — `src/agent/agentSession.ts` on the real engine: start runs the top level only; step counts ticks and is repeatable (same calls, same pixels); hold vs integrate; the pose surviving a restart while held inputs and monitors do not; a Lua error at the top level / in a tick / an endless loop as a `failed` run (not a thrown request) that keeps the last pictures and outputs; `simulator:exit()`; the step time limit; scenario playback; monitors, touch, the picture before a step, snapshots across a restart, the log cursor and its cap.
- `mcpServer.test.mjs` — the AI tools end to end. `src/agent/mcp.ts` line by line (version negotiation, JSON-RPC error codes, notifications, batches), then `out/agent/server.js` as a child process driven by **the official MCP client** (`@modelcontextprotocol/sdk`, a devDependency that is never shipped — the protocol layer is hand-written, and this is what shows a real client accepts it): the tool list, the loop an agent runs, snapshots across an edit, a Lua error, scenario playback, the PNG, the build (writes only when asked, only inside the workspace), ~30 malformed-argument cases that must change nothing, and a garbage line on stdin.
- `pixels.test.mjs` / `png.test.mjs` / `scenario.test.mjs` / `project.test.mjs` — the pure halves of the AI tools: region/diff/expectation/grid queries on hand-built pictures; the PNG decoded chunk by chunk in the test; a CSV log written by `media/csv.js` read back as poses; JSONC settings, the workspace-folder walk and the `require` root order without VSCode.
- `mirrorLink.test.mjs` / `mirror.test.mjs` — the panel mirror. The protocol half: endpoint naming (independent of the environment, within a socket path's length, Windows' pointer file and random pipe name), an update byte for byte across the wire, ~30 malformed updates refused. The socket half, with a real `AgentSession` and real local sockets: the window found from the script by walking up, only changed pictures resent, a window opened later found after the retry interval, stop / failure / the agent going away, a second agent replacing the first, **a connection that does not greet displacing nobody** (another window's liveness probe), two windows on one folder, a stale socket taken over, owner-only modes, and the pointer-file lookup (run off Windows with a Unix socket standing in for the pipe).
- `controls.test.mjs` — `src/engine/controls.ts` alone (hold vs click, the one-tick latch, a press flipping the toggle, slider clamping, out-of-range numbers reading as nothing, what `info()` lists and when `onChange` fires), then through `VehicleRunner` with LifeBoatAPI's template script.
- `motion.test.mjs` — **the integrator desync guard**: `src/agent/motion.ts` and `media/integrator.js` (plus both `normalizeAngle`s) over the same vectors, exact equality. Extend it whenever the integration changes.
- `l10n.test.mjs` — every `%key%` in `package.json` exists in both `package.nls*.json`, every `vscode.l10n.t()` string has an entry in `l10n/bundle.l10n.ja.json` (and no entry is orphaned), and a translation keeps its `{n}` arguments.
- `webviewHtml.test.mjs` — loads `dom.js` / `monitorDom.js` against a recording `document` and checks `panel.html` / `monitors.html` have every id they look up, plus the `{{placeholder}}` set of each page against `src/template.ts`.

Helpers: `test/helpers/engineCard.mjs` (one card page = one tick with `input.getNumber(32)` set to the page, then one `onDraw` at the monitor size; returns the engine's frame), `test/helpers/luaRunner.mjs` (fengari, for `parity.test.mjs`).

Not covered by any test: anything that needs a real VSCode window — the webview painting frames, the debug UI, the F6/F7 keybindings, the editor-title buttons, the `.vsix` installed on Windows/Linux. See "Open items".

## Architecture — three runtimes

```
WebView (browser JS, Three.js)               media/
   │  postMessage: state (pose), timeScale, touch, screenSet/screenRemove, csv*, presets
   │  ◄── screenConfig {screens}, screenPixels {frames: RGBA per monitor}, csvState, …
   ▼
Extension host (Node, TypeScript)            src/
   extension.ts ── debug adapter (inline, DAP) ── Simulation ── EngineSession
   │  worker_threads postMessage (structured clone: bigint / Uint8Array survive)
   ▼
Engine worker (Node worker thread)           src/engine/worker.ts
   VehicleRunner ── Storm Lua Engine VM (extended environment) ── user script + prelude + PhySim.lua
```

The pose goes webview → host (`sanitizePhysState`) → `Simulation.setPhysState` → worker → `VehicleRunner`, and the script pulls it synchronously through the host binding `__physim_host.phys()` (called by `PhySim:update()`). Frames go the other way: the runner copies each powered monitor's frame after `onDraw`, sends only the changed ones, and the panel uploads them with `putImageData`. Nothing crosses a socket; nothing leaves the extension host process.

A build is a separate, short-lived worker (`buildWorker.ts`): minifying can take seconds and must not hold up the host, and a thrown-away worker leaves no compiler state.

1. **`media/`** — the WebView, split into ES modules loaded via relative imports from the entry `panel.js` (the CSP nonce on the entry `<script type="module">` propagates to the whole module graph — no `buildHtml` changes needed when adding a module):
   - `panel.js` — entry point; wires toolbar/keyboard/message events and the render loop only.
   - `vscodeApi.js` — `acquireVsCodeApi()` singleton (may only be called once).
   - `channels.js` — **CH13–17 derived math, pure module** (no DOM/three imports) so Node tests import it directly. Its Lua twin is `PhySim.lua:injectAsInputs`, guarded by `test/parity.test.mjs`.
   - `dom.js` — element registry, slider⇄number sync, channel table, and the **single shared `syncGuard`** re-entry flag (also used by `pose.js` — keep it one flag).
   - `scene.js` — Three.js scene, airplane mesh, Orbit/TransformControls, resize, axis labels.
     Its `ResizeObserver` only marks the size dirty; `flushResize()` applies it from
     `panel.js`'s render loop. RO callbacks run *after* the frame's rAF callbacks and
     resizing a WebGL drawing buffer clears it, so calling `setSize()` in the observer
     wipes the frame that was just drawn — during a continuous resize (the monitor
     splitter, the window) the viewport then reads as greyed out with only the HTML
     axis labels left. Keep the buffer resize inside the loop.
   - `pose.js` — pose number inputs ⇄ gizmo sync.
   - `messaging.js` — `readState()` / `sendState()` / rAF-debounced `scheduleSend()`.
   - `simulation.js` — fixed-timestep integration (60 Hz accumulator, stretched by the time scale) + recording/playback. Owns the toolbar's speed dropdown. The tick's math is `integrator.js`'s; this file only moves it between the gizmo and the number inputs.
   - `integrator.js` — **one Simulate tick, pure module** (semi-implicit Euler, rotation wrapped). Its TypeScript twin is `src/agent/motion.ts`, guarded by `test/motion.test.mjs`.
   - `timeScale.js` — **simulation speeds + the current one, pure module** so `test/timeScale.test.mjs` runs it in Node. `src/engine/physState.ts` keeps its own copy of `TIME_SCALES` to validate the webview; the test asserts they agree. See "Simulation speed".
   - `presets.js` — preset save/load/delete UI intents.
   - `logging.js` — CSV channel logging: owns the toolbar button, batches rows over `postMessage`, and reflects the host's authoritative `csvState` (starting is a round trip — the save dialog can be cancelled).
   - `csv.js` — **column set, row formatting and sample bookkeeping, pure module** (no DOM) so `test/csv.test.mjs` runs it in Node. Owns `CSV_HEADER`, which the webview sends as the log's first row — the host never learns what a channel is. `tickRow`/`sendRow` implement the one-row-per-frame handshake: `stepSimulation()` calls `sendState()` after its tick loop, and without it every simulated frame would end with a duplicate of its last tick.
   - `visuals.js` — the path trail (a `THREE.Line` with an age-faded vertex colour) and the world-frame velocity arrow, plus the sidebar toggles that own them. Samples per **tick** (called from `simulation.js`'s fixed-timestep loop) as well as per rAF, so a throttled panel still records the path at full resolution.
   - `trail.js` — **trail ring buffer + arrow scaling, pure module** (no DOM/three) so `test/trail.test.mjs` runs it in Node. The buffer shifts rather than wraps: the vertex order must equal the draw order or the line draws a stray segment across the seam.
   - `mcScreen.js` — the monitor view. Shows the engine's finished frames (`screenPixels`: `{screen, width, height, pixels}` with `pixels` the engine's "game-rgba8" bytes) on one `<canvas>` per powered monitor, all at one shared integer zoom, and relays touch back. It draws nothing itself. See "Monitor display" and "Multiple monitors".
   - `monitorDom.js` / `monitorMessaging.js` — the monitor section's elements and its webview→host messages, split out of `dom.js` / `messaging.js` so `mcScreen.js` imports nothing from the 3D panel. Keep it that way: the stand-alone monitor window loads `mcScreen.js` without `dom.js`, which throws on the first panel element it can't find.
   - `monitors.html` / `monitors.js` — the **stand-alone monitor window** (`physim.monitors.openInNewWindow`, default off, or the `physim.openMonitors` command). Its `#monitors` block mirrors `panel.html`'s; the ids are the contract with `monitorDom.js`. See "Monitor window".
   - `monitorConfig.js` — **monitor sizes, screen-number allocation and the shared fit scale, pure module** (no DOM/canvas) so `test/monitorConfig.test.mjs` runs it in Node. `src/engine/screens.ts` validates independently — a webview message is untrusted — and `test/screens.test.mjs` checks the host accepts everything the dropdown offers.
   - `panel.css` — the one stylesheet, shared by `panel.html` and `monitors.html`. Owns `.monitor-canvas`, whose black background is part of the compositing (see "Monitor display").
   - `globals.d.ts` — ambient `acquireVsCodeApi()` declaration for `npm run check:media`. `media/package.json` is only `{"type": "module"}`, so Node tests can import these files as ES modules; it is excluded from the `.vsix`.
   Coordinate convention is **Stormworks left-handed (X+ East, Y+ Up, Z+ North)** — three.js itself is right-handed, so the camera is positioned to make `+Z` look like "into the screen / north" without any scene-level flipping. The modules are vanilla JS with JSDoc types, checked by `npm run check:media` (strict).

2. **`src/`** — the extension host. Everything except `extension.ts`, `physSimPanel.ts` and `log.ts` imports no `vscode`, so the tests run it in plain Node.
   - `extension.ts` — activates on `onLanguage:lua` / `onDebugResolve:physim`. Registers the commands, the `physim` debug adapter (an inline `DebugAdapterInlineImplementation` around `PhysimDebugSession`) and its configuration provider (fills in `program` from the active editor, also for F5 with no launch.json). `physim.run` / `physim.runWithoutDebugging` call `vscode.debug.startDebugging` with `{ noDebug }`; the adapter's `launch` hook calls `Simulation.start`. Before running or building it `saveAll`s (what runs is what is on disk). Owns the `physim.running` context key (Stop command / editor-title buttons), routes `print`/`debug.log` into the Debug Console, and turns build problems into the `physim-build` diagnostic collection. Reads `physim.libraryPaths` and the legacy `lifeboatapi.stormworks.libs.libraryPaths` per resource.
   - `simulation.ts` — `Simulation`: the current run (an `EngineSession`, or none) plus everything that outlives a run — pose, speed, the panel's wanted monitor layout, the latest frame per monitor (for a webview opened mid-run). Hands the remembered state to each new run, so a script started after the gizmo moved sees the pose from tick 1. Every session callback checks it still belongs to the current run, so a replaced worker's late messages can't repaint the panel. On a Lua error the monitors keep their last picture; `stop()` blanks them.
   - `runTarget.ts` — `requireRoots()`: the directories `require` searches, in precedence order (see "LifeBoatAPI compatibility").
   - `debugSession.ts` — `PhysimDebugSession`, the Debug Adapter Protocol as plain JSON. See "Debugger".
   - `build.ts` — `collectProject` (the entry plus every file reachable through literal `require("…")` strings, found by regex and resolved with `SourceRoots`; capped at 1024 files) and `buildScript` (`compiler.buildLifeboat(..., { environment: "game", minify })`, diagnostics mapped back to files, size counted in characters against `GAME_SCRIPT_LIMIT` = 8192).
   - `buildRunner.ts` / `buildWorker.ts` — one build per worker thread; the worker loads the engine's compiler WASM (`dist/compiler-wasm/compiler_bg.wasm`, found next to the runtime WASM because the package doesn't export its path).
   - `physSimPanel.ts` serves `media/panel.html` (the **authoritative** markup template) after substituting the `{{…}}` placeholders — CSP, nonce, webview-resource URIs, slider bounds. `substituteTemplate` (in `template.ts`) throws if a placeholder is left unresolved. Note: an HTML comment in the template must never contain a literal double-brace token, or the leftover check trips. It validates every webview message (`sanitizePhysState`, `sanitizeTimeScale`, `sanitizeScreenRequest`) before it reaches `Simulation`, persists presets/monitor layout/speed in `workspaceState`, and posts `screenConfig`/`screenPixels` to whichever webview shows the monitors. Closing the panel zeroes the pose and puts the speed back to ×1.
   - `log.ts` — the `PhySim` Output channel (`log()` / `showLog()`, behind the `physim.showLog` command): activation, each run's `require` search list, build results, run endings.
   - `template.ts` — `substituteTemplate` and the per-page `{{placeholder}}` lists, as a **pure, `vscode`-free module**. `buildHtml`'s values are typed from the lists, so a new placeholder goes there first; `test/webviewHtml.test.mjs` checks the HTML uses exactly those.
   - `csvLogger.ts` — the CSV log file: open/append/close plus row sanitising, as a **pure, `vscode`-free module** so `test/csvLogger.test.mjs` can run it in Node. It appends whatever lines it is handed and counts them; the column set lives in `media/csv.js`.
   - `engine/loadEngine.ts` — loads the runtime once per thread: dynamic `import()` of the ESM package (kept real by `module: Node16`) and the WASM read from disk and passed as `wasmBinary` (not every extension-host Node can fetch a `file:` URL).
   - `engine/session.ts` — `EngineSession`, the host's handle on one run: owns the worker, forwards panel input, matches requests to responses, turns a dying worker into `ended("crash")`. One session = one run; to run again, dispose and create a new one (a fresh VM).
   - `engine/protocol.ts` — the host⇄worker message types (types only). Structured clone, never JSON: the debugger's values carry `bigint` and `Uint8Array`.
   - `engine/worker.ts` — the worker: loads the engine, builds a `VehicleRunner`, ticks it at 60 Hz × the time scale with an owed-time accumulator (at most `MAX_CATCH_UP` = 4 ticks back to back; beyond that the backlog is dropped, so a too-slow script runs slow instead of freezing the monitors). Messages that arrive while the engine is still loading are queued and applied before the script's top level runs. A debugger `resume` is answered first and run in a microtask, so the stop it may hit is an event, not the reply.
   - `engine/runner.ts` — `VehicleRunner`, one run with no timer and no transport: creates the VM (`environment: "extended"`, control namespace `__physim`, host bindings under `__physim_host`, `requireLoader` over `SourceRoots`), and runs a tick as a queue of phases — prelude tick → `onTick` → `onDraw` per powered monitor (decided after `onTick`, which may call `setScreen`). A breakpoint suspends the phase at the head; `resume()` continues it and drains the rest, so nothing in a tick runs twice. Keeps the last frame per monitor and reports only changed ones; a powered monitor without `onDraw` gets a blank frame.
   - `engine/prelude.ts` — the Lua loaded before the user script (chunk `@physim:prelude`): LifeBoatAPI's `simulator` object, the per-tick default inputs, and the phase guard (see "Calls in the wrong phase" below). See "LifeBoatAPI compatibility".
   - `engine/screens.ts` — `ScreenRegistry`: monitors (32 px per block, portrait swap, caps `MAX_BLOCKS` 9 and `MAX_SCREENS` 8), per-monitor touch, `sanitizeScreenRequest` for anything from the webview or saved state, and `declareFromScript` (LifeBoatAPI's numbering rule).
   - `engine/sourceRoots.ts` — `SourceRoots.resolve(name)` (dotted name → `.lua` / `/init.lua` / `.luah`, first root wins, looked up on demand rather than indexed), `moduleSegments` (refuses slashes, `..`, empty segments, drive letters — `require` must not read outside the roots), and `chunkName`/`chunkFile` (`@`-prefixed, forward-slashed, lower-case drive letter; a breakpoint only binds when its chunk name is byte-for-byte the loaded one).
   - `engine/physState.ts` — `PhysState`, `sanitizePhysState`, `TICKS_PER_SEC`, `TIME_SCALES` / `sanitizeTimeScale`. Shared by host and worker.

   - `mirrorServer.ts` — the window's end of the panel mirror: listens on a local socket per workspace folder for an agent's MCP server and reports what it sends. No vscode import.
   - `agent/` — **the AI tools (beta)**, a fourth entry point beside the extension: `node out/agent/server.js` is an MCP server an agent's client starts as a child process. No vscode import anywhere in it. See "AI tools".

3. **`lua/PhySim.lua`** — the module scripts `require("PhySim")`. Found through the bundled `lua/` root, which `runTarget.ts` puts after `physim.libraryPaths` and before the legacy LifeBoatAPI setting. Reads the pose from `__physim_host.phys()` / `__physim_host.tickRate()`.

## LifeBoatAPI compatibility (read before touching `prelude.ts`, `sourceRoots.ts`, `runTarget.ts` or `PhySim.lua`)

Scripts written for LifeBoatAPI's simulator must run unchanged. Nothing of LifeBoatAPI is installed, loaded or bundled; the behaviour is re-implemented.

- **`simulator` global** (`prelude.ts`): `setScreen(n, size, poweredOn, portrait)`, `setInputBool/Number(i, v)` (index must be 1..32, `nil` value ignored), `setProperty(label, value)` (number/string/boolean only), `getTouchScreen(n)` (LifeBoatAPI's table shape), `exit()`. `getIsClicked`/`getIsToggled`/`getSlider` read the panel's buttons and sliders (see "Buttons, toggles, sliders" below). `setFrameRate` is a no-op: the tick rate belongs to the panel.
- **Per-tick defaults**, as in LifeBoatAPI's `Simulator._simulateDefaultInputs`: before `onLBSimulatorTick`, monitor 1's touch goes to bool 1–2 and number 1–6 (width, height, x, y, xAlt, yAlt). A channel the script has set through `simulator:setInput*` is never overwritten by these defaults again in that run (sticky), which is why `injectAsInputs(simulator, 1)` hides touch coordinates.
- **`onLBSimulatorTick(simulator, ticks)`** runs after the defaults and before `onTick`.
- **`require`**: include-once, returns nothing (the engine's development loader keeps LifeBoatAPI's convention), globals shared between modules. Name rule as LifeBoatAPI's `SimulatorSandbox`: dots are directory separators, `init.lua` names its directory, `.luah` is a hidden Lua file. Roots in order (`runTarget.ts`): the workspace folder (or the script's directory), `physim.libraryPaths`, the bundled `lua/`, then the legacy `lifeboatapi.stormworks.libs.libraryPaths` if a workspace still has it — read as plain settings data. The legacy setting is last because 1.x wrote its own `lua/` directory into it (`autoInjectLibraryPath`): searched before the bundled directory, the 1.x socket `PhySim.lua` left there loads instead and `PhySim` stays nil. Last of all comes `<workspace>/_build/libs`, where LifeBoatAPI clones its git libraries (its own Lua library by default) and which it always searched: a project set up there keeps `require("LifeBoatAPI")` working with no setting. A project can shadow a library; nothing can shadow the project. The LifeBoatAPI Lua **library** (LBVec etc.) is not bundled.
- **Monitors**: one 3x3 screen 1 by default; `setScreen` with a number that names no existing monitor takes the lowest free number (LifeBoatAPI's rule, `declareFromScript`); a monitor that doesn't exist reads as a fresh LifeBoatAPI `SimulatorScreen` (powered, 32x32, untouched).
- **Build**: the engine's `buildLifeboat` keeps LifeBoatAPI's conventions — `---@section __LB_SIMULATOR_ONLY__` always removed, `---@section name` regions removed when unused.
- **Buttons, toggles, sliders** (`engine/controls.ts`, `ControlBoard`): the exe window's ten buttons and ten sliders, kept as state the host holds. `getIsClicked(n)` is true while button n is down; **a button and its toggle are one control** — every press flips `getIsToggled(n)`; `getSlider(n)` is 0..1; a number outside 1..10 reads `false`/`0` without an error (all as in LifeBoatAPI's `Simulator.lua`). Two deliberate differences: the panel shows only the controls the script has **read** (the board records them and fires `onControls`; the three getters go through `__physim_host.control`, which is how the host finds out), and a press is **latched until a tick has run** (`endTick()`, called when `onTick` completes), so a click between two ticks is not lost. Slider positions live in `Simulation` and survive runs; toggles start afresh. The webview side is `media/controls.js`, inside `#monitors` so it travels with the monitor window; the controls are cleared whenever the run that read them is gone.
- **Not kept**: the exe's input/output panel, LifeBoatAPI's colour gamma (see "Monitor display"), `lua-debug` (the debugger is PhySim's own).
- **Keys**: `physim.run` is F6 and `physim.build` F7 (`editorTextFocus && editorLangId == lua && !inDebugMode`) — the same keys as LifeBoatAPI's, whose bindings carry no `when` at all. With both installed they collide. The setting `physim.keybindings.useF6F7` (default on) is ANDed into those two bindings' `when` as `config.physim.keybindings.useF6F7`, so turning it off hands F6/F7 back; Shift+F6 / Shift+F7 are bound to the same commands unconditionally, so PhySim always has keys of its own.

Constraints on `lua/PhySim.lua`:

- **No metatables, no `pcall`/`error`.** `PhySim` is a singleton — `PhySim:new()` re-initialises the same global table and returns it. It is never shipped into the game (it belongs in an `__LB_SIMULATOR_ONLY__` section), but it stays valid in the game's restricted environment anyway.
- **Publish as a global**, don't return from the chunk — `require` discards return values.
- **Bail out at the top** with `print` + `return` when `__physim_host` is missing (required outside PhySim).
- **Keep the 1.x API**: `new(host, port)` accepts and ignores its arguments, `close()` is a no-op, `isAlive` stays `true` — existing scripts call them.
- `math.atan` is the Lua 5.3 form `math.atan(y, x)`; `math.atan2` doesn't exist.
- `__physim` and `__physim_host` are reserved global names.

## Calls in the wrong phase

In the game, `input.*`/`output.*` inside `onDraw` and `screen.*` inside `onTick` are Lua errors that stop the script (card H, 2026-11-13, Stormworks v1.15.26; `doc/ingame-findings.md` §11; messages photographed: `<line>: attempting to use input function outside onTick`, `<line>: attempting to use screen function outside onDraw`). The engine (0.4.1) instead reads 0/false, drops writes and draws nothing. Until it changes (requested from the engine; the local, untracked `doc/storm-lua-engine-requests.md` item 4 has the write-up), `prelude.ts` replaces every function in `input`, `output` and `screen` with a wrapper that raises the game's message with `error(msg, 2)`, so it names the script's line. Because the prelude runs first, an alias the script takes at its top level (`S = screen`) is the wrapper too — the game catches those as well.

- The phase is read from the engine, not tracked: `screen.getWidth()` is the monitor's width (≥ 32) while drawing and 0 anywhere else.
- `input`/`output` fail only while drawing; `screen` fails only once the first tick has begun (a `ticked` flag set by the prelude tick). The top level is left alone — the game's behaviour there is unmeasured. `onLBSimulatorTick` is tick phase, so `screen.*` there is an error too.
- Costs: a Lua call per API call, counted against the instruction budget — with the default budget, `onDraw` fits about 62k `screen.setColor` calls in a loop instead of about 143k. The check is inlined in each wrapper for that reason. An error raised through a tail call (`return screen.getWidth()`) names the line of whoever called the tail-calling function.
- Step-into on an API call would stop inside the wrapper; `VehicleRunner.resume` keeps stepping while a step `into` lands deeper in `@physim:prelude`, so it arrives at the next line (pinned by `engineRunner.test.mjs`).
- The `output` message is assumed by analogy (`attempting to use output function outside onTick`); only the `input` and `screen` ones were photographed.

## Debugger

`src/debugSession.ts` maps DAP onto the engine's debugger (requests go host → worker → `VehicleRunner`): line breakpoints (bound by chunk name and line; every breakpoint is reported verified, because the engine can't say in advance whether a line holds code), step into/over/out, one thread ("Microcontroller"), stack frames addressed by level (PhySim's prelude shown de-emphasised), Locals/Upvalues scopes (compiler temporaries `(…)` filtered), table expansion in pages of 200 up to 2000 entries, evaluate for watch and hover. `variablesReference`s are valid for one stop only — cleared on every continue/step.

What it refuses, deliberately:

- **Pause.** The engine suspends only at a breakpoint or step, never on request from outside; the request fails with a message rather than being faked.
- **Stepping across ticks.** A step that runs off the end of `onTick`/`onDraw` finishes the tick and the script runs on.

A suspended script holds the whole simulation (ticks and monitors). The panel keeps working — its Simulate integrator is in the webview and does not know about the debugger — and its changes reach the next tick. `noDebug` runs launch with no breakpoints. Ending the debug session (any way) stops the script; starting a new run ends the previous debug session.

## Build

`PhySim: Build` (F7) → `extension.ts` `build()` → `runBuild` (worker) → `buildScript`. `collectProject` only decides which files to offer the compiler: its regex also matches inside comments, strings and simulator-only blocks, which is harmless — an offered module that is never really required is left out, and a really-required missing one is the compiler's error, with a location. Output environment is `game` (no `print`/`pcall`/`require`). Written to `physim.build.outputDirectory` (default `_build/release`, relative to the workspace folder or the script's folder) under the entry's base name; over 8192 characters it is still written, with a warning.

## AI tools (beta)

`doc/ai-integration-spec.md` (Japanese) records what was decided and why; the "AIエージェント連携（ベータ）" section of `doc/next/README.md` is the user-facing description. Stage 1 is a headless MCP server; stage 2 mirrors its run into a VSCode window's panel (see "The panel mirror" below).

The server is the panel's run with the clock taken out. `AgentSession` owns a `VehicleRunner` directly — no worker, no timer — and advances it only when asked ("run 60 ticks"), so the same calls always give the same pixels. That repeatability is the point: it is what lets an agent tell whether its edit changed anything.

- `agent/server.ts` — the process entry: stdin lines → `McpServer.handleLine` → stdout lines, one request at a time. **stdout carries protocol lines only**; anything for a person goes to stderr.
- `agent/mcp.ts` — JSON-RPC 2.0 / MCP for a tools-only stdio server, hand-written so the `.vsix` gains no dependency. A tool that throws becomes a result with `isError` (the model reads it and reacts); only malformed requests are JSON-RPC errors.
- `agent/tools.ts` — the 22 tools: schema, argument checks, and the mapping onto `AgentSession`. Arguments come from a language model, so every one is checked by hand and a wrong one is answered with a sentence saying what was expected; a request is validated in full before any state changes. Answers are JSON text laid out by `formatAnswer` (one top-level field per line; a text grid's rows a line each).
- `agent/agentSession.ts` — the run plus what outlives it. **The pose and the named snapshots survive `start`; held inputs, touch and monitors do not.** A Lua error is a state (`failed`, with the message) rather than a thrown request, and the last pictures and I/O stay readable.
- `agent/pixels.ts` — the monitor as numbers: region stats, diff, expectations, text grid. Every colour is the **visible** one (rgb × alpha / 255 over black, as the panel composites), and "lit" means that colour is not black.
- `agent/png.ts` (opaque RGB, integer upscale, `node:zlib` only), `agent/scenario.ts` (the panel's CSV log read back as poses, by column name), `agent/project.ts` (workspace folder by walking up to `.git` or a `.vscode` that holds a project file — **never a bare `.vscode`, and never the home directory**: VSCode keeps `~/.vscode` on every machine, which would make all of `$HOME` the workspace — then `.vscode/settings.json` parsed as JSONC and the same `requireRoots` as F6), `agent/motion.ts` (the integrator twin).

Two things in the engine layer exist for the tools:

- **Held inputs** (`VehicleRunner.holdInputNumber/Bool`, the `__physim_host.inputs` binding, the block in `prelude.ts`'s tick). They are written every tick after the touch defaults and before `onLBSimulatorTick`, and skip any channel the script has set through `simulator:setInput*` — the same "script wins" rule as monitors. They cannot be written from the host directly: only the prelude knows which channels the script has claimed.
- **Properties** (`RunnerOptions.properties`, `VehicleRunner.setProperty`). Start-up values are in place before the top level, so a `simulator:setProperty` in the script replaces them; a later `setProperty` from outside is a single write.

`build_script` is the only tool that writes to disk. Its target must be inside the workspace folder **after following symbolic links** (`ToolEnvironment.realPath`), is never a source file of the build, and outside the default `_build/release` does not replace an existing file without `overwrite: true`. A pose that overflows while integrating is an error before the tick runs — the script is never fed a non-finite value.

### The panel mirror

The MCP server stays the owner of the run; a window is only **told what to show**. After each state-changing tool call (`McpServer`'s `afterCall` hook → `agent/mirrorClient.ts`) the server sends the run's status, tick, pose, monitor layout and the pictures that changed to a window that has the script's folder — or one above it — open (`src/mirrorServer.ts`, one listener per workspace folder). **Nothing flows the other way**, by design: there is no path from the window, or from anything else that finds the endpoint, into the agent's run. That is also why the tools exist once, not once per front end.

- `agent/mirrorLink.ts` — the protocol, shared by both ends: endpoint naming, NDJSON encode, and a decoder that checks every field (the receiver is an extension host; a line that fails ends the connection).
- **The endpoint must not depend on the environment.** An agent's client starts its MCP servers with a trimmed environment (no `TMPDIR`), the window has the full one; a socket under `os.tmpdir()` was simply never found. It lives in `~/.physim/<hash>.sock` (directory 0700, socket 0600), falling back to `/tmp/physim-<uid>-<hash>.sock` only when the home path is too long for a socket.
- **Windows:** a pipe has no directory to keep other users out, and a name computed from the folder could be claimed first by someone else, who would then receive the pictures. The window makes up a random pipe name and writes it to `~/.physim/<hash>.pipe`; the server reads it there (`usesPointerFile`). Not yet run on a real Windows machine — the tests exercise the lookup with a Unix socket standing in.
- A connection counts only after its `hello`. Before that it may be another window probing whether the endpoint is alive, and must not displace the agent being shown.
- `Simulation.showMirror` / `clearMirror` hold the display rule: **the window's own run always has the panel**; the agent's is shown while there is none, and comes back on Stop. `getScreens()` / `getFrames()` answer for whichever is on show, so the panel and the monitor window need no special case.
- The agent's buttons and sliders ride along (`MirrorUpdate.controls`, optional on the wire so an older server still decodes). `Simulation.getControls()` answers for whichever run is on show, and `syncControls()` announces only a real change; the panel sends `controlsConfig` with `readOnly: true` while a mirror is shown, and `media/controls.js` then draws the state (held included) with everything disabled.
- The pose reaches the gizmo as a `mirrorPose` message (the preset path with the trail kept). The webview echoes it back as its own state, which only reaches this window's `Simulation`.
- `physim.agent.showInPanel` (default true) turns the window's listening off; `PHYSIM_MIRROR=0` in the server's environment turns the server's looking off.

Things that surprise: `input.*`/`output.*` inside `onDraw` and `screen.*` inside `onTick` stop the script (as in the game — see "Calls in the wrong phase") and the build rejects `print`/`require` outside `__LB_SIMULATOR_ONLY__`; both are in `SERVER_INSTRUCTIONS` so the agent is told. The extension's only part is `physim.copyMcpConfig`, which copies the config with the installed path — the path holds the version, so it is a command and not a line of documentation.

## Channel layout (CH1–17)

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels via `simulator:setInputNumber`. CH1–12 are the raw pose values from `__physim_host.phys()` (12 numbers, order position/rotation/velocity/angularVelocity — `runner.ts` and `PhySim.lua:update()` must agree); CH13–17 are derived locally with trig on the rotation values. On the JS side this math is single-sourced in `media/channels.js:deriveChannels`; the Lua side stays hand-written in `injectAsInputs` (Lua cannot share code with JS) and `test/parity.test.mjs` asserts the two agree — extend its vector table when changing the math.

The Stormworks tick rate (60 Hz) is baked into the m/tick → m/s and rad/tick → RPS conversions for CH13 and CH14.

CH4–6 are normalized to **[-π, π)**. That math exists three times (the third, `normalizeAngle` in `src/agent/motion.ts`, is pinned by `test/motion.test.mjs`); all three fold the one rounding case that would land on +π — a value a hair below -π — back to -π. The first two: `normalizeAngle()` in `media/channels.js` (applied in `readState()` and in the integrator so the pose inputs stay wrapped too) and `_normAngle` in `lua/PhySim.lua` (applied in `update()`, so `phys:rotation()` and CH4–6 always agree). Lua's `%` is floor-modulo and JS' is a remainder — the JS side needs the sign fix-up, the Lua side doesn't. Wrapping is idempotent, so applying it on both sides is harmless. `test/roundtrip.test.mjs` pins the Lua half against the JS twin.

Composite inputs are float32 in the engine (as in the game), so a script reads CH values rounded to float32; the CSV log records the panel's doubles rounded to six decimals.

## Monitor display

The engine rasterises; the webview only shows pictures. A frame is the engine's "game-rgba8" buffer: straight (not premultiplied) RGBA in row order, with alpha blended by the same weights as the colour, starting from transparent black each frame. `mcScreen.js` copies the bytes into an `ImageData` unchanged — no alpha correction, no gamma — and the canvas composites it over `.monitor-canvas`'s **black** background, which is what makes the visible colour rgb × alpha (`doc/ingame-findings.md` D9 / B4). Keep it black.

Colours are the `setColor` values themselves. LifeBoatAPI gamma-lifted every colour in Lua (`255 * ((c/255)/0.85)^(1/2.4)`), and 1.x showed that lift, with a "True colour" toggle (`unGamma`) to undo it. Both are gone: that curve was LifeBoatAPI's model, not something measured on the game's monitor (B1's screenshots go through scene lighting and tone mapping, so they can't pin an absolute curve).

Frames are sent only when they changed (`VehicleRunner` compares bytes per monitor). In the webview, `applyScreenPixels` keeps only the newest pending frame per monitor, drops one whose size doesn't match the canvas (a frame drawn just before a resize), and repaints in one `requestAnimationFrame` (`scheduleRepaint`). That is also what keeps a hidden panel from painting: `retainContextWhenHidden` means the webview still receives every message while hidden, but rAF doesn't run.

`screen.drawMap` has no terrain to draw: the runner's map provider fills with the ocean colour (`setMapColorOcean`, else 1.x's default blue). The engine has no `map` table; `prelude.ts` defines `map.screenToMap` / `map.mapToScreen` with LifeBoatAPI's formulas (floored). Alt touch is never sent (always 0).

## Monitor rasterising (the in-game fixture)

The rules a monitor follows are fitted to **screenshots of the real game** (Stormworks v1.15.23; Apple M5 and RTX 4070Ti give identical pixels, except on a vertex exactly on a 1/512px tie). `doc/ingame-findings.md` has the evidence and `doc/monitor-rendering.md` the rules front to back. Until 1.2.1 PhySim implemented them itself (`media/raster.js`, `blend.js`, `pixelFont.js`, deleted in 2.0.0); now Storm Lua Engine's rasteriser implements them, and this repo's job is to keep checking it against the game:

`test/ingame.test.mjs` runs each verification card page (the `.lua` file itself, through `test/helpers/engineCard.mjs`) on the engine at the page's monitor size and compares the frame, binarised the way the screenshots were, with `test/fixtures/ingame-raster.json` — the lit pixels of 86 pages. All 86 match pixel for pixel. A page's key also names its monitor (`tools/ingame/analysis/screen.mjs`): `D4` is a 3x3 (96x96), `E2_5x3` page E2 on a 5x3 (160x96); card E's pages cover every size from 1x1 to 9x5. To extend it, add a page to `tools/ingame/verify*.lua`, shoot it on the monitor, convert to PNG (`sips -s format png`, named like the key), add it to `PAGES` in `tools/ingame/analysis/export-fixture.mjs` and run it (`<macDir> <winDir> <out.json>`); it refuses a page whose mean calibration residual is over 0.1px or whose two platforms disagree — except the tie pages (F3, G1-G3, `TIE_PAGES`), which take the RTX 4070Ti shot and print how far the Apple M5 one is from it. Card G is read with `tools/ingame/analysis/ties.mjs <shot.png>`, which lists each tie's direction and its distance from `snapUnits()` (the RTX 4070Ti vertex-path model, which now lives in `ties.mjs` itself). Nothing is masked: the green rulers and labels stay under the brightness threshold.

If a fixture page fails after an engine upgrade, the engine changed — fix it there (or pin the old version), not by editing the fixture. Fit changes to the screenshots, never to another monitor emulator.

## Multiple monitors

The panel can give the microcontroller monitors its script never asked for. `Simulation` keeps the panel's wanted layout and seeds every new run with it: the runner configures the default 3x3 screen 1, then the panel's layout, then the script's own `setScreen` calls land on top. So the script wins any screen number it declares at start-up, and a panel change during the run lasts until the script calls `setScreen` for that number again. `removeScreen` really removes the monitor from the registry (1.x could only power it off, because LifeBoatAPI's Lua had no way to drop a screen).

The layout lives in `ctx.workspaceState` under `physim.monitors` (how many screens a microcontroller drives is a property of the project) and is restored before the first run. Screen 1 cannot be removed from the panel (`mcScreen.js` disables its ✕): it is the default screen and the only one whose size and touch reach the composite inputs.

In the panel every monitor is drawn at **one shared zoom factor**, fit included. Fitting each one to the column separately would scale a 1x1 by 8 and a 3x3 by 2, so the small monitor would draw larger than the big one. Fit is bounded by width only; tall layouts scroll.

## Monitor window

`PhysSimPanelManager` can show the monitors in a second webview panel (`physim.monitors`) moved into its own window with `workbench.action.moveEditorToNewWindow`. While it exists it **owns the monitors**: `screenTarget()` sends every `screenConfig`/`screenPixels` there, and the panel is sent an empty `screenConfig`, which hides its section. A `screenRequest` is only answered for the current target (with `Simulation.getScreens()` / `getFrames()`), so the panel loading later doesn't grab them back.

- With the setting on, the window opens on the first powered-on `screenConfig` of a run, not with the panel.
- Closing it by hand replays the screens into the panel and sets `monitorWindowDismissed`, so the next `screenConfig` doesn't reopen it; `simulatorStarted()` (each run) clears that. Turning the setting off closes it without counting as a dismissal.

## Simulation speed

The toolbar's ×1 / ×0.5 / ×0.25 / ×0.1 stretches the **real time a tick takes**, never what a tick contains: velocities stay m/tick, CH13/14 keep ×60 (game seconds). Both clocks are scaled together, or the microcontroller would see a position moving at a different rate than the velocity channels say:

- the webview integrator (`simulation.js`'s `tickDtMs`);
- the engine worker's tick loop (`worker.ts`: `TICK_MS / timeScale`), which also tells the runner the rate so `PhySim:tickRate()` reports 60 × scale.

This no longer depends on the script: 1.x sent `RATE` over the socket and `PhySim.lua` poked LifeBoatAPI's `simulator._timePerFrame` from `injectAsInputs`, so a script without it ran at 60 Hz. The speed is saved in `workspaceState` (`physim.timeScale`), applied when the panel opens, reset to ×1 when the panel is disposed, and the dropdown turns yellow off ×1 so a leftover setting can't pass for slow user code. Slow-down only (`TIME_SCALES` has nothing above 1). The clocks are not phase-locked — a script tick can see 0 or 2 webview ticks, same as at 60 Hz. There is no pause or single-step in the panel; the debugger's breakpoints are the way to stop the script.

## Coordinate / sign conventions

- Stormworks world: **left-handed**, X+ East / Y+ Up / Z+ North. Easy to get wrong, because three.js is right-handed (see `scene.js` above).
- Rotations are Three.js `Euler XYZ` intrinsic, in radians. CH4-6 expose these directly. The local-axis decomposition formulas in `PhySim.lua:injectAsInputs` and `media/channels.js:deriveChannels` assume this order — changing it breaks tilt and compass.
- The airplane mesh's wing-tip lights are placed by visual convention (red on +X), not strict aviation port=red. Variable names are `redTip`/`greenTip` to reflect this.

## When changing the pose or channels

Touch all of these in lockstep, or things will silently desync:
1. `media/messaging.js` — `readState()`; `media/channels.js` — `deriveChannels()`; `media/dom.js` — `refreshChannelTable()`; table rows in `media/panel.html` if adding a CH
2. `src/engine/physState.ts` — `PhysState`, `sanitizePhysState`; `src/engine/runner.ts` — the `__physim_host.phys` binding's value order
3. `lua/PhySim.lua` — `update()` (the order it unpacks `_host.phys()`), channel writes in `injectAsInputs()`
4. `test/` — `channels.test.mjs` (golden vectors), `parity.test.mjs` (JS⇄Lua vectors), `roundtrip.test.mjs` (pose → channels on the engine)
5. `media/csv.js` — `CSV_COLUMNS` and `csvRow()` (the CSV log's shape; `test/csv.test.mjs` pins the width and a golden row)
6. `src/agent/scenario.ts` — `SCENARIO_COLUMNS` (it reads CH1–12 back out of that log by name); `src/agent/tools.ts` — `set_pose` and the pose in answers

The READMEs also need updating for any new CH — while 2.x is a pre-release that means `doc/next/README.md` (Japanese) and `doc/next/README_en.md`, see "Where the 2.x README lives".

## Localisation (English / Japanese)

User-facing host text is translated; the webview panel is not.

- `package.json` settings descriptions and command titles are `%key%` placeholders. English lives in `package.nls.json`, Japanese in `package.nls.ja.json`. A new setting or command needs a key in **both**. `displayName` and the settings section title stay literal (product name).
- Notifications and dialog titles in `src/` go through `vscode.l10n.t("English text {0}", arg)` — the English string *is* the key, so editing it orphans the entry in `l10n/bundle.l10n.ja.json`; update both together. Button labels are mixed: the build's "Copy to Clipboard" / "Open" and "Show Log" go through `l10n.t`, the CSV log's "Open" and "Start logging" are literal English. Output-channel `log()` lines and Debug Console text stay English.
- `test/l10n.test.mjs` fails on a missing or orphaned key in either mechanism. It finds `l10n.t()` strings by regex, so the first argument must be a plain double-quoted literal.

## Where the 2.x README lives

**While 2.x is a pre-release, the user-facing documents at their usual paths are the 1.x ones and must be left alone**: `README.md`, `doc/README_en.md` and `CHANGELOG.md` are byte-for-byte what 1.2.1 shipped. Stable users are still on 1.2.1, and those are the files GitHub and the Marketplace show them. (The maintainer's instruction, 2026-11-13.)

The 2.x versions live beside them in `doc/next/`: `README.md` (Japanese), `README_en.md`, `CHANGELOG.md`. **Edit those.** Each opens with a one-line note saying what it is; when 2.x is released, the three files move to their usual paths (replacing the 1.x ones), the notes come out, the language links at the top go back to the absolute GitHub URLs, and `README_en.md`'s link to the changelog becomes `../CHANGELOG.md` again.

**Build the 2.x preview `.vsix` with `npm run package:preview`, not `npx vsce package`** (the maintainer's decision, 2026-11-13). `.vscodeignore` leaves `doc/` out, so a plain build carries the 1.x README. `scripts/package-preview.mjs` puts `doc/next/README.md` in place of the root `README.md` while `vsce package --pre-release` runs (vsce 2.15 has no README option) and always restores the 1.x file. In the copy, the repository-layout note becomes a preview note and the two links relative to `doc/next/` (`README_en.md`, `CHANGELOG.md`) become absolute GitHub URLs. The `.vsix`'s `CHANGELOG.md` is still the 1.x one.

Japanese text in `doc/next/` is written without half-width spaces between Japanese and English words (the maintainer's choice, also 2026-11-13); the 1.x files keep the spaces they were published with.

## Distribution

The extension is published on the VS Code Marketplace as `shannon-toppo.physim` (first published 2026-09-24; the `"preview"` flag was dropped in 1.2.0). Since 2.0.0 it has no `extensionDependencies`. The one runtime dependency, `@stormcat-works/storm-lua-engine`, is packaged from `node_modules/`: `.vscodeignore` excludes `node_modules/**` and re-includes the engine's `package.json`, license files and `dist/**/*.js|*.wasm|package.json`; `scripts/check-package.mjs` fails if any of the runtime/compiler WASM files or `out/engine/*.js` is missing.

`engines.vscode` is `^1.101.0` because the engine package asks for Node ≥ 22.18 — see "Open items".

Releases are uploaded by hand: `npx vsce package`, then upload the `.vsix` at https://marketplace.visualstudio.com/manage (the extension's "…" menu → Update). Marketplace refuses a version it already has, so bump `version` in `package.json` for every release. CI runs `npm run check:package` on the file list; it only sees tracked files, so check `npx vsce ls` for stray untracked ones before packaging locally. The same `.vsix` can also be attached to a GitHub Release.

There is no `vsce publish` from the CLI or CI yet. Azure DevOps retires global PATs on 2026-12-01, so don't set one up; automating this means `vsce publish --azure-credential` (vsce >= 2.26.1) with a user-assigned managed identity federated to GitHub Actions. The locally resolved vsce is 2.15.0, which is too old for that flag.

## Open items (2.0.0)

- **Calls in the wrong phase — guarded in PhySim until the engine errors itself.** See "Calls in the wrong phase" above. Unmeasured in the game: calls at the top level (outside both callbacks), and the exact `output` message. When an engine release raises these errors, take the guard out of `prelude.ts` (`phaseCard.test.mjs` and the `engineRunner` test keep pinning the behaviour).

- **Minimum VSCode.** Which VSCode release first ships an extension-host Node ≥ 22.18 (the engine's `engines.node`) has not been verified; `^1.101.0` is a placeholder until it is.
- **Nothing has been run in a real VSCode window yet.** Implemented but unchecked: the webview painting `screenPixels` frames, the debug UI (breakpoints, stepping, Variables, hover, Debug Console source links), the F6/F7 keybindings and the editor-title Run/Stop buttons, the configuration provider on F5, `saveAll` before run/build, the build notifications and Problems view, the `.vsix` contents loading the WASM after installation.
- **Platforms.** Only macOS/Node tests have been run. Windows and Linux are expected to work (no per-OS code), and CI's matrix covers all three for the Node tests, but nothing has been checked in VSCode there.
- **AI tools (beta).** Stage 1 works from a real agent (Claude Code, macOS, confirmed by the user on 2026-11-12). Stage 2, the panel mirror, works in a real window too (monitors and gizmo following the agent, macOS, confirmed by the user on 2026-11-13). Unchecked: the named-pipe path on a real Windows machine, and either stage on Windows/Linux or from an installed `.vsix`.
- **Buttons and sliders.** The `Controls` block below the monitors (`media/controls.js`) is covered only up to the host: the webview drawing it, pointer capture on a held button, the block following the monitor window, and the read-only display of an agent's controls have not been tried in a window. Neither has the toolbar's wrapping (`#toolbar` in `panel.css`: `flex-wrap`, no-break labels, the hint cut with an ellipsis, and below 760px replaced by a "?" whose bubble — CSS only, on hover or focus — shows the same text).
- **F6/F7 collide with LifeBoatAPI** when both are installed. No `when` clause can see the other extension, so it is the user's choice: `physim.keybindings.useF6F7` off, and Shift+F6 / Shift+F7 instead. That the `config.` context key really disables the bindings has not been checked in a window.
