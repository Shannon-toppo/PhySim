// Microcontroller monitor rendering.
//
// Normally the LifeBoatAPI simulator draws the MC's screens in its own
// STORMWORKS_Simulator.exe window. That exe is Windows-only, so on macOS the
// extension host always stands in for it (src/simStubServer.ts) — and on
// Windows it can be asked to, via the experimental
// `physim.monitors.useBuiltInOnWindows` setting. Either way the host forwards
// two messages here:
//
//   {type:"screenConfig", screens:[{number,width,height,poweredOn,portrait}]}
//   {type:"screenFrame",  commands:[["RECT",1,1,0,0,32,32], ...]}
//
// One <canvas> per powered-on screen, sized in *logical* Stormworks pixels
// (32 per monitor block) and scaled up by CSS with image-rendering:pixelated,
// so the result looks like the chunky in-game monitor rather than a blurry
// upscale.
//
// The exe clears the screen between rendered frames and the MC's onDraw
// repaints from scratch every frame, so each screenFrame starts from black.
//
// Everything draws into an ImageData buffer through a Uint32Array view, and
// each monitor is uploaded with a single putImageData at the end of the
// frame. The obvious implementation — ctx.fillRect(x, y, 1, 1) per pixel —
// is what made monitor simulation eat a core: an A/B of the two on the same
// frames put it 6-7x slower (500 commands: 2.85 ms vs 0.45 ms), and in the
// visible panel a 500-command frame cost 11.6 ms, i.e. 70% of a core at
// 60 Hz. Of the surviving 0.45 ms, the clear and the upload are 0.01 ms
// between them — the rest is the rasterisers. See doc/worklog.md.
//
// Repaints are coalesced into one animation frame (scheduleRepaint). TICKEND
// arrives ~60x a second and used to repaint synchronously from the message
// handler, so bursts painted more often than the display could show — and a
// panel in a background tab kept painting canvases nobody could see, because
// retainContextWhenHidden keeps the webview receiving messages while hidden.

import {
  monitorsSection, monitorsList, monitorZoomEl, monitorTrueColourEl
} from "./dom.js";
import { sendTouch } from "./messaging.js";
import {
  drawPixelText, measurePixelText, measurePixelBlockHeight, LINE_HEIGHT
} from "./pixelFont.js";
import {
  strokeLine, strokeCircle, fillCircle, strokeTriangle, fillTriangle
} from "./raster.js";
import { packColour, blendPixel } from "./blend.js";

/**
 * @typedef {object} ScreenInfo
 * @property {number} number
 * @property {number} width
 * @property {number} height
 * @property {boolean} poweredOn
 * @property {boolean} portrait
 */

/** One parsed draw call: [COMMAND, ...params]. @typedef {(string|number)[]} DrawCommand */

/**
 * @typedef {object} Monitor
 * @property {HTMLCanvasElement} canvas
 * @property {CanvasRenderingContext2D} ctx
 * @property {ImageData} img the pixel buffer every draw call writes into
 * @property {Uint32Array} u32 one word per pixel, a view over img.data
 * @property {HTMLElement} label
 * @property {ScreenInfo} info
 */

/** @type {Map<number, Monitor>} */
const monitors = new Map();

// Text is rasterised from the hand-drawn 4x5 bitmap font in pixelFont.js, one
// buffer word per lit pixel. Canvas fillText at 5px would anti-alias into
// grey mush that the integer CSS upscale then magnifies into unreadable blobs.

/**
 * @param {string | number | undefined} v
 * @returns {number}
 */
function n(v) {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// LifeBoatAPI gamma-corrects every colour in Lua before it reaches us
// (Simulator_ScreenAPI.lua: `255 * ((c/255) / 0.85) ^ (1/2.4)`) to replicate
// what the game does to monitor colours. It lifts dark tones hard — a
// setColor of 30 arrives as 112, and anything from 217 up clips to white — so
// the panel looks washed out on purpose. "True colour" undoes exactly that and
// shows the values the microcontroller actually passed to screen.setColor.
// Off by default: the washed-out rendering is the faithful one.
//
// The correction is applied unclamped on the Lua side, so the inverse is
// lossless: 255 leaves as 272.9 and comes back as 255.

const GAMMA_A = 0.85;
const GAMMA_Y = 2.4;

/** Whether to undo LifeBoatAPI's gamma correction before drawing. */
let trueColour = false;

/**
 * @param {number} c gamma-corrected channel value as sent by LifeBoatAPI
 * @returns {number} the raw screen.setColor value
 */
function unGamma(c) {
  return c <= 0 ? 0 : 255 * GAMMA_A * Math.pow(c / 255, GAMMA_Y);
}

/**
 * A draw colour resolved for the pixel buffer. `packed` is the ready-to-store
 * word for the common opaque case; the channels are kept for the blend path.
 * The packed word always carries alpha 255 — the buffer is opaque, and the
 * source alpha in `a` is what blendPixel() weighs the colour by.
 * @typedef {object} Colour
 * @property {number} packed
 * @property {number} r
 * @property {number} g
 * @property {number} b
 * @property {number} a 0-255
 */

/**
 * Alpha is not gamma-corrected on the Lua side, so it is passed through.
 * @param {number} r @param {number} g @param {number} b @param {number} a
 * @returns {Colour}
 */
function makeColour(r, g, b, a) {
  if (trueColour) { r = unGamma(r); g = unGamma(g); b = unGamma(b); }
  const cr = clamp255(r), cg = clamp255(g), cb = clamp255(b);
  return { packed: packColour(cr, cg, cb, 255), r: cr, g: cg, b: cb, a: clamp255(a) };
}

/** Cleared-screen pixel, and the two colours a frame starts from. */
const BLACK = packColour(0, 0, 0, 255);
/** Frame-start colour. Never gamma-mapped — it is our default, not the MC's. */
const WHITE = { packed: packColour(255, 255, 255, 255), r: 255, g: 255, b: 255, a: 255 };
const DEFAULT_OCEAN = { packed: packColour(20, 40, 90, 255), r: 20, g: 40, b: 90, a: 255 };

/** Current draw colour, set by COLOUR and used until the next one. */
let colour = WHITE;
/** MAP is a placeholder fill; MAPOCEAN gives it a plausible colour. */
let oceanColour = DEFAULT_OCEAN;

// --- Scaling ---------------------------------------------------------------
//
// A 96x96 screen at 1:1 is unreadable, so every canvas is CSS-upscaled by an
// *integer* factor (with image-rendering:pixelated) to keep pixels square.
// "fit" picks the largest factor whose result still fits the monitors column;
// the fixed factors are applied as-is and simply overflow-scroll if too wide.

const MIN_SCALE = 1;
const MAX_SCALE = 16;
/** Used before the section is laid out (clientWidth is 0 while hidden). */
const FALLBACK_WIDTH = 480;
/** The canvas' 1px border on each side is not available to the pixels. */
const CANVAS_CHROME = 2;

/** Current selection: "fit", or a fixed integer factor as a string. */
let zoomMode = "fit";
/**
 * Continuous value the pinch gesture accumulates into; the applied factor is
 * its round(). Keeping the fraction means a slow pinch still advances instead
 * of being rounded away on every event. Only read while zoomMode is fixed.
 */
let zoomFloat = 4;

/**
 * @param {number} w logical (Stormworks) pixel width
 * @returns {number} integer CSS upscale factor
 */
function scaleFor(w) {
  const fixed = parseInt(zoomMode, 10);
  if (Number.isFinite(fixed) && fixed > 0) {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, fixed));
  }
  const avail = (monitorsList.clientWidth || FALLBACK_WIDTH) - CANVAS_CHROME;
  const fit = Math.floor(avail / Math.max(1, w));
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
}

/** @param {Monitor} m */
function applyScale(m) {
  const w = m.canvas.width, h = m.canvas.height;
  const scale = scaleFor(w);
  m.canvas.style.width = `${w * scale}px`;
  m.canvas.style.height = `${h * scale}px`;
  m.label.textContent = `Screen ${Math.round(n(m.info.number))} — ${w}x${h} · ${scale}×`;
}

/** Re-run the scale calculation for every live monitor. */
function relayout() {
  for (const m of monitors.values()) applyScale(m);
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
  if (zoomMode !== "fit") return zoomFloat;
  const first = monitors.values().next().value;
  return first ? scaleFor(first.canvas.width) : zoomFloat;
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
  // After unhiding, monitorsList finally has a real clientWidth for "fit".
  relayout();
  // A resized or newly powered-on screen starts black; repaint the frame we
  // already have instead of waiting for the next TICKEND.
  scheduleRepaint();
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
  label.textContent = `Screen ${num} — ${w}x${h}`;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.className = "monitor-canvas";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PhySim panel: 2D canvas context unavailable");
  const img = ctx.createImageData(w, h);
  const u32 = new Uint32Array(img.data.buffer);
  u32.fill(BLACK);
  ctx.putImageData(img, 0, 0);

  wrapper.appendChild(label);
  wrapper.appendChild(canvas);
  monitorsList.appendChild(wrapper);

  attachTouch(canvas, num);
  const m = { canvas, ctx, img, u32, label, info };
  applyScale(m);
  return m;
}

// --- Frame replay ----------------------------------------------------------

/**
 * The last frame's draw calls, kept so a rendering setting (true colour) can
 * repaint what is already on screen instead of waiting for the next tick —
 * which never comes if the simulated microcontroller is paused.
 * @type {DrawCommand[]}
 */
let lastCommands = [];

/**
 * Take one frame's accumulated draw calls. The repaint itself waits for the
 * next animation frame — see scheduleRepaint.
 * @param {DrawCommand[]} commands
 */
export function applyScreenFrame(commands) {
  lastCommands = Array.isArray(commands) ? commands : [];
  scheduleRepaint();
}

/** Whether a repaint is already booked for the next animation frame. */
let repaintPending = false;

/**
 * Book a repaint for the next animation frame, at most one per frame.
 *
 * Frames arrive from the simulator at its own cadence, not the display's, and
 * only the newest one is worth drawing — lastCommands already holds it. This
 * also means a hidden panel does no drawing at all: the webview keeps
 * receiving messages while hidden (retainContextWhenHidden), but rAF doesn't
 * run, so the work is skipped and resumes with the latest frame on the
 * callback that fires when the panel comes back.
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
  if (monitors.size === 0) return;
  for (const m of monitors.values()) m.u32.fill(BLACK);
  colour = WHITE;
  for (const c of lastCommands) {
    if (Array.isArray(c)) draw(c);
  }
  for (const m of monitors.values()) m.ctx.putImageData(m.img, 0, 0);
}

monitorTrueColourEl.addEventListener("change", () => {
  trueColour = monitorTrueColourEl.checked;
  scheduleRepaint();
});

/**
 * @param {number} index
 * @returns {Monitor | null}
 */
function monitorFor(index) {
  return monitors.get(Math.round(index)) ?? null;
}

/** @param {DrawCommand} c */
function draw(c) {
  const cmd = String(c[0]);

  if (cmd === "COLOUR") { colour = makeColour(n(c[1]), n(c[2]), n(c[3]), n(c[4])); return; }
  if (cmd === "MAPOCEAN") { oceanColour = makeColour(n(c[1]), n(c[2]), n(c[3]), n(c[4])); return; }
  if (cmd === "MAPSHALLOWS" || cmd === "MAPLAND" || cmd === "MAPGRASS" ||
      cmd === "MAPSAND" || cmd === "MAPSNOW") return;   // no terrain data to tint

  const m = monitorFor(n(c[1]));
  if (!m) return;
  const canvas = m.canvas;

  switch (cmd) {
    case "CLEAR":
      fillRect(m, 0, 0, canvas.width, canvas.height);
      return;

    case "MAP":
      // No terrain data here; a flat ocean fill at least shows the map is live.
      fillRect(m, 0, 0, canvas.width, canvas.height, oceanColour);
      return;

    case "LINE":
      strokeLine(plotter(m), n(c[2]), n(c[3]), n(c[4]), n(c[5]), canvas);
      return;

    case "CIRCLE": {
      const fill = n(c[2]) === 1;
      if (fill) fillCircle(runner(m), n(c[3]), n(c[4]), n(c[5]), canvas);
      else strokeCircle(plotter(m), n(c[3]), n(c[4]), n(c[5]));
      return;
    }

    case "RECT": {
      // Snapped to whole pixels: the microcontroller is free to pass fractional
      // coordinates, and fillRect would anti-alias those into grey edges.
      const fill = n(c[2]) === 1;
      const x0 = Math.round(n(c[3])), y0 = Math.round(n(c[4]));
      const x1 = Math.round(n(c[3]) + n(c[5])), y1 = Math.round(n(c[4]) + n(c[6]));
      const w = x1 - x0, h = y1 - y0;
      if (fill) {
        fillRect(m, x0, y0, w, h);
      } else if (w > 0 && h > 0) {
        // Four 1px runs rather than an outline pass, so the corners aren't
        // drawn twice (which would double-blend a translucent colour).
        fillRect(m, x0, y0, w, 1);
        if (h > 1) fillRect(m, x0, y1 - 1, w, 1);
        if (h > 2) {
          fillRect(m, x0, y0 + 1, 1, h - 2);
          if (w > 1) fillRect(m, x1 - 1, y0 + 1, 1, h - 2);
        }
      }
      return;
    }

    case "TRIANGLE": {
      const fill = n(c[2]) === 1;
      const v = [n(c[3]), n(c[4]), n(c[5]), n(c[6]), n(c[7]), n(c[8])];
      if (fill) fillTriangle(runner(m), v[0], v[1], v[2], v[3], v[4], v[5], canvas);
      else strokeTriangle(plotter(m), v[0], v[1], v[2], v[3], v[4], v[5], canvas);
      return;
    }

    case "TEXT": {
      drawPixelText(pixelSetter(m), String(c[4] ?? ""), Math.round(n(c[2])), Math.round(n(c[3])));
      return;
    }

    case "TEXTBOX": {
      drawTextbox(
        m, n(c[2]), n(c[3]), n(c[4]), n(c[5]),
        n(c[6]), n(c[7]), String(c[8] ?? "")
      );
      return;
    }

    default:
      return;
  }
}

// --- Pixel writers ----------------------------------------------------------
//
// All four of these take the *current* colour at the moment they are created,
// not per pixel: a colour can only change between draw commands, so binding it
// once keeps the inner loops free of module-variable reads. Every one clips —
// the canvas used to do that for free, but a raw buffer write with a negative
// x would silently land on the previous row.

/**
 * Fill an axis-aligned rectangle, clipped to the screen.
 * @param {Monitor} m
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {Colour} [col] defaults to the current draw colour
 */
function fillRect(m, x, y, w, h, col = colour) {
  const width = m.canvas.width, height = m.canvas.height;
  const x0 = Math.max(0, x), x1 = Math.min(width, x + w);
  const y0 = Math.max(0, y), y1 = Math.min(height, y + h);
  if (x1 <= x0 || y1 <= y0 || col.a === 0) return;
  const u32 = m.u32;
  if (col.a === 255) {
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * width;
      u32.fill(col.packed, row + x0, row + x1);
    }
    return;
  }
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * width;
    for (let xx = x0; xx < x1; xx++) {
      u32[row + xx] = blendPixel(u32[row + xx], col.r, col.g, col.b, col.a);
    }
  }
}

/**
 * A pixel plotter for raster.js. The rasterisers can revisit a pixel (the
 * circle's eight-way symmetry meets on the axes, a triangle's edges meet at
 * its corners), which matters only for a translucent colour — painting one
 * twice would double-blend it into a brighter dot. An opaque store is
 * idempotent, so that case skips the de-duplication (and its per-shape Set)
 * entirely: measured 1.7x faster on a mixed frame and 3.5x on an outline-heavy
 * one. The translucent path keeps a Set per shape; outlines are O(perimeter),
 * so it stays small. doc/monitor-dedup-plan.md has the measurements and the
 * plan for replacing that Set with a stamp buffer.
 * @param {Monitor} m
 * @returns {import("./raster.js").Plot}
 */
function plotter(m) {
  const width = m.canvas.width, height = m.canvas.height;
  const u32 = m.u32, col = colour;
  if (col.a === 255) {
    const packed = col.packed;
    return (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      u32[y * width + x] = packed;
    };
  }
  const seen = new Set();
  return (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (seen.has(i)) return;
    seen.add(i);
    u32[i] = blendPixel(u32[i], col.r, col.g, col.b, col.a);
  };
}

/**
 * Horizontal-run painter for the filled rasterisers. Runs never overlap, so
 * unlike plotter() this needs no de-duplication — just clipping.
 * @param {Monitor} m
 * @returns {import("./raster.js").FillRun}
 */
function runner(m) {
  const width = m.canvas.width, height = m.canvas.height;
  const u32 = m.u32, col = colour;
  return (x, y, w) => {
    if (y < 0 || y >= height) return;
    const from = Math.max(0, x), to = Math.min(width, x + w);
    if (to <= from) return;
    const row = y * width;
    if (col.a === 255) { u32.fill(col.packed, row + from, row + to); return; }
    for (let xx = from; xx < to; xx++) {
      u32[row + xx] = blendPixel(u32[row + xx], col.r, col.g, col.b, col.a);
    }
  };
}

/**
 * A pixel-plotting callback for the bitmap font.
 * @param {Monitor} m
 * @returns {(px: number, py: number) => void}
 */
function pixelSetter(m) {
  const width = m.canvas.width, height = m.canvas.height;
  const u32 = m.u32, col = colour;
  return (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = py * width + px;
    u32[i] = col.a === 255 ? col.packed : blendPixel(u32[i], col.r, col.g, col.b, col.a);
  };
}

/**
 * hAlign/vAlign are -1/0/1 → left|centre|right and top|middle|bottom, aligned
 * within the box rather than against the screen edges. Alignment is computed
 * from the bitmap font's own metrics (each line measured independently) and
 * rounded to whole pixels so glyphs land on the pixel grid.
 * @param {Monitor} m
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} hAlign @param {number} vAlign
 * @param {string} text
 */
function drawTextbox(m, x, y, w, h, hAlign, vAlign, text) {
  const setPixel = pixelSetter(m);
  const lines = text.split("\n");
  const blockH = measurePixelBlockHeight(lines.length);

  let top = y;
  if (vAlign === 0) top = y + (h - blockH) / 2;
  else if (vAlign > 0) top = y + h - blockH;

  for (let i = 0; i < lines.length; i++) {
    const lineW = measurePixelText(lines[i]);
    let left = x;
    if (hAlign === 0) left = x + (w - lineW) / 2;
    else if (hAlign > 0) left = x + w - lineW;
    drawPixelText(setPixel, lines[i], Math.round(left), Math.round(top + i * LINE_HEIGHT));
  }
}

// --- Pointer input ---------------------------------------------------------

/** Coalesce pointermove floods to one TOUCH per animation frame. */
let movePending = false;
/** @type {{screen:number,x:number,y:number} | null} */
let queuedMove = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} screen
 */
function attachTouch(canvas, screen) {
  let down = false;

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
    queuedMove = { screen, x: p.x, y: p.y };
    if (movePending) return;
    movePending = true;
    requestAnimationFrame(() => {
      movePending = false;
      const q = queuedMove;
      queuedMove = null;
      if (q) sendTouch({ screen: q.screen, isTouched: 1, isTouchedAlt: 0, x: q.x, y: q.y, xAlt: 0, yAlt: 0 });
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
