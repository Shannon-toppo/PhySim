// The window's end of the mirror: listens for an MCP server that has a script
// of this workspace running, and reports what it says. See agent/mirrorLink.ts
// for the protocol and why it is one way. No vscode import, so the tests run
// it in plain Node.
//
// One listener per workspace folder. One agent at a time is shown: a new
// connection replaces the one before it.

import { randomBytes } from "crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import * as path from "path";
import { Server, Socket, connect, createServer } from "net";
import * as os from "os";
import {
  MAX_MIRROR_LINE, MIRROR_DIR, MirrorUpdate, decodeMirrorLine, mirrorEndpoint, mirrorPipeName, mirrorPointerFile, usesPointerFile
} from "./agent/mirrorLink";

export interface MirrorServerOptions {
  platform?: string;
  /** The home directory the sockets live under. */
  home?: string;
  /** Leave the endpoint's name in a pointer file. Default: as the platform needs (Windows). */
  pointerFile?: boolean;
  /** For the tests, which cannot make a named pipe off Windows: the endpoint to use with a pointer file. */
  makeEndpoint?: (folder: string, token: string) => string;
  uid?: number;
  log?: (line: string) => void;
}

export interface MirrorEvents {
  /** An agent's server connected and said which version it is. */
  connected(server: string): void;
  update(update: MirrorUpdate): void;
  /** The agent's server went away (or was replaced by another). */
  disconnected(): void;
}

/** A connection that has not greeted by then is closed. */
const GREETING_TIMEOUT_MS = 5000;

interface Listener {
  folder: string;
  /** What is listened on. */
  endpoint: string;
  /** The file that tells a server the endpoint's name, where one is used. */
  pointer?: string;
  server: Server;
}

export class MirrorServer {
  private listeners = new Map<string, Listener>();
  private current: Socket | null = null;
  private disposed = false;
  private readonly platform: string;
  private readonly home: string;
  private readonly uid: number | undefined;

  constructor(private readonly events: MirrorEvents, private readonly options: MirrorServerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  }

  /** The endpoints being listened on, for the log and the tests. */
  endpoints(): string[] { return Array.from(this.listeners.values(), l => l.endpoint); }

  private get pointed(): boolean { return this.options.pointerFile ?? usesPointerFile(this.platform); }

  /** What identifies a folder's listener: the endpoint where it is computed, the pointer file where it is looked up. */
  private keyFor(real: string): string {
    return this.pointed
      ? mirrorPointerFile(real, this.platform, this.home)
      : mirrorEndpoint(real, this.platform, this.home, this.uid);
  }

  /**
   * Listen for exactly these folders: new ones are opened, ones no longer
   * listed are closed. Resolves when every new listener is up or has given up.
   */
  async setFolders(folders: readonly string[]): Promise<void> {
    if (this.disposed) return;
    const wanted = new Map<string, string>();
    for (const f of folders) {
      let real: string;
      try { real = realpathSync(f); } catch { continue; }
      wanted.set(this.keyFor(real), real);
    }
    for (const [key, l] of this.listeners) {
      if (wanted.has(key)) continue;
      this.listeners.delete(key);
      this.closeListener(l);
    }
    await Promise.all(Array.from(wanted, ([key, folder]) =>
      this.listeners.has(key) ? undefined : this.listen(folder, key)));
  }

  dispose(): void {
    this.disposed = true;
    for (const l of this.listeners.values()) this.closeListener(l);
    this.listeners.clear();
    const socket = this.current;
    this.current = null;
    socket?.destroy();
  }

  private log(line: string): void { this.options.log?.(line); }

  private closeListener(l: Listener): void {
    l.server.close();
    if (l.pointer) {
      // Only if it still points here: another window may have taken the folder over since.
      try { if (readFileSync(l.pointer, "utf8").trim() === l.endpoint) unlinkSync(l.pointer); } catch { /* already gone */ }
    }
    // Node removes a socket file it created when the server closes; this covers the case where it could not.
    if (this.platform !== "win32") { try { unlinkSync(l.endpoint); } catch { /* already gone */ } }
  }

  private async listen(folder: string, key: string): Promise<void> {
    // Sockets and pointer files live in a directory nobody else can reach into.
    if (this.platform !== "win32" || this.pointed) {
      try {
        mkdirSync(path.join(this.home, MIRROR_DIR), { recursive: true, mode: 0o700 });
      } catch (err) {
        this.log(`[mirror] could not create ${path.join(this.home, MIRROR_DIR)}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (this.pointed) { await this.listenPointed(folder, key); return; }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.tryListen(folder, key, key);
      if (result === "ok" || this.disposed) return;
      if (result !== "in-use") { this.log(`[mirror] could not listen for ${folder}: ${result}`); return; }
      // The name is taken: by another window with this folder open, or by a
      // socket file a window that crashed left behind.
      if (await isAlive(key)) {
        this.log(`[mirror] another window is already showing agents for ${folder}`);
        return;
      }
      try { unlinkSync(key); } catch { return; }
    }
  }

  /** Listen on a name made up here, and leave it in the pointer file for a server to find. */
  private async listenPointed(folder: string, pointer: string): Promise<void> {
    let existing: string | null = null;
    try { existing = readFileSync(pointer, "utf8").trim(); } catch { /* no window has this folder */ }
    if (existing && await isAlive(existing)) {
      this.log(`[mirror] another window is already showing agents for ${folder}`);
      return;
    }
    const token = randomBytes(16).toString("hex");
    const endpoint = this.options.makeEndpoint?.(folder, token) ?? mirrorPipeName(folder, this.platform, token);
    const result = await this.tryListen(folder, pointer, endpoint, pointer);
    if (result !== "ok") { this.log(`[mirror] could not listen for ${folder}: ${result}`); return; }
    if (this.disposed) return;
    try {
      writeFileSync(pointer, endpoint, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      this.log(`[mirror] could not write ${pointer}: ${err instanceof Error ? err.message : String(err)}`);
      const l = this.listeners.get(pointer);
      if (l) { this.listeners.delete(pointer); this.closeListener(l); }
    }
  }

  private tryListen(folder: string, key: string, endpoint: string, pointer?: string): Promise<"ok" | "in-use" | string> {
    return new Promise(resolve => {
      const server = createServer(socket => this.accept(socket));
      server.once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE" ? "in-use" : err.message);
      });
      server.listen(endpoint, () => {
        if (this.disposed) { server.close(); resolve("ok"); return; }
        // Owner only — the guard that still holds when the socket had to go to the shared /tmp.
        if (this.platform !== "win32") { try { chmodSync(endpoint, 0o600); } catch { /* best effort */ } }
        server.on("error", err => this.log(`[mirror] ${err.message}`));
        this.listeners.set(key, { folder, endpoint, pointer, server });
        resolve("ok");
      });
    });
  }

  private accept(socket: Socket): void {
    // A connection counts only once it has greeted. Until then it may be
    // another window probing whether this endpoint is alive (isAlive below),
    // and that must not push out the agent being shown.
    let buffer = "";
    const end = (why?: string): void => {
      if (why) this.log(`[mirror] connection dropped: ${why}`);
      socket.destroy();
    };
    const greeting = setTimeout(() => end(), GREETING_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line === "") continue;
        const message = decodeMirrorLine(line);
        if (!message) { end("a line that is not a mirror message"); return; }
        if (message.type === "hello") {
          if (this.current === socket) continue;
          clearTimeout(greeting);
          const previous = this.current;
          this.current = socket;
          if (previous) {
            previous.destroy();
            this.events.disconnected();
          }
          this.events.connected(message.server);
        } else if (this.current !== socket) {
          // Before its greeting, or after a newer connection took its place.
          end("an update from a connection that is not the current one");
          return;
        } else {
          const { type: _type, ...update } = message;
          void _type;
          this.events.update(update);
        }
      }
      if (buffer.length > MAX_MIRROR_LINE) end("a line longer than the limit");
    });
    socket.on("error", () => { /* "close" follows */ });
    socket.on("close", () => {
      clearTimeout(greeting);
      if (this.current !== socket) return;
      this.current = null;
      this.events.disconnected();
    });
  }
}

/** Whether something accepts connections on the endpoint right now. */
function isAlive(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = connect(endpoint);
    const done = (alive: boolean): void => { probe.destroy(); resolve(alive); };
    probe.setTimeout(500, () => done(false));
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}
