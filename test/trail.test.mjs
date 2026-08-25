// media/trail.js — the trail ring buffer and the velocity-arrow scaling. The
// point of these tests is that the buffer always holds the NEWEST points in
// draw order (a wrapped buffer would draw a stray segment across the seam),
// that a parked gizmo can't flood it, and that the arrow length stays inside
// the scene for any speed a microcontroller might produce.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTrail, clearTrail, setCapacity, pushPoint, trailColorAt, arrowLength,
  ARROW_MIN_LEN, ARROW_MAX_LEN, ARROW_GAIN, MIN_STEP_SQ, DEFAULT_CAPACITY
} from "../media/trail.js";

/** The stored points as [x,y,z] triples, oldest first. */
function points(t) {
  const out = [];
  for (let i = 0; i < t.count; i++) {
    out.push([t.positions[i * 3], t.positions[i * 3 + 1], t.positions[i * 3 + 2]]);
  }
  return out;
}

test("pushPoint appends in order and reports success", () => {
  const t = createTrail(4);
  assert.equal(pushPoint(t, 0, 0, 0), true);
  assert.equal(pushPoint(t, 1, 2, 3), true);
  assert.equal(t.count, 2);
  assert.deepEqual(points(t), [[0, 0, 0], [1, 2, 3]]);
});

test("pushPoint drops samples closer than the minimum step", () => {
  const t = createTrail(8);
  pushPoint(t, 0, 0, 0);
  // just under the threshold in a single axis
  const under = Math.sqrt(MIN_STEP_SQ) * 0.5;
  assert.equal(pushPoint(t, under, 0, 0), false);
  assert.equal(t.count, 1);
  // comfortably over it
  assert.equal(pushPoint(t, 0.01, 0, 0), true);
  assert.equal(t.count, 2);
});

test("pushPoint rejects non-finite coordinates", () => {
  const t = createTrail(4);
  assert.equal(pushPoint(t, NaN, 0, 0), false);
  assert.equal(pushPoint(t, 0, Infinity, 0), false);
  assert.equal(t.count, 0);
});

test("a full buffer drops the oldest point and keeps draw order", () => {
  const t = createTrail(3);
  for (let i = 0; i < 5; i++) pushPoint(t, i, 0, 0);
  assert.equal(t.count, 3);
  assert.deepEqual(points(t), [[2, 0, 0], [3, 0, 0], [4, 0, 0]]);
});

test("setCapacity keeps the newest points when shrinking", () => {
  const t = createTrail(6);
  for (let i = 0; i < 6; i++) pushPoint(t, i, 0, 0);
  setCapacity(t, 2);
  assert.equal(t.capacity, 2);
  assert.equal(t.positions.length, 6);
  assert.deepEqual(points(t), [[4, 0, 0], [5, 0, 0]]);
  // growing keeps everything and leaves room
  setCapacity(t, 5);
  assert.equal(t.capacity, 5);
  assert.deepEqual(points(t), [[4, 0, 0], [5, 0, 0]]);
  pushPoint(t, 9, 0, 0);
  assert.deepEqual(points(t), [[4, 0, 0], [5, 0, 0], [9, 0, 0]]);
});

test("setCapacity is a no-op at the same size and floors to at least 2", () => {
  const t = createTrail(4);
  pushPoint(t, 1, 1, 1);
  const arr = t.positions;
  setCapacity(t, 4);
  assert.equal(t.positions, arr, "same capacity must not reallocate");
  setCapacity(t, 0);
  assert.equal(t.capacity, 2);
});

test("clearTrail empties the buffer but keeps the capacity", () => {
  const t = createTrail(DEFAULT_CAPACITY);
  pushPoint(t, 1, 0, 0);
  pushPoint(t, 2, 0, 0);
  clearTrail(t);
  assert.equal(t.count, 0);
  assert.equal(t.capacity, DEFAULT_CAPACITY);
  // the next point starts a fresh path rather than continuing the old one
  assert.equal(pushPoint(t, 2, 0, 0), true);
});

test("trailColorAt fades from the old end to the new end", () => {
  const oldest = trailColorAt(0, 10);
  const newest = trailColorAt(9, 10);
  for (const c of [...oldest, ...newest]) assert.ok(c >= 0 && c <= 1);
  // brighter at the new end on every channel
  for (let i = 0; i < 3; i++) assert.ok(newest[i] > oldest[i]);
  // monotone in between
  let prev = -1;
  for (let i = 0; i < 10; i++) {
    const g = trailColorAt(i, 10)[1];
    assert.ok(g > prev);
    prev = g;
  }
  // a single point gets the bright end, not a division by zero
  assert.deepEqual(trailColorAt(0, 1), newest);
});

test("arrowLength hides tiny speeds and clamps big ones", () => {
  assert.equal(arrowLength(0), 0);
  assert.equal(arrowLength(1e-9), 0);
  assert.equal(arrowLength(NaN), 0);
  assert.equal(arrowLength(0.001), ARROW_MIN_LEN);
  assert.equal(arrowLength(1e6), ARROW_MAX_LEN);
  // linear in between
  const mid = (ARROW_MIN_LEN / ARROW_GAIN + ARROW_MAX_LEN / ARROW_GAIN) / 2;
  assert.equal(arrowLength(mid), mid * ARROW_GAIN);
});
