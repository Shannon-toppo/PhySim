import * as net from "net";

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

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)).toString();
}

function encode(state: PhysState): Buffer {
  const v = [
    "PHYS",
    fmt(state.position[0]), fmt(state.position[1]), fmt(state.position[2]),
    fmt(state.rotation[0]), fmt(state.rotation[1]), fmt(state.rotation[2]),
    fmt(state.velocity[0]), fmt(state.velocity[1]), fmt(state.velocity[2]),
    fmt(state.angularVelocity[0]), fmt(state.angularVelocity[1]), fmt(state.angularVelocity[2])
  ].join("|");
  const len = Buffer.byteLength(v, "utf8");
  if (len > 9999) {
    throw new Error("PhysServer: message too long for 4-digit length prefix");
  }
  return Buffer.from(len.toString().padStart(4, "0") + v, "utf8");
}

export class PhysServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private latest: PhysState = ZERO_STATE;
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

  private onConnection(socket: net.Socket): void {
    if (this.client && !this.client.destroyed) {
      try { this.client.destroy(); } catch {}
    }
    this.client = socket;
    socket.setNoDelay(true);
    socket.on("close", () => { if (this.client === socket) this.client = null; });
    socket.on("error", () => { if (this.client === socket) this.client = null; });
    // send initial state so the client has something even before the user moves the gizmo
    try { socket.write(encode(this.latest)); } catch {}
  }
}
