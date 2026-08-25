// Simulation mode + recording/playback.
//
// Simulation: position/rotation are advanced from the velocities and the
// velocities from the accelerations, on a fixed Stormworks tick (1/60 s).
// An accumulator decouples integration from the (variable) rAF cadence, so
// the motion is frame-rate independent and matches the rate the Lua side
// sees.
//
// Recording: each captured frame is the same shape as readState() —
// pos/rot/vel/angVel. The buffer lives in memory only; closing the panel
// discards it. Simulation, recording and playback are mutually exclusive
// where it matters: playback stops simulation/recording, recording can't
// start during playback.

import { TICKS_PER_SEC, normalizeAngle } from "./channels.js";
import { simBtn, recBtn, playBtn, recCountEl, readNum, writeNum } from "./dom.js";
import { targetGroup } from "./scene.js";
import { syncInputsFromPose } from "./pose.js";
import { readState, sendState } from "./messaging.js";
import { resetTrail, sampleTrail } from "./visuals.js";
import { isLogging, logTick } from "./logging.js";

const TICK_DT_MS = 1000 / 60;
const MAX_CATCHUP_MS = 250;          // clamp after a stall so we don't fast-forward
let simulating = false;
let lastSimTime = 0;
let tickAccumulator = 0;

/** @type {import("./channels.js").PhysStateLike[]} */
const recordBuffer = [];
let recording = false;
let playing = false;
let playIndex = 0;
let lastPlayTime = 0;
let playAccumulator = 0;

export function isSimulating() { return simulating; }

/** @param {boolean} on */
export function setSimulating(on) {
  if (simulating === on) return;
  if (on && playing) setPlaying(false);
  simulating = on;
  simBtn.classList.toggle("active", on);
  simBtn.textContent = on ? "⏸ Pause" : "▶ Simulate";
  if (on) { lastSimTime = performance.now(); tickAccumulator = 0; }
}

export function toggleSimulating() { setSimulating(!simulating); }

function integrateOneTick() {
  // semi-implicit Euler: bump velocity by acceleration, then advance by velocity.
  const vx = readNum("vx") + readNum("lax");
  const vy = readNum("vy") + readNum("lay");
  const vz = readNum("vz") + readNum("laz");
  const ax = readNum("ax") + readNum("aax");
  const ay = readNum("ay") + readNum("aay");
  const az = readNum("az") + readNum("aaz");
  writeNum("vx", vx); writeNum("vy", vy); writeNum("vz", vz);
  writeNum("ax", ax); writeNum("ay", ay); writeNum("az", az);

  targetGroup.position.x += vx;
  targetGroup.position.y += vy;
  targetGroup.position.z += vz;
  // wrapped so a long spin doesn't leave the pose inputs reading 40 rad while
  // CH4-6 (normalized in readState) read something else
  targetGroup.rotation.x = normalizeAngle(targetGroup.rotation.x + ax);
  targetGroup.rotation.y = normalizeAngle(targetGroup.rotation.y + ay);
  targetGroup.rotation.z = normalizeAngle(targetGroup.rotation.z + az);

  sampleTrail();   // per tick, so a throttled rAF can't coarsen the trail
  // Both consumers want the post-integration state; read it once.
  if (recording || isLogging()) {
    const s = readState();
    if (recording) recordBuffer.push(s);
    logTick(s);
  }
}

function stepSimulation() {
  const now = performance.now();
  let elapsed = now - lastSimTime;
  lastSimTime = now;
  if (elapsed > MAX_CATCHUP_MS) elapsed = MAX_CATCHUP_MS;
  tickAccumulator += elapsed;
  let ticks = 0;
  while (tickAccumulator >= TICK_DT_MS) {
    tickAccumulator -= TICK_DT_MS;
    integrateOneTick();
    ticks++;
  }
  if (ticks > 0) {
    syncInputsFromPose();
    sendState();
    if (recording) { updateRecCount(); updatePlayBtn(); }
  }
}

function updateRecCount() {
  const n = recordBuffer.length;
  if (n === 0) { recCountEl.textContent = ""; return; }
  const secs = (n / TICKS_PER_SEC).toFixed(2);
  recCountEl.textContent = playing
    ? `${playIndex}/${n} (${secs}s)`
    : `${n} frames (${secs}s)`;
}

function updatePlayBtn() {
  playBtn.disabled = recordBuffer.length === 0 && !playing;
}

/** @param {boolean} on */
export function setRecording(on) {
  if (recording === on) return;
  if (on && playing) return;
  recording = on;
  if (on) { recordBuffer.length = 0; playIndex = 0; }
  recBtn.classList.toggle("recording", on);
  recBtn.textContent = on ? "■ Stop Rec" : "● Rec";
  updateRecCount();
  updatePlayBtn();
}

/** @param {import("./channels.js").PhysStateLike} f */
function applyFrame(f) {
  targetGroup.position.set(f.position[0], f.position[1], f.position[2]);
  targetGroup.rotation.set(f.rotation[0], f.rotation[1], f.rotation[2]);
  writeNum("vx", f.velocity[0]);
  writeNum("vy", f.velocity[1]);
  writeNum("vz", f.velocity[2]);
  writeNum("ax", f.angularVelocity[0]);
  writeNum("ay", f.angularVelocity[1]);
  writeNum("az", f.angularVelocity[2]);
}

/** @param {boolean} on */
export function setPlaying(on) {
  if (playing === on) return;
  if (on) {
    if (recordBuffer.length === 0) return;
    if (recording) setRecording(false);
    if (simulating) setSimulating(false);
    playIndex = 0;
    resetTrail();   // rewinding to frame 0 teleports; start the path fresh
    lastPlayTime = performance.now();
    playAccumulator = 0;
  }
  playing = on;
  playBtn.classList.toggle("active", on);
  playBtn.textContent = on ? "■ Stop" : "▶ Play";
  updateRecCount();
}

function stepPlayback() {
  const now = performance.now();
  let elapsed = now - lastPlayTime;
  lastPlayTime = now;
  if (elapsed > MAX_CATCHUP_MS) elapsed = MAX_CATCHUP_MS;
  playAccumulator += elapsed;
  let advanced = false;
  while (playAccumulator >= TICK_DT_MS) {
    playAccumulator -= TICK_DT_MS;
    if (playIndex >= recordBuffer.length) { setPlaying(false); break; }
    applyFrame(recordBuffer[playIndex]);
    sampleTrail();
    logTick(recordBuffer[playIndex]);   // replaying writes rows too
    playIndex++;
    advanced = true;
  }
  if (advanced) {
    syncInputsFromPose();
    sendState();
    updateRecCount();
  }
}

/** Advance whichever of simulation/playback is active. Called once per rAF. */
export function step() {
  if (simulating) stepSimulation();
  else if (playing) stepPlayback();
}

// toolbar buttons owned by this module
simBtn.addEventListener("click", () => setSimulating(!simulating));
recBtn.addEventListener("click", () => setRecording(!recording));
playBtn.addEventListener("click", () => setPlaying(!playing));
