// The wire between the MCP server and a PhySim panel that shows what an agent
// is doing. Pure module, shared by both ends: where to meet, what is said, and
// how the receiving end checks it.
//
// The server is its own process, started by the agent's client, and it owns
// the run. A VSCode window that has the script's folder open listens on a
// local endpoint named after that folder; the server looks for one and, if it
// is there, sends it the pose and the monitors after each tool call. One way
// only: the window is told what to show and has nothing to say back, so there
// is no path from the window (or from anything else that finds the endpoint)
// into the agent's run.
//
// The endpoint is a Unix domain socket or, on Windows, a named pipe — local to
// the machine, and not a TCP port. `usesPointerFile` says which of the two
// ways of finding it applies.

import { createHash } from "crypto";
import * as path from "path";
import { PhysState, sanitizePhysState } from "../engine/physState";
import { MAX_BLOCKS, MAX_SCREENS, PX_PER_BLOCK, ScreenInfo } from "../engine/screens";
import { ControlsInfo, MAX_CONTROLS, NO_CONTROLS, controlNumber } from "../engine/controls";
import type { RunStatus } from "./agentSession";

export const MIRROR_VERSION = 1;

/** True where the endpoint's name is looked up in a file (Windows) rather than computed (everywhere else). */
export function usesPointerFile(platform: string): boolean { return platform === "win32"; }

/** Longest line the receiver accepts: eight full-size monitors in base64, with room to spare. */
export const MAX_MIRROR_LINE = 8 * 1024 * 1024;

/** How far up from the script the server looks for a window's folder. */
export const MAX_MIRROR_ANCESTORS = 32;

const MAX_SIDE = MAX_BLOCKS * PX_PER_BLOCK;

export interface MirrorFrame {
  screen: number;
  width: number;
  height: number;
  /** RGBA, width*height*4. */
  pixels: Uint8Array;
}

export interface MirrorUpdate {
  /** The tool call this follows, for the window's log. */
  tool: string;
  status: RunStatus;
  /** Absolute path of the script, or null when none is running. */
  script: string | null;
  tick: number;
  pose: PhysState;
  screens: ScreenInfo[];
  /**
   * Pictures that changed since the last update on this connection — all of
   * them on the first. A monitor missing here keeps the picture it had.
   */
  frames: MirrorFrame[];
  /** The simulator's buttons and sliders the script reads, with their state. */
  controls: ControlsInfo;
  /** The Lua error, when status is "failed". */
  error?: string;
}

/** A Unix socket path may be about 100 bytes; beyond this the fallback directory is used. */
const MAX_SOCKET_PATH = 100;

/** The directory in the home directory that holds the sockets. Created by the window, owner only. */
export const MIRROR_DIR = ".physim";

function folderHash(folder: string, platform: string): string {
  // Windows paths differ in case from one spelling to the next; nothing else may be folded.
  const key = platform === "win32" ? folder.toLowerCase() : folder;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Where a window with `folder` open listens, on a system with Unix sockets.
 * Both ends compute it from the folder's real path, so they agree without
 * anything being written down.
 *
 * It must not depend on the environment: an agent's client commonly starts
 * its MCP servers with a trimmed one (no TMPDIR, say), while the window has
 * the user's full one. The home directory comes from the user database either
 * way, so the socket lives in `~/.physim/`; only a home path too long for a
 * socket falls back to `/tmp`, with the user id in the name.
 *
 * @param folder   the folder's real path (symbolic links already followed)
 * @param home     os.homedir()
 * @param uid      the user id where the OS has one
 */
export function mirrorEndpoint(folder: string, platform: string, home: string, uid: number | undefined): string {
  const hash = folderHash(folder, platform);
  const inHome = path.join(home, MIRROR_DIR, `${hash}.sock`);
  return Buffer.byteLength(inHome) <= MAX_SOCKET_PATH ? inHome : `/tmp/physim-${uid ?? 0}-${hash}.sock`;
}

// On Windows the endpoint is a named pipe, and a pipe's name is all there is
// to it: no directory keeps other users of the machine away from it. A name
// computed from the folder could be guessed — and claimed first by someone
// else, who would then be sent the agent's pictures. So the window makes up a
// name nobody can guess and leaves it in a file in the user's own profile,
// where only that user can read it; the server looks the name up there.

/** The file a window leaves its pipe's name in. */
export function mirrorPointerFile(folder: string, platform: string, home: string): string {
  return path.join(home, MIRROR_DIR, `${folderHash(folder, platform)}.pipe`);
}

/** A pipe name for `folder` that cannot be guessed. `token` is random hex from the caller. */
export function mirrorPipeName(folder: string, platform: string, token: string): string {
  return `\\\\.\\pipe\\physim-mirror-${folderHash(folder, platform)}-${token}`;
}

/** Whether text read from a pointer file is a pipe name of the kind a window makes. */
export function isMirrorPipeName(name: string): boolean {
  return /^\\\\\.\\pipe\\physim-mirror-[0-9a-f]{16}-[0-9a-f]{32}$/.test(name);
}

/** `dir` and every folder above it, nearest first. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = path.resolve(dir); out.length < MAX_MIRROR_ANCESTORS;) {
    out.push(d);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
}

// --- Encoding ------------------------------------------------------------------

export function encodeHello(serverVersion: string): string {
  return JSON.stringify({ v: MIRROR_VERSION, type: "hello", server: serverVersion });
}

export function encodeUpdate(u: MirrorUpdate): string {
  return JSON.stringify({
    v: MIRROR_VERSION, type: "update",
    tool: u.tool, status: u.status, script: u.script, tick: u.tick, pose: u.pose, screens: u.screens,
    controls: u.controls,
    frames: u.frames.map(f => ({
      screen: f.screen, width: f.width, height: f.height,
      pixels: Buffer.from(f.pixels.buffer, f.pixels.byteOffset, f.pixels.byteLength).toString("base64")
    })),
    ...(u.error === undefined ? {} : { error: u.error })
  });
}

// --- Decoding ------------------------------------------------------------------
//
// The receiving end is an extension host, and the endpoint can be found by any
// process of the same user. Everything is checked before it is believed; a
// line that fails ends the connection.

export type MirrorMessage =
  | { type: "hello"; server: string }
  | ({ type: "update" } & MirrorUpdate);

const STATUSES: readonly string[] = ["none", "running", "exited", "failed"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function wholeIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

function decodeScreen(v: unknown): ScreenInfo | null {
  if (!isObject(v)) return null;
  if (!wholeIn(v.number, 1, 1024) || !wholeIn(v.width, 1, MAX_SIDE) || !wholeIn(v.height, 1, MAX_SIDE)) return null;
  if (typeof v.poweredOn !== "boolean" || typeof v.portrait !== "boolean") return null;
  if (typeof v.size !== "string" || !/^\d{1,2}x\d{1,2}$/.test(v.size)) return null;
  return { number: v.number, width: v.width, height: v.height, poweredOn: v.poweredOn, portrait: v.portrait, size: v.size };
}

function decodeFrame(v: unknown): MirrorFrame | null {
  if (!isObject(v)) return null;
  if (!wholeIn(v.screen, 1, 1024) || !wholeIn(v.width, 1, MAX_SIDE) || !wholeIn(v.height, 1, MAX_SIDE)) return null;
  if (typeof v.pixels !== "string") return null;
  const bytes = v.width * v.height * 4;
  // Checked on the text first, so an oversized string is never decoded.
  if (v.pixels.length !== Math.ceil(bytes / 3) * 4) return null;
  const pixels = Buffer.from(v.pixels, "base64");
  if (pixels.length !== bytes) return null;
  return { screen: v.screen, width: v.width, height: v.height, pixels: new Uint8Array(pixels) };
}

/** Absent (a server from before the controls were mirrored) reads as none; anything malformed is refused. */
function decodeControls(v: unknown): ControlsInfo | null {
  if (v === undefined) return NO_CONTROLS;
  if (!isObject(v) || !Array.isArray(v.buttons) || !Array.isArray(v.sliders)) return null;
  if (v.buttons.length > MAX_CONTROLS || v.sliders.length > MAX_CONTROLS) return null;
  const buttons: ControlsInfo["buttons"] = [];
  for (const b of v.buttons) {
    if (!isObject(b) || controlNumber(b.number) === null) return null;
    if (typeof b.showsToggle !== "boolean" || typeof b.toggled !== "boolean" || typeof b.down !== "boolean") return null;
    buttons.push({ number: b.number as number, showsToggle: b.showsToggle, toggled: b.toggled, down: b.down });
  }
  const sliders: ControlsInfo["sliders"] = [];
  for (const s of v.sliders) {
    if (!isObject(s) || controlNumber(s.number) === null) return null;
    if (typeof s.value !== "number" || !(s.value >= 0 && s.value <= 1)) return null;
    sliders.push({ number: s.number as number, value: s.value });
  }
  return { buttons, sliders };
}

/** A line as a message, or null when it is not one this version understands. */
export function decodeMirrorLine(line: string): MirrorMessage | null {
  if (line.length > MAX_MIRROR_LINE) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== MIRROR_VERSION) return null;
  if (raw.type === "hello") {
    const server = text(raw.server, 64);
    return server === null ? null : { type: "hello", server };
  }
  if (raw.type !== "update") return null;

  const tool = text(raw.tool, 64);
  const pose = sanitizePhysState(raw.pose);
  const script = raw.script === null ? null : text(raw.script, 4096);
  if (tool === null || pose === null || (raw.script !== null && script === null)) return null;
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) return null;
  if (!wholeIn(raw.tick, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(raw.screens) || raw.screens.length > MAX_SCREENS) return null;
  if (!Array.isArray(raw.frames) || raw.frames.length > MAX_SCREENS) return null;
  const screens = raw.screens.map(decodeScreen);
  const frames = raw.frames.map(decodeFrame);
  const controls = decodeControls(raw.controls);
  if (screens.includes(null) || frames.includes(null) || controls === null) return null;
  let error: string | undefined;
  if (raw.error !== undefined) {
    const e = text(raw.error, 16384);
    if (e === null) return null;
    error = e;
  }
  return {
    type: "update", tool, status: raw.status as RunStatus, script, tick: raw.tick, pose,
    screens: screens as ScreenInfo[], frames: frames as MirrorFrame[], controls,
    ...(error === undefined ? {} : { error })
  };
}
