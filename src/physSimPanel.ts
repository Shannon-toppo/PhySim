import * as vscode from "vscode";
import * as fs from "fs";
import { PhysServer, PhysState, ZERO_STATE } from "./physServer";
import { SimStubServer } from "./simStubServer";
import { CsvLogger, defaultLogFileName } from "./csvLogger";
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
/** CSV logging: start asks for a file, rows carry pre-formatted lines. */
interface CsvStartMsg { type: "csvStart"; }
interface CsvRowsMsg { type: "csvRows"; rows: unknown; }
interface CsvStopMsg { type: "csvStop"; samples?: unknown; }
type FromWebview =
  StateMsg | PresetSaveMsg | PresetLoadMsg | PresetDeleteMsg | PresetListRequestMsg
  | TouchMsg | ScreenRequestMsg | CsvStartMsg | CsvRowsMsg | CsvStopMsg;

type PresetMap = { [name: string]: PhysState };
const PRESETS_KEY = "physim.presets";
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

export class PhysSimPanelManager {
  private panel: vscode.WebviewPanel | null = null;
  private panelLocation: OpenLocation | null = null;
  private disposables: vscode.Disposable[] = [];
  private csv = new CsvLogger();

  constructor(
    private ctx: vscode.ExtensionContext,
    private server: PhysServer,
    private stub: SimStubServer | null = null
  ) {
    // The stub outlives any individual panel, so subscribe once here and post
    // into whichever panel happens to be open. State needed to repaint a panel
    // opened later lives in the stub itself (getScreens / getLastFrame).
    if (this.stub) {
      this.stub.onScreenConfig = screens => {
        if (this.panel) this.panel.webview.postMessage({ type: "screenConfig", screens });
      };
      this.stub.onFrame = commands => {
        if (this.panel) this.panel.webview.postMessage({ type: "screenFrame", commands });
      };
    }
    // A log file that dies mid-session can't be recovered; tell the user and
    // put the webview's button back where it belongs.
    this.csv.onError = err => {
      vscode.window.showErrorMessage(`PhySim: CSV log write failed: ${err.message}`);
      log(`CSV log write failed: ${err.message}`);
      this.postCsvState(false);
    };
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
    created.webview.html = this.buildHtml(created.webview);

    if (openLocation === "newWindow") {
      try {
        await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      } catch (err) {
        vscode.window.showWarningMessage(
          `PhySim: failed to move panel to a new window (${err instanceof Error ? err.message : String(err)}). Requires VSCode 1.85+.`
        );
      }
    }

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
        if (msg.type === "presetListRequest") {
          this.postPresetList(created);
          return;
        }
        if (msg.type === "screenRequest") {
          // Posted once by the webview at load: a panel opened mid-session
          // would otherwise sit blank until the next SCREENCONFIG.
          this.replayScreens(created);
          return;
        }
        if (msg.type === "touch") {
          // Sent by mcScreen.js. Only ever fires while the stub is running:
          // always on macOS, opt-in on Windows.
          if (!this.stub) return;
          this.stub.sendTouch(
            Number(msg.screen) || 0,
            Number(msg.isTouched) === 1,
            Number(msg.isTouchedAlt) === 1,
            Number(msg.x) || 0,
            Number(msg.y) || 0,
            Number(msg.xAlt) || 0,
            Number(msg.yAlt) || 0
          );
          return;
        }
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
    });
  }

  reset(): void {
    if (this.panel) this.panel.webview.postMessage({ type: "reset" });
  }

  close(): void {
    if (this.panel) this.panel.dispose();
  }

  /**
   * Ask for a destination and open the log. The webview's button only lights
   * up on the csvState we post back, so cancelling the dialog simply leaves
   * logging off.
   */
  private async startCsvLog(): Promise<void> {
    if (this.csv.isLogging()) { this.postCsvState(true); return; }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = folder
      ? vscode.Uri.joinPath(folder, defaultLogFileName())
      : vscode.Uri.file(defaultLogFileName());
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "CSV": ["csv"] },
      saveLabel: "Start logging",
      title: "PhySim: log channel values to"
    });
    if (!target) { this.postCsvState(false); return; }
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

  private buildHtml(webview: vscode.Webview): string {
    const mediaUri = (p: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", ...p.split("/")));

    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    // The markup lives in media/panel.html (the authoritative template).
    // Reading it with node fs keeps this extension desktop-only — which it
    // already is (TCP server, _simulator.lua patching).
    const templatePath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "panel.html").fsPath;
    const template = fs.readFileSync(templatePath, "utf8");
    return substituteTemplate(template, {
      csp,
      nonce,
      panelCss: mediaUri("panel.css").toString(),
      threeUri: mediaUri("three/three.module.js").toString(),
      orbitUri: mediaUri("three/addons/controls/OrbitControls.js").toString(),
      tcUri: mediaUri("three/addons/controls/TransformControls.js").toString(),
      panelJs: mediaUri("panel.js").toString(),
      // Slider bounds: pi rad/tick (angular velocity), pi/10 rad/tick^2
      // (angular acceleration). toFixed(4) yields the historical literals
      // "3.1416" / "0.3142" byte-for-byte.
      piMax: Math.PI.toFixed(4),
      piTenthMax: (Math.PI / 10).toFixed(4)
    });
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
function substituteTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  const leftover = /\{\{\w+\}\}/.exec(out);
  if (leftover) {
    throw new Error(`PhySim: unresolved placeholder ${leftover[0]} in media/panel.html`);
  }
  return out;
}
