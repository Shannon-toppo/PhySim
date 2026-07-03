// Sync helpers bridging the position/rotation number inputs and the gizmo
// target. Re-entry is prevented by the shared syncGuard (one flag for both
// this module and dom.js's slider sync — see dom.js).

import { poseInputs, syncGuard } from "./dom.js";
import { targetGroup } from "./scene.js";

export function syncPoseFromInputs() {
  if (syncGuard.active) return;
  syncGuard.active = true;
  const px = parseFloat(poseInputs.px.value); if (Number.isFinite(px)) targetGroup.position.x = px;
  const py = parseFloat(poseInputs.py.value); if (Number.isFinite(py)) targetGroup.position.y = py;
  const pz = parseFloat(poseInputs.pz.value); if (Number.isFinite(pz)) targetGroup.position.z = pz;
  const rx = parseFloat(poseInputs.rx.value); if (Number.isFinite(rx)) targetGroup.rotation.x = rx;
  const ry = parseFloat(poseInputs.ry.value); if (Number.isFinite(ry)) targetGroup.rotation.y = ry;
  const rz = parseFloat(poseInputs.rz.value); if (Number.isFinite(rz)) targetGroup.rotation.z = rz;
  syncGuard.active = false;
}

export function syncInputsFromPose() {
  if (syncGuard.active) return;
  syncGuard.active = true;
  poseInputs.px.value = targetGroup.position.x.toFixed(3);
  poseInputs.py.value = targetGroup.position.y.toFixed(3);
  poseInputs.pz.value = targetGroup.position.z.toFixed(3);
  poseInputs.rx.value = targetGroup.rotation.x.toFixed(4);
  poseInputs.ry.value = targetGroup.rotation.y.toFixed(4);
  poseInputs.rz.value = targetGroup.rotation.z.toFixed(4);
  syncGuard.active = false;
}
