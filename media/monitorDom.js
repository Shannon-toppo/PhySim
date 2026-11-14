// The monitor section's elements. Kept apart from dom.js so mcScreen.js can
// run in the stand-alone monitor window (media/monitors.html), which has the
// monitor markup and nothing else — dom.js throws on the first panel element
// it can't find.

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function mustGet(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error("PhySim monitors: missing element #" + id);
  return el;
}

// Starts hidden; mcScreen.js unhides it once a screenConfig arrives.
export const monitorsSection = mustGet("monitors");
export const monitorsList = mustGet("monitors-list");
export const monitorZoomEl = /** @type {HTMLSelectElement} */ (mustGet("monitor-zoom"));
export const monitorAddEl = /** @type {HTMLButtonElement} */ (mustGet("monitor-add"));
// "True colour", named as in 1.x: on (the default) shows the setColor values,
// off shows LifeBoatAPI's colour lift (gamma.js). Display only.
export const monitorTrueColourEl = /** @type {HTMLInputElement} */ (mustGet("monitor-truecolour"));
// The simulator's buttons and sliders, below the monitors (controls.js).
// Starts hidden; shown while the running script reads any.
export const controlsSection = mustGet("controls");
export const controlsButtons = mustGet("controls-buttons");
export const controlsSliders = mustGet("controls-sliders");
