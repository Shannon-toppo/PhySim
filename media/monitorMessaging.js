// Monitor messages: webview → extension host. Shared by the main panel and
// the stand-alone monitor window, so it imports nothing but the vscode API.

import { vscode } from "./vscodeApi.js";

/**
 * Monitor touch input. The host relays this as a TOUCH frame to the Lua
 * simulator; every field must be present because the Lua-side split() drops
 * empty ones.
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
 * mid-session isn't blank until the next screen config. The host only answers
 * the webview that is currently showing the monitors.
 */
export function requestScreens() {
  vscode.postMessage({ type: "screenRequest" });
}

/**
 * Declare or reconfigure one monitor. The host validates before it forwards
 * anything to Lua, and answers with a fresh screenConfig — the controls are
 * never authoritative on their own, so a rejected size simply doesn't stick.
 * @param {{screen: number, size: string, poweredOn?: boolean, portrait?: boolean}} s
 */
export function sendScreenSet(s) {
  vscode.postMessage({ type: "screenSet", poweredOn: true, portrait: false, ...s });
}

/**
 * Drop a monitor. Lua has no delete for its `_screens` table, so this powers
 * the screen off; the microcontroller can bring it back with `setScreen`.
 * @param {number} screen
 */
export function sendScreenRemove(screen) {
  vscode.postMessage({ type: "screenRemove", screen });
}
