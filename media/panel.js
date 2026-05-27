// PhySim webview entry. Builds a Three.js scene with a TransformControls gizmo
// and posts every state change back to the extension via vscode.postMessage.
//
// Coordinate convention (Stormworks left-handed, exposed via three.js right-handed
// with relabeled axes):
//   +X = East, +Y = Up, +Z = North.
// The camera sits at +X/+Y/-Z and looks at origin, so +Z (north) extends
// AWAY from the viewer (into the screen). Axis tip labels are HTML overlays
// updated each frame.

import * as THREE from "three";
import { OrbitControls }     from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const vscode = acquireVsCodeApi();

// --- DOM ---------------------------------------------------------------------
const viewport = document.getElementById("viewport");
const modeButtons = Array.from(document.querySelectorAll("#toolbar button.mode"));
const resetBtn = document.getElementById("reset");
const SLIDER_KEYS = ["vx", "vy", "vz", "ax", "ay", "az"];
const sliders = {};
const numInputs = {};
for (const k of SLIDER_KEYS) {
  sliders[k]   = document.getElementById(k);
  numInputs[k] = document.getElementById(k + "-num");
}
const POSE_KEYS = ["px", "py", "pz", "rx", "ry", "rz"];
const poseInputs = {};
for (const k of POSE_KEYS) poseInputs[k] = document.getElementById(k + "-num");
const channelOut = {};
for (let i = 1; i <= 17; i++) channelOut[i] = document.getElementById("c" + i);

// preset UI elements
const presetNameEl   = document.getElementById("preset-name");
const presetListEl   = document.getElementById("preset-list");
const presetSaveBtn  = document.getElementById("preset-save");
const presetLoadBtn  = document.getElementById("preset-load");
const presetDeleteBtn = document.getElementById("preset-delete");

// --- Three.js scene ----------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(8, 6, -8);
camera.lookAt(0, 0, 0);

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 10, 5);
scene.add(dir);

// Ground grid in the XZ plane (east-north plane).
const grid = new THREE.GridHelper(20, 20, 0x666666, 0x333333);
scene.add(grid);

// Custom axes — colored thick lines along +X (East, red), +Y (Up, green), +Z (North, blue).
function makeAxis(dirVec, color) {
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    dirVec.clone().multiplyScalar(5)
  ]);
  return new THREE.Line(geom, mat);
}
scene.add(makeAxis(new THREE.Vector3(1, 0, 0), 0xff5555)); // East
scene.add(makeAxis(new THREE.Vector3(0, 1, 0), 0x55ff55)); // Up
scene.add(makeAxis(new THREE.Vector3(0, 0, 1), 0x5599ff)); // North

// HTML labels at axis tips, updated each frame using camera projection.
const axisTips = [
  { pos: new THREE.Vector3(5.5, 0,   0  ), text: "X+ East",  color: "#ff8080" },
  { pos: new THREE.Vector3(0,   5.5, 0  ), text: "Y+ Up",    color: "#80ff80" },
  { pos: new THREE.Vector3(0,   0,   5.5), text: "Z+ North", color: "#80b0ff" }
];
const labelEls = axisTips.map(t => {
  const el = document.createElement("div");
  el.className = "axis-label";
  el.style.color = t.color;
  el.textContent = t.text;
  viewport.appendChild(el);
  return el;
});

// The "target" — what the gizmo moves. A small airplane pointing nose toward
// +Z (north), wings spread along ±X (east/west), tail fin pointing +Y (up).
// Wing-tip lights are coloured so the viewer-facing default camera angle
// shows red on the left of the screen and green on the right (the colours
// have been swapped from the strict aviation port=red convention to match
// what looks intuitive from the default 3D viewport perspective).
const targetGroup = new THREE.Group();
scene.add(targetGroup);
buildAirplane(targetGroup);

function buildAirplane(group) {
  const matBody  = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  const matNose  = new THREE.MeshStandardMaterial({ color: 0xff8844 });
  const matFin   = new THREE.MeshStandardMaterial({ color: 0xf0d040 });
  const matRed   = new THREE.MeshStandardMaterial({ color: 0xe24040, emissive: 0x401010 });
  const matGreen = new THREE.MeshStandardMaterial({ color: 0x40d050, emissive: 0x104010 });

  // fuselage — cylinder along +Z (default Y-aligned; rotate geometry once).
  const fuseGeom = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 18);
  fuseGeom.rotateX(Math.PI / 2);
  group.add(new THREE.Mesh(fuseGeom, matBody));

  // nose cone at the front (+Z)
  const noseGeom = new THREE.ConeGeometry(0.16, 0.45, 18);
  noseGeom.rotateX(Math.PI / 2);
  const nose = new THREE.Mesh(noseGeom, matNose);
  nose.position.set(0, 0, 1.12);
  group.add(nose);

  // canopy / cockpit bump — pushes "up" identification
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), matBody);
  canopy.position.set(0, 0.12, 0.25);
  canopy.scale.set(0.9, 0.7, 1.3);
  group.add(canopy);

  // main wings — thin slab across X axis
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 0.55), matBody);
  wing.position.set(0, 0, 0.05);
  group.add(wing);

  // wing-tip nav lights — red on +X side, green on -X side (matches the
  // default 3D viewport's screen orientation; swap positions to revert).
  const tipGeom = new THREE.SphereGeometry(0.08, 12, 10);
  const redTip   = new THREE.Mesh(tipGeom, matRed);   redTip.position.set(  1.30, 0, 0.05); group.add(redTip);
  const greenTip = new THREE.Mesh(tipGeom, matGreen); greenTip.position.set(-1.30, 0, 0.05); group.add(greenTip);

  // horizontal stabiliser
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.28), matBody);
  hstab.position.set(0, 0, -0.82);
  group.add(hstab);

  // vertical tail fin — thin slab across X, standing up in Y, extending in Z
  const vfin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.4), matFin);
  vfin.position.set(0, 0.25, -0.75);
  group.add(vfin);
}

// --- Controls ----------------------------------------------------------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 0);
// Mostly default bindings, but mirror the right button onto the middle
// (wheel) button so users with no right mouse — or who prefer the wheel —
// can pan the same way.
orbit.mouseButtons = {
  LEFT:   THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT:  THREE.MOUSE.PAN
};
orbit.update();

const transform = new TransformControls(camera, renderer.domElement);
transform.attach(targetGroup);
transform.setSpace("world");
transform.setMode("translate");
scene.add(transform);

// dragging the gizmo must not also orbit the camera
transform.addEventListener("dragging-changed", e => { orbit.enabled = !e.value; });

// --- Mode buttons / reset ----------------------------------------------------
function setMode(mode) {
  transform.setMode(mode);
  modeButtons.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
}
modeButtons.forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

function resetGizmo() {
  targetGroup.position.set(0, 0, 0);
  targetGroup.rotation.set(0, 0, 0);
  for (const k of SLIDER_KEYS) {
    sliders[k].value   = "0";
    numInputs[k].value = "0";
  }
  for (const k of POSE_KEYS) poseInputs[k].value = "0";
  scheduleSend();
}
resetBtn.addEventListener("click", resetGizmo);

// Sync helpers: poseInputs <-> targetGroup. Avoid re-entry via _syncing.
function syncPoseFromInputs() {
  if (_syncing) return;
  _syncing = true;
  const px = parseFloat(poseInputs.px.value); if (Number.isFinite(px)) targetGroup.position.x = px;
  const py = parseFloat(poseInputs.py.value); if (Number.isFinite(py)) targetGroup.position.y = py;
  const pz = parseFloat(poseInputs.pz.value); if (Number.isFinite(pz)) targetGroup.position.z = pz;
  const rx = parseFloat(poseInputs.rx.value); if (Number.isFinite(rx)) targetGroup.rotation.x = rx;
  const ry = parseFloat(poseInputs.ry.value); if (Number.isFinite(ry)) targetGroup.rotation.y = ry;
  const rz = parseFloat(poseInputs.rz.value); if (Number.isFinite(rz)) targetGroup.rotation.z = rz;
  _syncing = false;
}
function syncInputsFromPose() {
  if (_syncing) return;
  _syncing = true;
  poseInputs.px.value = targetGroup.position.x.toFixed(3);
  poseInputs.py.value = targetGroup.position.y.toFixed(3);
  poseInputs.pz.value = targetGroup.position.z.toFixed(3);
  poseInputs.rx.value = targetGroup.rotation.x.toFixed(4);
  poseInputs.ry.value = targetGroup.rotation.y.toFixed(4);
  poseInputs.rz.value = targetGroup.rotation.z.toFixed(4);
  _syncing = false;
}

// keyboard shortcuts inside the panel
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "w" || e.key === "W") setMode("translate");
  else if (e.key === "e" || e.key === "E") setMode("rotate");
  else if (e.key === "r" || e.key === "R") resetGizmo();
});

// extension -> webview
window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "reset") resetGizmo();
  else if (msg.type === "setMode") setMode(msg.mode);
  else if (msg.type === "presetList") renderPresetList(Array.isArray(msg.names) ? msg.names : []);
  else if (msg.type === "presetLoaded") applyPresetState(msg.state);
});

// --- Sliders & number inputs (two-way binding) ------------------------------
// The range slider clamps to its min/max but the number input accepts arbitrary
// values; on typed input we let the slider clamp visually but keep the raw
// number for transmission. Each pair stays in sync without firing recursive
// events thanks to a guard flag.
let _syncing = false;
function syncSliderFromNum(k) {
  if (_syncing) return;
  _syncing = true;
  const n = parseFloat(numInputs[k].value);
  sliders[k].value = Number.isFinite(n) ? String(n) : "0";  // slider auto-clamps
  _syncing = false;
}
function syncNumFromSlider(k) {
  if (_syncing) return;
  _syncing = true;
  numInputs[k].value = sliders[k].value;
  _syncing = false;
}
for (const k of SLIDER_KEYS) {
  sliders[k].addEventListener("input", () => { syncNumFromSlider(k); scheduleSend(); });
  numInputs[k].addEventListener("input", () => { syncSliderFromNum(k);  scheduleSend(); });
}
for (const k of POSE_KEYS) {
  poseInputs[k].addEventListener("input", () => { syncPoseFromInputs(); scheduleSend(); });
}

// transform changes also schedule a send, and mirror the new gizmo state back
// into the position/rotation number inputs so typed and dragged input stay
// visibly in sync.
transform.addEventListener("change", scheduleSend);
transform.addEventListener("objectChange", () => { syncInputsFromPose(); scheduleSend(); });

// --- State streaming ---------------------------------------------------------
let pending = false;
function scheduleSend() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; sendState(); });
}

function readNum(k) {
  // The number input holds the source-of-truth value (may exceed slider
  // range); fall back to the slider only if it's empty/invalid.
  const n = parseFloat(numInputs[k].value);
  return Number.isFinite(n) ? n : (parseFloat(sliders[k].value) || 0);
}
function readState() {
  return {
    position: [targetGroup.position.x, targetGroup.position.y, targetGroup.position.z],
    rotation: [targetGroup.rotation.x, targetGroup.rotation.y, targetGroup.rotation.z],
    velocity: [readNum("vx"), readNum("vy"), readNum("vz")],
    angularVelocity: [readNum("ax"), readNum("ay"), readNum("az")]
  };
}

// Stormworks tick rate — slider values are per-tick; channel 13/14 convert to per-second.
const TICKS_PER_SEC = 60;
const TWO_PI = Math.PI * 2;

function refreshChannelTable(s) {
  channelOut[1].textContent  = s.position[0].toFixed(3);
  channelOut[2].textContent  = s.position[1].toFixed(3);
  channelOut[3].textContent  = s.position[2].toFixed(3);
  channelOut[4].textContent  = s.rotation[0].toFixed(3);
  channelOut[5].textContent  = s.rotation[1].toFixed(3);
  channelOut[6].textContent  = s.rotation[2].toFixed(3);
  channelOut[7].textContent  = s.velocity[0].toFixed(3);
  channelOut[8].textContent  = s.velocity[1].toFixed(3);
  channelOut[9].textContent  = s.velocity[2].toFixed(3);
  channelOut[10].textContent = s.angularVelocity[0].toFixed(3);
  channelOut[11].textContent = s.angularVelocity[1].toFixed(3);
  channelOut[12].textContent = s.angularVelocity[2].toFixed(3);

  // derived channels (CH13-17) — keep in sync with PhySim.lua:injectAsInputs
  const vx = s.velocity[0], vy = s.velocity[1], vz = s.velocity[2];
  const ax = s.angularVelocity[0], ay = s.angularVelocity[1], az = s.angularVelocity[2];
  const rx = s.rotation[0], ry = s.rotation[1], rz = s.rotation[2];

  const linAbs = Math.hypot(vx, vy, vz) * TICKS_PER_SEC;
  const angAbs = Math.hypot(ax, ay, az) * TICKS_PER_SEC / TWO_PI;

  const cosrx = Math.cos(rx), sinrx = Math.sin(rx);
  const cosry = Math.cos(ry), sinry = Math.sin(ry);
  const cosrz = Math.cos(rz), sinrz = Math.sin(rz);

  const fwd_x = sinry;
  const fwd_y = -sinrx * cosry;
  const fwd_z =  cosrx * cosry;
  const rgt_y =  sinrz * cosrx + cosrz * sinry * sinrx;

  const clamp = v => v > 1 ? 1 : (v < -1 ? -1 : v);
  const tiltZ = Math.asin(clamp(fwd_y)) / TWO_PI;
  const tiltX = -Math.asin(clamp(rgt_y)) / TWO_PI;   // sign matches PhySim.lua CH16
  const compass = -Math.atan2(fwd_x, fwd_z) / TWO_PI;

  channelOut[13].textContent = linAbs.toFixed(3);
  channelOut[14].textContent = angAbs.toFixed(3);
  channelOut[15].textContent = tiltZ.toFixed(4);
  channelOut[16].textContent = tiltX.toFixed(4);
  channelOut[17].textContent = compass.toFixed(4);
}

function sendState() {
  const s = readState();
  refreshChannelTable(s);
  vscode.postMessage({ type: "state", ...s });
}

// --- Presets ----------------------------------------------------------------
// Preset persistence lives on the extension side (globalState). The webview
// just sends Save/Load/Delete intents and re-renders the dropdown when the
// extension echoes back the current list.
function renderPresetList(names) {
  const prev = presetListEl.value;
  presetListEl.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    presetListEl.appendChild(opt);
  }
  // try to keep the user's previous selection
  if (names.indexOf(prev) !== -1) presetListEl.value = prev;
}

function isTriple(v) {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
}
function applyPresetState(s) {
  if (!s || !isTriple(s.position) || !isTriple(s.rotation) || !isTriple(s.velocity) || !isTriple(s.angularVelocity)) return;
  targetGroup.position.set(s.position[0], s.position[1], s.position[2]);
  targetGroup.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  numInputs.vx.value = String(s.velocity[0]);
  numInputs.vy.value = String(s.velocity[1]);
  numInputs.vz.value = String(s.velocity[2]);
  numInputs.ax.value = String(s.angularVelocity[0]);
  numInputs.ay.value = String(s.angularVelocity[1]);
  numInputs.az.value = String(s.angularVelocity[2]);
  for (const k of SLIDER_KEYS) syncSliderFromNum(k);
  syncInputsFromPose();
  scheduleSend();
}

presetSaveBtn.addEventListener("click", () => {
  const name = presetNameEl.value.trim();
  if (!name) return;
  vscode.postMessage({ type: "presetSave", name, state: readState() });
});
presetLoadBtn.addEventListener("click", () => {
  const name = presetListEl.value;
  if (!name) return;
  vscode.postMessage({ type: "presetLoad", name });
});
presetDeleteBtn.addEventListener("click", () => {
  const name = presetListEl.value;
  if (!name) return;
  vscode.postMessage({ type: "presetDelete", name });
});
presetNameEl.addEventListener("keydown", e => {
  if (e.key === "Enter") presetSaveBtn.click();
});

// initial preset list fetch
vscode.postMessage({ type: "presetListRequest" });

// --- Resize & render loop ---------------------------------------------------
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

const _v = new THREE.Vector3();
function updateLabels() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  for (let i = 0; i < axisTips.length; i++) {
    _v.copy(axisTips[i].pos).project(camera);
    const x = ( _v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    labelEls[i].style.left = x + "px";
    labelEls[i].style.top  = y + "px";
    labelEls[i].style.display = (_v.z > 1 || _v.z < -1) ? "none" : "block";
  }
}

function loop() {
  orbit.update();
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

// initial send (sets table to all zeros and primes the TCP client if connected)
sendState();
