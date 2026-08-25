// CSV channel logging — the webview half.
//
// The file itself is written by the extension host (src/csvLogger.ts); this
// module decides *when* a row exists, formats it (media/csv.js) and ships
// batches over postMessage. The host is deliberately dumb about channels: the
// first line it receives is the header this module sends on start.
//
// Sampling mirrors visuals.js: a row per simulated TICK (simulation.js calls
// logTick from inside its fixed-timestep loop, so a throttled rAF can't
// coarsen the log), plus a row per state send while nothing is ticking —
// which is what captures gizmo drags and typed poses. The sample counter and
// the tick/send de-duplication live in csv.js so the tests can drive them.
//
// Starting is a two-step round trip. csvStart asks the host for a file; the
// host acks with csvDialog the moment the native save dialog goes up, and
// answers with csvState once the user has picked a path or cancelled.
//
// The ack is what separates "the dialog is open, possibly behind another
// window" from "this extension host has never heard of csvStart" — the second
// is what a stale out/ looks like from in here, and with no ack it greyed the
// button out for two minutes with no error anywhere in the panel, the log, or
// the notifications. So: no ack within ACK_TIMEOUT_MS and we say so; after the
// ack we wait as long as the dialog needs, with a watchdog so a reply that
// never comes can't wedge the panel. The host ignores a second csvStart while
// its dialog is up.

import { vscode } from "./vscodeApi.js";
import { CSV_HEADER, createLog, tickRow, sendRow } from "./csv.js";
import { csvBtn, csvCountEl } from "./dom.js";

// Rows are batched: at 60 ticks/s a message per row would be ~60 postMessage
// round trips a second for a file write that is happy to see them in chunks.
const FLUSH_MS = 250;
const MAX_PENDING = 240;      // ~4 s of ticks — flush early rather than grow
const START_TIMEOUT_MS = 120000;   // a save dialog can legitimately sit open
const ACK_TIMEOUT_MS = 3000;       // the host's "dialog is up" is a local round trip
/** Toolbar text when csvStart goes unanswered — almost always an old host. */
const NO_HOST_NOTICE = "no response";
const NO_HOST_HELP =
  "The extension host did not answer the CSV request. It is most likely running "
  + "an older build than this panel (media/ is read from disk, out/ is not) — "
  + "run npm run compile and restart the extension host, or reinstall the .vsix.";

let logging = false;
let pendingStart = false;     // waiting for the host's answer to csvStart
let log = createLog(0);
/** @type {string[]} */
let pending = [];
/** @type {number} */
let flushTimer = 0;
/** @type {number} */
let startWatchdog = 0;
/** @type {number} */
let startAck = 0;
/** Shown in place of the row count when something went wrong. */
let notice = "";

export function isLogging() { return logging; }

function updateButton() {
  csvBtn.classList.toggle("recording", logging);
  csvBtn.textContent = pendingStart
    ? "… Choose a file"
    : (logging ? "■ Stop CSV" : "⬇ CSV Log");
  csvBtn.title = pendingStart
    ? "Waiting for the save dialog — it may have opened behind another window"
    : "Stream CH1-17 to a CSV file for offline analysis";
  csvBtn.disabled = pendingStart;
}

function clearStartTimers() {
  if (startWatchdog) { clearTimeout(startWatchdog); startWatchdog = 0; }
  if (startAck) { clearTimeout(startAck); startAck = 0; }
}

function updateCount() {
  csvCountEl.textContent = logging ? `${log.sample} rows` : notice;
  csvCountEl.title = !logging && notice ? NO_HOST_HELP : "";
  csvCountEl.classList.toggle("warn", !logging && notice !== "");
}

function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  if (pending.length === 0) return;
  vscode.postMessage({ type: "csvRows", rows: pending });
  pending = [];
  updateCount();
}

/** @param {string} row */
function append(row) {
  pending.push(row);
  if (pending.length >= MAX_PENDING) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/**
 * Record one simulated tick (or one played-back frame).
 * @param {import("./channels.js").PhysStateLike} s
 */
export function logTick(s) {
  if (!logging) return;
  append(tickRow(log, performance.now(), s));
}

/**
 * Record a state that is about to go on the wire. Skipped when a tick already
 * produced a row for it this frame.
 * @param {import("./channels.js").PhysStateLike} s
 */
export function logSend(s) {
  if (!logging) return;
  const row = sendRow(log, performance.now(), s);
  if (row !== null) append(row);
}

/**
 * Host → webview: the save dialog is on screen. Nothing to do but stop the
 * countdown — from here the wait belongs to the user, however long they take.
 */
export function applyCsvDialog() {
  if (!pendingStart) return;
  if (startAck) { clearTimeout(startAck); startAck = 0; }
  notice = "";
  updateCount();
}

/**
 * Host → webview: the authoritative logging state. Sent in reply to csvStart
 * (false if the user cancelled the save dialog or the file could not be
 * opened) and to csvStop.
 * @param {{logging?: unknown}} msg
 */
export function applyCsvState(msg) {
  const on = msg.logging === true;
  pendingStart = false;
  notice = "";
  clearStartTimers();
  if (on && !logging) {
    log = createLog(performance.now());
    pending = [];
    logging = true;
    append(CSV_HEADER);     // the host writes whatever it is handed, header included
  } else if (!on && logging) {
    logging = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    pending = [];           // the stop below already flushed; the file is closed
  }
  updateButton();
  updateCount();
}

csvBtn.addEventListener("click", () => {
  if (logging) {
    // Stop is not refusable, so drop out of logging immediately — rows added
    // between here and the host's reply would arrive after the file closed.
    flush();
    logging = false;
    vscode.postMessage({ type: "csvStop", samples: log.sample });
    updateButton();
    updateCount();
  } else {
    if (pendingStart) return;
    pendingStart = true;
    notice = "";
    updateButton();
    updateCount();
    vscode.postMessage({ type: "csvStart" });
    clearStartTimers();
    // No csvDialog ack means the host isn't handling csvStart at all. Say so
    // in the toolbar: silence here is what made a stale build look like a
    // broken button rather than an out-of-date extension.
    startAck = setTimeout(() => {
      startAck = 0;
      if (!pendingStart) return;
      pendingStart = false;
      notice = NO_HOST_NOTICE;
      updateButton();
      updateCount();
    }, ACK_TIMEOUT_MS);
    // The dialog did open, but no answer ever came. Give the button back
    // instead of leaving the panel with a permanently dead control.
    startWatchdog = setTimeout(() => {
      startWatchdog = 0;
      if (!pendingStart) return;
      pendingStart = false;
      updateButton();
    }, START_TIMEOUT_MS);
  }
});

updateButton();
