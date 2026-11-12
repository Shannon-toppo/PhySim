// The extension host's handle on one script run. Owns the worker thread;
// everything the rest of the extension knows about the engine goes through
// here. No vscode import, so the tests run a real worker in plain Node.
//
// A session is one run. To run again — or to run another script — dispose it
// and create a new one: a fresh worker is a fresh VM, with nothing left over
// from a script that failed or was stopped at a breakpoint.

import { Worker } from "worker_threads";
import * as path from "path";
import type { FromWorker, ToWorker, Requests, RequestName, StartOptions } from "./protocol";
import type { PhysState } from "./physState";
import type { LogLine, ScreenFrame } from "./runner";
import type { ScreenInfo, ScreenRequest, TouchState } from "./screens";
import type { ControlsInfo } from "./controls";

export interface SessionEvents {
  started?(files: string[]): void;
  screens?(screens: ScreenInfo[]): void;
  frames?(frames: ScreenFrame[]): void;
  controls?(controls: ControlsInfo): void;
  log?(line: LogLine): void;
  stopped?(reason: "breakpoint" | "step"): void;
  continued?(): void;
  /** The run is over. `crash` is the worker itself dying, as opposed to a Lua error. */
  ended?(reason: "error" | "exit" | "crash", message?: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

export class EngineSession {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private over = false;
  private screens: ScreenInfo[] = [];

  constructor(options: StartOptions, private readonly events: SessionEvents) {
    this.worker = new Worker(path.join(__dirname, "worker.js"));
    this.worker.on("message", (msg: FromWorker) => this.onMessage(msg));
    this.worker.on("error", err => this.finish("crash", err.message));
    this.worker.on("exit", code => {
      if (!this.over) this.finish("crash", `the engine worker exited with code ${code}`);
    });
    this.send({ type: "start", options });
  }

  /** False once the run has ended, for whatever reason. */
  isRunning(): boolean { return !this.over; }

  /** The monitors as last reported by the run. */
  getScreens(): ScreenInfo[] { return this.screens; }

  setPhysState(state: PhysState): void { this.send({ type: "phys", state }); }
  setTouch(screen: number, touch: TouchState): void { this.send({ type: "touch", screen, touch }); }
  configureScreen(request: ScreenRequest): void { this.send({ type: "screenSet", request }); }
  removeScreen(screen: number): void { this.send({ type: "screenRemove", screen }); }
  setTimeScale(scale: number): void { this.send({ type: "timeScale", scale }); }
  setButton(number: number, pressed: boolean): void { this.send({ type: "button", number, pressed }); }
  setSlider(number: number, value: number): void { this.send({ type: "slider", number, value }); }
  /** Ask for the monitor layout and every current frame again. */
  replay(): void { this.send({ type: "replay" }); }

  request<K extends RequestName>(name: K, args: Requests[K]["args"]): Promise<Requests[K]["result"]> {
    if (this.over) return Promise.reject(new Error("the script is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ type: "request", id, name, args } satisfies ToWorker);
    });
  }

  /** Stop the run. Safe to call more than once; no `ended` event follows. */
  async dispose(): Promise<void> {
    if (!this.over) {
      this.over = true;
      this.rejectPending("the script was stopped");
    }
    await this.worker.terminate();
  }

  private send(msg: ToWorker): void {
    if (!this.over) this.worker.postMessage(msg);
  }

  private onMessage(msg: FromWorker): void {
    if (this.over) return;
    switch (msg.type) {
      case "started": this.events.started?.(msg.files); return;
      case "screens": this.screens = msg.screens; this.events.screens?.(msg.screens); return;
      case "frames": this.events.frames?.(msg.frames); return;
      case "controls": this.events.controls?.(msg.controls); return;
      case "log": this.events.log?.(msg.line); return;
      case "stopped": this.events.stopped?.(msg.reason); return;
      case "continued": this.events.continued?.(); return;
      case "ended": this.finish(msg.reason, msg.message); return;
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
        return;
      }
    }
  }

  private finish(reason: "error" | "exit" | "crash", message?: string): void {
    if (this.over) return;
    this.over = true;
    this.rejectPending(message ?? "the script ended");
    void this.worker.terminate();
    this.events.ended?.(reason, message);
  }

  private rejectPending(why: string): void {
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }
}
