// Per-session shared secret for PhySim's two loopback servers.
//
// Both listen on 127.0.0.1 only, but that still lets any local process — or,
// in a browser that doesn't block public-to-loopback requests, a web page —
// open a connection. Before this gate either server handed its single client
// slot to whoever connected last, so a stray connection silently ended the
// developer's simulator session (14238) or took over the pose stream (14239).
//
// debugConfigPatcher renews the token on every F6 and writes it into
// _simulator.lua, where the Lua side sends it as its first frame:
//
//   PHYSIM_AUTH|<32 hex chars>
//
// Kept free of any `vscode` import so the servers stay testable in plain Node.
// The token is readable by any process running as the same OS user (it sits
// in _simulator.lua), which can rewrite that file anyway; what it keeps out is
// other OS users and browsers.

import * as crypto from "crypto";
import type * as net from "net";
import { FrameParser } from "./frame";

export const AUTH_COMMAND = "PHYSIM_AUTH";

/** How long a new connection gets to present the token before it is closed. */
export const AUTH_TIMEOUT_MS = 5000;

export class SessionAuth {
  private token: string | null = null;

  /** Start a new session: invalidates the previous token. */
  renew(): string {
    this.token = crypto.randomBytes(16).toString("hex");
    return this.token;
  }

  current(): string | null { return this.token; }

  /** Whether `body` is `PHYSIM_AUTH|<the current token>`. Always false before renew(). */
  verify(body: string): boolean {
    if (this.token === null) return false;
    const prefix = AUTH_COMMAND + "|";
    if (!body.startsWith(prefix)) return false;
    const given = Buffer.from(body.slice(prefix.length), "utf8");
    const want = Buffer.from(this.token, "utf8");
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }
}

/**
 * Holds new connections until their first frame proves the token. Nothing is
 * sent to a connection and the current client is left alone until then; a
 * wrong first frame, a corrupt prefix or the timeout closes it.
 */
export class AuthGate {
  /** Every socket admitted but not accepted, rejected ones included until they close. */
  private held = new Set<net.Socket>();

  constructor(
    private readonly auth: SessionAuth,
    private readonly timeoutMs: number = AUTH_TIMEOUT_MS
  ) {}

  /**
   * @param onAccept takes over the socket. `parser` holds any bytes after the
   *   token frame, and `rest` the frames that arrived in the same chunk.
   * @param onReject closes the socket (each server knows how — see simStubServer).
   */
  admit(
    socket: net.Socket,
    onAccept: (parser: FrameParser, rest: string[]) => void,
    onReject: (socket: net.Socket) => void
  ): void {
    const parser = new FrameParser();
    let settled = false;
    this.held.add(socket);

    const finish = (ok: boolean, rest: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      if (ok) {
        this.held.delete(socket);
        onAccept(parser, rest);
      } else {
        onReject(socket);
      }
    };
    const onData = (chunk: Buffer): void => {
      const bodies = parser.feed(chunk);
      if (parser.isBroken()) return finish(false, []);
      if (bodies.length === 0) return;
      finish(this.auth.verify(bodies[0]), bodies.slice(1));
    };
    const timer = setTimeout(() => finish(false, []), this.timeoutMs);

    socket.on("data", onData);
    socket.on("close", () => {
      this.held.delete(socket);
      if (!settled) { settled = true; clearTimeout(timer); }
    });
    socket.on("error", () => {});
  }

  /** Destroy every connection still held, so server.close() isn't kept waiting on them. */
  dropAll(): void {
    for (const s of this.held) { try { s.destroy(); } catch {} }
    this.held.clear();
  }
}
