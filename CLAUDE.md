# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VSCode extension that simulates Stormworks' in-game *physics sensor* block from a 3D gizmo, and feeds the values into `Stormworks Lua with LifeBoatAPI` (`NameousChangey.lifeboatapi`) microcontroller debug sessions. It runs alongside LifeBoatAPI's existing simulator (which already binds `127.0.0.1:14238`), so PhySim uses port **14239**.

See `worklog.md` for the iteration history — the sandbox-limitation discoveries there are still load-bearing context for any Lua-side change.

## Commands

```bash
npm install                # also runs scripts/copy-three.js (postinstall) — copies three.js & controls into media/three/
npm run compile            # tsc -p ./  →  out/
npm run watch              # tsc --watch
npx vsce package           # build physim-x.y.z.vsix for distribution
```

Debugging the extension itself: open the folder in VSCode and press **F5**. `.vscode/launch.json` is already wired (Extension Development Host, preLaunchTask = `npm: compile`).

There is no test suite.

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

1. **`media/panel.js`** — the WebView. Three.js scene; user drags `TransformControls` on a small airplane mesh. State is posted to the extension host via `vscode.postMessage`. Coordinate convention is **Stormworks left-handed (X+ East, Y+ Up, Z+ North)** — three.js itself is right-handed, so the camera is positioned to make `+Z` look like "into the screen / north" without any scene-level flipping. CH13–17 are derived in JS for live display and **the math here MUST stay in sync with `PhySim.lua`'s `injectAsInputs`**.

2. **`src/`** — the extension host.
   - `extension.ts` activates on `onStartupFinished`, listens for `vscode.debug.onDidStartDebugSession` filtered by `session.type === "lua" && session.name === "Run Simulator"` (the exact config LifeBoatAPI produces in its `runSimulator.js`). On match it starts `PhysServer` and opens the panel.
   - `physServer.ts` is a single-client `net.createServer` on `127.0.0.1:<port>` using the **same length-prefix protocol as LifeBoatAPI's `SimulatorConnection.lua`**: `sprintf("%04d", body.length) + body`. Don't reorder the 12 fields — `PhySim.lua` parses positionally.
   - `physSimPanel.ts` builds the WebView HTML inline (the `media/panel.html` file is just a stub). CSP nonce, importmap for `three`, and webview-resource URIs are wired here.
   - `debugConfigPatcher.ts` is the **critical glue**: see "LifeBoatAPI integration" below.
   - `libraryPathInjector.ts` writes the bundled `lua/` path into `lifeboatapi.stormworks.libs.libraryPaths` for editor autocompletion. Re-run on `onDidChangeWorkspaceFolders`. The **runtime** does not depend on this setting — only autocomplete does.

3. **`lua/PhySim.lua`** — runs inside LifeBoatAPI's sandbox.

## LifeBoatAPI integration (read before touching `debugConfigPatcher.ts` or `PhySim.lua`)

`assets/lua/Common/LifeBoatAPI/Tools/Simulator/SimulatorSandbox.lua` in the LifeBoatAPI extension builds an extremely restricted `_ENV` for user scripts. Things that are NOT available inside the sandbox:

- C modules — including `socket`. `require("socket")` from sandboxed code **always fails**.
- `setmetatable`, `getmetatable`, `pcall`, `error`, `assert`, `select`, `_G`, `io`, `package`, `loadstring`, `load`, `rawget`/`rawset`, …
- `require` returns nothing — its custom implementation calls the loaded chunk but discards the return value. Modules must publish themselves as globals.

We solve both barriers in `debugConfigPatcher.ts`'s `resolveDebugConfigurationWithSubstitutedVariables`, which VSCode calls during `vscode.debug.startDebugging` AFTER LifeBoatAPI has written `_build/_simulator.lua` but BEFORE `lua-debug` spawns Lua:

1. **Append the bundled `lua/` dir to `config.arg`.** LifeBoatAPI's `_simulator.lua` does `for i=3, #arg do rootDirs[...] = arg[i] end`, so anything we push gets indexed by `SimulatorSandbox`'s require map. This is why PhySim works in any LifeBoatAPI project without per-project setup — do NOT replace this with a settings-file approach.
2. **Patch `_simulator.lua`** to insert `sandboxEnv._physim_socket = require("socket")` right after the `createSandbox(rootDirs)` line. The regex `SANDBOX_LINE_RE` matches that line; the `_physim_socket` marker prevents double-patching.

Constraints this puts on `lua/PhySim.lua`:

- **No metatables.** `PhySim` is a singleton — `PhySim:new()` re-initialises the same global table and returns it.
- **No `pcall`/`error`.** Bail out by `print` + `return` at the top level.
- **Publish as a global**, don't return from the chunk (return is harmless but useless inside the sandbox).
- Read `_physim_socket` from the chunk's `_ENV` — that's the injected `socket`.
- `math.atan` is Lua 5.3 form `math.atan(y, x)`; `math.atan2` doesn't exist.

## Channel layout (CH1–17)

`PhySim:injectAsInputs(simulator, startCh)` writes 17 consecutive channels via `simulator:setInputNumber`. CH1–12 are the raw 12 floats from the wire protocol; CH13–17 are derived locally with trig on the rotation values. The same math is duplicated in `media/panel.js → refreshChannelTable` for live display — keep both in sync.

The Stormworks tick rate (60 Hz) is baked into the m/tick → m/s and rad/tick → RPS conversions for CH13 and CH14.

## Coordinate / sign conventions

- Stormworks world: **left-handed**, X+ East / Y+ Up / Z+ North. Stored in `memory/MEMORY.md` because it's easy to get wrong.
- Rotations are Three.js `Euler XYZ` intrinsic, in radians. CH4-6 expose these directly. The local-axis decomposition formulas in `PhySim.lua` and `panel.js` assume this order — changing it breaks tilt and compass.
- The airplane mesh's wing-tip lights are placed by visual convention (red on +X), not strict aviation port=red. Variable names are `redTip`/`greenTip` to reflect this.

## When changing the protocol or channels

Touch all three of these in lockstep, or things will silently desync:
1. `media/panel.js` — `readState()`, `refreshChannelTable()`, table rows in `physSimPanel.ts` if adding a CH
2. `src/physServer.ts` — `encode()` field order, `PhysState` type
3. `lua/PhySim.lua` — message parsing in `update()`, channel writes in `injectAsInputs()`

`README.md` and the channel table in `physSimPanel.ts`'s HTML also need updating for any new CH.

## Distribution

The extension is distributed as a `.vsix` produced by `npx vsce package` (private channel; LifeBoatAPI is pulled from the public marketplace via `extensionDependencies`). Bump `version` in `package.json` for each rebuild — VSCode uses it to detect updates on re-install.
