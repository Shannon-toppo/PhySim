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
// Starting is a round trip: the host may put a save dialog in front of the
// user and they may cancel it, so the button only lights up once the host
// answers with a csvState message. While waiting, the button says so rather
// than just greying out — the dialog is native and can end up behind another
// window (on Windows the LifeBoatAPI simulator exe is a separate top-level
// window), and a silent grey button looks exactly like a dead feature. A
// watchdog re-enables it so a reply that never comes can't wedge the panel;
// the host ignores a second csvStart while its dialog is up.

import { vscode } from "./vscodeApi.js";
import { CSV_HEADER, createLog, tickRow, sendRow } from "./csv.js";
import { csvBtn, csvCountEl } from "./dom.js";

// Rows are batched: at 60 ticks/s a message per row would be ~60 postMessage
// round trips a second for a file write that is happy to see them in chunks.
const FLUSH_MS = 250;
const MAX_PENDING = 240;      // ~4 s of ticks — flush early rather than grow
const START_TIMEOUT_MS = 120000;   // a save dialog can legitimately sit open

let logging = false;
let pendingStart = false;     // waiting for the host's answer to csvStart
let log = createLog(0);
/** @type {string[]} */
let pending = [];
/** @type {number} */
let flushTimer = 0;
/** @type {number} */
let startWatchdog = 0;

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

function clearStartWatchdog() {
  if (startWatchdog) { clearTimeout(startWatchdog); startWatchdog = 0; }
}

function updateCount() {
  csvCountEl.textContent = logging ? `${log.sample} rows` : "";
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
 * Host → webview: the authoritative logging state. Sent in reply to csvStart
 * (false if the user cancelled the save dialog or the file could not be
 * opened) and to csvStop.
 * @param {{logging?: unknown}} msg
 */
export function applyCsvState(msg) {
  const on = msg.logging === true;
  pendingStart = false;
  clearStartWatchdog();
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
    updateButton();
    vscode.postMessage({ type: "csvStart" });
    // If the host never answers, give the button back instead of leaving the
    // panel with a permanently dead control.
    clearStartWatchdog();
    startWatchdog = setTimeout(() => {
      startWatchdog = 0;
      if (!pendingStart) return;
      pendingStart = false;
      updateButton();
    }, START_TIMEOUT_MS);
  }
});

updateButton();
