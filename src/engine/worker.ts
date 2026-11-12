// The engine worker: one script run, ticked at 60 Hz times the panel's speed.
//
// Lua runs here rather than in the extension host so a heavy script cannot
// stall the host, which every other extension shares. This file is transport
// and timing only — what a tick is lives in runner.ts.

import { parentPort } from "worker_threads";
import { readFileSync, statSync } from "fs";
import { loadEngine } from "./loadEngine";
import { VehicleRunner } from "./runner";
import { sanitizeTimeScale, TICKS_PER_SEC } from "./physState";
import type { FromWorker, ToWorker, Requests, RequestName } from "./protocol";

if (!parentPort) throw new Error("engine/worker must be started as a worker thread");
const port = parentPort;

const TICK_MS = 1000 / TICKS_PER_SEC;
/**
 * Ticks run back to back to catch up after the thread was busy. Beyond this
 * the backlog is dropped: a script too slow for real time should run slow,
 * not fall ever further behind and freeze the monitors.
 */
const MAX_CATCH_UP = 4;

let runner: VehicleRunner | null = null;
/**
 * Messages that arrived while the engine was still loading. The panel does
 * not wait for a run to be ready — the gizmo moves, the speed changes — and
 * dropping those would start the script on stale state. Null once the runner
 * exists (or the start failed) and messages are handled as they come.
 */
let early: ToWorker[] | null = [];
let timeScale = 1;
let timer: NodeJS.Timeout | null = null;
/** Simulated milliseconds owed, and when it was last topped up. */
let owed = 0;
let lastTime = 0;

function post(msg: FromWorker): void { port.postMessage(msg); }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(delayMs: number): void {
  stopTimer();
  timer = setTimeout(loop, Math.max(0, delayMs));
}

function resumeTicking(): void {
  owed = 0;
  lastTime = performance.now();
  schedule(TICK_MS / timeScale);
}

function end(reason: "error" | "exit", message?: string): void {
  stopTimer();
  postFrames();
  post({ type: "ended", reason, message });
}

function postFrames(): void {
  const frames = runner?.takeFrames() ?? [];
  if (frames.length > 0) post({ type: "frames", frames });
}

/**
 * What to do after start/tick/resume returned. True when ticking may go on.
 */
function settle(outcome: "completed" | "suspended", reason: "breakpoint" | "step"): boolean {
  if (!runner) return false;
  postFrames();
  if (outcome === "suspended") {
    stopTimer();
    post({ type: "stopped", reason });
    return false;
  }
  if (runner.state === "exited") {
    end("exit");
    return false;
  }
  return true;
}

function loop(): void {
  timer = null;
  if (!runner || runner.state !== "ready") return;
  const now = performance.now();
  owed += (now - lastTime) * timeScale;
  lastTime = now;
  let steps = 0;
  try {
    while (owed >= TICK_MS && steps < MAX_CATCH_UP) {
      owed -= TICK_MS;
      steps++;
      if (!settle(runner.tick(), "breakpoint")) return;
    }
  } catch (err) {
    end("error", errorText(err));
    return;
  }
  if (owed >= TICK_MS) owed = 0;
  schedule((TICK_MS - owed) / timeScale);
}

async function start(msg: Extract<ToWorker, { type: "start" }>): Promise<void> {
  const { options } = msg;
  try {
    const engine = await loadEngine();
    timeScale = sanitizeTimeScale(options.timeScale);
    runner = new VehicleRunner(engine, {
      entry: options.entry,
      roots: options.roots,
      screens: options.screens,
      files: {
        isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
        read: f => readFileSync(f)
      },
      onLog: line => post({ type: "log", line }),
      onScreens: screens => post({ type: "screens", screens }),
      sliders: options.sliders,
      onControls: controls => post({ type: "controls", controls })
    });
    runner.setPhysState(options.phys);
    runner.setTickRate(TICKS_PER_SEC * timeScale);
    runner.setBreakpoints(options.breakpoints);
    // Before the script's top level runs, so its first tick sees them.
    const queued = early ?? [];
    early = null;
    for (const m of queued) handle(m);
    post({ type: "screens", screens: runner.screenList() });
    const outcome = runner.start();
    post({ type: "started", files: runner.loadedFiles() });
    if (settle(outcome, "breakpoint")) resumeTicking();
  } catch (err) {
    early = null;
    end("error", errorText(err));
  }
}

const handlers: { [K in RequestName]: (r: VehicleRunner, args: Requests[K]["args"]) => Requests[K]["result"] } = {
  setBreakpoints: (r, a) => r.setBreakpoints(a.points),
  resume: (r, a) => {
    post({ type: "continued" });
    // Reply first: the stop this resume may run into is an event, not this
    // request's answer. A Lua error raised while resuming ends the run instead.
    queueMicrotask(() => {
      try {
        const reason = a.mode === "continue" ? "breakpoint" : "step";
        if (settle(r.resume(a.mode), reason)) resumeTicking();
      } catch (err) {
        end("error", errorText(err));
      }
    });
  },
  stack: r => r.stack(),
  locals: (r, a) => r.locals(a.level),
  upvalues: (r, a) => r.upvalues(a.level),
  evaluate: (r, a) => r.evaluateWatch(a.expression, a.level),
  expand: (r, a) => r.expandTable(a.handle, a.start, a.limit),
  io: r => r.readIo()
};

port.on("message", (msg: ToWorker) => {
  if (msg.type === "start") {
    void start(msg);
    return;
  }
  if (early) early.push(msg); else handle(msg);
});

function handle(msg: ToWorker): void {
  switch (msg.type) {
    case "start":
      return;
    case "phys":
      runner?.setPhysState(msg.state);
      return;
    case "touch":
      runner?.setTouch(msg.screen, msg.touch);
      return;
    case "screenSet":
      runner?.configureScreen(msg.request);
      return;
    case "screenRemove":
      runner?.removeScreen(msg.screen);
      return;
    case "timeScale":
      timeScale = sanitizeTimeScale(msg.scale);
      runner?.setTickRate(TICKS_PER_SEC * timeScale);
      return;
    case "button":
      runner?.pressButton(msg.number, msg.pressed);
      return;
    case "slider":
      runner?.setSlider(msg.number, msg.value);
      return;
    case "replay":
      if (!runner) return;
      post({ type: "screens", screens: runner.screenList() });
      post({ type: "controls", controls: runner.controlsInfo() });
      post({ type: "frames", frames: runner.currentFrames() });
      return;
    case "request": {
      if (!runner) {
        post({ type: "response", id: msg.id, ok: false, error: "no script is running" });
        return;
      }
      try {
        const handler = handlers[msg.name] as (r: VehicleRunner, args: unknown) => unknown;
        post({ type: "response", id: msg.id, ok: true, result: handler(runner, msg.args) });
      } catch (err) {
        post({ type: "response", id: msg.id, ok: false, error: errorText(err) });
      }
      return;
    }
  }
}
