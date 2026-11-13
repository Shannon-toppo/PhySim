// The mirror end to end over a real local socket: src/agent/mirrorClient.ts
// (the MCP server's side, fed by a real AgentSession on the engine) talking to
// src/mirrorServer.ts (the window's side).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEngine } = require("../out/engine/loadEngine.js");
const { AgentSession } = require("../out/agent/agentSession.js");
const { MirrorClient } = require("../out/agent/mirrorClient.js");
const { MirrorServer } = require("../out/mirrorServer.js");
const { encodeHello, encodeUpdate, mirrorEndpoint, mirrorPointerFile, MIRROR_DIR } = require("../out/agent/mirrorLink.js");

const engine = await loadEngine();
const files = {
  isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
  read: f => readFileSync(f)
};
const WIN = process.platform === "win32";
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const MAIN = `
n = 0
function onTick() n = n + 1 end
function onDraw() screen.setColor(255, 255, 255); screen.drawRectF(0, 0, n, 1) end
`;

/** A project folder, and a stand-in home directory for the sockets (short: a socket path is limited). */
function workspace(sources = { "src/main.lua": MAIN }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "physim-mirror-")));
  for (const [name, text] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  const sockets = realpathSync(mkdtempSync(path.join(tmpdir(), "pm-")));
  return { dir, sockets, entry: path.join(dir, "src", "main.lua") };
}

/** A window listening for `folders`, recording what it is told. */
async function window_(t, sockets, folders, options = {}) {
  const events = [];
  const waiters = [];
  const push = e => { events.push(e); for (const w of waiters.splice(0)) w(); };
  const server = new MirrorServer({
    connected: v => push({ type: "connected", server: v }),
    update: u => push({ type: "update", ...u }),
    disconnected: () => push({ type: "disconnected" })
  }, { home: sockets, ...options });
  t.after(() => server.dispose());
  await server.setFolders(folders);
  /** Resolves once `count` events of `type` have arrived. */
  const until = async (type, count = 1) => {
    const deadline = Date.now() + 5000;
    while (events.filter(e => e.type === type).length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} × ${type}; got ${events.map(e => e.type).join(", ")}`);
      await Promise.race([new Promise(r => waiters.push(r)), new Promise(r => setTimeout(r, 100))]);
    }
    return events.filter(e => e.type === type);
  };
  return { server, events, until };
}

/** An agent's session with its mirror client. `clock` is the client's time, for the retry interval. */
function agent(t, sockets, clock = { now: 0 }, options = {}) {
  const session = new AgentSession(engine, files);
  const client = new MirrorClient(session, { serverVersion: "9.9.9", home: sockets, now: () => clock.now, ...options });
  t.after(() => { client.dispose(); session.dispose(); });
  return { session, client, clock };
}

const lit = frame => { let n = 0; for (let i = 0; i < frame.pixels.length; i += 4) if (frame.pixels[i] && frame.pixels[i + 3]) n++; return n; };
const settle = () => new Promise(r => setTimeout(r, 150));

test("a window with the script's folder open is found from the script, and told the run after each call", async t => {
  const { dir, sockets, entry } = workspace();
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);

  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  const [first] = await w.until("update");
  assert.deepEqual(w.events[0], { type: "connected", server: "9.9.9" });
  assert.equal(first.tool, "start_script", "the call that made the connection is still named");
  assert.deepEqual([first.status, first.script, first.tick], ["running", entry, 0]);
  assert.deepEqual(first.screens.map(s => [s.number, s.width, s.height, s.size]), [[1, 96, 96, "3x3"]]);
  assert.deepEqual(first.frames, [], "nothing is drawn before the first tick");

  a.session.setPose({ position: [1, 2, 3], rotation: [0, 0, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
  a.client.publish("set_pose");
  a.session.step({ ticks: 5, motion: "hold" });
  a.client.publish("step");
  const updates = await w.until("update", 3);
  assert.deepEqual(updates[1].pose.position, [1, 2, 3]);
  assert.equal(updates[1].frames.length, 0);
  assert.deepEqual([updates[2].tool, updates[2].tick], ["step", 5]);
  assert.equal(updates[2].frames.length, 1);
  assert.deepEqual([updates[2].frames[0].screen, updates[2].frames[0].width, lit(updates[2].frames[0])], [1, 96, 5]);
  assert.ok(a.client.isConnected());
});

test("the buttons and sliders the script reads go along, with how they stand", async t => {
  const { dir, sockets, entry } = workspace({ "src/main.lua": `
    function onTick() output.setBool(1, simulator:getIsClicked(1) or simulator:getIsToggled(2)); output.setNumber(1, simulator:getSlider(3)) end` });
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  const [first] = await w.until("update");
  assert.deepEqual(first.controls, { buttons: [], sliders: [] }, "nothing is read before a tick");
  a.session.step({ ticks: 1, motion: "hold" });
  a.session.pressButton(1, true);
  a.session.clickButton(2);
  a.session.setSlider(3, 0.25);
  a.client.publish("set_controls");
  const updates = await w.until("update", 2);
  assert.deepEqual(updates[1].controls, {
    buttons: [{ number: 1, showsToggle: false, toggled: true, down: true }, { number: 2, showsToggle: true, toggled: true, down: false }],
    sliders: [{ number: 3, value: 0.25 }]
  });
  a.session.stop();
  a.client.publish("stop_script");
  assert.deepEqual((await w.until("update", 3))[2].controls, { buttons: [], sliders: [] });
});

test("only pictures that changed are sent again", async t => {
  const { dir, sockets, entry } = workspace({ "src/main.lua": "function onDraw() screen.setColor(0, 255, 0); screen.drawRectF(0, 0, 3, 3) end" });
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir], screens: [{ number: 2, size: "1x1", poweredOn: true, portrait: false }] });
  a.client.publish("start_script");
  await w.until("update");
  a.session.step({ ticks: 1, motion: "hold" });
  a.client.publish("step");
  a.session.step({ ticks: 3, motion: "hold" });
  a.client.publish("step");
  const updates = await w.until("update", 3);
  assert.deepEqual(updates[1].frames.map(f => f.screen).sort(), [1, 2]);
  assert.deepEqual(updates[2].frames, [], "a static picture is not sent twice");
  assert.equal(updates[2].tick, 4);
});

test("the window may have a folder above the script open; the nearest listening one wins", async t => {
  const { dir, sockets, entry } = workspace();
  const outer = await window_(t, sockets, [dir]);
  const inner = await window_(t, sockets, [path.join(dir, "src")]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await inner.until("update");
  await settle();
  assert.equal(outer.events.length, 0);
});

test("with no window listening nothing happens, and a window opened later is found on the next start", async t => {
  const { dir, sockets, entry } = workspace();
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  a.session.step({ ticks: 2, motion: "hold" });
  a.client.publish("step");
  await settle();
  assert.equal(a.client.isConnected(), false);

  const w = await window_(t, sockets, [dir]);
  a.session.step({ ticks: 1, motion: "hold" });
  a.client.publish("step");
  await settle();
  assert.equal(w.events.length, 0, "not looked for again so soon after the last search");

  a.clock.now += 6000;
  a.session.step({ ticks: 1, motion: "hold" });
  a.client.publish("step");
  const [u] = await w.until("update");
  assert.equal(u.tick, 4);
  assert.equal(u.frames.length, 1, "a new connection gets every picture, not just what changed");
  assert.equal(lit(u.frames[0]), 4);
});

test("stop_script tells the window the run is gone; a failed run carries its error", async t => {
  const { dir, sockets, entry } = workspace({ "src/main.lua": "function onTick() error('boom') end" });
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await w.until("update");
  a.session.step({ ticks: 1, motion: "hold" });
  a.client.publish("step");
  a.session.stop();
  a.client.publish("stop_script");
  const updates = await w.until("update", 3);
  assert.equal(updates[1].status, "failed");
  assert.match(updates[1].error, /main\.lua:1: boom/);
  assert.deepEqual([updates[2].status, updates[2].script, updates[2].screens.length], ["none", null, 0]);
  assert.equal("error" in updates[2], false);
});

test("the agent's server going away is a disconnect; a window going away leaves the agent unharmed", async t => {
  const { dir, sockets, entry } = workspace();
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await w.until("update");
  a.client.dispose();
  await w.until("disconnected");

  const b = agent(t, sockets);
  b.session.start({ entry, roots: [dir] });
  b.client.publish("start_script");
  await w.until("update", 2);
  w.server.dispose();
  await settle();
  assert.equal(b.client.isConnected(), false);
  b.session.step({ ticks: 3, motion: "hold" });
  b.client.publish("step");
  assert.equal(b.session.getTicks(), 3);
});

test("a script in another folder ends the connection to the window that was watching", async t => {
  const one = workspace();
  const other = workspace();
  const w = await window_(t, one.sockets, [one.dir]);
  const a = agent(t, one.sockets);
  a.session.start({ entry: one.entry, roots: [one.dir] });
  a.client.publish("start_script");
  await w.until("update");
  a.session.start({ entry: other.entry, roots: [other.dir] });
  a.client.publish("start_script");
  await w.until("disconnected");
  assert.equal(w.events.filter(e => e.type === "update").length, 1, "the other folder's run is not this window's to show");
});

test("a second agent replaces the first; the first one's later updates are not shown", async t => {
  const { dir, sockets, entry } = workspace();
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets), b = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await w.until("update");
  b.session.start({ entry, roots: [dir] });
  b.session.step({ ticks: 7, motion: "hold" });
  b.client.publish("start_script");
  const updates = await w.until("update", 2);
  assert.equal(updates[1].tick, 7);
  assert.deepEqual(w.events.map(e => e.type), ["connected", "update", "disconnected", "connected", "update"]);
  await settle();
  assert.equal(a.client.isConnected(), false);
});

test("a connection that does not greet is not an agent: it displaces nobody and is dropped on garbage", async t => {
  const { dir, sockets, entry } = workspace();
  const w = await window_(t, sockets, [dir]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await w.until("update");
  const endpoint = w.server.endpoints()[0];

  // Another window probing whether the endpoint is alive: connects and leaves.
  await new Promise(resolve => { const s = connect(endpoint, () => { s.destroy(); resolve(); }); });
  // Something that sends an update without greeting, and something that sends rubbish.
  for (const line of [encodeUpdate({ tool: "x", status: "running", script: null, tick: 99, pose: { position: [0, 0, 0], rotation: [0, 0, 0], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }, screens: [], frames: [] }), "rubbish"]) {
    await new Promise(resolve => {
      const s = connect(endpoint, () => s.write(line + "\n"));
      s.on("close", resolve);
      s.on("error", () => {});
    });
  }
  a.session.step({ ticks: 2, motion: "hold" });
  a.client.publish("step");
  const updates = await w.until("update", 2);
  assert.equal(updates[1].tick, 2);
  assert.deepEqual(w.events.map(e => e.type), ["connected", "update", "update"], "the agent stayed, nothing else was shown");
});

test("a greeted connection that then sends rubbish is dropped", async t => {
  const { dir, sockets } = workspace();
  const w = await window_(t, sockets, [dir]);
  await new Promise(resolve => {
    const s = connect(w.server.endpoints()[0], () => s.write(encodeHello("1") + "\n{\"v\":1,\"type\":\"update\"}\n"));
    s.on("close", resolve);
    s.on("error", () => {});
  });
  assert.deepEqual((await w.until("disconnected")).length, 1);
  assert.deepEqual(w.events.map(e => e.type), ["connected", "disconnected"]);
});

test("two windows on one folder: the second leaves the first alone", async t => {
  const { dir, sockets, entry } = workspace();
  const first = await window_(t, sockets, [dir]);
  const second = await window_(t, sockets, [dir]);
  assert.equal(first.server.endpoints().length, 1);
  assert.equal(second.server.endpoints().length, 0);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await first.until("update");
  assert.equal(second.events.length, 0);
});

test("a socket file left by a window that crashed is taken over", { skip: WIN && "named pipes leave no file behind" }, async t => {
  const { dir, sockets, entry } = workspace();
  const endpoint = mirrorEndpoint(dir, process.platform, sockets, uid);
  mkdirSync(path.dirname(endpoint), { recursive: true });
  // A process that listens and is then killed outright leaves its socket file behind.
  spawnSync(process.execPath, ["-e",
    "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", endpoint]);
  assert.ok(existsSync(endpoint));
  const w = await window_(t, sockets, [dir]);
  assert.deepEqual(w.server.endpoints(), [endpoint]);
  const a = agent(t, sockets);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await w.until("update");
});

test("setFolders opens and closes listeners to match; dispose removes the sockets", async t => {
  const one = workspace(), two = workspace();
  const w = await window_(t, one.sockets, [one.dir]);
  const e1 = w.server.endpoints()[0];
  await w.server.setFolders([one.dir, two.dir, path.join(one.dir, "does-not-exist")]);
  assert.equal(w.server.endpoints().length, 2);
  await w.server.setFolders([two.dir]);
  assert.equal(w.server.endpoints().length, 1);
  assert.notEqual(w.server.endpoints()[0], e1);
  if (!WIN) assert.equal(existsSync(e1), false);
  const e2 = w.server.endpoints()[0];
  w.server.dispose();
  if (!WIN) assert.equal(existsSync(e2), false);
  await w.server.setFolders([one.dir]);
  assert.deepEqual(w.server.endpoints(), [], "a disposed server listens for nothing");
});

test("the socket is the owner's alone", { skip: WIN && "named pipes have no file mode" }, async t => {
  const { dir, sockets } = workspace();
  const w = await window_(t, sockets, [dir]);
  assert.equal(statSync(w.server.endpoints()[0]).mode & 0o077, 0);
  assert.equal(statSync(path.join(sockets, MIRROR_DIR)).mode & 0o077, 0, "and so is the directory it is in");
});

// --- The pointer file (how the endpoint is found on Windows) --------------------
//
// On Windows the endpoint is a named pipe with a random name, left in a file in
// the user's profile. Off Windows no pipe can be made, so these tests run the
// same lookup with a Unix socket standing in for the pipe; on Windows they use
// the real thing.

const pointed = sockets => WIN
  ? { window: { pointerFile: true }, agent: { pointerFile: true } }
  : {
    window: { pointerFile: true, makeEndpoint: (folder, token) => path.join(sockets, MIRROR_DIR, `${token.slice(0, 12)}.sock`) },
    agent: { pointerFile: true, acceptEndpoint: name => name.startsWith(path.join(sockets, MIRROR_DIR)) }
  };

test("pointer file: the window leaves its endpoint's name in the profile, and the server finds it there", async t => {
  const { dir, sockets, entry } = workspace();
  const o = pointed(sockets);
  const w = await window_(t, sockets, [dir], o.window);
  const pointer = mirrorPointerFile(dir, process.platform, sockets);
  assert.equal(readFileSync(pointer, "utf8"), w.server.endpoints()[0]);
  if (!WIN) assert.equal(statSync(pointer).mode & 0o077, 0);

  const a = agent(t, sockets, { now: 0 }, o.agent);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  const [u] = await w.until("update");
  assert.equal(u.tool, "start_script");

  w.server.dispose();
  assert.equal(existsSync(pointer), false, "the pointer goes with the window");
});

test("pointer file: each window makes up a different name", async t => {
  const one = workspace(), two = workspace();
  const o = pointed(one.sockets);
  const w = await window_(t, one.sockets, [one.dir, two.dir], o.window);
  const [e1, e2] = w.server.endpoints();
  assert.notEqual(e1, e2);
  w.server.dispose();
  const again = await window_(t, one.sockets, [one.dir], o.window);
  assert.notEqual(again.server.endpoints()[0], e1, "and a different one every time");
});

test("pointer file: a pointer left by a window that crashed is replaced; one of a live window is respected", async t => {
  const { dir, sockets, entry } = workspace();
  const o = pointed(sockets);
  const pointer = mirrorPointerFile(dir, process.platform, sockets);
  mkdirSync(path.dirname(pointer), { recursive: true });
  const dead = WIN
    ? "\\\\.\\pipe\\physim-mirror-0123456789abcdef-0123456789abcdef0123456789abcdef"
    : path.join(sockets, MIRROR_DIR, "gone.sock");
  writeFileSync(pointer, dead);

  const first = await window_(t, sockets, [dir], o.window);
  assert.equal(first.server.endpoints().length, 1);
  assert.notEqual(readFileSync(pointer, "utf8"), dead);

  const second = await window_(t, sockets, [dir], o.window);
  assert.equal(second.server.endpoints().length, 0);
  assert.equal(readFileSync(pointer, "utf8"), first.server.endpoints()[0], "the first window's pointer is untouched");
  second.server.dispose();
  assert.equal(existsSync(pointer), true, "a window that never had the folder does not remove the pointer");

  const a = agent(t, sockets, { now: 0 }, o.agent);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await first.until("update");
});

test("pointer file: a pointer that does not name an endpoint of the right kind is not connected to", async t => {
  const { dir, sockets, entry } = workspace();
  const o = pointed(sockets);
  const pointer = mirrorPointerFile(dir, process.platform, sockets);
  mkdirSync(path.dirname(pointer), { recursive: true });
  // Somebody else's listener, which would otherwise be sent the pictures.
  const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), "pe-")));
  const other = await window_(t, elsewhere, [dir]);
  writeFileSync(pointer, WIN ? "\\\\.\\pipe\\somebody-elses-pipe" : other.server.endpoints()[0]);

  const a = agent(t, sockets, { now: 0 }, o.agent);
  a.session.start({ entry, roots: [dir] });
  a.client.publish("start_script");
  await settle();
  assert.equal(a.client.isConnected(), false);
  assert.equal(other.events.length, 0);
  assert.deepEqual(readdirSync(path.dirname(pointer)), [path.basename(pointer)]);
});
