// One run of a microcontroller script on Storm Lua Engine.
//
// The runner owns the VM and the order things happen in within a tick. It has
// no timer and no transport: a caller (the worker, or a test) asks for one
// tick at a time. No vscode import, so the tests drive it in plain Node.
//
// A tick is a queue of phases:
//
//     prelude tick (default inputs, onLBSimulatorTick)  →  onTick  →  onDraw per powered monitor
//
// A breakpoint can suspend any of them. The queue then stays where it is, the
// runner reports "suspended", and `resume()` continues the same phase — the
// engine keeps the Lua continuation — before draining the rest. Nothing is
// re-run from the top, so a tick stopped half-way through never executes its
// first half twice.

import type {
  LuaEngine, VehicleVm, LuaValue, Outcome, LogRecord, PropertyEntry,
  Breakpoint, StepMode, StackFrame, Variable, DebugValue, DebugHandle, TableEntry
} from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };
import { PhysState, ZERO_STATE, TICKS_PER_SEC } from "./physState";
import { PRELUDE_CHUNK, PRELUDE_SOURCE, PRELUDE_TICK } from "./prelude";
import { ScreenRegistry, ScreenInfo, ScreenRequest, TouchState } from "./screens";
import { ControlBoard, ControlsInfo } from "./controls";
import { SourceRoots, chunkName } from "./sourceRoots";

/** Root tables the prelude reads. Both are reserved names in a user script. */
const CONTROL_NAMESPACE = "__physim";
const HOST_NAMESPACE = "__physim_host";

/** LifeBoatAPI's own default: one 3x3 monitor unless something says otherwise. */
const DEFAULT_SCREEN: ScreenRequest = { number: 1, size: "3x3", poweredOn: true, portrait: false };

/** What screen.drawMap fills with until the script picks an ocean colour. */
const DEFAULT_OCEAN: readonly [number, number, number, number] = [20, 40, 90, 255];

export interface RunnerFiles {
  isFile(file: string): boolean;
  read(file: string): Uint8Array;
}

export interface LogLine {
  source: "print" | "debug.log";
  text: string;
  /** Chunk name and line of the call, when the engine could tell. */
  chunk?: string;
  line?: number;
}

export interface ScreenFrame {
  screen: number;
  width: number;
  height: number;
  /** RGBA, width*height*4, owned by the receiver. */
  pixels: Uint8Array;
}

export interface RunnerOptions {
  /** Absolute path of the script to run. */
  entry: string;
  /** Directories `require` searches, in precedence order. */
  roots: readonly string[];
  files: RunnerFiles;
  /** The panel's monitor layout; the script's setScreen calls land on top. */
  screens?: readonly ScreenRequest[];
  /**
   * Property values in place before the script's top level runs, as the
   * microcontroller's property widgets would have them. A `simulator:setProperty`
   * in the script replaces the value for its label.
   */
  properties?: Readonly<Record<string, PropertyInput>>;
  onLog?: (line: LogLine) => void;
  onScreens?: (screens: ScreenInfo[]) => void;
  /** Slider positions to start from, as [number, value] pairs. */
  sliders?: Iterable<readonly [number, number]>;
  /** The script read a button, toggle or slider it had not read before. */
  onControls?: (controls: ControlsInfo) => void;
  /** Per-entry-point limits; the engine's defaults when omitted. */
  instructionBudget?: number;
  memoryBytes?: number;
}

/**
 * ready     — between ticks, or not started yet
 * suspended — stopped at a breakpoint or step; only resume() and inspection are valid
 * exited    — the script called simulator:exit()
 * failed    — a Lua error ended the run
 */
/** A value a property can hold: what `simulator:setProperty` accepts. */
export type PropertyInput = number | boolean | string;

/** Composite channels are numbered 1..32, as in the game. */
export const IO_CHANNELS = 32;

export type RunnerState = "ready" | "suspended" | "exited" | "failed" | "disposed";

interface Phase {
  run(): Outcome;
  /** After the phase completed (or was missing) — never while it is suspended. */
  done?(outcome: Outcome): void;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function int(v: number): bigint { return BigInt(Math.round(v)); }

/** Lua integers arrive as bigint and floats as number; a screen number may be either. */
function toNumber(v: LuaValue | undefined): number {
  if (typeof v === "bigint") return Number(v);
  return typeof v === "number" ? v : NaN;
}

/** A Lua string arrives as its bytes; a size or label is text. */
function toText(v: LuaValue | undefined): string {
  if (v instanceof Uint8Array) return decoder.decode(v);
  return typeof v === "string" ? v : "";
}

export class VehicleRunner {
  private readonly vm: VehicleVm;
  private readonly screens = new ScreenRegistry();
  private readonly controls: ControlBoard;
  private readonly roots: SourceRoots;
  private readonly loaded = new Set<string>();
  private queue: Phase[] = [];
  private status: RunnerState = "ready";
  private started = false;
  private ticks = 0;
  private phys: PhysState = ZERO_STATE;
  private tickRate = TICKS_PER_SEC;
  private exitRequested = false;
  /** Composite inputs held from outside the script, by channel. */
  private heldNumbers = new Map<number, number>();
  private heldBools = new Map<number, boolean>();
  /** Latest frame per monitor, kept to tell a changed frame from a repeat. */
  private lastFrames = new Map<number, ScreenFrame>();
  private freshFrames = new Map<number, ScreenFrame>();

  constructor(engine: LuaEngine, private readonly opts: RunnerOptions) {
    this.roots = new SourceRoots(opts.roots, opts.files);
    this.controls = new ControlBoard(opts.sliders);
    this.controls.onChange = info => opts.onControls?.(info);
    this.screens.configure(DEFAULT_SCREEN);
    for (const req of opts.screens ?? []) this.screens.configure(req);
    // Subscribed after seeding: the caller reads the initial layout from screenList().
    this.screens.onChange = list => {
      for (const n of this.lastFrames.keys()) {
        if (!list.some(s => s.number === n && s.poweredOn)) {
          this.lastFrames.delete(n);
          this.freshFrames.delete(n);
        }
      }
      opts.onScreens?.(list);
    };

    this.vm = engine.createVehicle({
      // extended: the development environment. `require`, `print` and `pcall`
      // exist only there, and LifeBoatAPI's sandbox offered the first two.
      environment: "extended",
      controlNamespace: CONTROL_NAMESPACE,
      instructionBudget: opts.instructionBudget,
      memoryBytes: opts.memoryBytes,
      properties: opts.properties,
      requireLoader: name => this.loadModule(name),
      // There is no world here, so screen.drawMap has no terrain to show. It
      // fills with the map's ocean colour (screen.setMapColorOcean, or PhySim
      // 1.x's default blue) — a placeholder, but one that keeps the script
      // running and whatever it draws on top of the map visible.
      mapProvider: request => {
        const [r, g, b, a] = request.colors.ocean ?? DEFAULT_OCEAN;
        const pixels = new Uint8Array(request.width * request.height * 4);
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
        }
        return pixels;
      },
      onLog: record => this.deliverLog(record),
      bindings: {
        functions: {
          [`${HOST_NAMESPACE}.screen`]: n => this.hostScreen(toNumber(n)),
          [`${HOST_NAMESPACE}.setScreen`]: (n, size, poweredOn, portrait) => [
            int(this.screens.declareFromScript(Math.round(toNumber(n)), toText(size), poweredOn === true, portrait === true))
          ],
          [`${HOST_NAMESPACE}.phys`]: () => [
            ...this.phys.position, ...this.phys.rotation,
            ...this.phys.velocity, ...this.phys.angularVelocity
          ],
          [`${HOST_NAMESPACE}.tickRate`]: () => [this.tickRate],
          [`${HOST_NAMESPACE}.inputs`]: () => this.heldInputs(),
          // kind 0 = getIsClicked, 1 = getIsToggled, 2 = getSlider
          [`${HOST_NAMESPACE}.control`]: (kind, n) => {
            const number = toNumber(n);
            switch (toNumber(kind)) {
              case 0: return [this.controls.readClicked(number)];
              case 1: return [this.controls.readToggled(number)];
              default: return [this.controls.readSlider(number)];
            }
          },
          [`${HOST_NAMESPACE}.exit`]: () => { this.exitRequested = true; return []; }
        }
      }
    });
  }

  get state(): RunnerState { return this.status; }
  get tickCount(): number { return this.ticks; }
  screenList(): ScreenInfo[] { return this.screens.list(); }

  /** Files executed so far: the entry and everything it required. */
  loadedFiles(): string[] { return Array.from(this.loaded); }

  // --- Inputs from the panel ------------------------------------------------

  setPhysState(state: PhysState): void { this.phys = state; }

  /** Ticks per second the caller is running at; `PhySim:tickRate()` reports it. */
  setTickRate(ticksPerSecond: number): void { this.tickRate = ticksPerSecond; }

  configureScreen(req: ScreenRequest): void { this.screens.configure(req); }
  removeScreen(number: number): void { this.screens.remove(number); }
  setTouch(number: number, touch: TouchState): void { this.screens.setTouch(number, touch); }

  /**
   * Hold a composite input at a value from outside the script, or release it
   * with `null`. It is written every tick before `onLBSimulatorTick`; a channel
   * the script sets itself through `simulator:setInput*` keeps the script's
   * value. A released channel keeps its last value until something writes it.
   */
  holdInputNumber(channel: number, value: number | null): void {
    checkChannel(channel);
    if (value === null) { this.heldNumbers.delete(channel); return; }
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`input ${channel} must be a finite number`);
    this.heldNumbers.set(channel, value);
  }

  holdInputBool(channel: number, value: boolean | null): void {
    checkChannel(channel);
    if (value === null) { this.heldBools.delete(channel); return; }
    if (typeof value !== "boolean") throw new Error(`input ${channel} must be true or false`);
    this.heldBools.set(channel, value);
  }

  /** The held inputs, for reporting. */
  heldInputList(): { numbers: Array<[number, number]>; booleans: Array<[number, boolean]> } {
    return { numbers: Array.from(this.heldNumbers), booleans: Array.from(this.heldBools) };
  }

  /**
   * Set one property between ticks. Unlike a held input this is a single
   * write: a later `simulator:setProperty` for the label replaces it.
   */
  setProperty(label: string, value: PropertyInput): void {
    if (this.status !== "ready") throw new Error(`the runner is ${this.status}, not ready`);
    const entry = propertyEntry(label, value);
    const entries = this.vm.properties().filter(e => labelText(e.label) !== label);
    entries.push(entry);
    this.vm.setProperties(entries);
  }

  /** Every property and its value, as text labels. Text values that are not UTF-8 read lossily. */
  propertyList(): Array<{ label: string; value: PropertyInput }> {
    return this.vm.properties().map(e => ({
      label: labelText(e.label),
      value: e.value.kind === "text" ? decoder.decode(e.value.bytes) : e.value.value
    }));
  }

  /** Press or release one of the simulator's buttons; a press flips its toggle. */
  pressButton(number: number, down: boolean): boolean { return this.controls.press(number, down); }
  /** Press and release at once: exactly the next tick sees the button down. */
  clickButton(number: number): boolean { return this.controls.click(number); }
  setSlider(number: number, value: number): boolean { return this.controls.setSlider(number, value); }
  /** The buttons and sliders the script has read so far, with their state. */
  controlsInfo(): ControlsInfo { return this.controls.info(); }

  // --- Execution ------------------------------------------------------------

  /** Run the prelude and the script's top level. Call once, before the first tick. */
  start(): "completed" | "suspended" {
    if (this.started) throw new Error("the runner has already been started");
    this.requireState("ready");
    this.started = true;
    const entry = this.opts.entry;
    this.queue = [
      { run: () => this.vm.load(PRELUDE_SOURCE, PRELUDE_CHUNK) },
      {
        run: () => {
          this.loaded.add(entry);
          return this.vm.load(this.opts.files.read(entry), chunkName(entry));
        }
      }
    ];
    return this.drain();
  }

  /** One simulator tick: inputs, onTick, then a draw per powered monitor. */
  tick(): "completed" | "suspended" {
    if (!this.started) throw new Error("start() must run before the first tick");
    this.requireState("ready");
    this.ticks++;
    this.queue = [
      { run: () => this.vm.callTick(PRELUDE_TICK, [BigInt(this.ticks)]) },
      {
        run: () => this.vm.tick(),
        // Decided only now: onTick (or onLBSimulatorTick) may have called setScreen.
        done: () => {
          // The tick has had its look at the buttons; a click is not owed to the next one.
          this.controls.endTick();
          for (const s of this.screens.list()) if (s.poweredOn) this.queue.push(this.drawPhase(s.number));
        }
      }
    ];
    return this.drain();
  }

  /** Continue from a breakpoint or step. */
  resume(mode: StepMode = "continue"): "completed" | "suspended" {
    this.requireState("suspended");
    let outcome: Outcome;
    try {
      // The prelude wraps input.* / output.* / screen.* (the phase guard). A
      // step into one of them would stop inside that wrapper, a chunk with no
      // file; step on through it, as a step into the engine's own function would.
      const depth = mode === "into" ? this.vm.stack().length : 0;
      outcome = this.vm.resume(mode);
      for (let i = 0; mode === "into" && outcome === "suspended" && i < 64; i++) {
        const frames = this.vm.stack();
        if (frames.length <= depth || frames[0].source !== PRELUDE_CHUNK) break;
        outcome = this.vm.resume("into");
      }
    } catch (err) {
      this.fail();
      throw err;
    }
    return this.drain(outcome);
  }

  /**
   * Frames that changed since the last call. A monitor whose picture is the
   * same as last tick is left out, so a static screen costs no transfer.
   */
  takeFrames(): ScreenFrame[] {
    const frames = Array.from(this.freshFrames.values());
    this.freshFrames.clear();
    return frames;
  }

  /** The current picture of every powered monitor, for a view opened mid-run. */
  currentFrames(): ScreenFrame[] { return Array.from(this.lastFrames.values()); }

  // --- Debugger -------------------------------------------------------------

  setBreakpoints(points: readonly Breakpoint[]): void { this.vm.setBreakpoints(points); }
  stack(): StackFrame[] { this.requireState("suspended"); return this.vm.stack(); }
  locals(level?: number): Variable[] { this.requireState("suspended"); return this.vm.locals(level); }
  upvalues(level?: number): Variable[] { this.requireState("suspended"); return this.vm.upvalues(level); }
  evaluateWatch(expression: string, level?: number): DebugValue {
    this.requireState("suspended");
    return this.vm.evaluateWatch(expression, level);
  }
  expandTable(handle: DebugHandle, start?: number, limit?: number): TableEntry[] {
    this.requireState("suspended");
    return this.vm.expandTable(handle, start, limit);
  }

  /** Composite I/O, copied: the engine's own views die with its next call. */
  readIo(): { inputNumbers: number[]; inputBooleans: boolean[]; outputNumbers: number[]; outputBooleans: boolean[] } {
    const io = this.vm.io;
    return {
      inputNumbers: Array.from(io.inputNumbers),
      inputBooleans: Array.from(io.inputBooleans, b => b !== 0),
      outputNumbers: Array.from(io.outputNumbers),
      outputBooleans: Array.from(io.outputBooleans, b => b !== 0)
    };
  }

  dispose(): void {
    if (this.status === "disposed") return;
    this.status = "disposed";
    this.queue = [];
    this.vm.dispose();
  }

  // --- Internals ------------------------------------------------------------

  private requireState(expected: RunnerState): void {
    if (this.status !== expected) throw new Error(`the runner is ${this.status}, not ${expected}`);
  }

  private fail(): void {
    this.queue = [];
    this.status = "failed";
  }

  /**
   * Run queued phases until the queue is empty or one suspends. `resumed` is
   * the outcome of a resume() that continued the phase at the head.
   */
  private drain(resumed?: Outcome): "completed" | "suspended" {
    try {
      let outcome = resumed;
      while (this.queue.length > 0) {
        const phase = this.queue[0];
        const result = outcome ?? phase.run();
        outcome = undefined;
        if (result === "suspended") {
          this.status = "suspended";
          return "suspended";
        }
        this.queue.shift();
        phase.done?.(result);
        if (this.exitRequested) {
          this.queue = [];
          this.status = "exited";
          return "completed";
        }
      }
    } catch (err) {
      this.fail();
      throw err;
    }
    this.status = "ready";
    return "completed";
  }

  private drawPhase(number: number): Phase {
    // Size is read when the phase runs and again when it completes: a
    // breakpoint inside onDraw can sit there while the panel resizes the monitor.
    let drawn: ScreenInfo | undefined;
    return {
      run: () => {
        drawn = this.screens.get(number);
        if (!drawn || !drawn.poweredOn) return "missing";
        return this.vm.draw(drawn.width, drawn.height);
      },
      done: outcome => {
        if (!drawn || !drawn.poweredOn) return;
        const { width, height } = drawn;
        // No onDraw: a powered monitor with nothing drawn on it is blank, not stale.
        const pixels = outcome === "completed" ? this.vm.frame().copy() : new Uint8Array(width * height * 4);
        const last = this.lastFrames.get(number);
        if (last && last.width === width && last.height === height && sameBytes(last.pixels, pixels)) return;
        const frame: ScreenFrame = { screen: number, width, height, pixels };
        this.lastFrames.set(number, frame);
        this.freshFrames.set(number, frame);
      }
    };
  }

  private loadModule(name: string): { source: Uint8Array; name: string } {
    const file = this.roots.resolve(name);
    if (!file) throw new Error(`Could not find require: ${name}`);
    this.loaded.add(file);
    return { source: this.opts.files.read(file), name: chunkName(file) };
  }

  private hostScreen(number: number): LuaValue[] {
    const s = this.screens.get(number);
    const t = this.screens.touch(number);
    // A monitor that doesn't exist reads as LifeBoatAPI's fresh SimulatorScreen
    // does: powered, 32x32, untouched.
    return [
      s ? s.poweredOn : true, s ? s.portrait : false,
      int(s ? s.width : 32), int(s ? s.height : 32),
      t.isTouched, t.isTouchedAlt, int(t.x), int(t.y), int(t.xAlt), int(t.yAlt)
    ];
  }

  private heldInputs(): LuaValue[] {
    const out: LuaValue[] = [];
    for (const [channel, value] of this.heldNumbers) out.push(false, BigInt(channel), value);
    for (const [channel, value] of this.heldBools) out.push(true, BigInt(channel), value);
    return out;
  }

  private deliverLog(record: LogRecord): void {
    this.opts.onLog?.({
      source: record.source,
      text: decoder.decode(record.bytes),
      chunk: record.location?.chunk,
      line: record.location?.line
    });
  }
}

function checkChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 1 || channel > IO_CHANNELS) {
    throw new Error(`input channel must be a whole number from 1 to ${IO_CHANNELS}, got ${String(channel)}`);
  }
}

function labelText(label: string | Uint8Array): string {
  return typeof label === "string" ? label : decoder.decode(label);
}

function propertyEntry(label: string, value: PropertyInput): PropertyEntry {
  if (typeof label !== "string" || label === "") throw new Error("a property label must be a non-empty string");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`property ${label} must be a finite number`);
    return { label, value: { kind: "number", value } };
  }
  if (typeof value === "boolean") return { label, value: { kind: "bool", value } };
  if (typeof value === "string") return { label, value: { kind: "text", bytes: new TextEncoder().encode(value) } };
  throw new Error(`property ${label} must be a number, a boolean or a string`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length
    && Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}
