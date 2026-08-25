// Motion visualisation: the path trail and the velocity arrow.
//
// The buffer bookkeeping and the scaling maths are in media/trail.js (a pure
// module, unit-tested in Node); this module owns the three.js objects, the
// sidebar toggles, and the per-frame update the render loop calls.
//
// Sampling is per TICK, not per frame: simulation.js calls sampleTrail() from
// inside its fixed-timestep loop, so a stalled or throttled rAF (a hidden
// panel, a busy host) still records the path at full resolution instead of
// leaving a coarse polyline behind. updateVisuals() — called once per rAF —
// samples too, which is what captures gizmo drags and typed poses, and then
// flushes whatever accumulated to the GPU once. Points closer than 1 mm to
// the previous one are dropped (see trail.js), so a parked target never
// floods the buffer.

import * as THREE from "three";
import { scene, targetGroup } from "./scene.js";
import { readNum, vizTrailEl, vizTrailLenEl, vizTrailClearBtn, vizVelEl } from "./dom.js";
import {
  createTrail, clearTrail, setCapacity, pushPoint, trailColorAt,
  arrowLength, DEFAULT_CAPACITY
} from "./trail.js";

let trail = createTrail(DEFAULT_CAPACITY);

const trailGeom = new THREE.BufferGeometry();
const trailMat  = new THREE.LineBasicMaterial({ vertexColors: true });
const trailLine = new THREE.Line(trailGeom, trailMat);
// The position attribute always spans the full capacity while only `count`
// points are drawn, so an auto-computed bounding sphere would include the
// unused zeros and could cull the line wrongly.
trailLine.frustumCulled = false;
trailLine.visible = false;
scene.add(trailLine);

/** @type {THREE.BufferAttribute} */ let posAttr;
/** @type {THREE.BufferAttribute} */ let colAttr;

/** (Re)point the geometry at the current buffer — needed after any resize. */
function bindTrailAttributes() {
  posAttr = new THREE.BufferAttribute(trail.positions, 3);
  colAttr = new THREE.BufferAttribute(new Float32Array(trail.capacity * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeom.setAttribute("position", posAttr);
  trailGeom.setAttribute("color", colAttr);
  refreshTrailGeometry();
}

/** Push the buffer's current contents to the GPU and repaint the age fade. */
function refreshTrailGeometry() {
  const colors = /** @type {Float32Array} */ (colAttr.array);
  for (let i = 0; i < trail.count; i++) {
    const c = trailColorAt(i, trail.count);
    colors[i * 3]     = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  trailGeom.setDrawRange(0, trail.count);
}

bindTrailAttributes();

// Velocity arrow — world-frame, like CH7–9 themselves, so it is parented to
// the scene and only follows the target's position, not its rotation.
const arrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 1, 0xffd24a
);
arrow.visible = false;
scene.add(arrow);

const _vel = new THREE.Vector3();

function updateArrow() {
  if (!vizVelEl.checked) { arrow.visible = false; return; }
  _vel.set(readNum("vx"), readNum("vy"), readNum("vz"));
  const len = arrowLength(_vel.length());
  if (len === 0) { arrow.visible = false; return; }
  arrow.position.copy(targetGroup.position);
  arrow.setDirection(_vel.normalize());
  // three.js' default head (0.2 x length, 0.2 x that wide) is nearly invisible
  // at this scale — widen it, and cap the length so a fast target's arrow
  // doesn't grow a comically large cone.
  const head = Math.min(0.25 * len, 1);
  arrow.setLength(len, head, head * 0.4);
  arrow.visible = true;
}

// Set by sampleTrail(), cleared by updateVisuals() — the GPU upload happens
// once per frame no matter how many ticks were integrated into it.
let trailDirty = false;

/** Drop the recorded path. Called on Reset and by the Clear button. */
export function resetTrail() {
  clearTrail(trail);
  refreshTrailGeometry();
  trailDirty = false;
  trailLine.visible = false;
}

/** Record the target's current position. Called once per simulated tick. */
export function sampleTrail() {
  if (!vizTrailEl.checked) return;
  const p = targetGroup.position;
  if (pushPoint(trail, p.x, p.y, p.z)) trailDirty = true;
}

/** Sample, flush the trail to the GPU and re-aim the arrow. Once per rAF. */
export function updateVisuals() {
  sampleTrail();
  if (trailDirty) { refreshTrailGeometry(); trailDirty = false; }
  trailLine.visible = vizTrailEl.checked && trail.count >= 2;
  updateArrow();
}

// --- Sidebar controls owned by this module -------------------------------------
vizTrailEl.addEventListener("change", () => {
  // Restarting from a clean path is less confusing than resuming with a gap
  // where the trail was switched off.
  if (vizTrailEl.checked) resetTrail();
  else trailLine.visible = false;
});
vizTrailLenEl.addEventListener("change", () => {
  const n = parseInt(vizTrailLenEl.value, 10);
  if (!Number.isFinite(n)) return;
  setCapacity(trail, n);
  bindTrailAttributes();     // setCapacity reallocates, so rebind
});
vizTrailClearBtn.addEventListener("click", resetTrail);
vizVelEl.addEventListener("change", updateArrow);
