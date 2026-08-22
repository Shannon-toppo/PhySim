// Wire protocol for the macOS stand-in for LifeBoatAPI's simulator exe:
// %04d framing (shared with physServer) plus the COMMAND|param|... body shape.
import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { frame, FrameParser } from "../out/frame.js";
import { SimStubServer, splitBody } from "../out/simStubServer.js";

test("frame: 4-digit zero-padded prefix equals body byte length", () => {
  const buf = frame("SHUTDOWN|");
  assert.equal(buf.toString("utf8"), "0009SHUTDOWN|");
});

test("frame: rejects bodies too long for the prefix", () => {
  assert.throws(() => frame("x".repeat(10000)), /4-digit length prefix/);
});

test("FrameParser: splits, concatenates and buffers partial frames", () => {
  const p = new FrameParser();
  const bytes = Buffer.concat([frame("A|1"), frame("B|2")]);
  assert.deepEqual(p.feed(bytes.subarray(0, 3)), [], "prefix alone completes nothing");
  assert.deepEqual(p.feed(bytes.subarray(3, 6)), [], "partial body completes nothing");
  assert.deepEqual(p.feed(bytes.subarray(6)), ["A|1", "B|2"], "rest completes both");
});

test("FrameParser: a corrupt prefix reports an error and latches", () => {
  const p = new FrameParser();
  let err = null;
  p.onError = e => { err = e; };
  assert.deepEqual(p.feed(Buffer.from("nope0003A|1")), []);
  assert.ok(err instanceof Error);
  assert.ok(p.isBroken());
  assert.deepEqual(p.feed(frame("A|1")), []);   // stays broken
});

test("splitBody: zero-param command keeps no phantom empty param", () => {
  assert.deepEqual(splitBody("SHUTDOWN|", 0), { command: "SHUTDOWN", params: [] });
});

test("splitBody: the limit keeps pipes inside a trailing text param", () => {
  // TEXT = 3 numeric params + text, so limit 4.
  assert.deepEqual(
    splitBody("TEXT|1|2|3|a|b|c", 4),
    { command: "TEXT", params: ["1", "2", "3", "a|b|c"] }
  );
});

/** @param {InstanceType<typeof SimStubServer>} server */
function serverHasClient(server) {
  // "client" is private in the TS source; the compiled JS exposes it, which is
  // good enough for a test-only readiness probe.
  return Boolean(server.client);
}

/** Drive a real socket against the server and collect the frames it sends back. */
async function withClient(fn) {
  const server = new SimStubServer();
  // Port 0 = ephemeral, so the suite doesn't collide with a live Extension
  // Development Host already holding 14238.
  await server.start(0);
  const sock = net.createConnection(server.getPort(), "127.0.0.1");
  const parser = new FrameParser();
  const received = [];
  sock.on("data", c => received.push(...parser.feed(c)));
  await new Promise(r => sock.once("connect", r));
  // The client-side "connect" can fire before the server has run its own
  // accept handler; give the server's event-loop turn a moment so
  // server→client sends aren't silently dropped on a still-null client.
  for (let i = 0; i < 100 && !serverHasClient(server); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  try {
    await fn(server, sock, received);
  } finally {
    sock.destroy();
    await server.stop();
  }
}

/** The server replies/flushes on the socket's event loop turn, not synchronously. */
const settle = () => new Promise(r => setTimeout(r, 30));

test("SCREENCONFIG is answered with SCREENSIZE in pixels", async () => {
  await withClient(async (server, sock, received) => {
    const screens = [];
    server.onScreenConfig = s => screens.push(s);
    sock.write(frame("SCREENCONFIG|1|1|3x3|0"));
    await settle();
    assert.deepEqual(received, ["SCREENSIZE|1|96|96"]);
    assert.deepEqual(server.getScreens(), [
      { number: 1, width: 96, height: 96, poweredOn: true, portrait: false }
    ]);
    assert.equal(screens.length, 1);
  });
});

test("portrait swaps width and height", async () => {
  await withClient(async (server, sock, received) => {
    sock.write(frame("SCREENCONFIG|2|1|1x3|1"));
    await settle();
    assert.deepEqual(received, ["SCREENSIZE|2|96|32"]);
  });
});

test("TICKEND|1 flushes the buffer, TICKEND|0 keeps accumulating", async () => {
  await withClient(async (server, sock) => {
    const frames = [];
    server.onFrame = c => frames.push(c);
    sock.write(frame("COLOUR|255|0|0|255"));
    sock.write(frame("RECT|1|1|0|0|32|16"));
    sock.write(frame("TICKEND|0"));
    await settle();
    assert.equal(frames.length, 0, "skipped tick must not flush");

    sock.write(frame("TEXT|1|2|3|hi|there"));
    sock.write(frame("TICKEND|1"));
    await settle();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], [
      ["COLOUR", 255, 0, 0, 255],
      ["RECT", 1, 1, 0, 0, 32, 16],
      ["TEXT", 1, 2, 3, "hi|there"]
    ]);

    sock.write(frame("TICKEND|1"));
    await settle();
    assert.deepEqual(frames[1], [], "the buffer is emptied by a flush");
  });
});

test("Lua-style float params and unknown commands", async () => {
  await withClient(async (server, sock) => {
    const frames = [];
    server.onFrame = c => frames.push(c);
    sock.write(frame("CIRCLE|1|0|223.30419898286|5.0|3"));
    sock.write(frame("INPUT|" + Array(64).fill("0").join("|")));
    sock.write(frame("WHATEVER|1|2"));
    sock.write(frame("TICKEND|1"));
    await settle();
    assert.deepEqual(frames[0], [["CIRCLE", 1, 0, 223.30419898286, 5, 3]]);
  });
});

test("TRIANGLE keeps all six coordinates", async () => {
  await withClient(async (server, sock) => {
    const frames = [];
    server.onFrame = c => frames.push(c);
    // LifeBoatAPI sends screen, fill, x1, y1, x2, y2, x3, y3 — eight params.
    // An arity that is one short doesn't drop the command, it folds "30|42"
    // into one field and loses y3, which stretched every filled triangle up
    // to y=0.
    sock.write(frame("TRIANGLE|1|1|10|12|20|22|30|42"));
    sock.write(frame("TRIANGLE|1|0|1|2|3|4|5|6"));
    sock.write(frame("TICKEND|1"));
    await settle();
    assert.deepEqual(frames[0], [
      ["TRIANGLE", 1, 1, 10, 12, 20, 22, 30, 42],
      ["TRIANGLE", 1, 0, 1, 2, 3, 4, 5, 6]
    ]);
  });
});

test("sendTouch emits all seven params, never an empty one", async () => {
  await withClient(async (server, sock, received) => {
    server.sendTouch(1, true, false, 12.4, 30.6, 0, 0);
    await settle();
    assert.deepEqual(received, ["TOUCH|1|1|0|12|31|0|0"]);
  });
});
