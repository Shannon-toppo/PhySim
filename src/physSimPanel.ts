import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { PhysServer, PhysState, ZERO_STATE, sanitizeTimeScale } from "./physServer";
import { SimStubServer, ScreenRequest, sanitizeScreenRequest } from "./simStubServer";
import { CsvLogger, defaultLogPath } from "./csvLogger";
import { log } from "./log";

type Triple = [number, number, number];

interface StateMsg {
  type: "state";
  position: Triple;
  rotation: Triple;
  velocity: Triple;
  angularVelocity: Triple;
}
interface PresetSaveMsg { type: "presetSave"; name: string; state: PhysState; }
interface PresetLoadMsg { type: "presetLoad"; name: string; }
interface PresetDeleteMsg { type: "presetDelete"; name: string; }
interface PresetListRequestMsg { type: "presetListRequest"; }
/** macOS monitor stand-in: pointer input on a rendered screen (see simStubServer). */
interface TouchMsg {
  type: "touch";
  screen: number;
  isTouched: number;
  isTouchedAlt: number;
  x: number;
  y: number;
  xAlt: number;
  yAlt: number;
}
/** Webview asking for a repaint of the monitors it may have missed. */
interface ScreenRequestMsg { type: "screenRequest"; }
/** Panel's monitor controls: declare/reconfigure one screen, or drop one. */
interface ScreenSetMsg {
  type: "screenSet";
  screen: number;
  size: string;
  poweredOn?: boolean;
  portrait?: boolean;
}
interface ScreenRemoveMsg { type: "screenRemove"; screen: number; }
/** CSV logging: start asks for a file, rows carry pre-formatted lines. */
interface CsvStartMsg { type: "csvStart"; }
interface CsvRowsMsg { type: "csvRows"; rows: unknown; }
interface CsvStopMsg { type: "csvStop"; samples?: unknown; }
/** Simulation speed picked in the toolbar (one of TIME_SCALES). */
interface TimeScaleMsg { type: "timeScale"; scale: unknown; }
/** Everything the monitor section posts — from the panel or the monitor window. */
type MonitorMsg = TouchMsg | ScreenRequestMsg | ScreenSetMsg | ScreenRemoveMsg;
type FromWebview =
  StateMsg | PresetSaveMsg | PresetLoadMsg | PresetDeleteMsg | PresetListRequestMsg
  | MonitorMsg
  | CsvStartMsg | CsvRowsMsg | CsvStopMsg | TimeScaleMsg;

type PresetMap = { [name: string]: PhysState };
const PRESETS_KEY = "physim.presets";
/**
 * Monitor layout. Workspace-scoped, not global: how many screens a
 * microcontroller drives is a property of the project being debugged.
 */
const MONITORS_KEY = "physim.monitors";
/**
 * Simulation speed. Workspace-scoped like the monitors, and kept across
 * sessions — slow motion is for watching the same behaviour again and again.
 * The toolbar marks anything but ×1 so a leftover setting can't pass for slow
 * user code.
 */
const TIME_SCALE_KEY = "physim.timeScale";
const MAX_PRESET_NAME_LEN = 64;

function isTriple(v: unknown): v is Triple {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
}
function sanitizePresetState(s: unknown): PhysState | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (!isTriple(o.position) || !isTriple(o.rotation) || !isTriple(o.velocity) || !isTriple(o.angularVelocity)) return null;
  return { position: o.position, rotation: o.rotation, velocity: o.velocity, angularVelocity: o.angularVelocity };
}

type OpenLocation = "beside" | "newWindow";

interface PanelSettings {
  openLocation: OpenLocation;
}

function readPanelSettings(): PanelSettings {
  const cfg = vscode.workspace.getConfiguration();
  const raw = cfg.get<string>("physim.panel.openLocation", "beside");
  const openLocation: OpenLocation = raw === "newWindow" ? "newWindow" : "beside";
  return { openLocation };
}

const MONITOR_WINDOW_SETTING = "physim.monitors.openInNewWindow";

function monitorWindowEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(MONITOR_WINDOW_SETTING, false) === true;
}

/**
 * Move the active editor — the webview panel just created with focus — into
 * a new floating window. The command is VSCode 1.85+; on anything older the
 * panel simply stays a tab in the current window.
 */
async function moveActiveEditorToNewWindow(what: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
  } catch (err) {
    vscode.window.showWarningMessage(
      `PhySim: failed to move ${what} to a new window (${err instanceof Error ? err.message : String(err)}). Requires VSCode 1.85+.`
    );
  }
}

export class PhysSimPanelManager {
  private panel: vscode.WebviewPanel | null = null;
  private panelLocation: OpenLocation | null = null;
  /**
   * The stand-alone monitor window. While it is open it owns the monitors:
   * screen messages go to it instead of the panel, whose own monitor section
   * is emptied (and with it hidden).
   */
  private monitorPanel: vscode.WebviewPanel | null = null;
  /**
   * The user closed the monitor window during this simulator session. The
   * monitors fall back into the panel, and the next screen config must not
   * pop the window straight back open. Cleared when a session starts.
   */
  private monitorWindowDismissed = false;
  /** Set while PhySim itself closes the window, so that isn't a dismissal. */
  private closingMonitorWindow = false;
  private disposables: vscode.Disposable[] = [];
  private csv = new CsvLogger();
  private csvDialogOpen = false;

  constructor(
    private ctx: vscode.ExtensionContext,
    private server: PhysServer,
    private stub: SimStubServer | null = null
  ) {
    // The stub outlives any individual panel, so subscribe once here and post
    // into whichever panel happens to be open. State needed to repaint a panel
    // opened later lives in the stub itself (getScreens / getLastFrame).
    if (this.stub) {
      // Restore the saved monitor layout before anything can connect; the stub
      // re-declares it to Lua on the next debug session.
      this.stub.setWantedScreens(this.getMonitorLayout());
      this.stub.onScreenConfig = screens => {
        // The window opens with the first monitor of a session rather than
        // with the panel: on Windows with the real exe there is never one to
        // show. Once open it asks for a replay, which covers this config.
        if (!this.monitorPanel && this.shouldAutoOpenMonitorWindow()) {
          void this.openMonitorWindow();
          return;
        }
        this.screenTarget()?.webview.postMessage({ type: "screenConfig", screens });
      };
      this.stub.onFrame = commands => {
        this.screenTarget()?.webview.postMessage({ type: "screenFrame", commands });
      };
      ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration(MONITOR_WINDOW_SETTING)) return;
        if (!monitorWindowEnabled()) {
          this.closeMonitorWindow();
          return;
        }
        this.monitorWindowDismissed = false;
        if (this.shouldAutoOpenMonitorWindow()) void this.openMonitorWindow();
      }));
    }
    // A log file that dies mid-session can't be recovered; tell the user and
    // put the webview's button back where it belongs.
    this.csv.onError = err => {
      vscode.window.showErrorMessage(`PhySim: CSV log write failed: ${err.message}`);
      log(`CSV log write failed: ${err.message}`);
      this.postCsvState(false);
    };
  }

  /** Whichever webview is showing the monitors right now, if any. */
  private screenTarget(): vscode.WebviewPanel | null {
    return this.monitorPanel ?? this.panel;
  }

  private shouldAutoOpenMonitorWindow(): boolean {
    return !!this.stub && monitorWindowEnabled() && !this.monitorWindowDismissed
      && this.stub.getScreens().some(s => s.poweredOn);
  }

  /** A simulator session is starting: the monitor window may open again. */
  simulatorStarted(): void {
    this.monitorWindowDismissed = false;
  }

  /**
   * Show the monitors in their own window. Opened automatically by the
   * physim.monitors.openInNewWindow setting, or on demand by the
   * physim.openMonitors command whatever the setting says.
   */
  async openMonitorWindow(): Promise<void> {
    if (!this.stub) {
      vscode.window.showInformationMessage("PhySim: the monitor view is not available on this platform.");
      return;
    }
    if (this.monitorPanel) {
      this.monitorPanel.reveal(undefined, true);
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    // Own viewType, so VSCode's remembered placement of the main panel never
    // lands on this one (see openOrReveal).
    const created = vscode.window.createWebviewPanel(
      "physim.monitors",
      "PhySim Monitors",
      // Created focused: moveEditorToNewWindow acts on the active editor.
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot]
      }
    );
    this.monitorPanel = created;
    created.webview.html = this.buildHtml(created.webview, "monitors.html", {
      monitorsJs: this.mediaUri(created.webview, "monitors.js")
    });
    // The window owns the monitors now; empty the panel's section, which
    // hides it and gives the 3D view the room back.
    if (this.panel) this.panel.webview.postMessage({ type: "screenConfig", screens: [] });

    const sub = created.webview.onDidReceiveMessage((msg: FromWebview) => {
      if (!msg || typeof (msg as { type?: unknown }).type !== "string") return;
      this.handleMonitorMessage(msg, created);
    });
    created.onDidDispose(() => {
      sub.dispose();
      if (this.monitorPanel !== created) return;
      this.monitorPanel = null;
      if (!this.closingMonitorWindow) this.monitorWindowDismissed = true;
      // Back into the panel, so closing the window never loses the monitors.
      if (this.panel) this.replayScreens(this.panel);
    });

    await moveActiveEditorToNewWindow("the monitors");
  }

  private closeMonitorWindow(): void {
    if (!this.monitorPanel) return;
    this.closingMonitorWindow = true;
    try {
      this.monitorPanel.dispose();
    } finally {
      this.closingMonitorWindow = false;
    }
  }

  /**
   * The monitor section's messages, from either webview. Returns false for
   * anything that isn't one. Only the webview showing the monitors gets a
   * replay — the panel asks too while the window has them.
   */
  private handleMonitorMessage(msg: FromWebview, source: vscode.WebviewPanel): boolean {
    if (msg.type === "screenRequest") {
      // Posted once by the webview at load: a panel opened mid-session
      // would otherwise sit blank until the next SCREENCONFIG.
      if (source === this.screenTarget()) this.replayScreens(source);
      return true;
    }
    if (msg.type === "screenSet" || msg.type === "screenRemove") {
      this.applyScreenMessage(msg);
      return true;
    }
    if (msg.type === "touch") {
      // Sent by mcScreen.js. Only ever fires while the stub is running:
      // always on macOS, opt-in on Windows.
      if (!this.stub) return true;
      this.stub.sendTouch(
        Number(msg.screen) || 0,
        Number(msg.isTouched) === 1,
        Number(msg.isTouchedAlt) === 1,
        Number(msg.x) || 0,
        Number(msg.y) || 0,
        Number(msg.xAlt) || 0,
        Number(msg.yAlt) || 0
      );
      return true;
    }
    return false;
  }

  /** Repaint monitors in a freshly opened panel from the stub's current state. */
  private replayScreens(panel: vscode.WebviewPanel): void {
    if (!this.stub) return;
    const screens = this.stub.getScreens();
    if (screens.length === 0) return;
    panel.webview.postMessage({ type: "screenConfig", screens });
    const last = this.stub.getLastFrame();
    if (last) panel.webview.postMessage({ type: "screenFrame", commands: last });
  }

  async openOrReveal(): Promise<void> {
    const { openLocation } = readPanelSettings();

    // If the setting changed since the panel was opened, dispose it so the new value takes effect.
    // (A panel in an auxiliary window won't move back to the main window via reveal(Beside).)
    if (this.panel && this.panelLocation !== openLocation) {
      const old = this.panel;
      this.panel = null;
      this.panelLocation = null;
      old.dispose();
    }

    if (this.panel) {
      // Don't force a column when in a new window — reveal(Beside) would yank it back.
      if (openLocation === "newWindow") this.panel.reveal(undefined, true);
      else this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const mediaRoot = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    // VSCode persists editor placement by viewType — a panel previously moved to an
    // auxiliary window is restored there on the next createWebviewPanel, even when we
    // request ViewColumn.Beside. Using a distinct viewType per mode keeps that state
    // from bleeding across modes.
    const viewType = openLocation === "newWindow" ? "physim.gizmo.newWindow" : "physim.gizmo.beside";
    // For newWindow we create with focus so the move-editor command targets this panel.
    // For beside we keep focus on the editor.
    const viewColumn = openLocation === "newWindow" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const preserveFocus = openLocation !== "newWindow";
    const created = vscode.window.createWebviewPanel(
      viewType,
      "Physics Sensor",
      { viewColumn, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot]
      }
    );
    this.panel = created;
    this.panelLocation = openLocation;
    // The Lua tick rate follows the panel: slowed only while there is a
    // panel showing (and marking) the speed.
    this.server.setTimeScale(this.getTimeScale());
    created.webview.html = this.buildPanelHtml(created.webview);

    if (openLocation === "newWindow") await moveActiveEditorToNewWindow("panel");

    // Bind disposables to this specific panel instance so a subsequent dispose
    // can't wipe state belonging to a newer panel.
    const localDisposables: vscode.Disposable[] = [];
    localDisposables.push(
      created.webview.onDidReceiveMessage(async (msg: FromWebview) => {
        if (!msg || typeof (msg as { type?: unknown }).type !== "string") return;
        if (msg.type === "state") {
          const state: PhysState = {
            position: msg.position,
            rotation: msg.rotation,
            velocity: msg.velocity,
            angularVelocity: msg.angularVelocity
          };
          this.server.broadcast(state);
          return;
        }
        if (msg.type === "timeScale") {
          const scale = sanitizeTimeScale(msg.scale);
          this.server.setTimeScale(scale);
          await this.ctx.workspaceState.update(TIME_SCALE_KEY, scale);
          return;
        }
        if (msg.type === "presetListRequest") {
          this.postPresetList(created);
          return;
        }
        if (this.handleMonitorMessage(msg, created)) return;
        if (msg.type === "csvStart") {
          await this.startCsvLog();
          return;
        }
        if (msg.type === "csvRows") {
          this.csv.write(msg.rows);
          return;
        }
        if (msg.type === "csvStop") {
          await this.stopCsvLog(true);
          return;
        }
        if (msg.type === "presetSave") {
          const name = typeof msg.name === "string" ? msg.name.trim().slice(0, MAX_PRESET_NAME_LEN) : "";
          const state = sanitizePresetState(msg.state);
          if (!name || !state) return;
          const presets = this.getPresets();
          presets[name] = state;
          await this.setPresets(presets);
          this.postPresetList(created);
          return;
        }
        if (msg.type === "presetLoad") {
          if (typeof msg.name !== "string") return;
          const entry = this.getPresets()[msg.name];
          if (entry) created.webview.postMessage({ type: "presetLoaded", state: entry });
          return;
        }
        if (msg.type === "presetDelete") {
          if (typeof msg.name !== "string") return;
          const presets = this.getPresets();
          if (!(msg.name in presets)) return;
          delete presets[msg.name];
          await this.setPresets(presets);
          this.postPresetList(created);
          return;
        }
      })
    );
    this.disposables.push(...localDisposables);

    created.onDidDispose(() => {
      localDisposables.forEach(d => d.dispose());
      if (this.panel === created) {
        this.panel = null;
        this.panelLocation = null;
        this.disposables = [];
      }
      // The panel was the only thing feeding the log; finish the file rather
      // than leaving a half-written one behind. After the clear above, so the
      // csvState it posts can't land on a disposed webview.
      this.stopCsvLog(false);
      // zero out the state on disconnect so the Lua side doesn't keep stale values
      this.server.broadcast(ZERO_STATE);
      // Nothing left to show the speed, so don't leave Lua running slow.
      this.server.setTimeScale(1);
    });
  }

  reset(): void {
    if (this.panel) this.panel.webview.postMessage({ type: "reset" });
  }

  close(): void {
    this.closeMonitorWindow();
    if (this.panel) this.panel.dispose();
  }

  /**
   * Where the save dialog starts. Must be an ABSOLUTE path: a URI built from a
   * bare file name resolves to a drive-relative `\name.csv` on Windows, which
   * the native dialog refuses to open — and the throw used to vanish into the
   * message handler, leaving the panel's button waiting forever.
   */
  private defaultCsvUri(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    // fsPath, not the URI: CsvLogger writes with node fs on the extension
    // host, so a non-file scheme could not be logged to anyway.
    return vscode.Uri.file(defaultLogPath(folder?.fsPath, os.homedir()));
  }

  /**
   * Ask for a destination and open the log. The webview's button only lights
   * up on the csvState we post back, so cancelling the dialog simply leaves
   * logging off — but every exit from here MUST post one, or the panel is
   * stuck with no way to retry.
   */
  private async startCsvLog(): Promise<void> {
    if (this.csv.isLogging()) { this.postCsvState(true); return; }
    // A second click while the dialog is already up would stack another one.
    if (this.csvDialogOpen) {
      log("CSV log start ignored: the save dialog is already open.");
      return;
    }
    this.csvDialogOpen = true;
    try {
      const defaultUri = this.defaultCsvUri();
      log(`CSV log: opening the save dialog at ${defaultUri.fsPath}`);
      // Ack before the dialog blocks us. The panel cannot otherwise tell a
      // dialog waiting behind another window from an extension host that has
      // never heard of csvStart — which is exactly what a stale out/ is, and
      // what made this look like a dead button on Windows.
      if (this.panel) this.panel.webview.postMessage({ type: "csvDialog" });
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { "CSV": ["csv"] },
        saveLabel: "Start logging",
        title: "PhySim: log channel values to"
      });
      if (!target) {
        log("CSV log: the save dialog was dismissed.");
        this.postCsvState(false);
        return;
      }
      try {
        this.csv.start(target.fsPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`PhySim: could not open CSV log: ${message}`);
        log(`CSV log open failed for ${target.fsPath}: ${message}`);
        this.postCsvState(false);
        return;
      }
      log(`CSV log started: ${this.csv.getPath()}`);
      this.postCsvState(true);
    } catch (err) {
      // showSaveDialog itself failed. Without this the rejection is swallowed
      // by the webview message handler and the panel never hears back.
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`PhySim: could not open the save dialog: ${message}`);
      log(`CSV log: showSaveDialog failed: ${message}`);
      this.postCsvState(false);
    } finally {
      this.csvDialogOpen = false;
    }
  }

  /**
   * Close the log. `announce` is false when the panel is going away — the
   * notification would arrive with nothing left to click back to.
   */
  private async stopCsvLog(announce: boolean): Promise<void> {
    const wasLogging = this.csv.isLogging();
    const result = await this.csv.stop();
    this.postCsvState(false);
    if (!wasLogging || !result) return;
    log(`CSV log stopped: ${result.path} (${result.lines} lines)`);
    if (!announce) return;
    // lines includes the header row; report the data rows the user recorded.
    const rows = Math.max(0, result.lines - 1);
    const open = "Open";
    const choice = await vscode.window.showInformationMessage(
      `PhySim: logged ${rows} rows to ${result.path}`, open
    );
    if (choice === open) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.path));
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  }

  private postCsvState(logging: boolean): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: "csvState", logging, path: this.csv.getPath() });
    }
  }

  /**
   * Add, resize or drop one monitor. Only ever reaches Lua when PhySim is the
   * one drawing the monitors — on Windows with the real exe the stub is never
   * started, and configureScreen then does nothing but remember the layout.
   */
  private applyScreenMessage(msg: ScreenSetMsg | ScreenRemoveMsg): void {
    if (!this.stub) return;
    if (msg.type === "screenRemove") {
      const n = Math.round(Number(msg.screen));
      if (!Number.isFinite(n)) return;
      this.stub.removeScreen(n);
    } else {
      const req = sanitizeScreenRequest({ ...msg, number: msg.screen });
      if (!req) {
        log(`Ignored a screen config for screen ${msg.screen} (size "${msg.size}").`);
        return;
      }
      this.stub.configureScreen(req);
    }
    this.setMonitorLayout(this.stub.getWantedScreens());
  }

  private getMonitorLayout(): ScreenRequest[] {
    const raw = this.ctx.workspaceState.get<unknown>(MONITORS_KEY, []);
    if (!Array.isArray(raw)) return [];
    const out: ScreenRequest[] = [];
    for (const entry of raw) {
      const req = sanitizeScreenRequest(entry);
      if (req) out.push(req);
    }
    return out;
  }

  private setMonitorLayout(list: ScreenRequest[]): Thenable<void> {
    return this.ctx.workspaceState.update(MONITORS_KEY, list);
  }

  private getTimeScale(): number {
    return sanitizeTimeScale(this.ctx.workspaceState.get<unknown>(TIME_SCALE_KEY, 1));
  }

  private getPresets(): PresetMap {
    const raw = this.ctx.globalState.get<PresetMap>(PRESETS_KEY, {});
    return raw && typeof raw === "object" ? { ...raw } : {};
  }

  private setPresets(presets: PresetMap): Thenable<void> {
    return this.ctx.globalState.update(PRESETS_KEY, presets);
  }

  private postPresetList(panel: vscode.WebviewPanel): void {
    const names = Object.keys(this.getPresets()).sort((a, b) => a.localeCompare(b));
    panel.webview.postMessage({ type: "presetList", names });
  }

  private mediaUri(webview: vscode.Webview, p: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", ...p.split("/"))).toString();
  }

  private buildPanelHtml(webview: vscode.Webview): string {
    const mediaUri = (p: string) => this.mediaUri(webview, p);
    return this.buildHtml(webview, "panel.html", {
      threeUri: mediaUri("three/three.module.js"),
      orbitUri: mediaUri("three/addons/controls/OrbitControls.js"),
      tcUri: mediaUri("three/addons/controls/TransformControls.js"),
      panelJs: mediaUri("panel.js"),
      // Slider bounds: pi rad/tick (angular velocity), pi/10 rad/tick^2
      // (angular acceleration). toFixed(4) yields the historical literals
      // "3.1416" / "0.3142" byte-for-byte.
      piMax: Math.PI.toFixed(4),
      piTenthMax: (Math.PI / 10).toFixed(4),
      timeScale: String(this.getTimeScale())
    });
  }

  /**
   * Fill one of the media/*.html templates. Every page gets the CSP, the
   * nonce and the stylesheet; `values` carries the page's own placeholders.
   */
  private buildHtml(webview: vscode.Webview, page: string, values: Record<string, string>): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    // The markup lives in media/*.html (the authoritative templates).
    // Reading it with node fs keeps this extension desktop-only — which it
    // already is (TCP server, _simulator.lua patching).
    const templatePath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", page).fsPath;
    const template = fs.readFileSync(templatePath, "utf8");
    return substituteTemplate(template, {
      csp,
      nonce,
      panelCss: this.mediaUri(webview, "panel.css"),
      ...values
    }, page);
  }
}

function makeNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Replace every {{key}} token in the template. Throws if any token remains
 * unresolved — catches placeholder typos at panel-open time instead of
 * silently shipping broken markup.
 */
function substituteTemplate(template: string, values: Record<string, string>, page: string): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  const leftover = /\{\{\w+\}\}/.exec(out);
  if (leftover) {
    throw new Error(`PhySim: unresolved placeholder ${leftover[0]} in media/${page}`);
  }
  return out;
}
