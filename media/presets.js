// Presets — persistence lives on the extension side (globalState). The
// webview just sends Save/Load/Delete intents and re-renders the dropdown
// when the extension echoes back the current list.

import { vscode } from "./vscodeApi.js";
import {
  presetNameEl, presetListEl, presetSaveBtn, presetLoadBtn, presetDeleteBtn,
  numInputs, SLIDER_KEYS, syncSliderFromNum
} from "./dom.js";
import { targetGroup } from "./scene.js";
import { syncInputsFromPose } from "./pose.js";
import { readState, scheduleSend } from "./messaging.js";
import { resetTrail } from "./visuals.js";

/** @param {string[]} names */
export function renderPresetList(names) {
  const prev = presetListEl.value;
  presetListEl.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    presetListEl.appendChild(opt);
  }
  // try to keep the user's previous selection
  if (names.indexOf(prev) !== -1) presetListEl.value = prev;
}

/**
 * @param {unknown} v
 * @returns {v is number[]}
 */
function isTriple(v) {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
}

/**
 * Put a whole pose on the gizmo and the number inputs — a loaded preset, or
 * the pose of an AI agent's run that the host is mirroring into this panel.
 *
 * @param {import("./channels.js").PhysStateLike | undefined} s
 * @param {boolean} [keepTrail] true for a mirrored pose: the agent moves the
 *   vehicle step by step, and the trail is how that movement shows.
 */
export function applyPresetState(s, keepTrail = false) {
  if (!s || !isTriple(s.position) || !isTriple(s.rotation) || !isTriple(s.velocity) || !isTriple(s.angularVelocity)) return;
  if (!keepTrail) resetTrail();   // loading a preset teleports; the old path would draw a jump
  targetGroup.position.set(s.position[0], s.position[1], s.position[2]);
  targetGroup.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  numInputs.vx.value = String(s.velocity[0]);
  numInputs.vy.value = String(s.velocity[1]);
  numInputs.vz.value = String(s.velocity[2]);
  numInputs.ax.value = String(s.angularVelocity[0]);
  numInputs.ay.value = String(s.angularVelocity[1]);
  numInputs.az.value = String(s.angularVelocity[2]);
  for (const k of SLIDER_KEYS) syncSliderFromNum(k);
  syncInputsFromPose();
  scheduleSend();
}

presetSaveBtn.addEventListener("click", () => {
  const name = presetNameEl.value.trim();
  if (!name) return;
  vscode.postMessage({ type: "presetSave", name, state: readState() });
});
presetLoadBtn.addEventListener("click", () => {
  const name = presetListEl.value;
  if (!name) return;
  vscode.postMessage({ type: "presetLoad", name });
});
presetDeleteBtn.addEventListener("click", () => {
  const name = presetListEl.value;
  if (!name) return;
  vscode.postMessage({ type: "presetDelete", name });
});
presetNameEl.addEventListener("keydown", e => {
  if (e.key === "Enter") presetSaveBtn.click();
});

// initial preset list fetch
vscode.postMessage({ type: "presetListRequest" });
