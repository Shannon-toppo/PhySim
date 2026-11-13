// What the panel talks to: the current script run, if there is one, plus the
// state that outlives any run — the panel's monitor layout, the gizmo's pose
// and the speed. No vscode import, so the tests can drive it in plain Node.
//
// A run comes and goes (PhySim: Run, a Lua error, Stop); the panel stays open
// across them. Everything the panel sets is therefore remembered here and
// handed to each new run as it starts, so a script launched after the gizmo
// was moved sees the pose from its first tick.

import type { Breakpoint } from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };
import { EngineSession } from "./engine/session";
import { PhysState, ZERO_STATE, sanitizeTimeScale } from "./engine/physState";
import type { LogLine, ScreenFrame } from "./engine/runner";
import { ScreenInfo, ScreenRequest, TouchState, sanitizeScreenRequest } from "./engine/screens";
import { ControlsInfo, NO_CONTROLS, controlNumber, sliderValue } from "./engine/controls";

export interface RunRequest {
  /** Absolute path of the script to run. */
  entry: string;
  /** Directories `require` searches, in precedence order. */
  roots: string[];
  breakpoints?: Breakpoint[];
}

export type EndReason = "error" | "exit" | "crash" | "stopped";

export class Simulation {
  private session: EngineSession | null = null;
  private wanted = new Map<number, ScreenRequest>();
  private phys: PhysState = ZERO_STATE;
  private timeScale = 1;
  private screens: ScreenInfo[] = [];
  /** Latest picture per monitor, for a webview opened or re-shown mid-run. */
  private frames = new Map<number, ScreenFrame>();
  /**
   * What an AI agent's own run looks like, as its MCP server reports it
   * (mirrorServer.ts). It is somebody else's run: nothing here can touch it.
   * It is shown only while this window has no run of its own.
   */
  private mirror: { screens: ScreenInfo[]; frames: Map<number, ScreenFrame>; controls: ControlsInfo } | null = null;
  private showingMirror = false;

  /** Where the panel's sliders stand. Kept across runs, like the pose: a slider stays where it was left. */
  private sliders = new Map<number, number>();
  /** The buttons and sliders the current run's script reads. */
  private controls: ControlsInfo = NO_CONTROLS;
  /** What onControls last reported, so that it speaks only when the controls on show really change. */
  private controlsShown = JSON.stringify(NO_CONTROLS);

  /** The script read a button or slider it had not read before, or the run that used them is gone. */
  onControls: ((controls: ControlsInfo) => void) | null = null;
  /** The monitor set changed (a run started, setScreen, the panel's controls). */
  onScreenConfig: ((screens: ScreenInfo[]) => void) | null = null;
  /** Monitors whose picture changed. */
  onFrames: ((frames: ScreenFrame[]) => void) | null = null;
  onLog: ((line: LogLine) => void) | null = null;
  /** The script's top level finished and ticking began. */
  onStarted: ((entry: string, files: string[]) => void) | null = null;
  /** The run is over. Not fired for a run replaced by the next start(). */
  onEnded: ((reason: EndReason, message?: string) => void) | null = null;
  onStopped: ((reason: "breakpoint" | "step") => void) | null = null;
  onContinued: (() => void) | null = null;

  isRunning(): boolean { return this.session !== null; }

  /** The live run, for the debugger's requests. */
  current(): EngineSession | null { return this.session; }

  /** Start a run, replacing any run in progress. */
  async start(request: RunRequest): Promise<void> {
    await this.dispose();
    this.screens = [];
    this.frames.clear();
    // The user's own run always has the panel; the events that follow replace the agent's pictures.
    this.showingMirror = false;
    this.setControls(NO_CONTROLS);
    const session = new EngineSession(
      {
        entry: request.entry,
        roots: request.roots,
        screens: this.getWantedScreens(),
        timeScale: this.timeScale,
        phys: this.phys,
        sliders: Array.from(this.sliders),
        breakpoints: request.breakpoints ?? []
      },
      {
        // Each handler checks it still belongs to the current run: a message
        // already in flight from a replaced worker must not repaint the panel.
        started: files => { if (this.session === session) this.onStarted?.(request.entry, files); },
        screens: screens => {
          if (this.session !== session) return;
          this.screens = screens;
          for (const n of this.frames.keys()) {
            if (!screens.some(s => s.number === n && s.poweredOn)) this.frames.delete(n);
          }
          this.onScreenConfig?.(screens);
        },
        frames: frames => {
          if (this.session !== session) return;
          for (const f of frames) this.frames.set(f.screen, f);
          this.onFrames?.(frames);
        },
        controls: controls => { if (this.session === session) this.setControls(controls); },
        log: line => { if (this.session === session) this.onLog?.(line); },
        stopped: reason => { if (this.session === session) this.onStopped?.(reason); },
        continued: () => { if (this.session === session) this.onContinued?.(); },
        ended: (reason, message) => {
          if (this.session !== session) return;
          // The monitors keep their last picture: what the script had drawn
          // when it failed is usually the thing worth looking at.
          this.session = null;
          // Nothing reads the buttons any more; left on screen they would look alive.
          this.setControls(NO_CONTROLS);
          this.onEnded?.(reason, message);
        }
      }
    );
    this.session = session;
  }

  /** Stop the run, if any, and blank the monitors. */
  async stop(): Promise<void> {
    if (!this.session) return;
    await this.dispose();
    this.screens = [];
    this.frames.clear();
    this.setControls(NO_CONTROLS);
    this.onScreenConfig?.([]);
    this.onEnded?.("stopped");
    // The panel is free again: an agent's run that was hidden behind this one comes back.
    this.presentMirror();
  }

  /** Tear down without events — extension shutdown, or just before a restart. */
  async dispose(): Promise<void> {
    const old = this.session;
    this.session = null;
    if (old) await old.dispose();
  }

  // --- Panel state ----------------------------------------------------------

  setPhysState(state: PhysState): void {
    this.phys = state;
    this.session?.setPhysState(state);
  }

  getTimeScale(): number { return this.timeScale; }

  setTimeScale(scale: unknown): void {
    const s = sanitizeTimeScale(scale);
    if (s === this.timeScale) return;
    this.timeScale = s;
    this.session?.setTimeScale(s);
  }

  setTouch(screen: number, touch: TouchState): void {
    this.session?.setTouch(screen, touch);
  }

  // --- Buttons and sliders ----------------------------------------------------

  /**
   * The buttons and sliders on show: the running script's, or those of an
   * agent's run being mirrored (which this window can look at but not work).
   */
  getControls(): ControlsInfo { return this.showingMirror && this.mirror ? this.mirror.controls : this.controls; }

  /** A button of the panel went down or came up. Ignored unless it is a control number. */
  setButton(number: unknown, pressed: boolean): void {
    const n = controlNumber(number);
    if (n !== null) this.session?.setButton(n, pressed);
  }

  /** A slider of the panel moved. Remembered for the next run too. */
  setSlider(number: unknown, value: unknown): void {
    const n = controlNumber(number), v = sliderValue(value);
    if (n === null || v === null) return;
    this.sliders.set(n, v);
    this.session?.setSlider(n, v);
  }

  private setControls(controls: ControlsInfo): void {
    this.controls = controls;
    this.syncControls();
  }

  /** Tell the panel the controls on show, if they are not what it was last told. */
  private syncControls(): void {
    const controls = this.getControls();
    const key = JSON.stringify(controls);
    if (key === this.controlsShown) return;
    this.controlsShown = key;
    this.onControls?.(controls);
  }

  // --- Monitors ---------------------------------------------------------------

  /** The monitors on show: the current (or last) run's, or an agent's. Empty before the first run and after Stop. */
  getScreens(): ScreenInfo[] { return this.showingMirror && this.mirror ? this.mirror.screens : this.screens; }

  /** The current picture of each monitor that has one. */
  getFrames(): ScreenFrame[] {
    return Array.from((this.showingMirror && this.mirror ? this.mirror.frames : this.frames).values());
  }

  // --- An agent's run, mirrored ------------------------------------------------

  /** True while the panel shows an agent's run rather than one of this window's. */
  isShowingMirror(): boolean { return this.showingMirror; }

  /**
   * What an agent's run looks like now. `frames` are the pictures that
   * changed; a monitor not among them keeps the one it had. Shown at once
   * unless this window has a run of its own going, in which case it is kept
   * for when that run is stopped.
   */
  showMirror(screens: ScreenInfo[], frames: readonly ScreenFrame[], controls: ControlsInfo = NO_CONTROLS): void {
    const mirror = this.mirror ?? { screens: [], frames: new Map<number, ScreenFrame>(), controls: NO_CONTROLS };
    mirror.controls = controls;
    const layoutChanged = JSON.stringify(mirror.screens) !== JSON.stringify(screens);
    mirror.screens = screens;
    for (const f of frames) mirror.frames.set(f.screen, f);
    for (const n of mirror.frames.keys()) {
      if (!screens.some(s => s.number === n && s.poweredOn)) mirror.frames.delete(n);
    }
    this.mirror = mirror;
    if (this.session) return;
    if (!this.showingMirror) { this.presentMirror(); return; }
    if (layoutChanged) this.onScreenConfig?.(screens);
    const shown = frames.filter(f => mirror.frames.get(f.screen) === f);
    if (shown.length > 0) this.onFrames?.(shown);
    this.syncControls();
  }

  /** The agent's run is gone (stopped, or its server went away). */
  clearMirror(): void {
    this.mirror = null;
    if (!this.showingMirror) return;
    this.showingMirror = false;
    this.onScreenConfig?.([]);
    this.syncControls();
  }

  /** Put the mirrored run on the panel in full, if there is one and the panel is free. */
  private presentMirror(): void {
    if (!this.mirror || this.session) return;
    this.showingMirror = true;
    this.onScreenConfig?.(this.mirror.screens);
    const frames = Array.from(this.mirror.frames.values());
    if (frames.length > 0) this.onFrames?.(frames);
    this.syncControls();
  }

  /** The panel's own monitor layout, for persisting across sessions. */
  getWantedScreens(): ScreenRequest[] {
    return Array.from(this.wanted.values()).sort((a, b) => a.number - b.number);
  }

  /** Restore a saved layout. The next run picks it up; a run in progress is not touched. */
  setWantedScreens(list: readonly unknown[]): void {
    this.wanted.clear();
    for (const raw of list) {
      const req = sanitizeScreenRequest(raw);
      if (req) this.wanted.set(req.number, req);
    }
  }

  /** Add or reconfigure one monitor from the panel. */
  configureScreen(req: ScreenRequest): void {
    this.wanted.set(req.number, req);
    this.session?.configureScreen(req);
  }

  /**
   * Take a monitor out. Accepts one the script declared too — the script can
   * bring it back by calling `setScreen` for it again.
   */
  removeScreen(number: number): void {
    const n = Math.round(number);
    this.wanted.delete(n);
    this.session?.removeScreen(n);
  }
}
