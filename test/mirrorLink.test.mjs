// src/agent/mirrorLink.ts: where the MCP server and a PhySim window meet, and
// what the window is prepared to believe of what arrives.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  mirrorEndpoint, ancestors, encodeHello, encodeUpdate, decodeMirrorLine,
  MIRROR_VERSION, MAX_MIRROR_LINE, MAX_MIRROR_ANCESTORS, MIRROR_DIR,
  mirrorPointerFile, mirrorPipeName, isMirrorPipeName, usesPointerFile
} = require("../out/agent/mirrorLink.js");

const POSE = { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
const SCREEN = { number: 1, width: 96, height: 96, poweredOn: true, portrait: false, size: "3x3" };
const CONTROLS = {
  buttons: [{ number: 1, showsToggle: false, toggled: false, down: true }, { number: 2, showsToggle: true, toggled: true, down: false }],
  sliders: [{ number: 3, value: 0.25 }]
};
const frame = (screen, width, height, fill = 7) => ({ screen, width, height, pixels: new Uint8Array(width * height * 4).fill(fill) });
const update = (over = {}) => ({
  tool: "step", status: "running", script: "/p/main.lua", tick: 12, pose: POSE, screens: [SCREEN], frames: [frame(1, 96, 96)],
  controls: CONTROLS, ...over
});
/** The wire form with one field changed, to test what the decoder refuses. */
const wire = (change) => { const o = JSON.parse(encodeUpdate(update())); change(o); return JSON.stringify(o); };

test("the endpoint is the same for the same folder and different for another", () => {
  const a = mirrorEndpoint("/home/me/proj", "linux", "/home/me", 1000);
  assert.equal(a, mirrorEndpoint("/home/me/proj", "linux", "/home/me", 1000));
  assert.notEqual(a, mirrorEndpoint("/home/me/proj2", "linux", "/home/me", 1000));
  assert.notEqual(a, mirrorEndpoint("/home/me/Proj", "linux", "/home/me", 1000), "case matters off Windows");
  assert.match(a, /^\/home\/me\/\.physim\/[0-9a-f]{16}\.sock$/);
  assert.equal(path.basename(path.dirname(a)), MIRROR_DIR);
});

test("the endpoint does not depend on the environment: only on the folder, the home directory and the user", () => {
  // An agent's client starts its servers with a trimmed environment; a
  // location taken from TMPDIR would differ between the two ends.
  const saved = { ...process.env };
  const a = mirrorEndpoint("/p", process.platform === "win32" ? "linux" : process.platform, "/home/me", 1);
  try {
    for (const k of ["TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR", "HOME", "USERPROFILE"]) process.env[k] = "/somewhere/else";
    assert.equal(mirrorEndpoint("/p", process.platform === "win32" ? "linux" : process.platform, "/home/me", 1), a);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("on Windows the pipe's name cannot be computed: it is random, and found through a file in the profile", () => {
  const home = "C:\\Users\\Me";
  const file = mirrorPointerFile("C:\\Users\\Me\\Proj", "win32", home);
  assert.equal(file, mirrorPointerFile("c:\\users\\me\\proj", "win32", home), "the folder's case does not matter there");
  assert.notEqual(file, mirrorPointerFile("C:\\Users\\Me\\Other", "win32", home));
  assert.ok(file.startsWith(path.join(home, MIRROR_DIR)));
  assert.match(path.basename(file), /^[0-9a-f]{16}\.pipe$/);

  const token = "0123456789abcdef0123456789abcdef";
  const name = mirrorPipeName("C:\\Users\\Me\\Proj", "win32", token);
  assert.match(name, /^\\\\\.\\pipe\\physim-mirror-[0-9a-f]{16}-0123456789abcdef0123456789abcdef$/);
  assert.equal(isMirrorPipeName(name), true);
  assert.equal(usesPointerFile("win32"), true);
  for (const p of ["linux", "darwin", "freebsd"]) assert.equal(usesPointerFile(p), false);
});

test("only a pipe name of the kind a window makes is accepted from a pointer file", () => {
  const good = "\\\\.\\pipe\\physim-mirror-0123456789abcdef-0123456789abcdef0123456789abcdef";
  assert.equal(isMirrorPipeName(good), true);
  for (const bad of ["", good + "x", good.slice(0, -1), good.toUpperCase(), "\\\\.\\pipe\\something-else",
    "\\\\server\\pipe\\physim-mirror-0123456789abcdef-0123456789abcdef0123456789abcdef", "/tmp/x.sock", good + "\nmore"]) {
    assert.equal(isMirrorPipeName(bad), false, JSON.stringify(bad));
  }
});

test("a home directory too long for a socket path falls back to /tmp, with the user in the name", () => {
  const short = mirrorEndpoint("/p", "linux", "/home/me", 1000);
  assert.ok(Buffer.byteLength(short) <= 100);
  const long = mirrorEndpoint("/p", "darwin", "/Network/Servers/" + "x".repeat(90), 1000);
  assert.match(long, /^\/tmp\/physim-1000-[0-9a-f]{16}\.sock$/);
  assert.notEqual(long, mirrorEndpoint("/p", "darwin", "/Network/Servers/" + "x".repeat(90), 1001));
  // Bytes, not characters: a home directory in kana is three bytes a character.
  assert.match(mirrorEndpoint("/p", "linux", "/home/" + "あ".repeat(30), 5), /^\/tmp\//);
});

test("ancestors: the folder and each one above it, nearest first, bounded", () => {
  const dir = path.resolve(path.sep, "a", "b", "c");
  assert.deepEqual(ancestors(dir), [dir, path.dirname(dir), path.dirname(path.dirname(dir)), path.resolve(path.sep)]);
  const deep = path.resolve(path.sep, ...Array.from({ length: 60 }, (_, i) => `d${i}`));
  assert.equal(ancestors(deep).length, MAX_MIRROR_ANCESTORS);
  assert.equal(ancestors(deep)[0], deep);
});

test("an update survives the wire: pose, monitors and pictures byte for byte", () => {
  const sent = update({ frames: [frame(1, 96, 96, 200), frame(2, 32, 64, 3)], error: "main.lua:3: boom\nstack" });
  const got = decodeMirrorLine(encodeUpdate(sent));
  assert.equal(got.type, "update");
  const { type, ...rest } = got;
  void type;
  assert.deepEqual(rest, sent);
  assert.ok(got.frames[0].pixels instanceof Uint8Array);
});

test("a frame that is a view into a larger buffer is sent as the view only", () => {
  const big = new Uint8Array(4 * 4 * 4 + 16).fill(9);
  const view = big.subarray(8, 8 + 4 * 4 * 4).fill(5);
  const got = decodeMirrorLine(encodeUpdate(update({ frames: [{ screen: 1, width: 4, height: 4, pixels: view }] })));
  assert.deepEqual(Array.from(got.frames[0].pixels), Array(64).fill(5));
});

test("hello carries the server's version; no script and no error are fine", () => {
  assert.deepEqual(decodeMirrorLine(encodeHello("2.0.0")), { type: "hello", server: "2.0.0" });
  const got = decodeMirrorLine(encodeUpdate(update({ status: "none", script: null, screens: [], frames: [] })));
  assert.equal(got.script, null);
  assert.equal("error" in got, false);
});

test("what is not a mirror message of this version is refused", () => {
  for (const line of ["", "not json", "[]", "null", "5", '{"type":"update"}',
    JSON.stringify({ v: MIRROR_VERSION + 1, type: "hello", server: "x" }),
    JSON.stringify({ v: MIRROR_VERSION, type: "bye" }),
    JSON.stringify({ v: MIRROR_VERSION, type: "hello" }),
    JSON.stringify({ v: MIRROR_VERSION, type: "hello", server: "x".repeat(65) })]) {
    assert.equal(decodeMirrorLine(line), null, line.slice(0, 40));
  }
});

test("every field of an update is checked", () => {
  const bad = [
    o => { o.tool = 5; },
    o => { o.tool = "x".repeat(65); },
    o => { o.status = "flying"; },
    o => { o.script = 5; },
    o => { o.script = "x".repeat(5000); },
    o => { o.tick = -1; },
    o => { o.tick = 1.5; },
    o => { o.tick = "3"; },
    o => { o.pose.position = [1, 2]; },
    o => { o.pose.rotation[1] = null; },
    o => { delete o.pose; },
    o => { o.screens = {}; },
    o => { o.screens = Array(9).fill(o.screens[0]); },
    o => { o.screens[0].width = 0; },
    o => { o.screens[0].height = 289; },
    o => { o.screens[0].number = 0; },
    o => { o.screens[0].poweredOn = 1; },
    o => { o.screens[0].size = "3 x 3"; },
    o => { o.frames = null; },
    o => { o.frames = Array(9).fill(o.frames[0]); },
    o => { o.frames[0].width = 95; },
    o => { o.frames[0].height = 1e9; },
    o => { o.frames[0].pixels = o.frames[0].pixels.slice(4); },
    o => { o.frames[0].pixels = o.frames[0].pixels + "AAAA"; },
    o => { o.frames[0].pixels = 5; },
    o => { o.frames[0].screen = "1"; },
    o => { o.controls = []; },
    o => { o.controls.buttons = null; },
    o => { o.controls.buttons = Array(11).fill(o.controls.buttons[0]); },
    o => { o.controls.buttons[0].number = 11; },
    o => { o.controls.buttons[0].down = 1; },
    o => { delete o.controls.buttons[1].toggled; },
    o => { o.controls.sliders[0].value = 1.5; },
    o => { o.controls.sliders[0].value = "0.5"; },
    o => { o.controls.sliders[0].number = 0; },
    o => { o.controls.sliders = Array(11).fill(o.controls.sliders[0]); },
    o => { o.error = 5; },
    o => { o.error = "x".repeat(20000); }
  ];
  for (const change of bad) assert.equal(decodeMirrorLine(wire(change)), null, change.toString());
  assert.notEqual(decodeMirrorLine(wire(() => {})), null, "the unchanged line is accepted");
});

test("an update without controls, from a server older than their mirroring, reads as none", () => {
  const got = decodeMirrorLine(wire(o => { delete o.controls; }));
  assert.deepEqual(got.controls, { buttons: [], sliders: [] });
});

test("pixels that are the right length but not base64 do not decode into a wrong-sized picture", () => {
  const line = wire(o => { o.frames[0].pixels = "!".repeat(o.frames[0].pixels.length); });
  assert.equal(decodeMirrorLine(line), null);
});

test("a line over the limit is refused without being parsed", () => {
  assert.equal(decodeMirrorLine(" ".repeat(MAX_MIRROR_LINE + 1)), null);
  // Eight of the largest monitors fit.
  const screens = Array.from({ length: 8 }, (_, i) => ({ ...SCREEN, number: i + 1, width: 288, height: 288, size: "9x9" }));
  const line = encodeUpdate(update({ screens, frames: screens.map(s => frame(s.number, 288, 288)) }));
  assert.ok(line.length < MAX_MIRROR_LINE);
  assert.equal(decodeMirrorLine(line).frames.length, 8);
});
