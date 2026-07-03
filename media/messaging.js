// State streaming: webview → extension host. readState() is the single
// source of the wire-visible state shape; sendState() also refreshes the
// channel table so the display always matches what was sent.

import { vscode } from "./vscodeApi.js";
import { readNum, refreshChannelTable } from "./dom.js";
import { targetGroup } from "./scene.js";

let pending = false;
export function scheduleSend() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; sendState(); });
}

/** @returns {import("./channels.js").PhysStateLike} */
export function readState() {
  return {
    position: [targetGroup.position.x, targetGroup.position.y, targetGroup.position.z],
    rotation: [targetGroup.rotation.x, targetGroup.rotation.y, targetGroup.rotation.z],
    velocity: [readNum("vx"), readNum("vy"), readNum("vz")],
    angularVelocity: [readNum("ax"), readNum("ay"), readNum("az")]
  };
}

export function sendState() {
  const s = readState();
  refreshChannelTable(s);
  vscode.postMessage({ type: "state", ...s });
}
