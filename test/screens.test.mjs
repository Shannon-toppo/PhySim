// src/engine/screens.ts: the microcontroller's monitors — request validation,
// pixel sizes, the script-vs-panel numbering rule, touch, and change events.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  SCREEN_SIZES as PANEL_SIZES, DEFAULT_SIZE, MAX_SCREENS as PANEL_MAX, PX_PER_BLOCK as PANEL_PX
} from "../media/monitorConfig.js";

const require = createRequire(import.meta.url);
const {
  ScreenRegistry, sanitizeScreenRequest, parseBlocks, NO_TOUCH, MAX_BLOCKS, MAX_SCREENS, PX_PER_BLOCK
} = require("../out/engine/screens.js");

const touch = (o = {}) => ({ isTouched: true, isTouchedAlt: false, x: 1, y: 2, xAlt: 0, yAlt: 0, ...o });

/** A registry that records every onChange payload. */
function registry() {
  const reg = new ScreenRegistry();
  const events = [];
  reg.onChange = list => events.push(list);
  return { reg, events };
}

// --- The host and the panel agree ------------------------------------------------

test("the host accepts every size the panel offers", () => {
  // A size the panel offers but the host rejects fails silently: the message
  // is dropped and the dropdown springs back to its old value.
  for (const size of [...PANEL_SIZES, DEFAULT_SIZE]) {
    assert.ok(sanitizeScreenRequest({ number: 1, size }), `${size} must be accepted`);
    assert.ok(parseBlocks(size), size);
  }
  assert.equal(PANEL_MAX, MAX_SCREENS);
  assert.equal(PANEL_PX, PX_PER_BLOCK);
});

test("the panel's largest size is within the host's block cap", () => {
  for (const size of PANEL_SIZES) {
    const { bw, bh } = parseBlocks(size);
    assert.ok(bw <= MAX_BLOCKS && bh <= MAX_BLOCKS, size);
  }
});

// --- parseBlocks / sanitizeScreenRequest -----------------------------------------

test("parseBlocks accepts 1x1 up to the cap and nothing else", () => {
  assert.deepEqual(parseBlocks("1x1"), { bw: 1, bh: 1 });
  assert.deepEqual(parseBlocks("9x5"), { bw: 9, bh: 5 });
  assert.deepEqual(parseBlocks("09x01"), { bw: 9, bh: 1 }, "leading zeros are still within two digits");
  assert.deepEqual(parseBlocks(`${MAX_BLOCKS}x${MAX_BLOCKS}`), { bw: MAX_BLOCKS, bh: MAX_BLOCKS });
  for (const bad of [
    "0x3", "3x0", "10x1", "1x10", "99x99", "100x1", "1x100", "-1x3", "3x-1", "1.5x2", "3X3", "3 x 3", " 3x3",
    "3x3 ", "3x3\n", "3", "3x", "x3", "", "3*3", "axb", "3x3x3", "0x0"
  ]) {
    assert.equal(parseBlocks(bad), null, JSON.stringify(bad));
  }
});

test("sanitizeScreenRequest: defaults, aliases, rounding", () => {
  assert.deepEqual(sanitizeScreenRequest({ number: 2, size: "2x2" }),
    { number: 2, size: "2x2", poweredOn: true, portrait: false });
  // `screen` is what the webview message calls it; `number` is the stored shape.
  assert.deepEqual(sanitizeScreenRequest({ screen: "2", size: "2x2" }),
    { number: 2, size: "2x2", poweredOn: true, portrait: false });
  assert.equal(sanitizeScreenRequest({ number: 3, screen: 4, size: "1x1" }).number, 3, "number wins over screen");
  assert.equal(sanitizeScreenRequest({ number: 2.4, size: "1x1" }).number, 2);
  assert.equal(sanitizeScreenRequest({ number: 2.6, size: "1x1" }).number, 3);
  assert.deepEqual(sanitizeScreenRequest({ number: 3, size: "5x3", portrait: true, poweredOn: false }),
    { number: 3, size: "5x3", poweredOn: false, portrait: true });
});

test("sanitizeScreenRequest: only an explicit false powers off, only an explicit true is portrait", () => {
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", poweredOn: 0 }).poweredOn, true);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", poweredOn: null }).poweredOn, true);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", poweredOn: "false" }).poweredOn, true);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", poweredOn: false }).poweredOn, false);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", portrait: 1 }).portrait, false);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", portrait: "true" }).portrait, false);
  assert.equal(sanitizeScreenRequest({ number: 1, size: "1x1", portrait: true }).portrait, true);
});

test("sanitizeScreenRequest rejects what would corrupt the registry", () => {
  const ok = { size: "3x3" };
  assert.equal(sanitizeScreenRequest({ ...ok, number: 0 }), null, "screen 0");
  assert.equal(sanitizeScreenRequest({ ...ok, number: -1 }), null);
  assert.equal(sanitizeScreenRequest({ ...ok, number: MAX_SCREENS + 1 }), null, "past the cap");
  assert.ok(sanitizeScreenRequest({ ...ok, number: MAX_SCREENS }), "the cap itself is fine");
  assert.equal(sanitizeScreenRequest({ ...ok, number: 0.4 }), null, "rounds to 0");
  assert.equal(sanitizeScreenRequest({ ...ok, number: NaN }), null);
  assert.equal(sanitizeScreenRequest({ ...ok, number: Infinity }), null);
  assert.equal(sanitizeScreenRequest({ ...ok, number: "x" }), null);
  assert.equal(sanitizeScreenRequest({ ...ok }), null, "no number at all");
  assert.equal(sanitizeScreenRequest({ number: 1, size: "0x3" }), null, "a zero-block axis");
  assert.equal(sanitizeScreenRequest({ number: 1, size: "20x20" }), null, "past the block cap");
  assert.equal(sanitizeScreenRequest({ number: 1, size: "3 x 3" }), null);
  assert.equal(sanitizeScreenRequest({ number: 1, size: 33 }), null, "a size must be a string spelling");
  assert.equal(sanitizeScreenRequest({ number: 1 }), null, "no size at all");
  for (const v of [null, undefined, 0, 1, "3x3", true, []]) assert.equal(sanitizeScreenRequest(v), null, String(v));
});

test("sanitizeScreenRequest returns a fresh object holding only known fields", () => {
  const input = { number: 1, size: "1x1", extra: "x" };
  const out = sanitizeScreenRequest(input);
  assert.deepEqual(Object.keys(out).sort(), ["number", "poweredOn", "portrait", "size"].sort());
  assert.notEqual(out, input);
});

// --- Sizes ---------------------------------------------------------------------------

test("a monitor block is 32 px; portrait swaps the axes", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "3x3", poweredOn: true, portrait: false });
  reg.configure({ number: 2, size: "5x3", poweredOn: true, portrait: false });
  reg.configure({ number: 3, size: "5x3", poweredOn: true, portrait: true });
  reg.configure({ number: 4, size: "9x5", poweredOn: false, portrait: true });
  const px = n => { const s = reg.get(n); return [s.width, s.height, s.size, s.portrait, s.poweredOn]; };
  assert.deepEqual(px(1), [96, 96, "3x3", false, true]);
  assert.deepEqual(px(2), [160, 96, "5x3", false, true]);
  assert.deepEqual(px(3), [96, 160, "5x3", true, true], "size stays as spelled, pixels swap");
  assert.deepEqual(px(4), [160, 288, "9x5", true, false]);
});

test("configure refuses a size outside the caps, leaving the registry untouched", () => {
  const { reg, events } = registry();
  assert.throws(() => reg.configure({ number: 1, size: "10x1", poweredOn: true, portrait: false }), /invalid screen size/);
  assert.deepEqual(reg.list(), []);
  assert.equal(events.length, 0);
});

test("list() is sorted by number whatever the declaration order", () => {
  const { reg } = registry();
  for (const n of [5, 1, 8, 3]) reg.configure({ number: n, size: "1x1", poweredOn: true, portrait: false });
  assert.deepEqual(reg.list().map(s => s.number), [1, 3, 5, 8]);
});

// --- Script declarations: the numbering rule ----------------------------------------

test("declareFromScript: an existing number is reconfigured in place", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "3x3", poweredOn: true, portrait: false });
  assert.equal(reg.declareFromScript(1, "1x1", true, true), 1);
  assert.deepEqual(reg.list().map(s => [s.number, s.size, s.portrait, s.width, s.height]), [[1, "1x1", true, 32, 32]]);
});

test("declareFromScript: an unknown number is not honoured, the next free one is used", () => {
  const { reg } = registry();
  assert.equal(reg.declareFromScript(5, "2x1", true, false), 1, "first monitor takes 1 even though 5 was asked for");
  assert.equal(reg.declareFromScript(5, "2x2", true, false), 2, "5 still unknown -> next free (2)");
  assert.equal(reg.declareFromScript(7, "1x1", true, false), 3);
  assert.deepEqual(reg.list().map(s => s.number), [1, 2, 3]);
  assert.equal(reg.declareFromScript(2, "3x3", true, false), 2, "now 2 exists and is honoured");
  assert.equal(reg.get(2).size, "3x3");
});

test("declareFromScript: the next free number fills gaps from 1", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  reg.configure({ number: 3, size: "1x1", poweredOn: true, portrait: false });
  assert.equal(reg.declareFromScript(99, "1x1", true, false), 2);
  assert.equal(reg.declareFromScript(0, "1x1", true, false), 4, "0 names no monitor either");
  assert.equal(reg.declareFromScript(-3, "1x1", true, false), 5);
});

test("declareFromScript: a declared number that names a seeded monitor lands on top of the panel's layout", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "2x2", poweredOn: true, portrait: false });   // the panel's
  reg.configure({ number: 2, size: "2x2", poweredOn: true, portrait: false });
  assert.equal(reg.declareFromScript(2, "1x1", false, false), 2);
  assert.equal(reg.get(2).size, "1x1");
  assert.equal(reg.get(2).poweredOn, false);
  assert.equal(reg.get(1).size, "2x2", "the other monitor is untouched");
});

test("declareFromScript rejects a bad size with a message naming it", () => {
  const { reg } = registry();
  assert.throws(() => reg.declareFromScript(1, "big", true, false), /"big" is not a monitor size/);
  assert.throws(() => reg.declareFromScript(1, "10x10", true, false), /"10x10"/);
  assert.throws(() => reg.declareFromScript(1, "", true, false), /not a monitor size/);
  assert.deepEqual(reg.list(), []);
});

test("MAX_SCREENS: the 9th new monitor is refused, existing ones can still be reconfigured", () => {
  const { reg } = registry();
  for (let i = 1; i <= MAX_SCREENS; i++) assert.equal(reg.declareFromScript(i, "1x1", true, false), i);
  assert.equal(reg.list().length, MAX_SCREENS);
  assert.throws(() => reg.declareFromScript(99, "1x1", true, false), new RegExp(`no more than ${MAX_SCREENS} monitors`));
  assert.equal(reg.list().length, MAX_SCREENS);
  assert.equal(reg.declareFromScript(4, "2x2", true, false), 4);
  assert.equal(reg.get(4).size, "2x2");
  reg.remove(3);
  assert.equal(reg.declareFromScript(99, "1x1", true, false), 3, "a freed number is reused");
});

// --- Touch ---------------------------------------------------------------------------

test("touch is stored per monitor, coerced to booleans and rounded integers", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "3x3", poweredOn: true, portrait: false });
  reg.configure({ number: 2, size: "3x3", poweredOn: true, portrait: false });
  assert.equal(reg.touch(1), NO_TOUCH);
  reg.setTouch(1, touch({ x: 40.6, y: -2.4, xAlt: 7, yAlt: 8 }));
  assert.deepEqual(reg.touch(1), { isTouched: true, isTouchedAlt: false, x: 41, y: -2, xAlt: 7, yAlt: 8 });
  assert.equal(reg.touch(2), NO_TOUCH, "the other monitor is not touched");
  reg.setTouch(1, { isTouched: "yes", isTouchedAlt: 1, x: NaN, y: Infinity, xAlt: "5", yAlt: undefined });
  assert.deepEqual(reg.touch(1), { isTouched: false, isTouchedAlt: false, x: 0, y: 0, xAlt: 5, yAlt: 0 });
});

test("touch on a missing or powered-off monitor is ignored", () => {
  const { reg } = registry();
  reg.setTouch(3, touch());
  assert.equal(reg.touch(3), NO_TOUCH, "no such monitor, and none is created");
  assert.deepEqual(reg.list(), []);
  reg.configure({ number: 1, size: "1x1", poweredOn: false, portrait: false });
  reg.setTouch(1, touch());
  assert.equal(reg.touch(1), NO_TOUCH);
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  reg.setTouch(1, touch());
  assert.equal(reg.touch(1).isTouched, true);
});

test("powering a monitor off drops its touch, and powering on does not bring it back", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  reg.setTouch(1, touch());
  reg.configure({ number: 1, size: "1x1", poweredOn: false, portrait: false });
  assert.equal(reg.touch(1), NO_TOUCH);
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  assert.equal(reg.touch(1), NO_TOUCH);
});

test("resizing a powered monitor keeps its touch; a removed monitor loses it", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  reg.setTouch(1, touch({ x: 9 }));
  reg.configure({ number: 1, size: "2x2", poweredOn: true, portrait: true });
  assert.equal(reg.touch(1).x, 9);
  reg.remove(1);
  assert.equal(reg.touch(1), NO_TOUCH);
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  assert.equal(reg.touch(1), NO_TOUCH, "a new monitor starts untouched");
});

test("NO_TOUCH is frozen and all-off", () => {
  assert.ok(Object.isFrozen(NO_TOUCH));
  assert.deepEqual({ ...NO_TOUCH }, { isTouched: false, isTouchedAlt: false, x: 0, y: 0, xAlt: 0, yAlt: 0 });
});

// --- onChange ------------------------------------------------------------------------

test("onChange fires only for real changes", () => {
  const { reg, events } = registry();
  const one = { number: 1, size: "3x3", poweredOn: true, portrait: false };
  reg.configure(one);
  assert.equal(events.length, 1);
  reg.configure({ ...one });
  assert.equal(events.length, 1, "identical configuration");
  reg.declareFromScript(1, "3x3", true, false);
  assert.equal(events.length, 1, "identical declaration");
  reg.setTouch(1, touch());
  assert.equal(events.length, 1, "touch is not a layout change");
  reg.configure({ ...one, portrait: true });
  assert.equal(events.length, 2);
  reg.configure({ ...one, portrait: true, poweredOn: false });
  assert.equal(events.length, 3);
  reg.configure({ ...one, portrait: true, poweredOn: false, size: "1x1" });
  assert.equal(events.length, 4);
  reg.remove(2);
  assert.equal(events.length, 4, "removing a monitor that is not there");
  reg.remove(1);
  assert.equal(events.length, 5);
  assert.deepEqual(events[4], []);
});

test("onChange carries the whole sorted list", () => {
  const { reg, events } = registry();
  reg.configure({ number: 2, size: "1x1", poweredOn: true, portrait: false });
  reg.configure({ number: 1, size: "2x1", poweredOn: true, portrait: false });
  assert.deepEqual(events.at(-1).map(s => s.number), [1, 2]);
  assert.deepEqual(events.at(-1), reg.list());
});

test("a registry with no listener works", () => {
  const reg = new ScreenRegistry();
  assert.doesNotThrow(() => {
    reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
    reg.remove(1);
  });
});

test("screen info is a snapshot of the registry, not a live alias of an earlier list", () => {
  const { reg } = registry();
  reg.configure({ number: 1, size: "1x1", poweredOn: true, portrait: false });
  const before = reg.list();
  reg.configure({ number: 1, size: "2x2", poweredOn: true, portrait: false });
  assert.equal(before[0].size, "1x1");
  assert.equal(reg.list()[0].size, "2x2");
});
