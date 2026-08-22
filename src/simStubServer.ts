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

import * as net from "net";
import { frame, FrameParser } from "./frame";

export const SIM_STUB_PORT = 14238;

/** Pixels per Stormworks monitor block. */
const PX_PER_BLOCK = 32;

export interface ScreenInfo {
  number: number;
  width: number;
  height: number;
  poweredOn: boolean;
  portrait: boolean;
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
  getScreens(): ScreenInfo[] { return Array.from(this.screens.values()); }
  getLastFrame(): DrawCommand[] | null { return this.lastFrame; }

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
    this.screens.set(number, { number, width, height, poweredOn, portrait });
    // The MC's composite screen-size inputs stay 0 until this reply lands.
    this.send(["SCREENSIZE", String(number), String(width), String(height)].join("|"));
    if (this.onScreenConfig) this.onScreenConfig(this.getScreens());
  }
}
