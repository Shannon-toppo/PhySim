// The simulator's buttons and sliders, below the monitors. LifeBoatAPI's
// simulator window had ten of each; here only the ones the running script
// reads are shown (the host says which — `controlsConfig`), so a script that
// uses none gets no section at all.
//
// A button and its toggle are one control, as in LifeBoatAPI: holding button n
// makes `simulator:getIsClicked(n)` true, and every press flips
// `simulator:getIsToggled(n)`. The toggle's state is shown on the button when
// the script reads it. A slider reads 0..1 through `simulator:getSlider(n)`.
//
// Like the rest of the monitor section this imports nothing from the 3D panel,
// so the stand-alone monitor window can load it.

import { controlsSection, controlsButtons, controlsSliders } from "./monitorDom.js";
import { sendControlButton, sendControlSlider } from "./monitorMessaging.js";

/**
 * @typedef {{number: number, showsToggle: boolean, toggled: boolean, down?: boolean}} ButtonInfo
 * @typedef {{number: number, value: number}} SliderInfo
 * @typedef {{buttons: ButtonInfo[], sliders: SliderInfo[]}} ControlsInfo
 */

/** @type {Map<number, {el: HTMLButtonElement, down: boolean, showsToggle: boolean, toggled: boolean}>} */
const buttons = new Map();
/** @type {Map<number, {row: HTMLElement, input: HTMLInputElement, out: HTMLElement, dragging: boolean}>} */
const sliders = new Map();

/**
 * True while the controls shown belong to an AI agent's run that the host is
 * mirroring: they show how that run's buttons and sliders stand, and nothing
 * done here would reach it.
 */
let readOnly = false;

/** @param {number} v */
function formatSlider(v) { return v.toFixed(2); }

/**
 * @param {number} number
 * @param {boolean} down
 */
function setDown(number, down) {
  const b = buttons.get(number);
  if (!b || readOnly || b.down === down) return;
  b.down = down;
  b.el.classList.toggle("down", down);
  if (down) {
    // The host flips the toggle on a press; mirrored here so the lamp follows
    // without a round trip. The next controlsConfig carries the host's value.
    b.toggled = !b.toggled;
    paintToggle(b);
  }
  sendControlButton(number, down);
}

/** @param {{el: HTMLButtonElement, showsToggle: boolean, toggled: boolean}} b */
function paintToggle(b) {
  const lit = b.showsToggle && b.toggled;
  b.el.classList.toggle("toggled", lit);
  if (b.showsToggle) b.el.setAttribute("aria-pressed", String(b.toggled));
  else b.el.removeAttribute("aria-pressed");
}

/** @param {ButtonInfo} info */
function makeButton(info) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "control-button";
  el.textContent = String(info.number);
  const b = { el, down: false, showsToggle: info.showsToggle, toggled: info.toggled };
  buttons.set(info.number, b);
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    // Captured, so the release is seen even when the pointer has left the button.
    el.setPointerCapture(e.pointerId);
    setDown(info.number, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    el.addEventListener(type, () => setDown(info.number, false));
  }
  el.addEventListener("keydown", e => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); setDown(info.number, true); }
  });
  el.addEventListener("keyup", e => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); setDown(info.number, false); }
  });
  el.addEventListener("blur", () => setDown(info.number, false));
  return b;
}

/** @param {SliderInfo} info */
function makeSlider(info) {
  const row = document.createElement("label");
  row.className = "control-slider";
  const name = document.createElement("span");
  name.textContent = `Slider ${info.number}`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "1";
  input.step = "0.01";
  input.title = `simulator:getSlider(${info.number}) — 0 to 1`;
  const out = document.createElement("output");
  row.append(name, input, out);
  const s = { row, input, out, dragging: false };
  sliders.set(info.number, s);
  input.addEventListener("input", () => {
    if (readOnly) return;
    const v = Number(input.value);
    out.textContent = formatSlider(v);
    sendControlSlider(info.number, v);
  });
  input.addEventListener("pointerdown", () => { s.dragging = true; });
  for (const type of ["pointerup", "pointercancel"]) input.addEventListener(type, () => { s.dragging = false; });
  return s;
}

/**
 * Show exactly these controls. Called when a run's script reads one it had
 * not read before, when a view is opened mid-run, and with nothing when the
 * run is over.
 * @param {unknown} raw
 * @param {boolean} [watchOnly] the controls are an agent's: show them, but do not work them
 */
export function applyControlsConfig(raw, watchOnly = false) {
  // Going over to watching: anything held here was held on this window's own
  // run, which is no longer the one on show.
  if (watchOnly && !readOnly) {
    for (const [n, b] of buttons) if (b.down) { b.down = false; sendControlButton(n, false); }
    for (const s of sliders.values()) s.dragging = false;
  }
  readOnly = watchOnly;
  controlsSection.classList.toggle("read-only", readOnly);
  const info = /** @type {Partial<ControlsInfo>} */ (raw && typeof raw === "object" ? raw : {});
  const wantButtons = Array.isArray(info.buttons) ? info.buttons : [];
  const wantSliders = Array.isArray(info.sliders) ? info.sliders : [];

  for (const [n, b] of buttons) {
    if (wantButtons.some(w => w.number === n)) continue;
    if (b.down && !readOnly) sendControlButton(n, false);
    b.el.remove();
    buttons.delete(n);
  }
  for (const w of wantButtons) {
    const b = buttons.get(w.number) ?? makeButton(w);
    b.showsToggle = w.showsToggle === true;
    if (readOnly) {
      // Watching: the host's word is all there is, the held state included.
      b.down = w.down === true;
      b.toggled = w.toggled === true;
    } else if (!b.down) {
      // While the button is held the local flip is newer than what the host sent.
      b.toggled = w.toggled === true;
    }
    b.el.disabled = readOnly;
    b.el.classList.toggle("down", b.down);
    b.el.title = b.showsToggle
      ? `Button ${w.number} — hold: simulator:getIsClicked(${w.number}); each press flips simulator:getIsToggled(${w.number})`
      : `Button ${w.number} — hold: simulator:getIsClicked(${w.number})`;
    paintToggle(b);
    controlsButtons.append(b.el);   // appending an attached node moves it: this also puts them in order
  }

  for (const [n, s] of sliders) {
    if (wantSliders.some(w => w.number === n)) continue;
    s.row.remove();
    sliders.delete(n);
  }
  for (const w of wantSliders) {
    const s = sliders.get(w.number) ?? makeSlider(w);
    s.input.disabled = readOnly;
    // A slider being dragged is ahead of the host, not behind it.
    if (!s.dragging) {
      const v = Math.min(1, Math.max(0, Number(w.value) || 0));
      s.input.value = String(v);
      s.out.textContent = formatSlider(v);
    }
    controlsSliders.append(s.row);
  }

  controlsSection.classList.toggle("hidden", buttons.size + sliders.size === 0);
}
