import * as vscode from "vscode";
import { PhysServer, PhysState, ZERO_STATE } from "./physServer";

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
type FromWebview = StateMsg | PresetSaveMsg | PresetLoadMsg | PresetDeleteMsg | PresetListRequestMsg;

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

  constructor(private ctx: vscode.ExtensionContext, private server: PhysServer) {}

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
      } catch (err: any) {
        vscode.window.showWarningMessage(
          `PhySim: failed to move panel to a new window (${err?.message ?? err}). Requires VSCode 1.85+.`
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

    const threeUri  = mediaUri("three/three.module.js");
    const orbitUri  = mediaUri("three/addons/controls/OrbitControls.js");
    const tcUri     = mediaUri("three/addons/controls/TransformControls.js");
    const panelJs   = mediaUri("panel.js");
    const panelCss  = mediaUri("panel.css");
    const nonce     = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Physics Sensor</title>
<link rel="stylesheet" href="${panelCss}" />
<script type="importmap" nonce="${nonce}">
{
  "imports": {
    "three":           "${threeUri}",
    "three/addons/controls/OrbitControls.js":     "${orbitUri}",
    "three/addons/controls/TransformControls.js": "${tcUri}"
  }
}
</script>
</head>
<body>
  <div id="toolbar">
    <button data-mode="translate" class="mode active" title="Translate (W)">Move</button>
    <button data-mode="rotate"    class="mode"        title="Rotate (E)">Rotate</button>
    <button id="reset" title="Reset position &amp; rotation">Reset</button>
    <button id="simulate" title="Integrate velocity &amp; acceleration over time (Space)">&#9654; Simulate</button>
    <button id="record" title="Record every tick during simulation">&#9679; Rec</button>
    <button id="play" title="Play back the recorded motion" disabled>&#9654; Play</button>
    <span id="rec-count" class="rec-count"></span>
    <span class="hint">Drag the gizmo. Left-drag = orbit, right/wheel-drag = pan, scroll = zoom.</span>
  </div>

  <div id="viewport"></div>

  <div id="sidebar">
    <h3>Position <small>(m)</small></h3>
    <div class="numrow"><label>X</label><input type="number" id="px-num" step="0.1" value="0" /><button class="rst" data-reset="px" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="numrow"><label>Y</label><input type="number" id="py-num" step="0.1" value="0" /><button class="rst" data-reset="py" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="numrow"><label>Z</label><input type="number" id="pz-num" step="0.1" value="0" /><button class="rst" data-reset="pz" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Rotation <small>(rad)</small></h3>
    <div class="numrow"><label>X</label><input type="number" id="rx-num" step="0.01" value="0" /><button class="rst" data-reset="rx" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="numrow"><label>Y</label><input type="number" id="ry-num" step="0.01" value="0" /><button class="rst" data-reset="ry" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="numrow"><label>Z</label><input type="number" id="rz-num" step="0.01" value="0" /><button class="rst" data-reset="rz" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Linear velocity <small>(m/tick)</small></h3>
    <div class="slider"><label>X</label><input type="range" id="vx" min="-10" max="10" step="0.01" value="0" /><input type="number" id="vx-num" step="0.01" value="0" /><button class="rst" data-reset="vx" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Y</label><input type="range" id="vy" min="-10" max="10" step="0.01" value="0" /><input type="number" id="vy-num" step="0.01" value="0" /><button class="rst" data-reset="vy" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Z</label><input type="range" id="vz" min="-10" max="10" step="0.01" value="0" /><input type="number" id="vz-num" step="0.01" value="0" /><button class="rst" data-reset="vz" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Angular velocity <small>(rad/tick)</small></h3>
    <div class="slider"><label>X</label><input type="range" id="ax" min="-3.1416" max="3.1416" step="0.001" value="0" /><input type="number" id="ax-num" step="0.001" value="0" /><button class="rst" data-reset="ax" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Y</label><input type="range" id="ay" min="-3.1416" max="3.1416" step="0.001" value="0" /><input type="number" id="ay-num" step="0.001" value="0" /><button class="rst" data-reset="ay" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Z</label><input type="range" id="az" min="-3.1416" max="3.1416" step="0.001" value="0" /><input type="number" id="az-num" step="0.001" value="0" /><button class="rst" data-reset="az" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Linear acceleration <small>(m/tick&sup2;)</small></h3>
    <div class="slider"><label>X</label><input type="range" id="lax" min="-1" max="1" step="0.001" value="0" /><input type="number" id="lax-num" step="0.001" value="0" /><button class="rst" data-reset="lax" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Y</label><input type="range" id="lay" min="-1" max="1" step="0.001" value="0" /><input type="number" id="lay-num" step="0.001" value="0" /><button class="rst" data-reset="lay" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Z</label><input type="range" id="laz" min="-1" max="1" step="0.001" value="0" /><input type="number" id="laz-num" step="0.001" value="0" /><button class="rst" data-reset="laz" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Angular acceleration <small>(rad/tick&sup2;)</small></h3>
    <div class="slider"><label>X</label><input type="range" id="aax" min="-0.3142" max="0.3142" step="0.0001" value="0" /><input type="number" id="aax-num" step="0.0001" value="0" /><button class="rst" data-reset="aax" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Y</label><input type="range" id="aay" min="-0.3142" max="0.3142" step="0.0001" value="0" /><input type="number" id="aay-num" step="0.0001" value="0" /><button class="rst" data-reset="aay" title="Reset to 0" tabindex="-1">&#8634;</button></div>
    <div class="slider"><label>Z</label><input type="range" id="aaz" min="-0.3142" max="0.3142" step="0.0001" value="0" /><input type="number" id="aaz-num" step="0.0001" value="0" /><button class="rst" data-reset="aaz" title="Reset to 0" tabindex="-1">&#8634;</button></div>

    <h3>Presets</h3>
    <div class="preset-row">
      <input type="text" id="preset-name" placeholder="preset name" maxlength="64" />
      <button id="preset-save" title="Save current pose &amp; velocity">Save</button>
    </div>
    <div class="preset-row">
      <select id="preset-list"></select>
      <button id="preset-load" title="Load selected preset">Load</button>
      <button id="preset-delete" title="Delete selected preset" class="danger">Del</button>
    </div>

    <h3>Channels</h3>
    <table id="channels">
      <tr><th>CH</th><th>Value</th><th>Quantity</th></tr>
      <tr><td>1</td><td id="c1">0.000</td><td>pos.x (East)</td></tr>
      <tr><td>2</td><td id="c2">0.000</td><td>pos.y (Up)</td></tr>
      <tr><td>3</td><td id="c3">0.000</td><td>pos.z (North)</td></tr>
      <tr><td>4</td><td id="c4">0.000</td><td>rot.x (rad)</td></tr>
      <tr><td>5</td><td id="c5">0.000</td><td>rot.y (rad)</td></tr>
      <tr><td>6</td><td id="c6">0.000</td><td>rot.z (rad)</td></tr>
      <tr><td>7</td><td id="c7">0.000</td><td>vel.x</td></tr>
      <tr><td>8</td><td id="c8">0.000</td><td>vel.y</td></tr>
      <tr><td>9</td><td id="c9">0.000</td><td>vel.z</td></tr>
      <tr><td>10</td><td id="c10">0.000</td><td>angVel.x</td></tr>
      <tr><td>11</td><td id="c11">0.000</td><td>angVel.y</td></tr>
      <tr><td>12</td><td id="c12">0.000</td><td>angVel.z</td></tr>
      <tr><td>13</td><td id="c13">0.000</td><td>|vel| (m/s)</td></tr>
      <tr><td>14</td><td id="c14">0.000</td><td>|angVel| (RPS)</td></tr>
      <tr><td>15</td><td id="c15">0.000</td><td>tilt.z (rot)</td></tr>
      <tr><td>16</td><td id="c16">0.000</td><td>tilt.x (rot)</td></tr>
      <tr><td>17</td><td id="c17">0.000</td><td>compass (rot)</td></tr>
    </table>
  </div>

  <script type="module" nonce="${nonce}" src="${panelJs}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
