// The MCP server's end of the mirror: after a tool call, tell a PhySim window
// what the run looks like now — if a window is listening. See mirrorLink.ts.
//
// Everything here is best effort and silent. No window, a window that goes
// away, a slow window: none of it may delay or fail a tool call, because the
// agent's run does not depend on anybody watching it.

import { existsSync, readFileSync, realpathSync } from "fs";
import { connect, Socket } from "net";
import * as os from "os";
import * as path from "path";
import type { AgentSession } from "./agentSession";
import {
  MirrorFrame, ancestors, encodeHello, encodeUpdate, isMirrorPipeName, mirrorEndpoint, mirrorPointerFile, usesPointerFile
} from "./mirrorLink";

/** How long one endpoint gets to accept before the next folder up is tried. */
const CONNECT_TIMEOUT_MS = 500;
/** With no window found, how long until looking again (a start_script looks at once). */
const RETRY_AFTER_MS = 5000;
/** Unsent bytes beyond which pictures are held back until the window catches up. */
const BACKLOG_LIMIT = 16 * 1024 * 1024;

export interface MirrorClientOptions {
  serverVersion: string;
  /** Replaceable for the tests; defaults to the real platform. */
  platform?: string;
  /** The home directory the sockets live under. */
  home?: string;
  /** Look the endpoint up in a pointer file. Default: as the platform needs (Windows). */
  pointerFile?: boolean;
  uid?: number;
  now?: () => number;
  /** For the tests, which cannot make a named pipe off Windows: also accept this as a pointer file's content. */
  acceptEndpoint?: (name: string) => boolean;
}

export class MirrorClient {
  private socket: Socket | null = null;
  /** The folder the live connection (or the search in progress) is for. */
  private target: string | null = null;
  private searching = false;
  /** The latest tool call, so a connection made after it can still say what it followed. */
  private lastTool = "connect";
  private lastSearch = -Infinity;
  /** Pictures the window has, by monitor — identity, since the runner never rewrites a frame's buffer. */
  private sent = new Map<number, Uint8Array>();
  private readonly platform: string;
  private readonly home: string;
  private readonly uid: number | undefined;
  private readonly now: () => number;

  constructor(private readonly session: AgentSession, private readonly options: MirrorClientOptions) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    this.now = options.now ?? (() => performance.now());
  }

  isConnected(): boolean { return this.socket !== null; }

  /** Call after every tool call. Never throws. */
  publish(tool: string): void {
    this.lastTool = tool;
    try {
      const entry = this.session.getEntry();
      if (entry) {
        const dir = realDir(entry);
        // A script somewhere else: the window that was watching has no part in it.
        if (this.socket && this.target !== null && !isInside(dir, this.target)) this.drop();
        const retry = tool === "start_script" || this.now() - this.lastSearch >= RETRY_AFTER_MS;
        if (!this.socket && !this.searching && retry) this.search(dir);
      }
      this.send(tool);
    } catch {
      // A mirror that misbehaves is dropped, not reported: see the note at the top.
      this.drop();
    }
  }

  dispose(): void { this.drop(); }

  private send(tool: string): void {
    const socket = this.socket;
    if (!socket) return;
    const status = this.session.getStatus();
    const frames: MirrorFrame[] = [];
    if (socket.writableLength < BACKLOG_LIMIT) {
      for (const [screen, picture] of this.session.pictures()) {
        if (this.sent.get(screen) === picture.pixels) continue;
        this.sent.set(screen, picture.pixels);
        frames.push({ screen, width: picture.width, height: picture.height, pixels: picture.pixels });
      }
    }
    if (status === "none") this.sent.clear();
    const error = this.session.getError();
    socket.write(encodeUpdate({
      tool, status, script: this.session.getEntry(), tick: this.session.getTicks(),
      pose: this.session.getPose(), screens: this.session.screens(), frames,
      controls: this.session.controls(),
      ...(error === null ? {} : { error })
    }) + "\n");
  }

  /** Try the script's folder and each one above it, nearest first, until a window answers. */
  private search(dir: string): void {
    this.searching = true;
    this.lastSearch = this.now();
    const candidates = ancestors(dir);
    const next = (i: number): void => {
      if (i >= candidates.length) { this.searching = false; return; }
      const folder = candidates[i];
      const endpoint = this.endpointFor(folder);
      if (endpoint === null) { next(i + 1); return; }
      const socket = connect(endpoint);
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        next(i + 1);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, fail);
      socket.once("error", fail);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        this.searching = false;
        this.adopt(socket, folder);
      });
    };
    next(0);
  }

  /** Where a window with `folder` open would be listening, or null when plainly none is. */
  private endpointFor(folder: string): string | null {
    if (this.options.pointerFile ?? usesPointerFile(this.platform)) {
      let name: string;
      try {
        name = readFileSync(mirrorPointerFile(folder, this.platform, this.home), "utf8").trim();
      } catch {
        return null;
      }
      // The file is in the user's own profile, but what it says is still only connected to if it looks right.
      return isMirrorPipeName(name) || this.options.acceptEndpoint?.(name) ? name : null;
    }
    const endpoint = mirrorEndpoint(folder, this.platform, this.home, this.uid);
    // A socket is a file: when it is not there, nobody is listening.
    return existsSync(endpoint) ? endpoint : null;
  }

  private adopt(socket: Socket, folder: string): void {
    this.socket = socket;
    this.target = folder;
    this.sent.clear();
    // The window never speaks, but a closed or broken pipe must not go unnoticed.
    socket.on("error", () => this.dropIf(socket));
    socket.on("close", () => this.dropIf(socket));
    socket.resume();
    socket.write(encodeHello(this.options.serverVersion) + "\n");
    // What the run looks like now. The tool call that started the search has
    // returned by now; its name still goes along, since a window opens its
    // panel on a start_script.
    try { this.send(this.lastTool); } catch { this.drop(); }
  }

  private dropIf(socket: Socket): void {
    if (this.socket === socket) this.drop();
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.target = null;
    this.sent.clear();
    socket?.destroy();
  }
}

function realDir(file: string): string {
  const dir = path.dirname(file);
  try { return realpathSync(dir); } catch { return dir; }
}

function isInside(dir: string, folder: string): boolean {
  const rel = path.relative(folder, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
