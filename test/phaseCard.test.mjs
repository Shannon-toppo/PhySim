// tools/ingame/verifyH_phase.lua — the card that asks the real game what
// input.* / output.* do inside onDraw and screen.* inside onTick — run on the
// engine. Two purposes: the card has to work before anyone carries it into the
// game (paging, FIRE, every page reaching "OK"), and what the ENGINE answers on
// each page is pinned here, so that the in-game answers have something exact
// to be compared with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../out/engine/loadEngine.js");
const { VehicleRunner } = require("../out/engine/runner.js");
const { regionStats, textGrid } = require("../out/agent/pixels.js");
const { GAME_SCRIPT_LIMIT } = require("../out/build.js");

const FILE = path.resolve(import.meta.dirname, "..", "tools", "ingame", "verifyH_phase.lua");
const SOURCE = readFileSync(FILE, "utf8");
const engine = await loadEngine();

test("the card is ASCII only and small enough to paste into the game as it is", () => {
  const bad = SOURCE.split("\n").flatMap((l, i) => /[^\p{ASCII}]/u.test(l) ? [i + 1] : []);
  assert.deepEqual(bad, []);
  assert.ok(SOURCE.length <= GAME_SCRIPT_LIMIT, `${SOURCE.length} characters`);
});

/** The card on a monitor of `size`, in the game environment's wiring: touch on the composite inputs. */
function card(t, size = "3x3") {
  const r = new VehicleRunner(engine, {
    entry: FILE, roots: [], screens: [{ number: 1, size, poweredOn: true, portrait: false }],
    files: { isFile: () => false, read: () => new TextEncoder().encode(SOURCE) }
  });
  t.after(() => r.dispose());
  r.start();
  r.tick();   // the card reports its page on the outputs from its first tick
  const screen = r.screenList()[0];
  const tap = (x, y) => {
    r.setTouch(1, { isTouched: true, isTouchedAlt: false, x, y, xAlt: 0, yAlt: 0 });
    r.tick();
    r.setTouch(1, { isTouched: false, isTouchedAlt: false, x: 0, y: 0, xAlt: 0, yAlt: 0 });
    r.tick();
  };
  const out = () => { const o = r.readIo().outputNumbers; return { page: o[19], stage: o[20], result: o[21] }; };
  return {
    r, screen, out,
    next: () => tap(screen.width - 5, screen.height - 5),
    previous: () => tap(5, screen.height - 5),
    fire: () => { tap(5, 5); for (let i = 0; i < 3; i++) r.tick(); },
    picture: () => r.currentFrames()[0],
    /** Lit pixels of the result line ("TOP=FIRE", "FIRING", "OK ..."), by colour. */
    line: () => regionStats(r.currentFrames()[0], { x: 0, y: 52, width: screen.width, height: 5 })
  };
}

const GREEN = [0, 255, 0], YELLOW = [255, 255, 0];
const colorOf = stats => stats.colors[0]?.color;

test("it opens on the control page, and nothing fires until the top half is tapped", t => {
  const c = card(t);
  c.r.tick();
  assert.deepEqual(c.out(), { page: 1, stage: 0, result: 0 });
  for (let i = 0; i < 30; i++) c.r.tick();
  assert.equal(c.out().stage, 0);
  assert.deepEqual(colorOf(c.line()), YELLOW, '"TOP=FIRE" is waiting');
});

test("bottom-right pages forward, bottom-left back, and both wrap; paging never fires", t => {
  const c = card(t);
  const pages = [];
  for (let i = 0; i < 8; i++) { c.next(); pages.push(c.out().page); }
  assert.deepEqual(pages, [2, 3, 4, 5, 6, 7, 1, 2]);
  c.previous(); c.previous();
  assert.equal(c.out().page, 7);
  assert.equal(c.out().stage, 0);
});

test("FIRE announces itself for one frame before it makes the call", t => {
  const c = card(t);
  c.next();
  c.r.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 5, y: 5, xAlt: 0, yAlt: 0 });
  c.r.tick();
  assert.deepEqual(colorOf(c.line()), YELLOW, '"FIRING": if the next frame is an error, this is what is left on the monitor');
  assert.equal(c.out().stage, 1, "seen by onTick before the announcing frame moved it on");
  c.r.tick();
  assert.deepEqual(colorOf(c.line()), GREEN, '"OK ..."');
});

// What the ENGINE answers. The game's answers go beside these once the card has been shot there.
const ENGINE = [
  [1, "control", 1],
  [2, "input.getNumber(1) in onDraw reads 0, not the monitor's width", 0],
  [3, "input.getBool(1) in onDraw reads false", 0],
  [4, "output.setNumber in onDraw is not an error", 1],
  [5, "output.setBool in onDraw is not an error", 1],
  [6, "screen.getWidth() in onTick reads 0", 0],
  [7, "screen.drawRectF in onTick is not an error", 1]
];

for (const [page, what, result] of ENGINE) {
  test(`on the engine, H${page}: ${what}`, t => {
    const c = card(t);
    for (let i = 1; i < page; i++) c.next();
    assert.equal(c.out().page, page);
    // H3 reads the touch itself: keep the finger down through the call, as the card asks.
    if (page === 3) {
      c.r.setTouch(1, { isTouched: true, isTouchedAlt: false, x: 5, y: 5, xAlt: 0, yAlt: 0 });
      for (let i = 0; i < 4; i++) c.r.tick();
    } else {
      c.fire();
    }
    assert.equal(c.r.state, "ready", "no error on the engine");
    assert.deepEqual(c.out(), { page, stage: 3, result });
    assert.deepEqual(colorOf(c.line()), GREEN);
  });
}

test("on the engine, what onDraw writes to the outputs is dropped, and what onTick draws is not shown", t => {
  const c = card(t);
  for (let i = 1; i < 4; i++) c.next();
  c.fire();
  assert.equal(c.r.readIo().outputNumbers[0], 0, "output.setNumber(1, 123) from onDraw did not take");
  c.next();
  c.fire();
  assert.equal(c.r.readIo().outputBooleans[0], false);
  c.next(); c.next();
  c.fire();
  const red = regionStats(c.picture()).colors.find(k => k.color[0] === 255 && k.color[1] === 0 && k.color[2] === 0);
  assert.equal(red, undefined, "the red square drawn from onTick is nowhere on the monitor");
});

test("the dial on ch32 jumps to a page", t => {
  const c = card(t);
  c.r.holdInputNumber(32, 5);
  c.r.tick();
  assert.equal(c.out().page, 5);
  c.r.holdInputNumber(32, 99);
  c.r.tick();
  assert.equal(c.out().page, 7, "past the last page stops at the last");
});

test("the text fits a 3x3 and the card runs on larger monitors too", t => {
  for (const size of ["3x3", "5x3", "9x5"]) {
    const c = card(t, size);
    for (let page = 1; page <= 7; page++) {
      c.fire();
      const p = c.picture();
      const edge = regionStats(p, { x: p.width - 1, y: 0, width: 1, height: p.height });
      assert.equal(edge.lit, 0, `H${page} on ${size}: nothing runs into the right edge`);
      c.next();
    }
  }
  // What a person reads on the control page, as the test sees it.
  const c = card(t);
  c.fire();
  assert.ok(textGrid(c.picture(), { x: 0, y: 52, width: 40, height: 5 }).rows.some(r => r.includes("#")));
});
