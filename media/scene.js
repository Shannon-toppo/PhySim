// Three.js scene for the PhySim webview: lights, grid, axes with HTML tip
// labels, the airplane target mesh, orbit + transform controls, and
// resize/label-projection housekeeping.
//
// Coordinate convention (Stormworks left-handed, exposed via three.js
// right-handed with relabeled axes): +X = East, +Y = Up, +Z = North.
// The camera sits at +X/+Y/-Z and looks at origin, so +Z (north) extends
// AWAY from the viewer (into the screen).

import * as THREE from "three";
import { OrbitControls }     from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { viewport } from "./dom.js";

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

export const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
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
/**
 * @param {THREE.Vector3} dirVec
 * @param {number} color
 */
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
export const targetGroup = new THREE.Group();
scene.add(targetGroup);
buildAirplane(targetGroup);

/** @param {THREE.Group} group */
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

  // horizontal stabiliser — rear edge flush with fuselage tail (z = -0.9)
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.28), matBody);
  hstab.position.set(0, 0, -0.76);
  group.add(hstab);

  // vertical tail fin — thin slab across X, standing up in Y, extending in Z.
  // Rear edge flush with fuselage tail (z = -0.9).
  const vfin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.4), matFin);
  vfin.position.set(0, 0.25, -0.7);
  group.add(vfin);
}

// --- Controls ----------------------------------------------------------------
export const orbit = new OrbitControls(camera, renderer.domElement);
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

export const transform = new TransformControls(camera, renderer.domElement);
transform.attach(targetGroup);
transform.setSpace("world");
transform.setMode("translate");
scene.add(transform);

// dragging the gizmo must not also orbit the camera
transform.addEventListener("dragging-changed", e => { orbit.enabled = !e.value; });

// --- Resize & label projection ------------------------------------------------
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
export function updateLabels() {
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
