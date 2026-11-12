// Microcontroller monitor display.
//
// The microcontroller's Lua runs in a worker thread of the extension host on
// Storm Lua Engine (src/engine/), which rasterises every monitor itself. What reaches
// this page is finished pictures, not draw calls:
//
//   {type:"screenConfig", screens:[{number,width,height,poweredOn,portrait,size}]}
//   {type:"screenPixels", frames:[{screen,width,height,pixels}]}
//
// `pixels` is the engine's "game-rgba8" frame for one monitor: width*height*4
// bytes of R,G,B,A in row order. Only monitors whose picture changed are
// listed; any other monitor keeps the picture it last got.
//
// One <canvas> per powered-on screen, sized in *logical* Stormworks pixels
// (32 per monitor block) and scaled up by CSS with image-rendering:pixelated,
// so the result looks like the chunky in-game monitor rather than a blurry
// upscale.
//
// There can be several: the engine runs onDraw once per powered-on screen
// with `screen.getWidth()/getHeight()` reporting that screen's size, exactly
// as the game does for a microcontroller wired to more than one monitor.
// Screens normally come from the script's own `simulator:setScreen` calls;
// the header controls here declare extra ones, which the host adds to the
// engine's screen list (see media/monitorConfig.js and src/engine/screens.ts).
// Panel-declared screens lose to the script's own setScreen for the same
// number.
//
// How a frame is shown. "game-rgba8" is the game's own 4-channel buffer, not
// premultiplied RGBA: the engine blends alpha with the same weights as the
// colour (docs/specs/screen.md, "RGBAとフレームの寿命", in storm-lua-engine
// v0.4.1), so rgb > alpha is a normal pixel, and a frame starts from
// transparent black. The spec's CanvasPresenter copies the bytes into an
// ImageData unchanged — no alpha correction, no gamma — and so does this
// file. ImageData is straight (non-premultiplied) RGBA, which is exactly what
// the bytes are, so nothing has to be converted on the way in. What the
// monitor *shows* is rgb × alpha (doc/ingame-findings.md, D9 and B4): the
// canvas composites the straight-alpha pixel over its CSS background, and
// .monitor-canvas's black background (panel.css) is what turns that into the
// multiplication. Keep it black.
//
// Repaints are coalesced into one animation frame (scheduleRepaint). Frames
// arrive at the simulator's cadence, not the display's, and only the newest
// one per monitor is worth uploading. A panel in a background tab keeps
// receiving messages (retainContextWhenHidden) but rAF doesn't run there, so
// it uploads nothing until it is visible again.

import {
  monitorsSection, monitorsList, monitorZoomEl, monitorAddEl
} from "./monitorDom.js";
import { sendTouch, sendScreenSet, sendScreenRemove } from "./monitorMessaging.js";
import {
  SCREEN_SIZES, DEFAULT_SIZE, MAX_SCREENS, nextScreenNumber, pixelsToSize, fitScale
} from "./monitorConfig.js";

/**
 * @typedef {object} ScreenInfo
 * @property {number} number
 * @property {number} width
 * @property {number} height
 * @property {boolean} poweredOn
 * @property {boolean} portrait
 * @property {string} [size] block size, e.g. "3x3"; derived when absent
 */

/**
 * One monitor's picture as the host posts it. `pixels` is typed loosely on
 * purpose: what survives the webview's message transfer is checked by
 * frameBytes() before anything trusts it.
 * @typedef {object} ScreenFrame
 * @property {number} screen
 * @property {number} width
 * @property {number} height
 * @property {unknown} pixels
 */

/**
 * @typedef {object} Monitor
 * @property {HTMLCanvasElement} canvas
 * @property {CanvasRenderingContext2D} ctx
 * @property {ImageData} img the upload buffer, reused for every frame
 * @property {Uint8Array | null} pending the newest frame not yet uploaded
 * @property {HTMLElement} name the "Screen 1 - 96x96 - 4x" caption
 * @property {HTMLSelectElement} sizeEl
 * @property {HTMLInputElement} portraitEl
 * @property {ScreenInfo} info
 */

/** @type {Map<number, Monitor>} */
const monitors = new Map();

/**
 * @param {string | number | undefined} v
 * @returns {number}
 */
function n(v) {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
}

// --- Scaling ---------------------------------------------------------------
//
// A 96x96 screen at 1:1 is unreadable, so every canvas is CSS-upscaled by an
// *integer* factor (with image-rendering:pixelated) to keep pixels square.
// "fit" picks the largest factor whose result still fits the monitors column;
// the fixed factors are applied as-is and simply overflow-scroll if too wide.
//
// Every monitor gets the SAME factor, fit included. Fitting each one to the
// column separately would scale a 1x1 up by 8 and a 3x3 by 2, so the small
// monitor would draw larger than the big one — which is the one thing a
// multi-monitor view has to get right. fitScale() in monitorConfig.js picks
// the largest factor that keeps them in one row, and falls back to what the
// widest can take once they have to wrap.

const MIN_SCALE = 1;
const MAX_SCALE = 16;
/** Used before the section is laid out (clientWidth is 0 while hidden). */
const FALLBACK_WIDTH = 480;
/** The canvas' 1px border on each side is not available to the pixels. */
const CANVAS_CHROME = 2;
/** #monitors-list's flex gap, in px. Kept in step with panel.css. */
const MONITOR_GAP = 10;

/** Current selection: "fit", or a fixed integer factor as a string. */
let zoomMode = "fit";
/**
 * Continuous value the pinch gesture accumulates into; the applied factor is
 * its round(). Keeping the fraction means a slow pinch still advances instead
 * of being rounded away on every event. Only read while zoomMode is fixed.
 */
let zoomFloat = 4;

/**
 * The one factor every monitor is drawn at.
 * @returns {number} integer CSS upscale factor
 */
function currentScale() {
  const fixed = parseInt(zoomMode, 10);
  if (Number.isFinite(fixed) && fixed > 0) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, fixed));
  }
  const widths = Array.from(monitors.values(), m => m.canvas.width);
  return fitScale(widths, monitorsList.clientWidth || FALLBACK_WIDTH, {
    gap: MONITOR_GAP, chrome: CANVAS_CHROME, min: MIN_SCALE, max: MAX_SCALE
  });
}

/**
 * @param {Monitor} m
 * @param {number} scale
 */
function applyScale(m, scale) {
  const w = m.canvas.width, h = m.canvas.height;
  m.canvas.style.width = `${w * scale}px`;
  m.canvas.style.height = `${h * scale}px`;
  m.name.textContent = `Screen ${Math.round(n(m.info.number))} — ${w}x${h} · ${scale}×`;
}

/** Re-run the scale calculation for every live monitor. */
function relayout() {
  const scale = currentScale();
  for (const m of monitors.values()) applyScale(m, scale);
}

monitorZoomEl.addEventListener("change", () => {
  zoomMode = monitorZoomEl.value;
  const fixed = parseFloat(zoomMode);
  if (Number.isFinite(fixed)) zoomFloat = fixed;
  dropCustomOption();
  relayout();
});

// --- Pinch zoom ------------------------------------------------------------
//
// A macOS trackpad pinch reaches Chromium (which is what a VSCode webview
// runs on) as a wheel event with ctrlKey set — there is no separate pinch
// event, and Safari's gesture* events don't exist here. Ctrl/Cmd + a real
// mouse wheel produces the same shape and means the same thing, so both are
// handled together. preventDefault is required: otherwise the webview
// browser-zooms the whole panel instead.

/** deltaY per e-fold of scale. Chosen so a full trackpad pinch spans 1x-16x. */
const ZOOM_SENSITIVITY = 0.01;
/** A mouse notch is ~100px of deltaY; cap it so one notch isn't a 3x jump. */
const MAX_STEP = 40;

/**
 * Wheel deltas come in pixels, lines or pages depending on the device.
 * @param {WheelEvent} e
 * @returns {number} deltaY in pixels
 */
function wheelPixels(e) {
  if (e.deltaMode === 1) return e.deltaY * 16;    // lines
  if (e.deltaMode === 2) return e.deltaY * 100;   // pages
  return e.deltaY;
}

/**
 * Where a gesture starts from: the live fixed factor, or — in "fit" mode —
 * whatever fit is currently showing, so the first pinch doesn't jump.
 * @returns {number}
 */
function currentZoomFloat() {
  return zoomMode === "fit" ? currentScale() : zoomFloat;
}

monitorsSection.addEventListener("wheel", e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, wheelPixels(e)));
  // Pinch out (negative deltaY) magnifies; exponential so each pinch of the
  // same size changes the scale by the same ratio.
  const next = currentZoomFloat() * Math.exp(-step * ZOOM_SENSITIVITY);
  zoomFloat = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  zoomMode = String(Math.round(zoomFloat));
  showZoomOption(zoomMode);

  const anchor = anchorUnder(e);
  relayout();
  if (anchor) keepAnchored(anchor);
}, { passive: false });

// --- Cursor anchoring ------------------------------------------------------
//
// Growing a canvas moves the pixel under the cursor away from it, so the
// gesture feels like it zooms the top-left corner. Instead: remember which
// logical (Stormworks) pixel the cursor is over, then after the relayout
// scroll it back under the cursor. The anchor is recomputed from the real
// post-layout rect rather than scaled by the zoom ratio — the labels, gaps
// and flex wrapping around the canvas don't scale with it.

/**
 * @typedef {object} ZoomAnchor
 * @property {HTMLCanvasElement} canvas
 * @property {number} lx logical pixel X under the cursor
 * @property {number} ly logical pixel Y under the cursor
 * @property {number} clientX where to put it back
 * @property {number} clientY
 */

/**
 * @param {WheelEvent} e
 * @returns {ZoomAnchor | null} null when the cursor isn't over a monitor
 */
function anchorUnder(e) {
  const canvas = e.target instanceof HTMLCanvasElement ? e.target : null;
  if (!canvas || !canvas.classList.contains("monitor-canvas")) return null;
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    canvas,
    lx: (e.clientX - r.left) * (canvas.width / r.width),
    ly: (e.clientY - r.top) * (canvas.height / r.height),
    clientX: e.clientX,
    clientY: e.clientY
  };
}

/** @param {ZoomAnchor} a */
function keepAnchored(a) {
  const r = a.canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const sx = r.width / a.canvas.width, sy = r.height / a.canvas.height;
  // Whole pixels: a fractional scroll offset would blur the pixelated canvas.
  const dx = Math.round(r.left + a.lx * sx - a.clientX);
  const dy = Math.round(r.top + a.ly * sy - a.clientY);
  nudgeScroll(a.canvas.parentElement, dx, dy);
}

/**
 * Push the delta through the scrollable ancestors, innermost first: the
 * .monitor wrapper scrolls horizontally, #monitors-list vertically, and each
 * consumes only what it can (non-scrollable ones consume nothing and pass it
 * on).
 * @param {HTMLElement | null} from
 * @param {number} dx @param {number} dy
 */
function nudgeScroll(from, dx, dy) {
  for (let node = from; node && (dx || dy); node = node.parentElement) {
    if (dx) {
      const before = node.scrollLeft;
      node.scrollLeft = before + dx;
      dx -= node.scrollLeft - before;
    }
    if (dy) {
      const before = node.scrollTop;
      node.scrollTop = before + dy;
      dy -= node.scrollTop - before;
    }
    if (node === monitorsSection) return;
  }
}

/**
 * The <select> only lists a few preset factors, but a pinch can land on any
 * integer — park those on one reusable option kept in numeric order.
 * @type {HTMLOptionElement | null}
 */
let customOption = null;

function dropCustomOption() {
  if (!customOption) return;
  customOption.remove();
  customOption = null;
}

/** @param {string} value integer factor as a string */
function showZoomOption(value) {
  const preset = Array.from(monitorZoomEl.options)
    .some(o => o.value === value && o !== customOption);
  if (preset) {
    dropCustomOption();
    monitorZoomEl.value = value;
    return;
  }
  if (!customOption) {
    customOption = document.createElement("option");
    monitorZoomEl.appendChild(customOption);
  }
  customOption.value = value;
  customOption.textContent = `${value}×`;

  const v = parseInt(value, 10);
  const after = Array.from(monitorZoomEl.options)
    .find(o => o !== customOption && parseInt(o.value, 10) > v);
  monitorZoomEl.insertBefore(customOption, after ?? null);
  monitorZoomEl.value = value;
}

// Fit mode depends on the column width, which changes with the panel/sidebar.
let lastWidth = -1;
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    const w = monitorsList.clientWidth;
    if (w === lastWidth) return;   // height-only changes can't affect the fit
    lastWidth = w;
    if (zoomMode === "fit") relayout();
  }).observe(monitorsList);
}

// --- Screen configuration -------------------------------------------------

/**
 * Rebuild the monitor list. Screens that vanish or power off lose their canvas.
 * @param {ScreenInfo[]} screens
 */
export function applyScreenConfig(screens) {
  const live = new Set();

  for (const s of screens) {
    if (!s || !s.poweredOn) continue;
    const num = Math.round(n(s.number));
    const w = Math.max(1, Math.round(n(s.width)));
    const h = Math.max(1, Math.round(n(s.height)));
    live.add(num);

    const existing = monitors.get(num);
    if (existing && existing.canvas.width === w && existing.canvas.height === h) {
      existing.info = s;
      // Same pixels, possibly a different declaration behind them — a 3x3
      // turned portrait keeps its 96x96 canvas but must not leave the
      // portrait box unticked.
      syncControls(existing);
      continue;
    }
    if (existing) existing.canvas.parentElement?.remove();
    monitors.set(num, createMonitor(num, w, h, s));
  }

  for (const [num, m] of Array.from(monitors)) {
    if (live.has(num)) continue;
    m.canvas.parentElement?.remove();
    monitors.delete(num);
  }

  // Keep the panel order stable regardless of the order screens arrive in.
  const wrappers = Array.from(monitors.keys()).sort((a, b) => a - b);
  for (const num of wrappers) {
    const wrapper = monitors.get(num)?.canvas.parentElement;
    if (wrapper) monitorsList.appendChild(wrapper);
  }

  monitorsSection.classList.toggle("hidden", monitors.size === 0);
  // The splitter — and any height dragged with it — only mean something while
  // a monitor is on screen; panel.css keys both off this class.
  document.body.classList.toggle("no-monitors", monitors.size === 0);
  monitorAddEl.disabled = monitors.size >= MAX_SCREENS;
  // Screen 1 is the default monitor (LifeBoatAPI's too) and the only one whose
  // touch and size reach the composite inputs (the prelude's per-tick
  // defaults, src/engine/prelude.ts), so removing it would leave a run no
  // script can talk to.
  for (const [num, m] of monitors) {
    const remove = m.canvas.parentElement?.querySelector(".monitor-remove");
    if (remove instanceof HTMLButtonElement) remove.disabled = num === 1;
  }
  // After unhiding, monitorsList finally has a real clientWidth for "fit".
  relayout();
  // No repaint here. A monitor that kept its size keeps its picture, and a
  // new or resized one has none to show until a frame of its new size
  // arrives — the old picture would not fit it.
}

/**
 * @param {number} num
 * @param {number} w
 * @param {number} h
 * @param {ScreenInfo} info
 * @returns {Monitor}
 */
function createMonitor(num, w, h, info) {
  const wrapper = document.createElement("div");
  wrapper.className = "monitor";

  const label = document.createElement("div");
  label.className = "monitor-label";

  const name = document.createElement("span");
  name.className = "monitor-name";
  name.textContent = `Screen ${num} — ${w}x${h}`;

  const sizeEl = document.createElement("select");
  sizeEl.className = "monitor-size";
  sizeEl.title = "Monitor block size, as simulator:setScreen spells it.";
  for (const size of SCREEN_SIZES) {
    const opt = document.createElement("option");
    opt.value = size;
    opt.textContent = size;
    sizeEl.appendChild(opt);
  }

  const portraitLabel = document.createElement("label");
  portraitLabel.className = "monitor-portrait";
  portraitLabel.title = "Stand the monitor on its end (swaps width and height).";
  const portraitEl = document.createElement("input");
  portraitEl.type = "checkbox";
  portraitLabel.appendChild(portraitEl);
  portraitLabel.appendChild(document.createTextNode("Portrait"));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "monitor-remove";
  remove.textContent = "\u2715";
  remove.title = "Power this monitor off and drop it from the panel.";

  label.append(name, sizeEl, portraitLabel, remove);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.className = "monitor-canvas";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PhySim panel: 2D canvas context unavailable");
  // A fresh canvas is transparent black, which is also what an engine frame
  // starts from, so the monitor reads as blank until its first frame.
  const img = ctx.createImageData(w, h);

  wrapper.appendChild(label);
  wrapper.appendChild(canvas);
  monitorsList.appendChild(wrapper);

  attachTouch(canvas, num);
  /** @type {Monitor} */
  const m = { canvas, ctx, img, pending: null, name, sizeEl, portraitEl, info };
  syncControls(m);

  // The host is what actually changes anything; the controls only ask. It
  // answers with a screenConfig that rebuilds this monitor, so a request Lua
  // or the host declines simply leaves the widgets where they were.
  const push = () => sendScreenSet({
    screen: num, size: sizeEl.value, portrait: portraitEl.checked, poweredOn: true
  });
  sizeEl.addEventListener("change", push);
  portraitEl.addEventListener("change", push);
  remove.addEventListener("click", () => sendScreenRemove(num));

  applyScale(m, currentScale());
  return m;
}

/**
 * Point the size/portrait widgets at what the screen actually is. `size` comes
 * from the host when it knows it; a screen the microcontroller declared is
 * only ever reported to us in pixels, so it is derived back into blocks.
 * @param {Monitor} m
 */
function syncControls(m) {
  const info = m.info;
  const portrait = info.portrait === true;
  const size = typeof info.size === "string" && info.size
    ? info.size
    : pixelsToSize(m.canvas.width, m.canvas.height, portrait);
  // A script is free to call setScreen("4x4"); show it rather than snapping
  // the dropdown to something the user never chose.
  if (!Array.from(m.sizeEl.options).some(o => o.value === size)) {
    const opt = document.createElement("option");
    opt.value = size;
    opt.textContent = size;
    m.sizeEl.appendChild(opt);
  }
  m.sizeEl.value = size;
  m.portraitEl.checked = portrait;
}

monitorAddEl.addEventListener("click", () => {
  const screen = nextScreenNumber(monitors.keys());
  if (!screen) return;
  sendScreenSet({ screen, size: DEFAULT_SIZE, portrait: false, poweredOn: true });
});

// --- Frames ----------------------------------------------------------------

/**
 * The bytes of a posted frame, whatever shape the message transfer left them
 * in: the host posts a Uint8Array, but a structured clone may hand over
 * another view type or the bare ArrayBuffer. Anything else is not a frame.
 * @param {unknown} pixels
 * @returns {Uint8Array | null}
 */
function frameBytes(pixels) {
  if (pixels instanceof Uint8Array) return pixels;
  if (ArrayBuffer.isView(pixels)) {
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }
  if (pixels instanceof ArrayBuffer) return new Uint8Array(pixels);
  return null;
}

/**
 * Take the pictures of the monitors that changed. The upload waits for the
 * next animation frame — see scheduleRepaint.
 *
 * A frame is dropped, not stretched or cropped, when it doesn't fit the
 * monitor it names. That happens legitimately: a frame drawn just before a
 * resize can arrive after the screenConfig that resized the canvas, and the
 * next frame at the new size replaces it anyway.
 * @param {ScreenFrame[]} frames
 */
export function applyScreenPixels(frames) {
  let changed = false;
  for (const f of frames) {
    if (!f || typeof f !== "object") continue;
    const m = monitors.get(Math.round(n(f.screen)));
    if (!m) continue;
    const w = m.canvas.width, h = m.canvas.height;
    if (n(f.width) !== w || n(f.height) !== h) continue;
    const bytes = frameBytes(f.pixels);
    if (!bytes || bytes.byteLength !== w * h * 4) continue;
    m.pending = bytes;
    changed = true;
  }
  if (changed) scheduleRepaint();
}

/** Whether a repaint is already booked for the next animation frame. */
let repaintPending = false;

/**
 * Book a repaint for the next animation frame, at most one per frame.
 *
 * Frames arrive from the simulator at its own cadence, not the display's, and
 * only the newest one per monitor is worth uploading — `pending` already
 * holds it. This also means a hidden panel does no drawing at all: the
 * webview keeps receiving messages while hidden (retainContextWhenHidden),
 * but rAF doesn't run, so the work is skipped and resumes with the latest
 * frames on the callback that fires when the panel comes back.
 */
function scheduleRepaint() {
  if (repaintPending) return;
  repaintPending = true;
  requestAnimationFrame(() => {
    repaintPending = false;
    repaint();
  });
}

function repaint() {
  for (const m of monitors.values()) {
    if (!m.pending) continue;
    // Copied as they are: the bytes are already straight RGBA, which is what
    // ImageData holds. See the top of this file for why no alpha or gamma
    // step belongs here.
    m.img.data.set(m.pending);
    m.pending = null;
    m.ctx.putImageData(m.img, 0, 0);
  }
}

// --- Pointer input ---------------------------------------------------------

/**
 * Pointer input for one monitor. The move-coalescing state is per canvas: with
 * several monitors on screen a pointer-up on one would otherwise cancel a
 * queued move belonging to another, and two pens or touch points dragging on
 * different monitors would overwrite each other's position.
 * @param {HTMLCanvasElement} canvas
 * @param {number} screen
 */
function attachTouch(canvas, screen) {
  let down = false;
  /** Coalesce pointermove floods to one TOUCH per animation frame. */
  let movePending = false;
  /** @type {{x:number,y:number} | null} */
  let queuedMove = null;

  /**
   * @param {PointerEvent} e
   * @returns {{x:number,y:number}}
   */
  const toPixels = e => {
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? canvas.width / r.width : 1;
    const sy = r.height > 0 ? canvas.height / r.height : 1;
    const x = Math.floor((e.clientX - r.left) * sx);
    const y = Math.floor((e.clientY - r.top) * sy);
    return {
      x: Math.min(canvas.width - 1, Math.max(0, x)),
      y: Math.min(canvas.height - 1, Math.max(0, y))
    };
  };

  canvas.addEventListener("pointerdown", e => {
    down = true;
    canvas.setPointerCapture(e.pointerId);
    const p = toPixels(e);
    sendTouch({ screen, isTouched: 1, isTouchedAlt: 0, x: p.x, y: p.y, xAlt: 0, yAlt: 0 });
  });

  canvas.addEventListener("pointermove", e => {
    if (!down) return;
    const p = toPixels(e);
    queuedMove = { x: p.x, y: p.y };
    if (movePending) return;
    movePending = true;
    requestAnimationFrame(() => {
      movePending = false;
      const q = queuedMove;
      queuedMove = null;
      if (q) sendTouch({ screen, isTouched: 1, isTouchedAlt: 0, x: q.x, y: q.y, xAlt: 0, yAlt: 0 });
    });
  });

  /** @param {PointerEvent} e */
  const release = e => {
    if (!down) return;
    down = false;
    queuedMove = null;
    const p = toPixels(e);
    sendTouch({ screen, isTouched: 0, isTouchedAlt: 0, x: p.x, y: p.y, xAlt: 0, yAlt: 0 });
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", release);
}
