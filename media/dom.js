// DOM element registry and input-sync helpers for the PhySim webview.
// All getElementById lookups live here so the other modules import typed
// references instead of re-querying. Also owns the single re-entry guard
// shared by every sync helper (see syncGuard).

import { deriveChannels } from "./channels.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function mustGet(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error("PhySim panel: missing element #" + id);
  return el;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function mustGetInput(id) {
  return /** @type {HTMLInputElement} */ (mustGet(id));
}

export const viewport = mustGet("viewport");
export const modeButtons = /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll("#toolbar button.mode")));
export const resetBtn = mustGet("reset");
export const simBtn = mustGet("simulate");
export const recBtn = mustGet("record");
export const playBtn = /** @type {HTMLButtonElement} */ (mustGet("play"));
export const recCountEl = mustGet("rec-count");

// Monitor stand-in for LifeBoatAPI's Windows-only simulator exe (macOS).
// Starts hidden; mcScreen.js unhides it once a screenConfig arrives.
export const monitorsSection = mustGet("monitors");
export const monitorsList = mustGet("monitors-list");
export const monitorZoomEl = /** @type {HTMLSelectElement} */ (mustGet("monitor-zoom"));
export const monitorTrueColourEl = /** @type {HTMLInputElement} */ (mustGet("monitor-truecolour"));

// vx-vz: linear velocity, ax-az: angular velocity (CH7-12, sent on the wire).
// lax-laz / aax-aaz: linear / angular acceleration — webview-only, they drive
// the velocities during simulation but are never sent as channels.
export const VEL_KEYS   = ["vx", "vy", "vz", "ax", "ay", "az"];
export const ACCEL_KEYS = ["lax", "lay", "laz", "aax", "aay", "aaz"];
export const SLIDER_KEYS = [...VEL_KEYS, ...ACCEL_KEYS];

/** @type {Record<string, HTMLInputElement>} */
export const sliders = {};
/** @type {Record<string, HTMLInputElement>} */
export const numInputs = {};
for (const k of SLIDER_KEYS) {
  sliders[k]   = mustGetInput(k);
  numInputs[k] = mustGetInput(k + "-num");
}

export const POSE_KEYS = ["px", "py", "pz", "rx", "ry", "rz"];
/** @type {Record<string, HTMLInputElement>} */
export const poseInputs = {};
for (const k of POSE_KEYS) poseInputs[k] = mustGetInput(k + "-num");

/** @type {Record<number, HTMLElement>} */
export const channelOut = {};
for (let i = 1; i <= 17; i++) channelOut[i] = mustGet("c" + i);

// Motion visualisation toggles (media/visuals.js owns their behaviour).
export const vizTrailEl      = /** @type {HTMLInputElement} */ (mustGet("viz-trail"));
export const vizTrailLenEl   = /** @type {HTMLSelectElement} */ (mustGet("viz-trail-len"));
export const vizTrailClearBtn = mustGet("viz-trail-clear");
export const vizVelEl        = /** @type {HTMLInputElement} */ (mustGet("viz-vel"));

// preset UI elements
export const presetNameEl    = /** @type {HTMLInputElement} */ (mustGet("preset-name"));
export const presetListEl    = /** @type {HTMLSelectElement} */ (mustGet("preset-list"));
export const presetSaveBtn   = mustGet("preset-save");
export const presetLoadBtn   = mustGet("preset-load");
export const presetDeleteBtn = mustGet("preset-delete");

// Single re-entry guard shared by ALL sync helpers — slider⇄number below AND
// pose⇄gizmo in pose.js. The original monolith used one flag for both; keep
// it that way, splitting it would subtly change the re-entrancy behaviour.
export const syncGuard = { active: false };

// The range slider clamps to its min/max but the number input accepts
// arbitrary values; on typed input we let the slider clamp visually but keep
// the raw number for transmission. Each pair stays in sync without firing
// recursive events thanks to the guard flag.

/** @param {string} k */
export function syncSliderFromNum(k) {
  if (syncGuard.active) return;
  syncGuard.active = true;
  const n = parseFloat(numInputs[k].value);
  sliders[k].value = Number.isFinite(n) ? String(n) : "0";  // slider auto-clamps
  syncGuard.active = false;
}

/** @param {string} k */
export function syncNumFromSlider(k) {
  if (syncGuard.active) return;
  syncGuard.active = true;
  numInputs[k].value = sliders[k].value;
  syncGuard.active = false;
}

/**
 * The number input holds the source-of-truth value (may exceed slider
 * range); fall back to the slider only if it's empty/invalid.
 * @param {string} k
 * @returns {number}
 */
export function readNum(k) {
  const n = parseFloat(numInputs[k].value);
  return Number.isFinite(n) ? n : (parseFloat(sliders[k].value) || 0);
}

/**
 * String(n) round-trips a JS number exactly, so the input stays the precise
 * source of truth; the slider just tracks it visually (and auto-clamps).
 * @param {string} k
 * @param {number} n
 */
export function writeNum(k, n) {
  numInputs[k].value = String(n);
  sliders[k].value = String(n);
}

/** @param {import("./channels.js").PhysStateLike} s */
export function refreshChannelTable(s) {
  channelOut[1].textContent  = s.position[0].toFixed(3);
  channelOut[2].textContent  = s.position[1].toFixed(3);
  channelOut[3].textContent  = s.position[2].toFixed(3);
  channelOut[4].textContent  = s.rotation[0].toFixed(3);
  channelOut[5].textContent  = s.rotation[1].toFixed(3);
  channelOut[6].textContent  = s.rotation[2].toFixed(3);
  channelOut[7].textContent  = s.velocity[0].toFixed(3);
  channelOut[8].textContent  = s.velocity[1].toFixed(3);
  channelOut[9].textContent  = s.velocity[2].toFixed(3);
  channelOut[10].textContent = s.angularVelocity[0].toFixed(3);
  channelOut[11].textContent = s.angularVelocity[1].toFixed(3);
  channelOut[12].textContent = s.angularVelocity[2].toFixed(3);

  // derived channels (CH13-17) — math lives in channels.js; the Lua twin in
  // PhySim.lua:injectAsInputs is guarded by test/parity.test.mjs
  const d = deriveChannels(s);
  channelOut[13].textContent = d.linAbs.toFixed(3);
  channelOut[14].textContent = d.angAbs.toFixed(3);
  channelOut[15].textContent = d.tiltZ.toFixed(4);
  channelOut[16].textContent = d.tiltX.toFixed(4);
  channelOut[17].textContent = d.compass.toFixed(4);
}
