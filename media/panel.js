// PhySim webview entry point. The scene, input sync, simulation and preset
// logic live in sibling ES modules (loaded via relative imports — the CSP
// nonce on this script propagates to the whole module graph):
//
//   vscodeApi.js  — acquireVsCodeApi() singleton
//   channels.js   — CH13–17 derived math (parity-tested against PhySim.lua)
//   dom.js        — element registry, slider⇄number sync, channel table
//   scene.js      — Three.js scene, airplane mesh, orbit/transform controls
//   pose.js       — pose inputs ⇄ gizmo sync
//   messaging.js  — state streaming to the extension host
//   simulation.js — fixed-timestep integration + recording/playback
//   presets.js    — preset save/load/delete UI
//
// This file only wires the modules together: toolbar mode buttons, reset,
// keyboard shortcuts, extension→webview messages, input events, and the
// render loop.

import {
  modeButtons, resetBtn, sliders, numInputs, poseInputs,
  SLIDER_KEYS, POSE_KEYS, syncSliderFromNum, syncNumFromSlider
} from "./dom.js";
import { scene, renderer, camera, orbit, transform, targetGroup, updateLabels } from "./scene.js";
import { syncPoseFromInputs, syncInputsFromPose } from "./pose.js";
import { scheduleSend, sendState } from "./messaging.js";
import { setSimulating, toggleSimulating, step } from "./simulation.js";
import { renderPresetList, applyPresetState } from "./presets.js";

// --- Mode buttons / reset ----------------------------------------------------
/** @param {string} mode */
function setMode(mode) {
  transform.setMode(/** @type {"translate" | "rotate" | "scale"} */ (mode));
  modeButtons.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
}
modeButtons.forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode ?? "translate")));

function resetGizmo() {
  setSimulating(false);
  targetGroup.position.set(0, 0, 0);
  targetGroup.rotation.set(0, 0, 0);
  for (const k of SLIDER_KEYS) {
    sliders[k].value   = "0";
    numInputs[k].value = "0";
  }
  for (const k of POSE_KEYS) poseInputs[k].value = "0";
  scheduleSend();
}
resetBtn.addEventListener("click", resetGizmo);

// --- Keyboard shortcuts inside the panel --------------------------------------
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "w" || e.key === "W") setMode("translate");
  else if (e.key === "e" || e.key === "E") setMode("rotate");
  else if (e.key === "r" || e.key === "R") resetGizmo();
  else if (e.key === " ") { e.preventDefault(); toggleSimulating(); }
});

// --- extension -> webview ------------------------------------------------------
window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "reset") resetGizmo();
  else if (msg.type === "setMode") setMode(msg.mode);
  else if (msg.type === "presetList") renderPresetList(Array.isArray(msg.names) ? msg.names : []);
  else if (msg.type === "presetLoaded") applyPresetState(msg.state);
});

// --- Input events --------------------------------------------------------------
for (const k of SLIDER_KEYS) {
  sliders[k].addEventListener("input", () => { syncNumFromSlider(k); scheduleSend(); });
  numInputs[k].addEventListener("input", () => { syncSliderFromNum(k);  scheduleSend(); });
}
for (const k of POSE_KEYS) {
  poseInputs[k].addEventListener("input", () => { syncPoseFromInputs(); scheduleSend(); });
}

// Per-field reset buttons (the small ↺ next to each number box). Zero a single
// value without touching the others.
/** @param {string} k */
function resetField(k) {
  if (POSE_KEYS.includes(k)) {
    poseInputs[k].value = "0";
    syncPoseFromInputs();
  } else if (SLIDER_KEYS.includes(k)) {
    numInputs[k].value = "0";
    sliders[k].value = "0";
  } else {
    return;
  }
  scheduleSend();
}
for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(".rst"))) {
  btn.addEventListener("click", () => resetField(btn.dataset.reset ?? ""));
}

// transform changes also schedule a send, and mirror the new gizmo state back
// into the position/rotation number inputs so typed and dragged input stay
// visibly in sync.
transform.addEventListener("change", scheduleSend);
transform.addEventListener("objectChange", () => { syncInputsFromPose(); scheduleSend(); });

// --- Render loop ----------------------------------------------------------------
function loop() {
  step();               // simulation or playback, whichever is active
  orbit.update();
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

// initial send (sets table to all zeros and primes the TCP client if connected)
sendState();
