// Messages between the extension host and the engine worker. Types only.
//
// Everything here crosses a worker boundary by structured clone, which keeps
// bigint and Uint8Array intact — the debugger's values (Lua integers, byte
// strings, table handles) rely on that and must not be passed through JSON.

import type {
  Breakpoint, StepMode, StackFrame, Variable, DebugValue, DebugHandle, TableEntry
} from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };
import type { PhysState } from "./physState";
import type { LogLine, ScreenFrame } from "./runner";
import type { ScreenInfo, ScreenRequest, TouchState } from "./screens";
import type { ControlsInfo } from "./controls";

export interface StartOptions {
  /** Absolute path of the script to run. */
  entry: string;
  /** Directories `require` searches, in precedence order. */
  roots: string[];
  screens: ScreenRequest[];
  timeScale: number;
  phys: PhysState;
  /** Where the panel's sliders stand, as [number, value]. */
  sliders: Array<[number, number]>;
  breakpoints: Breakpoint[];
}

/** Questions the host asks the worker; each gets exactly one reply. */
export interface Requests {
  setBreakpoints: { args: { points: Breakpoint[] }; result: void };
  resume: { args: { mode: StepMode }; result: void };
  stack: { args: Record<string, never>; result: StackFrame[] };
  locals: { args: { level: number }; result: Variable[] };
  upvalues: { args: { level: number }; result: Variable[] };
  evaluate: { args: { expression: string; level: number }; result: DebugValue };
  expand: { args: { handle: DebugHandle; start: number; limit: number }; result: TableEntry[] };
  io: { args: Record<string, never>; result: IoSnapshot };
}

export interface IoSnapshot {
  inputNumbers: number[];
  inputBooleans: boolean[];
  outputNumbers: number[];
  outputBooleans: boolean[];
}

export type RequestName = keyof Requests;

export type ToWorker =
  | { type: "start"; options: StartOptions }
  | { type: "phys"; state: PhysState }
  | { type: "touch"; screen: number; touch: TouchState }
  | { type: "screenSet"; request: ScreenRequest }
  | { type: "screenRemove"; screen: number }
  | { type: "timeScale"; scale: number }
  /** One of the simulator's buttons went down or came up. */
  | { type: "button"; number: number; pressed: boolean }
  | { type: "slider"; number: number; value: number }
  /** Send the monitor layout and every current frame again (a view opened mid-run). */
  | { type: "replay" }
  | { type: "request"; id: number; name: RequestName; args: unknown };

export type FromWorker =
  /** The script's top level ran; ticking has begun. */
  | { type: "started"; files: string[] }
  | { type: "screens"; screens: ScreenInfo[] }
  | { type: "frames"; frames: ScreenFrame[] }
  /** The buttons and sliders the script reads (it read one it had not before). */
  | { type: "controls"; controls: ControlsInfo }
  | { type: "log"; line: LogLine }
  /** Execution is suspended at a breakpoint or after a step. */
  | { type: "stopped"; reason: "breakpoint" | "step" }
  | { type: "continued" }
  /** The run is over: a Lua error, or the script called simulator:exit(). */
  | { type: "ended"; reason: "error" | "exit"; message?: string }
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };
