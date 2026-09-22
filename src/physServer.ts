import * as net from "net";
import { frame } from "./frame";

export interface PhysState {
  position: [number, number, number];
  rotation: [number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
}

export const ZERO_STATE: PhysState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0]
};

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)).toString();
}

export function encode(state: PhysState): Buffer {
  const v = [
    "PHYS",
    fmt(state.position[0]), fmt(state.position[1]), fmt(state.position[2]),
    fmt(state.rotation[0]), fmt(state.rotation[1]), fmt(state.rotation[2]),
    fmt(state.velocity[0]), fmt(state.velocity[1]), fmt(state.velocity[2]),
    fmt(state.angularVelocity[0]), fmt(state.angularVelocity[1]), fmt(state.angularVelocity[2])
  ].join("|");
  return frame(v);
}

/**
 * Simulation speeds the panel may ask for. A copy of media/timeScale.js's
 * TIME_SCALES (the webview is ESM, the host CommonJS) — a webview message is
 * untrusted, so the host validates on its own; test/timeScale.test.mjs keeps
 * the two lists equal.
 */
export const TIME_SCALES = [1, 0.5, 0.25, 0.1];
const TICKS_PER_SEC = 60;

export function sanitizeTimeScale(v: unknown): number {
  const n = Number(v);
  return TIME_SCALES.includes(n) ? n : 1;
}

/**
 * The Lua tick rate for a time scale: "RATE|<ticks per second>". PhySim.lua
 * writes it into LifeBoatAPI's Simulator._timePerFrame (not setFrameRate /
 * TICKRATE, which would also reset the frame skip).
 */
export function encodeRate(scale: number): Buffer {
  return frame(`RATE|${fmt(TICKS_PER_SEC * sanitizeTimeScale(scale))}`);
}

export class PhysServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private latest: PhysState = ZERO_STATE;
  private timeScale = 1;
  private port = 14239;
  private listening = false;

  isListening(): boolean { return this.listening; }
  getPort(): number { return this.port; }

  start(port: number): Promise<void> {
    if (this.listening && this.port === port) return Promise.resolve();
    return this.stop().then(() => new Promise((resolve, reject) => {
      this.port = port;
      this.server = net.createServer(socket => this.onConnection(socket));
      this.server.once("error", err => {
        this.listening = false;
        reject(err);
      });
      this.server.listen(port, "127.0.0.1", () => {
        this.listening = true;
        resolve();
      });
    }));
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      const done = () => { this.listening = false; this.server = null; resolve(); };
      if (this.client) { try { this.client.destroy(); } catch {} this.client = null; }
      if (!this.server) return done();
      this.server.close(() => done());
    });
  }

  broadcast(state: PhysState): void {
    this.latest = state;
    if (!this.client || this.client.destroyed) return;
    try {
      this.client.write(encode(state));
    } catch {
      // socket may have died between checks; drop it
      this.client = null;
    }
  }

  getTimeScale(): number { return this.timeScale; }

  /** Change the Lua tick rate. Re-sent to every new connection, since Lua starts at 60 Hz. */
  setTimeScale(scale: number): void {
    const s = sanitizeTimeScale(scale);
    if (s === this.timeScale) return;
    this.timeScale = s;
    if (!this.client || this.client.destroyed) return;
    try {
      this.client.write(encodeRate(s));
    } catch {
      this.client = null;
    }
  }

  private onConnection(socket: net.Socket): void {
    if (this.client && !this.client.destroyed) {
      try { this.client.destroy(); } catch {}
    }
    this.client = socket;
    socket.setNoDelay(true);
    socket.on("close", () => { if (this.client === socket) this.client = null; });
    socket.on("error", () => { if (this.client === socket) this.client = null; });
    // send initial state so the client has something even before the user moves the gizmo
    try { socket.write(Buffer.concat([encode(this.latest), encodeRate(this.timeScale)])); } catch {}
  }
}
