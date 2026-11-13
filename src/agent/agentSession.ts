// What the AI tools drive: one script on the engine, advanced a tick at a time
// on request. No timer, no worker thread, no vscode — the caller says "run 60
// ticks" and gets back what happened.
//
// This is the panel's run (simulation.ts, worker.ts) with the clock taken out.
// An agent's turn takes seconds, so real time means nothing to it; stepping
// instead makes every run repeatable — the same calls give the same pixels —
// which is what lets an agent tell whether its edit changed anything.
//
// Like the panel, some state outlives a run: the pose, and the named monitor
// snapshots (taken before an edit, compared after the script is run again).
// Held inputs and the monitor layout belong to a run and start afresh with it.

import type { LuaEngine } from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };
import { PhysState, ZERO_STATE } from "../engine/physState";
import { VehicleRunner, RunnerFiles, PropertyInput } from "../engine/runner";
import { ScreenInfo, ScreenRequest, TouchState, NO_TOUCH } from "../engine/screens";
import { chunkFile } from "../engine/sourceRoots";
import { ControlsInfo, NO_CONTROLS, MAX_CONTROLS, controlNumber } from "../engine/controls";
import { Acceleration, NO_ACCELERATION, integrateTick } from "./motion";
import type { Picture } from "./pixels";

/** Ticks one step request may run: ten minutes of game time. */
export const MAX_STEP_TICKS = 36_000;
/** Wall-clock bound on one step request; it returns early with the ticks it managed. */
export const STEP_TIME_LIMIT_MS = 20_000;
/** Log lines kept; older ones are dropped and counted. */
export const MAX_LOG_LINES = 2000;
/** Characters kept of one log line. */
export const MAX_LOG_TEXT = 2000;
export const MAX_SNAPSHOTS = 32;

export interface AgentLogLine {
  /** Counts every line since the server started; a cursor for "what is new". */
  seq: number;
  /** The tick the line was printed in; 0 is the script's top level. */
  tick: number;
  source: "print" | "debug.log";
  text: string;
  file?: string;
  line?: number;
}

/**
 * none     no script has been started
 * running  between ticks, ready for the next step
 * exited   the script called simulator:exit()
 * failed   a Lua error (or an engine limit) ended the run
 */
export type RunStatus = "none" | "running" | "exited" | "failed";

export interface StartRequest {
  /** Absolute path of the script. */
  entry: string;
  /** Directories `require` searches, in precedence order. */
  roots: readonly string[];
  /** Monitors on top of the default 3x3 screen 1; the script's setScreen calls land on top of these. */
  screens?: readonly ScreenRequest[];
  properties?: Readonly<Record<string, PropertyInput>>;
}

export interface StepRequest {
  ticks: number;
  /**
   * hold       the pose stays as set
   * integrate  the pose advances every tick by its velocities, as the panel's Simulate does
   */
  motion: "hold" | "integrate";
  acceleration?: Acceleration;
}

export interface StepResult {
  /** Ticks actually run by this request. */
  ticksRun: number;
  /** Why it returned: all ticks done, the run ended, or the time limit. */
  stopped: "done" | "exited" | "failed" | "time-limit";
}

export interface Io {
  inputNumbers: number[];
  inputBooleans: boolean[];
  outputNumbers: number[];
  outputBooleans: boolean[];
}

function checkControl(number: number): number {
  const n = controlNumber(number);
  if (n === null) throw new Error(`a button or slider number must be a whole number from 1 to ${MAX_CONTROLS}, got ${String(number)}`);
  return n;
}

function isFinitePose(p: PhysState): boolean {
  return [p.position, p.rotation, p.velocity, p.angularVelocity].every(t => t.every(Number.isFinite));
}

const EMPTY_IO: Io = { inputNumbers: [], inputBooleans: [], outputNumbers: [], outputBooleans: [] };

export class AgentSession {
  private runner: VehicleRunner | null = null;
  private status: RunStatus = "none";
  private entry: string | null = null;
  private error: string | null = null;
  private pose: PhysState = ZERO_STATE;
  private logs: AgentLogLine[] = [];
  private logSeq = 0;
  /** Pictures as they were when the current step request began, for "what did this step change". */
  private before = new Map<number, Picture>();
  private snapshots = new Map<string, Map<number, Picture>>();
  /** Kept from a run that has ended, so its last pictures and I/O stay readable. */
  private lastScreens: ScreenInfo[] = [];
  private lastIo: Io = EMPTY_IO;
  private lastTicks = 0;

  constructor(
    private readonly engine: LuaEngine,
    private readonly files: RunnerFiles,
    /** Milliseconds, monotonic; replaceable so the tests can run the time limit down. */
    private readonly now: () => number = () => performance.now()
  ) {}

  // --- Run ------------------------------------------------------------------

  getStatus(): RunStatus { return this.status; }
  getEntry(): string | null { return this.entry; }
  /** The Lua error that ended the run, with its traceback; null unless failed. */
  getError(): string | null { return this.error; }
  /** Ticks run since the script started. */
  getTicks(): number { return this.runner ? this.runner.tickCount : this.lastTicks; }

  /**
   * Start a script, replacing any run in progress. Runs its top level; a Lua
   * error there leaves the session `failed`, not thrown — an error in the
   * script is a result for the agent to read, not a fault of the request.
   */
  start(request: StartRequest): void {
    this.stop();
    // Built before anything is recorded: if the engine refuses the options, the
    // session is left with no run rather than half of one.
    const runner = new VehicleRunner(this.engine, {
      entry: request.entry,
      roots: request.roots,
      files: this.files,
      screens: request.screens,
      properties: request.properties,
      onLog: line => this.addLog({
        source: line.source,
        text: line.text,
        file: line.chunk === undefined ? undefined : chunkFile(line.chunk) ?? undefined,
        line: line.line
      })
    });
    this.runner = runner;
    this.entry = request.entry;
    this.status = "running";
    runner.setPhysState(this.pose);
    try {
      runner.start();
      this.afterRun();
    } catch (err) {
      this.failed(err);
    }
  }

  /** End the run. The pose and the snapshots stay; the pictures do not. */
  stop(): void {
    this.runner?.dispose();
    this.runner = null;
    this.status = "none";
    this.entry = null;
    this.error = null;
    this.before.clear();
    this.lastScreens = [];
    this.lastIo = EMPTY_IO;
    this.lastTicks = 0;
  }

  dispose(): void { this.stop(); this.snapshots.clear(); }

  step(request: StepRequest): StepResult {
    const runner = this.live();
    const ticks = request.ticks;
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_STEP_TICKS) {
      throw new Error(`ticks must be a whole number from 1 to ${MAX_STEP_TICKS}`);
    }
    const acceleration = request.acceleration ?? NO_ACCELERATION;
    return this.advance(ticks, done => {
      if (request.motion === "integrate") {
        const next = integrateTick(this.pose, acceleration);
        // Each input was finite, but a sum can still overflow. The script must
        // not be fed Infinity, and a pose of nulls is no answer to give.
        if (!isFinitePose(next)) {
          throw new Error(
            `the pose overflowed while integrating tick ${done + 1} of this step (${done} ran); ` +
            "the pose is left as it was before that tick. Set a smaller velocity or acceleration."
          );
        }
        this.pose = next;
      }
      runner.setPhysState(this.pose);
    });
  }

  /** One tick per pose, in order. Returns early like `step` when the run ends. */
  play(states: readonly PhysState[]): StepResult {
    const runner = this.live();
    if (states.length < 1) throw new Error("the scenario has no poses");
    let i = 0;
    for (const [n, s] of states.entries()) {
      if (!isFinitePose(s)) throw new Error(`pose ${n + 1} of the scenario is not finite`);
    }
    return this.advance(states.length, () => {
      this.pose = states[i++];
      runner.setPhysState(this.pose);
    });
  }

  /** `beforeTick` gets the ticks run so far; if it throws, that tick does not run and the error is the request's. */
  private advance(ticks: number, beforeTick: (done: number) => void): StepResult {
    const runner = this.live();
    this.before = this.pictures();
    const deadline = this.now() + STEP_TIME_LIMIT_MS;
    let ticksRun = 0;
    while (ticksRun < ticks) {
      // Checked before the tick, and not on the first: a request always makes progress.
      if (ticksRun > 0 && this.now() >= deadline) return { ticksRun, stopped: "time-limit" };
      beforeTick(ticksRun);
      try {
        runner.tick();
      } catch (err) {
        // The tick that failed did start, and whatever it printed is in the log under its number.
        this.failed(err);
        return { ticksRun: ticksRun + 1, stopped: "failed" };
      }
      ticksRun++;
      this.afterRun();
      if (this.status === "exited") return { ticksRun, stopped: "exited" };
    }
    return { ticksRun, stopped: "done" };
  }

  // --- Pose -----------------------------------------------------------------

  getPose(): PhysState { return this.pose; }

  /** The script reads it on its next tick. Kept across runs, like the panel's gizmo. */
  setPose(pose: PhysState): void {
    if (!isFinitePose(pose)) throw new Error("every value of the pose must be a finite number");
    this.pose = pose;
    if (this.status === "running") this.runner?.setPhysState(pose);
  }

  // --- Inputs ---------------------------------------------------------------

  holdInputNumber(channel: number, value: number | null): void { this.live().holdInputNumber(channel, value); }
  holdInputBool(channel: number, value: boolean | null): void { this.live().holdInputBool(channel, value); }
  heldInputs(): { numbers: Array<[number, number]>; booleans: Array<[number, boolean]> } {
    return this.runner && this.status === "running" ? this.runner.heldInputList() : { numbers: [], booleans: [] };
  }

  // --- The simulator's buttons and sliders ------------------------------------

  /** Hold a button down, or let it go. A press flips the button's toggle. */
  pressButton(number: number, down: boolean): void { this.live().pressButton(checkControl(number), down); }
  /** Press and release at once: exactly the next tick sees the button down. */
  clickButton(number: number): void { this.live().clickButton(checkControl(number)); }
  setSlider(number: number, value: number): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`slider ${number} must be a number from 0 to 1`);
    }
    this.live().setSlider(checkControl(number), value);
  }
  /** The buttons and sliders the script has read so far, with their state. */
  controls(): ControlsInfo {
    return this.runner && this.status === "running" ? this.runner.controlsInfo() : NO_CONTROLS;
  }

  setProperty(label: string, value: PropertyInput): void { this.live().setProperty(label, value); }
  properties(): Array<{ label: string; value: PropertyInput }> { return this.live().propertyList(); }

  /** Composite I/O as of the last tick; of a run that has ended, as it ended. */
  io(): Io { return this.lastIo; }

  // --- Monitors ---------------------------------------------------------------

  screens(): ScreenInfo[] { return this.lastScreens; }

  configureScreen(request: ScreenRequest): void {
    const runner = this.live();
    runner.configureScreen(request);
    this.lastScreens = runner.screenList();
  }

  removeScreen(number: number): void {
    const runner = this.live();
    runner.removeScreen(number);
    this.lastScreens = runner.screenList();
  }

  /** Press (or with `null`, release) a monitor. The script sees it from its next tick. */
  setTouch(number: number, touch: { x: number; y: number } | null): void {
    const runner = this.live();
    const screen = runner.screenList().find(s => s.number === number);
    if (!screen) throw new Error(`there is no monitor ${number}`);
    if (!touch) { runner.setTouch(number, NO_TOUCH); return; }
    if (!screen.poweredOn) throw new Error(`monitor ${number} is powered off`);
    const x = Math.round(touch.x), y = Math.round(touch.y);
    if (!(x >= 0 && x < screen.width && y >= 0 && y < screen.height)) {
      throw new Error(`the touch (${touch.x}, ${touch.y}) is outside monitor ${number} (${screen.width}x${screen.height})`);
    }
    const state: TouchState = { ...NO_TOUCH, isTouched: true, x, y };
    runner.setTouch(number, state);
  }

  /**
   * The current picture of each powered monitor. Empty before the first tick:
   * a monitor is drawn by `onDraw`, which runs with a tick.
   */
  pictures(): Map<number, Picture> {
    const out = new Map<number, Picture>();
    if (!this.runner) return out;
    for (const f of this.runner.currentFrames()) out.set(f.screen, f);
    return out;
  }

  picture(number: number): Picture {
    const p = this.pictures().get(number);
    if (p) return p;
    if (this.status === "none") throw new Error("no script is running");
    const screen = this.lastScreens.find(s => s.number === number);
    if (!screen) throw new Error(`there is no monitor ${number}`);
    if (!screen.poweredOn) throw new Error(`monitor ${number} is powered off, so it has no picture`);
    throw new Error(`monitor ${number} has no picture yet: nothing is drawn until the first tick`);
  }

  /** The picture `number` had when the latest step (or scenario) request began, if it had one. */
  pictureBeforeStep(number: number): Picture | undefined { return this.before.get(number); }

  // --- Snapshots --------------------------------------------------------------

  /** Remember every monitor's picture under a name. Survives a restart of the script. */
  saveSnapshot(name: string): number[] {
    if (!this.snapshots.has(name) && this.snapshots.size >= MAX_SNAPSHOTS) {
      throw new Error(`at most ${MAX_SNAPSHOTS} snapshots are kept; delete one first`);
    }
    const pictures = this.pictures();
    if (pictures.size === 0) throw new Error("there is no picture to save: no monitor has been drawn yet");
    // The runner replaces a frame's buffer rather than writing into it, so the
    // pictures can be kept as they are.
    this.snapshots.set(name, pictures);
    return Array.from(pictures.keys()).sort((a, b) => a - b);
  }

  snapshot(name: string, number: number): Picture {
    const snap = this.snapshots.get(name);
    if (!snap) throw new Error(`there is no snapshot named "${name}"`);
    const p = snap.get(number);
    if (!p) throw new Error(`snapshot "${name}" has no picture of monitor ${number}`);
    return p;
  }

  deleteSnapshot(name: string): boolean { return this.snapshots.delete(name); }

  snapshotList(): Array<{ name: string; monitors: number[] }> {
    return Array.from(this.snapshots, ([name, pictures]) => ({
      name, monitors: Array.from(pictures.keys()).sort((a, b) => a - b)
    }));
  }

  // --- Logs -------------------------------------------------------------------

  /** The sequence number the next log line will get. */
  logCursor(): number { return this.logSeq; }

  /**
   * Lines with `seq >= since`, oldest first, at most `limit`. `dropped` counts
   * lines in that range that are no longer kept.
   */
  logsSince(since: number, limit: number): { lines: AgentLogLine[]; dropped: number; more: number } {
    const oldest = this.logs.length > 0 ? this.logs[0].seq : this.logSeq;
    const dropped = Math.max(0, Math.min(oldest, this.logSeq) - Math.max(0, since));
    const wanted = this.logs.filter(l => l.seq >= since);
    return { lines: wanted.slice(0, limit), dropped, more: Math.max(0, wanted.length - limit) };
  }

  // --- Internals ---------------------------------------------------------------

  /** The runner of a run that can still be stepped, or a message saying why there is none. */
  private live(): VehicleRunner {
    if (this.runner && this.status === "running") return this.runner;
    if (this.status === "failed") throw new Error("the script stopped with an error; start it again");
    if (this.status === "exited") throw new Error("the script called simulator:exit(); start it again");
    throw new Error("no script is running; start one first");
  }

  private afterRun(): void {
    const runner = this.runner;
    if (!runner) return;
    this.lastScreens = runner.screenList();
    this.lastIo = runner.readIo();
    this.lastTicks = runner.tickCount;
    if (runner.state === "exited") this.status = "exited";
  }

  private failed(err: unknown): void {
    this.status = "failed";
    this.error = err instanceof Error ? err.message : String(err);
    const runner = this.runner;
    if (!runner) return;
    this.lastScreens = runner.screenList();
    this.lastTicks = runner.tickCount;
    // The VM is still there after a Lua error; what the script had written to
    // its outputs before failing is worth reading.
    try { this.lastIo = runner.readIo(); } catch { /* keep the previous tick's */ }
  }

  private addLog(line: Omit<AgentLogLine, "seq" | "tick">): void {
    const text = line.text.length > MAX_LOG_TEXT
      ? `${line.text.slice(0, MAX_LOG_TEXT)}… (${line.text.length - MAX_LOG_TEXT} more characters)`
      : line.text;
    this.logs.push({ ...line, text, seq: this.logSeq++, tick: this.runner?.tickCount ?? 0 });
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }
}
