// src/sessionAuth.ts and the 14239 side of it: PhysServer hands its pose
// stream only to a connection whose first frame is this session's token, and
// a stray local connection can no longer push PhySim.lua out of the slot.
// (The 14238 side is in simstub.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { frame, FrameParser } from "../out/frame.js";
import { SessionAuth, AUTH_COMMAND } from "../out/sessionAuth.js";
import { PhysServer, ZERO_STATE } from "../out/physServer.js";

test("SessionAuth: nothing verifies before the first renew()", () => {
  const auth = new SessionAuth();
  assert.equal(auth.current(), null);
  assert.equal(auth.verify(`${AUTH_COMMAND}|`), false);
  assert.equal(auth.verify(`${AUTH_COMMAND}|null`), false);
});

test("SessionAuth: only the current token verifies, and only with the command in front", () => {
  const auth = new SessionAuth();
  const first = auth.renew();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(auth.verify(`${AUTH_COMMAND}|${first}`), true);
  assert.equal(auth.verify(first), false);
  assert.equal(auth.verify(`${AUTH_COMMAND}|${first}x`), false);
  assert.equal(auth.verify(`${AUTH_COMMAND}|${first.slice(1)}`), false);
  const second = auth.renew();
  assert.notEqual(second, first);
  assert.equal(auth.verify(`${AUTH_COMMAND}|${first}`), false, "a renewed session drops the old token");
  assert.equal(auth.verify(`${AUTH_COMMAND}|${second}`), true);
});

async function newServer(authTimeoutMs) {
  const auth = new SessionAuth();
  auth.renew();
  const server = new PhysServer(auth, authTimeoutMs);
  await server.start(0);
  return server;
}

async function connect(server) {
  const sock = net.createConnection(server.getPort(), "127.0.0.1");
  const parser = new FrameParser();
  const received = [];
  sock.on("data", c => received.push(...parser.feed(c)));
  sock.on("error", () => {});
  await new Promise(r => sock.once("connect", r));
  return { sock, received };
}

const settle = () => new Promise(r => setTimeout(r, 30));
const closed = sock => new Promise(r => {
  if (sock.destroyed) return r();
  sock.once("close", r);
});

const MOVED = { ...ZERO_STATE, position: [1, 2, 3] };

test("PhysServer: the pose stream starts only after the token", async () => {
  const server = await newServer();
  try {
    const c = await connect(server);
    await settle();
    assert.deepEqual(c.received, [], "nothing before authenticating");
    c.sock.write(frame(`${AUTH_COMMAND}|${server.auth.current()}`));
    await settle();
    assert.equal(c.received.length, 2, "initial state + rate");
    assert.match(c.received[0], /^PHYS\|/);
    assert.equal(c.received[1], "RATE|60");
    server.broadcast(MOVED);
    await settle();
    assert.match(c.received[2], /^PHYS\|1\|2\|3\|/);
    c.sock.destroy();
  } finally {
    await server.stop();
  }
});

test("PhysServer: a connection without the token gets no pose and evicts nobody", async () => {
  const server = await newServer();
  try {
    const lua = await connect(server);
    lua.sock.write(frame(`${AUTH_COMMAND}|${server.auth.current()}`));
    await settle();

    for (const body of ["PHYS|9|9|9", `${AUTH_COMMAND}|${"0".repeat(32)}`]) {
      const intruder = await connect(server);
      intruder.sock.write(frame(body));
      await closed(intruder.sock);
      assert.deepEqual(intruder.received, [], body);
    }
    assert.equal(lua.sock.destroyed, false, "PhySim.lua keeps its connection");
    const before = lua.received.length;
    server.broadcast(MOVED);
    await settle();
    assert.equal(lua.received.length, before + 1, "and still receives the stream");
    lua.sock.destroy();
  } finally {
    await server.stop();
  }
});

test("PhysServer: a silent connection is dropped after the timeout", async () => {
  const server = await newServer(50);
  try {
    const quiet = await connect(server);
    await closed(quiet.sock);
    assert.deepEqual(quiet.received, []);
  } finally {
    await server.stop();
  }
});

test("PhysServer: the next run's Lua, holding the new token, takes over", async () => {
  const server = await newServer();
  try {
    const old = await connect(server);
    old.sock.write(frame(`${AUTH_COMMAND}|${server.auth.current()}`));
    await settle();
    server.auth.renew();
    const fresh = await connect(server);
    fresh.sock.write(frame(`${AUTH_COMMAND}|${server.auth.current()}`));
    await closed(old.sock);
    await settle();
    assert.equal(fresh.received.length, 2);
    fresh.sock.destroy();
  } finally {
    await server.stop();
  }
});
