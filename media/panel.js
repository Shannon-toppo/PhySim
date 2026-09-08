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
//   visuals.js    — path trail + velocity arrow (maths in trail.js)
//   presets.js    — preset save/load/delete UI
//   logging.js    — CSV channel logging (rows formatted by csv.js)
//
// This file only wires the modules together: toolbar mode buttons, reset,
// keyboard shortcuts, extension→webview messages, input events, and the
// render loop.

import {
  modeButtons, resetBtn, sliders, numInputs, poseInputs, sidebarToggleBtn,
  viewport, monitorsSection, monitorsResizer,
  SLIDER_KEYS, POSE_KEYS, syncSliderFromNum, syncNumFromSlider
} from "./dom.js";
import { scene, renderer, camera, orbit, transform, targetGroup, updateLabels, flushResize } from "./scene.js";
import { syncPoseFromInputs, syncInputsFromPose } from "./pose.js";
import { scheduleSend, sendState, requestScreens } from "./messaging.js";
import { applyScreenConfig, applyScreenFrame } from "./mcScreen.js";
import { setSimulating, toggleSimulating, step } from "./simulation.js";
import { renderPresetList, applyPresetState } from "./presets.js";
import { updateVisuals, resetTrail } from "./visuals.js";
import { applyCsvState, applyCsvDialog } from "./logging.js";

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
  resetTrail();          // the old path no longer belongs to where we are now
  scheduleSend();
}
resetBtn.addEventListener("click", resetGizmo);

// --- Sidebar visibility --------------------------------------------------------
// Collapsing the right column is a pure CSS class on <body>; the viewport and
// the monitor list each observe their own size, so the renderer and the monitor
// fit scale re-layout without being told.
let sidebarVisible = true;
/** @param {boolean} visible */
function setSidebarVisible(visible) {
  sidebarVisible = visible;
  document.body.classList.toggle("sidebar-hidden", !visible);
  sidebarToggleBtn.classList.toggle("active", visible);
  sidebarToggleBtn.setAttribute("aria-pressed", String(visible));
}
sidebarToggleBtn.addEventListener("click", () => setSidebarVisible(!sidebarVisible));
setSidebarVisible(true);

// --- Viewport / monitor splitter -----------------------------------------------
// Dragging the handle sets --monitors-h, which panel.css uses as the monitor
// row's track size (it is "auto" — size to the contents — until then). Both
// rows observe their own size, so the renderer and the monitor fit scale follow.
const MIN_MONITORS_H = 72;   // the Monitors header plus a sliver of canvas
const MIN_VIEWPORT_H = 120;  // enough 3D view left to still aim the gizmo

/**
 * Apply a monitor-row height, clamped to what the panel can actually give it.
 * @param {number} h desired height in px
 */
function setMonitorsHeight(h) {
  const top = viewport.getBoundingClientRect().top;   // below the toolbar
  const room = document.body.clientHeight - top - monitorsResizer.offsetHeight;
  const max = Math.max(MIN_MONITORS_H, room - MIN_VIEWPORT_H);
  const clamped = Math.min(Math.max(h, MIN_MONITORS_H), max);
  document.body.classList.add("monitors-sized");
  document.body.style.setProperty("--monitors-h", clamped + "px");
}

/** Back to sizing the row to its contents (capped at 50vh by the stylesheet). */
function resetMonitorsHeight() {
  document.body.classList.remove("monitors-sized");
  document.body.style.removeProperty("--monitors-h");
}

monitorsResizer.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  monitorsResizer.setPointerCapture(e.pointerId);    // keep the drag while the
  document.body.classList.add("resizing-monitors");  // pointer outruns the handle
  // No preventDefault here: it would also suppress the compatibility mouse
  // events, and with them the double-click that resets the height. The
  // body class kills text selection for the duration instead.
});
monitorsResizer.addEventListener("pointermove", e => {
  if (!monitorsResizer.hasPointerCapture(e.pointerId)) return;
  // Grab the handle by its middle, so it stays under the cursor.
  setMonitorsHeight(document.body.clientHeight - e.clientY - monitorsResizer.offsetHeight / 2);
});
/** @param {PointerEvent} e */
function endMonitorDrag(e) {
  if (monitorsResizer.hasPointerCapture(e.pointerId)) monitorsResizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove("resizing-monitors");
}
monitorsResizer.addEventListener("pointerup", endMonitorDrag);
monitorsResizer.addEventListener("pointercancel", endMonitorDrag);
monitorsResizer.addEventListener("dblclick", resetMonitorsHeight);
monitorsResizer.addEventListener("keydown", e => {
  const step = e.shiftKey ? 48 : 16;
  const now = monitorsSection.getBoundingClientRect().height;
  if (e.key === "ArrowUp") setMonitorsHeight(now + step);
  else if (e.key === "ArrowDown") setMonitorsHeight(now - step);
  else if (e.key === "Home" || e.key === "End") resetMonitorsHeight();
  else return;
  e.preventDefault();
});
// A shrinking panel can leave the dragged height over its own limit.
window.addEventListener("resize", () => {
  if (document.body.classList.contains("monitors-sized")) {
    setMonitorsHeight(monitorsSection.getBoundingClientRect().height);
  }
});

// --- Keyboard shortcuts inside the panel --------------------------------------
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "w" || e.key === "W") setMode("translate");
  else if (e.key === "e" || e.key === "E") setMode("rotate");
  else if (e.key === "r" || e.key === "R") resetGizmo();
  else if (e.key === "h" || e.key === "H") setSidebarVisible(!sidebarVisible);
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
  else if (msg.type === "csvState") applyCsvState(msg);
  else if (msg.type === "csvDialog") applyCsvDialog();
  // macOS monitor stand-in — never sent on Windows.
  else if (msg.type === "screenConfig") applyScreenConfig(Array.isArray(msg.screens) ? msg.screens : []);
  else if (msg.type === "screenFrame") applyScreenFrame(Array.isArray(msg.commands) ? msg.commands : []);
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
  flushResize();        // apply a pending resize before drawing, never after
  step();               // simulation or playback, whichever is active
  updateVisuals();      // trail sample + velocity arrow
  orbit.update();
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

// initial send (sets table to all zeros and primes the TCP client if connected)
sendState();
// repaint monitors if the simulator was already running when this panel opened
requestScreens();
