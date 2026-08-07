// Microcontroller monitor rendering (macOS only).
//
// On Windows the LifeBoatAPI simulator draws the MC's screens in its own
// STORMWORKS_Simulator.exe window. That exe is Windows-only, so on macOS the
// extension host stands in for it (src/simStubServer.ts) and forwards two
// messages here:
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

import { monitorsSection, monitorsList, monitorZoomEl } from "./dom.js";
import { sendTouch } from "./messaging.js";
import {
  drawPixelText, measurePixelText, measurePixelBlockHeight, LINE_HEIGHT
} from "./pixelFont.js";

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
 * @property {HTMLElement} label
 * @property {ScreenInfo} info
 */

/** @type {Map<number, Monitor>} */
const monitors = new Map();

// Text is rasterised from the hand-drawn 4x5 bitmap font in pixelFont.js, one
// 1x1 fillRect per lit pixel. Canvas fillText at 5px would anti-alias into
// grey mush that the integer CSS upscale then magnifies into unreadable blobs.

/** Current draw colour, set by COLOUR and used until the next one. */
let colour = "rgba(255,255,255,1)";
/** MAP is a placeholder fill; MAPOCEAN gives it a plausible colour. */
let oceanColour = "rgb(20,40,90)";

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

/**
 * Lua already gamma-corrects the channel values, so they map straight to CSS.
 * @param {number} r @param {number} g @param {number} b @param {number} a
 * @returns {string}
 */
function rgba(r, g, b, a) {
  return `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${clamp255(a) / 255})`;
}

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
  relayout();
});

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
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  wrapper.appendChild(label);
  wrapper.appendChild(canvas);
  monitorsList.appendChild(wrapper);

  attachTouch(canvas, num);
  const m = { canvas, ctx, label, info };
  applyScale(m);
  return m;
}

// --- Frame replay ----------------------------------------------------------

/**
 * Repaint every monitor from one frame's accumulated draw calls.
 * @param {DrawCommand[]} commands
 */
export function applyScreenFrame(commands) {
  if (monitors.size === 0) return;
  for (const m of monitors.values()) {
    m.ctx.fillStyle = "#000";
    m.ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
  }
  colour = "rgba(255,255,255,1)";
  if (!Array.isArray(commands)) return;
  for (const c of commands) {
    if (Array.isArray(c)) draw(c);
  }
}

/**
 * @param {number} index
 * @returns {CanvasRenderingContext2D | null}
 */
function ctxFor(index) {
  const m = monitors.get(Math.round(index));
  if (!m) return null;
  m.ctx.fillStyle = colour;
  m.ctx.strokeStyle = colour;
  m.ctx.lineWidth = 1;
  return m.ctx;
}

/** @param {DrawCommand} c */
function draw(c) {
  const cmd = String(c[0]);

  if (cmd === "COLOUR") { colour = rgba(n(c[1]), n(c[2]), n(c[3]), n(c[4])); return; }
  if (cmd === "MAPOCEAN") { oceanColour = rgba(n(c[1]), n(c[2]), n(c[3]), n(c[4])); return; }
  if (cmd === "MAPSHALLOWS" || cmd === "MAPLAND" || cmd === "MAPGRASS" ||
      cmd === "MAPSAND" || cmd === "MAPSNOW") return;   // no terrain data to tint

  const ctx = ctxFor(n(c[1]));
  if (!ctx) return;
  const canvas = ctx.canvas;

  switch (cmd) {
    case "CLEAR":
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;

    case "MAP": {
      // No terrain data here; a flat ocean fill at least shows the map is live.
      const prev = ctx.fillStyle;
      ctx.fillStyle = oceanColour;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = prev;
      return;
    }

    case "LINE": {
      // +0.5 puts the 1px stroke on the pixel centre instead of straddling
      // two pixels (which would render as a 2px blur).
      ctx.beginPath();
      ctx.moveTo(n(c[2]) + 0.5, n(c[3]) + 0.5);
      ctx.lineTo(n(c[4]) + 0.5, n(c[5]) + 0.5);
      ctx.stroke();
      return;
    }

    case "CIRCLE": {
      const fill = n(c[2]) === 1;
      ctx.beginPath();
      ctx.arc(n(c[3]) + 0.5, n(c[4]) + 0.5, Math.max(0, n(c[5])), 0, Math.PI * 2);
      if (fill) ctx.fill(); else ctx.stroke();
      return;
    }

    case "RECT": {
      const fill = n(c[2]) === 1;
      const x = n(c[3]), y = n(c[4]), w = n(c[5]), h = n(c[6]);
      if (fill) ctx.fillRect(x, y, w, h);
      else ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return;
    }

    case "TRIANGLE": {
      const fill = n(c[2]) === 1;
      ctx.beginPath();
      ctx.moveTo(n(c[3]) + 0.5, n(c[4]) + 0.5);
      ctx.lineTo(n(c[5]) + 0.5, n(c[6]) + 0.5);
      ctx.lineTo(n(c[7]) + 0.5, n(c[8]) + 0.5);
      ctx.closePath();
      if (fill) ctx.fill(); else ctx.stroke();
      return;
    }

    case "TEXT": {
      drawPixelText(pixelSetter(ctx), String(c[4] ?? ""), Math.round(n(c[2])), Math.round(n(c[3])));
      return;
    }

    case "TEXTBOX": {
      drawTextbox(
        ctx, n(c[2]), n(c[3]), n(c[4]), n(c[5]),
        n(c[6]), n(c[7]), String(c[8] ?? "")
      );
      return;
    }

    default:
      return;
  }
}

/**
 * A pixel-plotting callback bound to one context, for the bitmap font. The
 * fill colour is already set by ctxFor().
 * @param {CanvasRenderingContext2D} ctx
 * @returns {(px: number, py: number) => void}
 */
function pixelSetter(ctx) {
  return (px, py) => ctx.fillRect(px, py, 1, 1);
}

/**
 * hAlign/vAlign are -1/0/1 → left|centre|right and top|middle|bottom, aligned
 * within the box rather than against the screen edges. Alignment is computed
 * from the bitmap font's own metrics (each line measured independently) and
 * rounded to whole pixels so glyphs land on the pixel grid.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} hAlign @param {number} vAlign
 * @param {string} text
 */
function drawTextbox(ctx, x, y, w, h, hAlign, vAlign, text) {
  const setPixel = pixelSetter(ctx);
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
