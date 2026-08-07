// State streaming: webview → extension host. readState() is the single
// source of the wire-visible state shape; sendState() also refreshes the
// channel table so the display always matches what was sent.

import { vscode } from "./vscodeApi.js";
import { normalizeAngle } from "./channels.js";
import { readNum, refreshChannelTable } from "./dom.js";
import { targetGroup } from "./scene.js";

let pending = false;
export function scheduleSend() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; sendState(); });
}

/**
 * The gizmo's own Euler angles are unbounded (the integrator keeps adding to
 * them, and the pose inputs accept any number), so rotation is normalized to
 * [-π, π) here — CH4–6, the channel table and the wire all see the wrapped
 * value. lua/PhySim.lua wraps again on parse, which is idempotent.
 * @returns {import("./channels.js").PhysStateLike}
 */
export function readState() {
  return {
    position: [targetGroup.position.x, targetGroup.position.y, targetGroup.position.z],
    rotation: [
      normalizeAngle(targetGroup.rotation.x),
      normalizeAngle(targetGroup.rotation.y),
      normalizeAngle(targetGroup.rotation.z)
    ],
    velocity: [readNum("vx"), readNum("vy"), readNum("vz")],
    angularVelocity: [readNum("ax"), readNum("ay"), readNum("az")]
  };
}

export function sendState() {
  const s = readState();
  refreshChannelTable(s);
  vscode.postMessage({ type: "state", ...s });
}

/**
 * Monitor touch input (macOS monitor stand-in). The host relays this as a
 * TOUCH frame to the Lua simulator; every field must be present because the
 * Lua-side split() drops empty ones.
 * @typedef {object} TouchState
 * @property {number} screen
 * @property {number} isTouched
 * @property {number} isTouchedAlt
 * @property {number} x
 * @property {number} y
 * @property {number} xAlt
 * @property {number} yAlt
 *
 * @param {TouchState} t
 */
export function sendTouch(t) {
  vscode.postMessage({ type: "touch", ...t });
}

/**
 * Ask the host to repaint the monitors. Called once at load so a panel opened
 * mid-session isn't blank until the next screen config.
 */
export function requestScreens() {
  vscode.postMessage({ type: "screenRequest" });
}
