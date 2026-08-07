// Shared "%04d length prefix + body" framing, used by both TCP servers:
//
//   * physServer.ts  (port 14239) — PhySim's own physics-sensor stream.
//   * simStubServer.ts (port 14238) — the macOS stand-in for LifeBoatAPI's
//     Windows-only STORMWORKS_Simulator.exe.
//
// Both directions of both protocols use the same wire shape: four ASCII
// decimal digits giving the byte length of the body, immediately followed by
// the body. No terminator, frames run back-to-back.

/** Encode one body string as a length-prefixed frame. */
export function frame(body: string): Buffer {
  const len = Buffer.byteLength(body, "utf8");
  if (len > 9999) {
    throw new Error("PhySim: message too long for 4-digit length prefix");
  }
  return Buffer.from(len.toString().padStart(4, "0") + body, "utf8");
}

const PREFIX_LEN = 4;

/**
 * Incremental parser for the length-prefixed stream. Chunks arriving from the
 * socket can split a frame anywhere (or carry several at once), so bytes are
 * buffered until a whole frame is available.
 *
 * A non-numeric length prefix means the stream is desynchronised beyond
 * recovery; the parser latches into a broken state and reports it through
 * `onError` so the caller can close the socket *gracefully* (see
 * simStubServer — an RST crashes the Lua client with a traceback).
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private broken = false;

  /** Called once when a corrupt length prefix is seen. */
  onError: ((err: Error) => void) | null = null;

  isBroken(): boolean { return this.broken; }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.broken = false;
  }

  /** Feed raw socket bytes; returns every complete body they completed. */
  feed(chunk: Buffer): string[] {
    if (this.broken) return [];
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    const out: string[] = [];
    for (;;) {
      if (this.buf.length < PREFIX_LEN) break;
      const prefix = this.buf.toString("latin1", 0, PREFIX_LEN);
      if (!/^\d{4}$/.test(prefix)) {
        this.broken = true;
        this.buf = Buffer.alloc(0);
        if (this.onError) this.onError(new Error(`PhySim: corrupt frame prefix ${JSON.stringify(prefix)}`));
        break;
      }
      const len = Number(prefix);
      if (this.buf.length < PREFIX_LEN + len) break;
      out.push(this.buf.toString("utf8", PREFIX_LEN, PREFIX_LEN + len));
      this.buf = this.buf.subarray(PREFIX_LEN + len);
    }
    return out;
  }
}
