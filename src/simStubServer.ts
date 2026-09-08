// Stand-in for LifeBoatAPI's Windows-only STORMWORKS_Simulator.exe. Always
// used on macOS, where the exe cannot run at all; on Windows only when the
// user opts in (`physim.monitors.useBuiltInOnWindows`), in which case
// debugConfigPatcher also stops LifeBoatAPI from launching the real exe so
// the two don't fight over the port.
//
// LifeBoatAPI's Lua simulator opens a TCP connection to 127.0.0.1:14238 (the
// port is hardcoded in its SimulatorConnection.lua), immediately sends
// SCREENCONFIG, and errors out if nobody is listening — it never retries. So
// this server has to be listening *before* lua-debug spawns Lua; that ordering
// is arranged by debugConfigPatcher, which awaits start() inside
// resolveDebugConfigurationWithSubstitutedVariables.
//
// Wire shape is the same %04d-length-prefixed framing as physServer (see
// frame.ts). Body is `COMMAND|param|param|...` — note there is ALWAYS a "|"
// after the command name, even with zero params.
//
// Two protocol landmines, both learned the hard way:
//
//   * The Lua side's split() drops empty fields, so a parameter must never be
//     the empty string (send "0", not "").
//   * On shutdown the socket must be end()ed (FIN). destroy() sends an RST,
//     which makes the Lua client die with a traceback instead of exiting.
//
// Traffic is not one-way: besides the SCREENSIZE reply to SCREENCONFIG and
// TOUCH, the panel declares its own monitors here. LifeBoatAPI's Simulator
// renders every powered-on entry of its `_screens` table, and its SCREENSIZE
// handler creates a missing entry (`_screens[n] = _screens[n] or
// SimulatorScreen:new(n)`), so `SCREENSIZE|2|64|64` is all it takes to give
// the microcontroller a second monitor — no Lua patch, no change to the user's
// script. SCREENPOWER switches one off again. See "Panel-declared screens".

import * as net from "net";
import { frame, FrameParser } from "./frame";

export const SIM_STUB_PORT = 14238;

/** Pixels per Stormworks monitor block. */
const PX_PER_BLOCK = 32;

/**
 * Widest/tallest monitor accepted, in blocks. The game's largest is 9x5, and
 * the panel's dropdown only offers real sizes — but a script is free to call
 * `simulator:setScreen(1, "3x1")`, and the panel then shows that size back as
 * an extra option. Rejecting anything off the dropdown's list would make the
 * portrait checkbox on such a screen a dead control, so any NxM inside these
 * bounds goes through. The cap is what keeps a typo from asking for a canvas
 * the panel has to rasterise every frame.
 */
export const MAX_BLOCKS = 9;

/** Panel cap on declared monitors; mirrors MAX_SCREENS in monitorConfig.js. */
export const MAX_SCREENS = 8;

export interface ScreenInfo {
  number: number;
  width: number;
  height: number;
  poweredOn: boolean;
  portrait: boolean;
  /** Block size as LifeBoatAPI spells it, e.g. "3x3". Drives the panel's size picker. */
  size: string;
}

/** One monitor the panel wants to exist, before it is pushed to Lua. */
export interface ScreenRequest {
  number: number;
  size: string;
  poweredOn: boolean;
  portrait: boolean;
}

/**
 * Validate a screen request arriving from the webview. Everything crossing
 * that boundary is untrusted: a bad screen number would create junk entries in
 * Lua's `_screens` (which the render loop then walks every frame), and a size
 * outside the table would reach `setScreen`'s `splits[1] * 32` as a nil.
 */
export function sanitizeScreenRequest(v: unknown): ScreenRequest | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const number = Math.round(Number(o.number ?? o.screen));
  if (!Number.isFinite(number) || number < 1 || number > MAX_SCREENS) return null;
  const size = String(o.size ?? "");
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return null;
  const bw = Number(m[1]), bh = Number(m[2]);
  if (bw < 1 || bh < 1 || bw > MAX_BLOCKS || bh > MAX_BLOCKS) return null;
  return {
    number,
    size,
    poweredOn: o.poweredOn !== false,
    portrait: o.portrait === true
  };
}

/** Blocks to canvas pixels; portrait stands the monitor on its end. */
function sizePixels(size: string, portrait: boolean): { width: number; height: number } {
  const { w, h } = parseSize(size);
  return portrait ? { width: h, height: w } : { width: w, height: h };
}

/** Inverse of parseSize, for reporting a Lua-declared screen back to the panel. */
function pixelsToSize(width: number, height: number, portrait: boolean): string {
  const w = portrait ? height : width;
  const h = portrait ? width : height;
  const bw = Math.max(1, Math.round(w / PX_PER_BLOCK));
  const bh = Math.max(1, Math.round(h / PX_PER_BLOCK));
  return `${bw}x${bh}`;
}

/**
 * One parsed draw call: `[COMMAND, ...params]`, e.g.
 * `["RECT", 1, 1, 0, 0, 32, 32]` or `["TEXT", 1, 2, 2, "hello"]`.
 * Numeric params are numbers; only trailing text stays a string. This shape
 * is JSON-serialisable and is what media/mcScreen.js replays onto a canvas.
 */
export type DrawCommand = (string | number)[];

/**
 * Numeric-argument counts per command. Commands whose LAST parameter is free
 * text (which may itself contain "|") are listed in TEXT_TAIL — for those the
 * count is the number of leading numeric params and everything after them is
 * one text field.
 */
const ARG_COUNTS: Record<string, number> = {
  COLOUR: 4,
  CLEAR: 1,
  LINE: 5,
  CIRCLE: 5,
  RECT: 6,
  // screen, fill, x1, y1, x2, y2, x3, y3 — eight, not seven. Getting this
  // short doesn't drop the command, it silently swallows the tail into the
  // last field (parseFloat("30|30") === 30), so y3 read back as 0 and every
  // filled triangle was stretched to the top of the screen.
  TRIANGLE: 8,
  TEXT: 3,
  TEXTBOX: 7,
  MAP: 4,
  MAPOCEAN: 4,
  MAPSHALLOWS: 4,
  MAPLAND: 4,
  MAPGRASS: 4,
  MAPSAND: 4,
  MAPSNOW: 4
};

const TEXT_TAIL = new Set(["TEXT", "TEXTBOX"]);

interface ParsedCommand {
  command: string;
  params: string[];
}

/**
 * Split a body into command + raw params. `limit` caps the number of splits so
 * a trailing free-text param keeps any "|" it contains.
 */
export function splitBody(body: string, limit: number): ParsedCommand {
  const head = body.indexOf("|");
  if (head === -1) return { command: body, params: [] };
  const command = body.slice(0, head);
  let rest = body.slice(head + 1);
  const params: string[] = [];
  while (params.length < limit - 1) {
    const i = rest.indexOf("|");
    if (i === -1) break;
    params.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  params.push(rest);
  // A command with zero params still carries the trailing "|", which leaves a
  // single empty tail — drop it rather than inventing a phantom parameter.
  if (params.length === 1 && params[0] === "") params.length = 0;
  return { command, params };
}

/** Lua sends numbers as tostring() output ("5.0", "223.30419898286"). */
function num(s: string | undefined): number {
  const n = parseFloat(s ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** `"3x3"` → 3 blocks wide, 3 blocks tall (pixels = blocks * 32). */
function parseSize(size: string): { w: number; h: number } {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(size ?? "");
  if (!m) return { w: PX_PER_BLOCK, h: PX_PER_BLOCK };
  return { w: Number(m[1]) * PX_PER_BLOCK, h: Number(m[2]) * PX_PER_BLOCK };
}

export class SimStubServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private parser = new FrameParser();
  private listening = false;
  private screens = new Map<number, ScreenInfo>();
  /**
   * Monitors the panel declared, as opposed to the ones the microcontroller's
   * own `simulator:setScreen` calls produced. Survives stop() and reconnects —
   * a debug session ending must not silently drop the user's monitor layout —
   * and is re-pushed to Lua once per connection (see pushWantedScreens).
   */
  private wanted = new Map<number, ScreenRequest>();
  /** Whether `wanted` has been pushed on the current connection yet. */
  private pushed = false;
  /** Draw calls accumulated since the last flushed TICKEND. */
  private pending: DrawCommand[] = [];
  private lastFrame: DrawCommand[] | null = null;

  /** Fired whenever the screen registry changes (SCREENCONFIG). */
  onScreenConfig: ((screens: ScreenInfo[]) => void) | null = null;
  /** Fired once per rendered frame (TICKEND|1). */
  onFrame: ((commands: DrawCommand[]) => void) | null = null;

  private boundPort = SIM_STUB_PORT;

  isListening(): boolean { return this.listening; }
  getPort(): number { return this.boundPort; }
  /** Sorted by screen number so the panel's monitor order never depends on
   *  which screen happened to send SCREENCONFIG first. */
  getScreens(): ScreenInfo[] {
    return Array.from(this.screens.values()).sort((a, b) => a.number - b.number);
  }
  getLastFrame(): DrawCommand[] | null { return this.lastFrame; }

  // --- Panel-declared screens ---------------------------------------------
  //
  // The panel can add monitors the microcontroller never asked for. Both
  // commands used here are ones LifeBoatAPI's Simulator already handles, so
  // nothing is patched and no user script has to change:
  //
  //   SCREENSIZE|n|w|h   sets the size, creating `_screens[n]` if it is
  //                      missing (a fresh SimulatorScreen is poweredOn)
  //   SCREENPOWER|n|0|1  switches one off/on; off also zeroes its touch state
  //
  // The microcontroller keeps the last word. Its `setScreen` calls arrive
  // after our per-connection push and overwrite whatever we set for the same
  // screen number, which is the precedence you want: the script under debug
  // describes the machine, the panel only fills in what the script left out.
  //
  // Removing is a power-off, not a delete: Lua has no command to drop an entry
  // from `_screens`, so a removed monitor stays in that table as poweredOn =
  // false, drawn by nobody, and comes back if it is added again.

  /** The panel's monitor layout, for persisting across sessions. */
  getWantedScreens(): ScreenRequest[] {
    return Array.from(this.wanted.values()).sort((a, b) => a.number - b.number);
  }

  /**
   * Restore a saved layout without pushing it — used at startup, before any
   * Lua is running. The next connection picks it up.
   */
  setWantedScreens(list: ScreenRequest[]): void {
    this.wanted.clear();
    for (const raw of list) {
      const req = sanitizeScreenRequest(raw);
      if (req) this.wanted.set(req.number, req);
    }
  }

  /** Add or reconfigure one monitor. */
  configureScreen(req: ScreenRequest): void {
    this.wanted.set(req.number, req);
    if (!this.listening) return;
    this.pushScreen(req);
    this.announceScreens();
  }

  /**
   * Power a monitor off and take it out of the panel. Accepts screens the
   * microcontroller declared too — the script can turn one back on by calling
   * `setScreen` for it again, which is the only sensible outcome when the two
   * disagree.
   */
  removeScreen(number: number): void {
    const n = Math.round(number);
    this.wanted.delete(n);
    if (!this.screens.has(n) && !this.listening) return;
    this.send(`SCREENPOWER|${n}|0`);
    this.screens.delete(n);
    this.announceScreens();
  }

  private pushScreen(req: ScreenRequest): void {
    const { width, height } = sizePixels(req.size, req.portrait);
    this.send(`SCREENSIZE|${req.number}|${width}|${height}`);
    this.send(`SCREENPOWER|${req.number}|${req.poweredOn ? "1" : "0"}`);
    this.screens.set(req.number, {
      number: req.number,
      width,
      height,
      poweredOn: req.poweredOn,
      portrait: req.portrait,
      size: req.size
    });
  }

  /**
   * Re-declare the panel's monitors on a fresh connection. Deferred until the
   * first SCREENCONFIG rather than done on connect: `_beginSimulation` sends
   * its default `setScreen(1, "3x3")` before the main loop starts reading our
   * messages, so pushing earlier would let that default overwrite a screen 1
   * the user had resized.
   */
  private pushWantedScreens(): void {
    if (this.pushed || this.wanted.size === 0) return;
    this.pushed = true;
    for (const req of this.getWantedScreens()) this.pushScreen(req);
  }

  private announceScreens(): void {
    if (this.onScreenConfig) this.onScreenConfig(this.getScreens());
  }

  /**
   * The Lua client hardcodes 14238, so production always uses the default.
   * Tests pass 0 to get an ephemeral port (read it back via getPort()) so they
   * don't collide with a live Extension Development Host holding 14238.
   */
  start(port: number = SIM_STUB_PORT): Promise<void> {
    if (this.listening && this.boundPort === port) return Promise.resolve();
    return this.stop().then(() => new Promise<void>((resolve, reject) => {
      const server = net.createServer(socket => this.onConnection(socket));
      this.server = server;
      const onError = (err: Error) => { this.listening = false; reject(err); };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        server.on("error", () => {});
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        this.listening = true;
        resolve();
      });
    }));
  }

  /** Graceful teardown: FIN on the client, then close the listener. */
  stop(): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        this.listening = false;
        this.server = null;
        this.screens.clear();
        // `wanted` deliberately survives: it is the user's monitor layout, not
        // session state, and the next F6 re-declares it.
        this.pushed = false;
        this.pending = [];
        this.lastFrame = null;
        this.parser.reset();
        resolve();
      };
      this.endClient();
      if (!this.server) return done();
      this.server.close(() => done());
    });
  }

  /**
   * Touch state for one screen. All seven params are always present — the Lua
   * split() would silently shift the fields if any were empty.
   */
  sendTouch(
    screen: number,
    isTouched: boolean,
    isTouchedAlt: boolean,
    x: number,
    y: number,
    xAlt: number,
    yAlt: number
  ): void {
    this.send([
      "TOUCH",
      String(Math.round(screen)),
      isTouched ? "1" : "0",
      isTouchedAlt ? "1" : "0",
      String(Math.round(x)),
      String(Math.round(y)),
      String(Math.round(xAlt)),
      String(Math.round(yAlt))
    ].join("|"));
  }

  private send(body: string): void {
    if (!this.client || this.client.destroyed) return;
    try {
      this.client.write(frame(body));
    } catch {
      this.client = null;
    }
  }

  private endClient(): void {
    const c = this.client;
    this.client = null;
    if (!c) return;
    // end(), never destroy() — an RST crashes the Lua client.
    try { c.end(); } catch {}
  }

  private onConnection(socket: net.Socket): void {
    this.endClient();
    this.parser.reset();
    this.pending = [];
    this.screens.clear();
    this.pushed = false;
    this.client = socket;
    socket.setNoDelay(true);
    this.parser.onError = () => this.endClient();
    socket.on("data", chunk => {
      for (const body of this.parser.feed(chunk)) this.handle(body);
    });
    socket.on("close", () => { if (this.client === socket) this.client = null; });
    socket.on("error", () => { if (this.client === socket) this.client = null; });
  }

  private handle(body: string): void {
    const head = body.indexOf("|");
    const name = (head === -1 ? body : body.slice(0, head)).toUpperCase();

    if (name === "SCREENCONFIG") {
      const { params } = splitBody(body, 4);
      this.applyScreenConfig(params);
      return;
    }
    if (name === "TICKEND") {
      const { params } = splitBody(body, 1);
      // "1" = rendered tick → flush. "0" = frame-skipped → keep accumulating.
      if (num(params[0]) === 1) {
        const commands = this.pending;
        this.pending = [];
        this.lastFrame = commands;
        if (this.onFrame) this.onFrame(commands);
      }
      return;
    }
    if (name === "SHUTDOWN") {
      this.endClient();
      return;
    }

    const count = ARG_COUNTS[name];
    if (count === undefined) return;   // INPUT/OUTPUT and anything unknown: ignore

    const limit = TEXT_TAIL.has(name) ? count + 1 : count;
    const { params } = splitBody(body, limit);
    const cmd: DrawCommand = [name];
    for (let i = 0; i < count; i++) cmd.push(num(params[i]));
    if (TEXT_TAIL.has(name)) cmd.push(params[count] ?? "");
    this.pending.push(cmd);
  }

  private applyScreenConfig(params: string[]): void {
    const number = Math.round(num(params[0]));
    const poweredOn = num(params[1]) === 1;
    const { w, h } = parseSize(params[2] ?? "");
    const portrait = num(params[3]) === 1;
    const width = portrait ? h : w;
    const height = portrait ? w : h;
    this.screens.set(number, {
      number, width, height, poweredOn, portrait,
      size: pixelsToSize(width, height, portrait)
    });
    // The MC's composite screen-size inputs stay 0 until this reply lands.
    this.send(["SCREENSIZE", String(number), String(width), String(height)].join("|"));
    // The Lua has finished _beginSimulation by the time it sends this, so the
    // panel's own monitors can go out now without the default setScreen(1,
    // "3x3") landing on top of them.
    this.pushWantedScreens();
    this.announceScreens();
  }
}
