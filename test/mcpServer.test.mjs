// The AI tools end to end. Two halves:
//
//  - src/agent/mcp.ts as a line-in/line-out function: the JSON-RPC edges a
//    well-behaved client never exercises (bad JSON, notifications, unknown
//    methods, batches).
//  - out/agent/server.js as a child process, driven by the official MCP client
//    (@modelcontextprotocol/sdk, a devDependency — never shipped). The protocol
//    layer here is hand-written; this is what shows a real client accepts it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, realpathSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { csvRow, CSV_HEADER } from "../media/csv.js";

const require = createRequire(import.meta.url);
const { McpServer, PROTOCOL_VERSIONS } = require("../out/agent/mcp.js");
const { formatAnswer } = require("../out/agent/tools.js");
const pkg = require("../package.json");

// --- The protocol layer on its own ---------------------------------------------

function echoServer() {
  return new McpServer({ name: "t", version: "1.2.3", instructions: "be kind" }, [
    {
      name: "echo", description: "says it back", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
      call: args => ({ content: [{ type: "text", text: JSON.stringify(args) }] })
    },
    { name: "boom", description: "throws", inputSchema: { type: "object" }, call: () => { throw new Error("it broke"); } },
    { name: "slow", description: "async", inputSchema: { type: "object" }, call: async () => ({ content: [{ type: "text", text: "late" }] }) }
  ]);
}

const ask = async (server, message) => {
  const line = await server.handleLine(typeof message === "string" ? message : JSON.stringify(message));
  return line === null ? null : JSON.parse(line);
};
const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("initialize answers with the client's protocol version when known, else the newest", async () => {
  const server = echoServer();
  for (const v of PROTOCOL_VERSIONS) {
    const r = await ask(server, rpc(1, "initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "c", version: "0" } }));
    assert.equal(r.result.protocolVersion, v);
  }
  for (const v of ["1999-01-01", 5, undefined]) {
    const r = await ask(server, rpc(1, "initialize", { protocolVersion: v }));
    assert.equal(r.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  }
  const r = await ask(server, rpc("init", "initialize"));
  assert.deepEqual(r, {
    jsonrpc: "2.0", id: "init",
    result: {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "t", version: "1.2.3" },
      instructions: "be kind"
    }
  });
});

test("ping, tools/list and tools/call", async () => {
  const server = echoServer();
  assert.deepEqual(await ask(server, rpc(1, "ping")), { jsonrpc: "2.0", id: 1, result: {} });
  const list = await ask(server, rpc(2, "tools/list"));
  assert.deepEqual(list.result.tools.map(t => t.name), ["echo", "boom", "slow"]);
  assert.deepEqual(list.result.tools[0], {
    name: "echo", description: "says it back", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }
  });
  assert.equal("annotations" in list.result.tools[1], false);
  const call = await ask(server, rpc(3, "tools/call", { name: "echo", arguments: { a: 1 } }));
  assert.deepEqual(call.result, { content: [{ type: "text", text: '{"a":1}' }] });
  assert.equal((await ask(server, rpc(4, "tools/call", { name: "echo" }))).result.content[0].text, "{}", "arguments may be omitted");
  assert.equal((await ask(server, rpc(5, "tools/call", { name: "slow" }))).result.content[0].text, "late");
});

test("a tool that throws is a result with isError, not a protocol error", async () => {
  const r = await ask(echoServer(), rpc(1, "tools/call", { name: "boom", arguments: {} }));
  assert.deepEqual(r.result, { content: [{ type: "text", text: "it broke" }], isError: true });
});

test("protocol errors carry the JSON-RPC codes", async () => {
  const server = echoServer();
  const code = async m => (await ask(server, m)).error.code;
  assert.equal(await code("{ not json"), -32700);
  assert.equal(await code("[]"), -32600);
  assert.equal(await code('"hello"'), -32600);
  assert.equal(await code({ id: 1, method: "ping" }), -32600, "no jsonrpc field");
  assert.equal(await code({ jsonrpc: "2.0", id: {}, method: "ping" }), -32600);
  assert.equal(await code({ jsonrpc: "2.0", id: 1, method: 5 }), -32600);
  assert.equal(await code(rpc(1, "resources/list")), -32601);
  assert.equal(await code(rpc(1, "tools/call", { name: "nope" })), -32602);
  assert.equal(await code(rpc(1, "tools/call", {})), -32602);
  assert.equal(await code(rpc(1, "tools/call", { name: "echo", arguments: [1] })), -32602);
  assert.equal((await ask(server, "{ not json")).id, null);
});

test("notifications, responses and blank lines get no answer", async () => {
  const server = echoServer();
  assert.equal(await ask(server, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await ask(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
  assert.equal(await ask(server, { jsonrpc: "2.0", method: "no/such/thing" }), null, "an unknown notification is dropped");
  assert.equal(await ask(server, { jsonrpc: "2.0", id: 9, result: {} }), null);
  assert.equal(await server.handleLine(""), null);
  assert.equal(await server.handleLine("   "), null);
});

test("a batch is answered as a batch, leaving out its notifications", async () => {
  const server = echoServer();
  const r = await ask(server, [rpc(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc(2, "nope")]);
  assert.deepEqual(r.map(a => a.id), [1, 2]);
  assert.equal(r[1].error.code, -32601);
  assert.equal(await ask(server, [{ jsonrpc: "2.0", method: "notifications/initialized" }]), null);
});

test("duplicate tool names are refused when the server is built", () => {
  const t = { name: "a", description: "", inputSchema: {}, call: () => ({ content: [] }) };
  assert.throws(() => new McpServer({ name: "t", version: "0" }, [t, t]), /duplicate tool name a/);
});

test("formatAnswer: one top-level field per line, string lists a line per string, and it is JSON", () => {
  const value = { a: 1, skipped: undefined, rows: ["#.#", ".#."], one: ["x"], nested: { b: [1, 2], c: "d" }, empty: [] };
  const text = formatAnswer(value);
  assert.deepEqual(JSON.parse(text), { a: 1, rows: ["#.#", ".#."], one: ["x"], nested: { b: [1, 2], c: "d" }, empty: [] });
  assert.equal(text, '{\n "a": 1,\n "rows": [\n  "#.#",\n  ".#."\n ],\n "one": ["x"],\n "nested": {"b":[1,2],"c":"d"},\n "empty": []\n}');
});

// --- The real server, through the official client -------------------------------

// Resolved, because the server reports paths from its own working directory,
// which the OS hands it resolved (macOS: /var is a link to /private/var).
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "physim-mcp-")));
const file = (name, text) => {
  const f = path.join(dir, name);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
};

const MAIN = file("main.lua", `
---@section __LB_SIMULATOR_ONLY__
do
  simulator:setScreen(1, "3x3")
  require("PhySim")
  phys = PhySim:new()
  -- print exists only here: the game has none, so the build would refuse it outside this section.
  function onLBSimulatorTick(simulator, ticks)
    phys:update(); phys:injectAsInputs(simulator, 1)
    if ticks == 1 then print("hello from tick 1") end
  end
end
---@endsection
require("lib.gauge")
ticks = 0
function onTick()
  ticks = ticks + 1
  -- input.* is an error inside onDraw, as in the game; what the picture needs is kept here.
  width, touched, tx, ty = math.floor(input.getNumber(20)), input.getBool(1), input.getNumber(21), input.getNumber(22)
  output.setNumber(1, input.getNumber(1) * 2)
  output.setNumber(2, input.getNumber(20) + property.getNumber("Gain"))
  output.setBool(3, input.getBool(25))
end
function onDraw()
  screen.setColor(255, 255, 255)
  drawGauge(4, 4, width)
  if touched then screen.setColor(255, 0, 0); screen.drawRectF(tx, ty, 2, 2) end
end
`);
file("lib/gauge.lua", `function drawGauge(x, y, w) screen.drawRectF(x, y, w, 3) end\n`);
file(".vscode/settings.json", `{
  // a workspace that once ran PhySim 1.x
  "lifeboatapi.stormworks.libs.libraryPaths": ["old-libs",],
}`);
// What 1.x left in the legacy setting: a PhySim.lua that defines nothing here.
file("old-libs/PhySim.lua", `print("the 1.x PhySim.lua was loaded")\n`);
const BROKEN = file("broken.lua", `function onTick()\n  local t = nil\n  t.x = 1\nend\n`);
const SCENARIO = file("flight.csv", [CSV_HEADER, ...[1, 2, 3, 4, 5].map(i => csvRow(i, 0, i / 60, 1, {
  position: [i * 10, 0, 0], rotation: [0, 0, 0], velocity: [10, 0, 0], angularVelocity: [0, 0, 0]
}))].join("\r\n") + "\r\n");

// A home directory of the test's own: the server keeps the mirror's sockets
// under it, and the real one is not the test's to write in.
const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), "ph-")));

let client;
before(async () => {
  client = new Client({ name: "physim-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, "..", "out", "agent", "server.js")],
    cwd: dir,
    // What a real client passes on: a handful of variables, and notably no TMPDIR.
    env: { ...getDefaultEnvironment(), HOME, USERPROFILE: HOME },
    stderr: "inherit"
  }));
});
after(async () => { await client?.close(); });

/** Call a tool; returns the parsed JSON answer, or throws with the tool's error text. */
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(c => c.type === "text")?.text ?? "";
  if (result.isError) throw Object.assign(new Error(text), { result });
  return JSON.parse(text);
}

const TOOLS = [
  "start_script", "stop_script", "get_status", "set_pose", "step", "play_scenario", "set_inputs", "set_controls", "set_properties",
  "touch_monitor", "set_monitor", "remove_monitor", "get_io", "get_logs", "monitor_region", "monitor_diff",
  "monitor_check", "monitor_grid", "monitor_image", "save_snapshot", "delete_snapshot", "build_script"
];

test("the official client connects, and the server introduces itself", () => {
  assert.deepEqual(client.getServerVersion(), { name: "physim", version: pkg.version });
  assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
  assert.match(client.getInstructions(), /Time only moves when you call step/);
});

test("the tool list: every tool, each with a description and a closed object schema", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), TOOLS);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} has a real description`);
    assert.equal(t.inputSchema.type, "object", t.name);
    for (const required of t.inputSchema.required ?? []) {
      assert.ok(required in t.inputSchema.properties, `${t.name}: required "${required}" is a declared property`);
    }
  }
  const readOnly = tools.filter(t => t.annotations?.readOnlyHint).map(t => t.name);
  assert.deepEqual(readOnly, ["get_status", "get_io", "get_logs", "monitor_region", "monitor_diff", "monitor_check", "monitor_grid", "monitor_image"]);
});

test("before a script is started, the tools say so", async () => {
  await call("stop_script");
  assert.equal((await call("get_status")).status, "none");
  for (const [name, args] of [["step", {}], ["monitor_region", {}], ["set_inputs", { numbers: { 1: 1 } }], ["touch_monitor", { pressed: false }]]) {
    await assert.rejects(call(name, args), /no script is running/, name);
  }
});

test("start_script: the workspace is found, the bundled PhySim.lua wins over the legacy path, no tick has run", async () => {
  const r = await call("start_script", { script: "main.lua", properties: { Gain: 100 } });
  assert.equal(r.status, "running");
  assert.equal(r.tick, 0);
  assert.equal(r.script, MAIN);
  assert.equal(r.requireRoots[0], dir);
  assert.deepEqual(r.requireRoots.slice(-2), [path.join(dir, "old-libs"), path.join(dir, "_build", "libs")]);
  assert.ok(r.requireRoots.indexOf(path.join(dir, "old-libs")) > r.requireRoots.findIndex(p => p.endsWith(path.join("", "lua"))));
  assert.deepEqual(r.monitors, [{ number: 1, width: 96, height: 96, poweredOn: true, portrait: false }]);
  assert.deepEqual(r.logs.lines, [], "the 1.x PhySim.lua would have printed");
});

test("the loop an agent runs: pose, inputs, step, read outputs, logs and the monitor", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 100 } });
  assert.deepEqual((await call("set_pose", { position: [3, 0, 0], velocity: [0.5, 0, 0] })).pose, {
    position: [3, 0, 0], rotation: [0, 0, 0], velocity: [0.5, 0, 0], angularVelocity: [0, 0, 0]
  });
  assert.deepEqual(await call("set_inputs", { numbers: { 20: 30 }, booleans: { 25: true } }), {
    heldNumbers: { 20: 30 }, heldBooleans: { 25: true }
  });

  const s = await call("step", { ticks: 4, motion: "integrate" });
  assert.equal(s.ticksRun, 4);
  assert.equal(s.stopped, "done");
  assert.equal(s.tick, 4);
  assert.deepEqual(s.pose.position, [5, 0, 0]);
  assert.deepEqual(s.outputs, { numbers: { 1: 10, 2: 130 }, booleansOn: [3] });
  assert.deepEqual(s.logs.lines.map(l => [l.tick, l.text, l.file, l.line]), [[1, "hello from tick 1", MAIN.replace(/^[A-Z]:/, m => m.toLowerCase()), 10]]);
  assert.deepEqual(s.monitors, [{ number: 1, width: 96, height: 96, lit: 90, changedPixels: "first picture" }]);

  const io = await call("get_io");
  assert.equal(io.inputs.numbers[1], 5);
  assert.equal(io.inputs.numbers[20], 30);
  assert.equal(io.inputs.numbers[7], 0.5);
  assert.deepEqual(io.inputs.booleansOn, [25]);

  const region = await call("monitor_region");
  assert.equal(region.lit, 90);
  assert.deepEqual(region.litBounds, { left: 4, top: 4, right: 33, bottom: 6 });
  assert.deepEqual(region.colors, [{ color: [255, 255, 255], pixels: 90, bounds: { left: 4, top: 4, right: 33, bottom: 6 } }]);
  assert.equal((await call("monitor_region", { x: 0, y: 0, width: 4, height: 96 })).lit, 0);

  const grid = await call("monitor_grid", { x: 2, y: 3, width: 6, height: 5 });
  assert.deepEqual(grid.rows, ["......", "..####", "..####", "..####", "......"]);

  const check = await call("monitor_check", {
    checks: [
      { label: "bar", x: 4, y: 4, width: 30, height: 3, expect: "filled", color: [255, 255, 255] },
      { label: "below", y: 7, expect: "empty" },
      { label: "white only", expect: "only", color: [255, 255, 255] },
      { label: "wrong", x: 4, y: 4, width: 32, height: 3, expect: "filled" }
    ]
  });
  assert.equal(check.pass, false);
  assert.equal(check.failed, 1);
  assert.deepEqual(check.results.map(r => [r.label, r.pass]), [["bar", true], ["below", true], ["white only", true], ["wrong", false]]);
  assert.equal(check.results[3].offendingCount, 6);
  assert.deepEqual(check.results[3].offending[0], { x: 34, y: 4, color: [0, 0, 0] });
});

test("a later step reports what it changed, and monitor_diff says where", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await call("set_inputs", { numbers: { 20: 10 } });
  await call("step");
  await call("set_inputs", { numbers: { 20: 14 } });
  const s = await call("step", { ticks: 2 });
  assert.deepEqual(s.monitors[0], {
    number: 1, width: 96, height: 96, lit: 42, changedPixels: 12, changedBounds: { left: 14, top: 4, right: 17, bottom: 6 }
  });
  const diff = await call("monitor_diff");
  assert.equal(diff.against, "previous");
  assert.deepEqual([diff.changed, diff.appeared, diff.disappeared, diff.recolored], [12, 12, 0, 0]);
  assert.deepEqual(diff.examples[0], { x: 14, y: 4, before: [0, 0, 0], after: [255, 255, 255] });
});

test("touch, monitors and properties reach the script", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 1 }, monitors: [{ number: 2, size: "1x2", portrait: true }] });
  assert.deepEqual((await call("get_status")).monitors.map(m => [m.number, m.width, m.height]), [[1, 96, 96], [2, 64, 32]]);
  // PhySim's injectAsInputs writes numbers 1-17 itself, so the touch position is not on 3-4 here;
  // the pressed flag on boolean 1 is untouched by it.
  await call("touch_monitor", { pressed: true, x: 50, y: 60 });
  await call("step");
  assert.deepEqual((await call("get_io")).inputs.booleansOn, [1]);
  await call("touch_monitor", { pressed: false });
  await call("step");
  assert.deepEqual((await call("get_io")).inputs.booleansOn, []);
  await assert.rejects(call("touch_monitor", { pressed: true, x: 96, y: 0 }), /outside monitor 1/);

  assert.deepEqual((await call("set_properties", { values: { Gain: 7, Mode: "auto", On: true } })).properties, { Gain: 7, Mode: "auto", On: true });
  assert.equal((await call("step")).outputs.numbers[2], 7);

  assert.deepEqual((await call("set_monitor", { number: 3, size: "2x2" })).monitors.map(m => m.number), [1, 2, 3]);
  assert.deepEqual((await call("remove_monitor", { monitor: 2 })).monitors.map(m => m.number), [1, 3]);
  await assert.rejects(call("remove_monitor", { monitor: 1 }), /monitor 1 cannot be removed/);
  await assert.rejects(call("remove_monitor", { monitor: 2 }), /no monitor 2/);
  await assert.rejects(call("set_monitor", { number: 2, size: "10x1" }), /size must be/);
});

test("set_controls works the simulator's buttons and sliders, and lists the ones the script reads", async () => {
  const src = file("controls.lua", `
    ---@section __LB_SIMULATOR_ONLY__
    function onLBSimulatorTick(simulator)
      simulator:setInputBool(31, simulator:getIsClicked(1))
      simulator:setInputBool(32, simulator:getIsToggled(2))
      simulator:setInputNumber(31, simulator:getSlider(1))
    end
    ---@endsection
    clicks = 0
    function onTick()
      if input.getBool(31) then clicks = clicks + 1 end
      output.setNumber(1, clicks); output.setBool(2, input.getBool(32)); output.setNumber(3, input.getNumber(31))
    end`);
  await call("start_script", { script: src });
  assert.deepEqual((await call("get_status")).controls, { buttons: [], sliders: [] }, "nothing is read before a tick");
  await call("step");
  const listed = { buttons: [{ number: 1, showsToggle: false, toggled: false, down: false }, { number: 2, showsToggle: true, toggled: false, down: false }], sliders: [{ number: 1, value: 0 }] };
  assert.deepEqual((await call("get_status")).controls, listed);

  const set = await call("set_controls", { click: [1, 2], sliders: { 1: 0.25 } });
  assert.deepEqual(set.controls.buttons[1], { number: 2, showsToggle: true, toggled: true, down: false });
  assert.deepEqual(set.controls.sliders, [{ number: 1, value: 0.25 }]);
  assert.deepEqual((await call("step", { ticks: 5 })).outputs, { numbers: { 1: 1, 3: 0.25 }, booleansOn: [2] }, "one click, seen by one tick");

  await call("set_controls", { hold: { 1: true } });
  assert.equal((await call("step", { ticks: 4 })).outputs.numbers[1], 5, "held: seen by every tick");
  await call("set_controls", { hold: { 1: false }, click: [2] });
  assert.deepEqual((await call("step", { ticks: 3 })).outputs, { numbers: { 1: 5, 3: 0.25 }, booleansOn: [] });

  for (const [args, pattern] of [
    [{}, /nothing to set/],
    [{ click: [0] }, /click: 0 is not a number from 1 to 10/],
    [{ click: [11] }, /11 is not a number from 1 to 10/],
    [{ hold: { 1: 1 } }, /hold\["1"\] must be true or false/],
    [{ hold: { x: true } }, /"x" is not a number from 1 to 10/],
    [{ sliders: { 1: 1.5 } }, /sliders\["1"\] must be a number from 0 to 1/],
    [{ sliders: { 12: 0.5 } }, /"12" is not a number from 1 to 10/],
    [{ click: [3], hold: { 3: true } }, /both clicked and held/],
    [{ click: [2], sliders: { 1: 9 } }, /from 0 to 1/]
  ]) await assert.rejects(call("set_controls", args), pattern, JSON.stringify(args));
  assert.deepEqual((await call("get_status")).controls.buttons[1], { number: 2, showsToggle: true, toggled: false, down: false }, "the half-wrong request did not click button 2");
  await call("stop_script");
  await assert.rejects(call("set_controls", { click: [1] }), /no script is running/);
});

test("a snapshot taken before an edit is compared with the picture after it", async () => {
  const gauge = path.join(dir, "lib", "gauge.lua");
  const original = readFileSync(gauge, "utf8");
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await call("set_inputs", { numbers: { 20: 10 } });
  await call("step");
  assert.deepEqual(await call("save_snapshot", { name: "before" }), { name: "before", monitors: [1] });
  try {
    writeFileSync(gauge, original.replace("w, 3)", "w, 5)"));
    await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
    await call("set_inputs", { numbers: { 20: 10 } });
    await call("step");
    const diff = await call("monitor_diff", { against: "before" });
    assert.equal(diff.changed, 20);
    assert.deepEqual(diff.changedBounds, { left: 4, top: 7, right: 13, bottom: 8 });
  } finally {
    writeFileSync(gauge, original);
  }
  assert.deepEqual((await call("get_status")).snapshots, [{ name: "before", monitors: [1] }]);
  await assert.rejects(call("save_snapshot", { name: "previous" }), /reserved/);
  await assert.rejects(call("monitor_diff", { against: "nope" }), /no snapshot named "nope"/);
  assert.deepEqual((await call("delete_snapshot", { name: "before" })).snapshots, []);
  await assert.rejects(call("delete_snapshot", { name: "before" }), /no snapshot named/);
});

test("a Lua error comes back as the run's state, with file and line, and the next step says to restart", async () => {
  const r = await call("start_script", { script: "broken.lua" });
  assert.equal(r.status, "running");
  const s = await call("step", { ticks: 5 });
  assert.equal(s.stopped, "failed");
  assert.equal(s.ticksRun, 1);
  assert.equal(s.status, "failed");
  assert.match(s.error, /broken\.lua:3: attempt to index a nil value/);
  assert.equal((await call("get_status")).status, "failed");
  await assert.rejects(call("step"), /stopped with an error; start it again/);
  void BROKEN;
});

test("play_scenario plays a panel CSV log a row per tick, and can resume part-way", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  const first = await call("play_scenario", { file: "flight.csv", maxTicks: 2 });
  assert.deepEqual([first.rows, first.nextRow, first.ticksRun], [5, 3, 2]);
  assert.equal(first.outputs.numbers[1], 40, "row 2's x of 20, doubled");
  const rest = await call("play_scenario", { file: SCENARIO, startRow: first.nextRow });
  assert.deepEqual([rest.finished, rest.ticksRun, rest.tick], [true, 3, 5]);
  assert.deepEqual(rest.pose.position, [50, 0, 0]);
  await assert.rejects(call("play_scenario", { file: "flight.csv", startRow: 6 }), /past the end: the scenario has 5 rows/);
  await assert.rejects(call("play_scenario", { file: "missing.csv" }), /there is no file/);
  await assert.rejects(call("play_scenario", { file: "main.lua" }), /no column "ch1_pos_x"/);
});

test("get_logs reads on from a cursor", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  const before = (await call("get_logs", { since: 0, limit: 500 })).next;
  await call("step", { ticks: 3 });
  const logs = await call("get_logs", { since: before });
  assert.deepEqual(logs.lines.map(l => l.text), ["hello from tick 1"]);
  assert.equal(logs.next, before + 1);
  assert.deepEqual((await call("get_logs", { since: logs.next })).lines, []);
});

test("monitor_image returns a PNG of the monitor at the asked scale", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await call("step");
  const result = await client.callTool({ name: "monitor_image", arguments: { scale: 2 } });
  assert.deepEqual(JSON.parse(result.content[0].text), { monitor: 1, monitorSize: [96, 96], scale: 2 });
  assert.equal(result.content[1].mimeType, "image/png");
  const png = Buffer.from(result.content[1].data, "base64");
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [192, 192]);
  assert.ok(inflateSync(png.subarray(41, png.length - 16)).length === (1 + 192 * 3) * 192);
});

test("build_script links, strips the simulator-only section and reports the size; it writes only when asked", async () => {
  const r = await call("build_script", { script: "main.lua", includeCode: true });
  assert.equal(r.ok, true);
  assert.equal(r.size, r.code.length);
  assert.deepEqual([r.limit, r.remaining, r.fits], [8192, 8192 - r.size, true]);
  assert.deepEqual(r.files.map(f => path.basename(f)).sort(), ["gauge.lua", "main.lua"]);
  assert.ok(!r.code.includes("PhySim") && !r.code.includes("require"));
  assert.equal(existsSync(path.join(dir, "_build")), false);
  assert.equal("written" in r, false);

  const readable = await call("build_script", { script: "main.lua", minify: false });
  assert.ok(readable.size > r.size);
  assert.equal("code" in readable, false);

  const written = await call("build_script", { script: "main.lua", write: true });
  assert.equal(written.written, path.join(dir, "_build", "release", "main.lua"));
  assert.equal(readFileSync(written.written, "utf8").length, written.size);
  await assert.rejects(call("build_script", { script: "main.lua", outputDirectory: "x" }), /only applies with write true/);
  await assert.rejects(call("build_script", { script: "main.lua", write: true, outputDirectory: "." }), /overwrite a source file/);
  // A linked module is a source file too: building lib/gauge.lua's user into lib/ must not replace it.
  const inLib = file("lib/main.lua", 'require("lib.gauge")\nfunction onTick() end\n');
  // Its output would land on the top-level main.lua: not one of its sources, but somebody's file.
  const top = readFileSync(MAIN, "utf8");
  await assert.rejects(call("build_script", { script: inLib, write: true, outputDirectory: "." }), /main\.lua already exists; pass overwrite: true/);
  assert.equal(readFileSync(MAIN, "utf8"), top);
  const gaugeUser = file("gauge.lua", 'require("lib.gauge")\nfunction onDraw() drawGauge(0, 0, 1) end\n');
  await assert.rejects(call("build_script", { script: gaugeUser, write: true, outputDirectory: "lib" }), /overwrite a source file \(.*lib.gauge\.lua\)/);
  // A folder whose name merely starts with two dots is inside.
  const dotted = await call("build_script", { script: "main.lua", write: true, outputDirectory: "..out" });
  assert.equal(dotted.written, path.join(dir, "..out", "main.lua"));
  // The same custom directory again: the file is there now, so it takes overwrite.
  await assert.rejects(call("build_script", { script: "main.lua", write: true, outputDirectory: "..out" }), /already exists/);
  assert.equal((await call("build_script", { script: "main.lua", write: true, outputDirectory: "..out", overwrite: true })).written, dotted.written);
  // The default directory is rebuilt freely, as F7 does.
  assert.equal((await call("build_script", { script: "main.lua", write: true })).written, path.join(dir, "_build", "release", "main.lua"));
  for (const outside of ["..", path.join("..", "elsewhere"), path.resolve(dir, "..", "abs")]) {
    await assert.rejects(call("build_script", { script: "main.lua", write: true, outputDirectory: outside }), /must be inside the workspace folder/);
  }
  assert.equal(existsSync(path.resolve(dir, "..", "main.lua")), false);
});

test("build_script does not write through a link that leaves the workspace", async t => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "physim-outside-")));
  try {
    symlinkSync(outside, path.join(dir, "link"), "dir");
  } catch {
    t.skip("this platform does not let the test create a symbolic link");
    return;
  }
  await assert.rejects(call("build_script", { script: "main.lua", write: true, outputDirectory: "link" }), /must be inside the workspace folder/);
  await assert.rejects(call("build_script", { script: "main.lua", write: true, outputDirectory: path.join("link", "deeper", "still") }), /must be inside the workspace folder/);
  assert.deepEqual(readdirSync(outside), []);
});

test("a property labelled __proto__ is a property like any other", async () => {
  const src = file("proto.lua", 'function onTick() output.setNumber(1, property.getNumber("__proto__")); output.setNumber(2, property.getNumber("Gain")) end\n');
  await call("start_script", { script: src, properties: JSON.parse('{ "__proto__": 5, "Gain": 2 }') });
  assert.deepEqual((await call("step")).outputs.numbers, { 1: 5, 2: 2 });
  const set = await client.callTool({ name: "set_properties", arguments: JSON.parse('{ "values": { "__proto__": 9 } }') });
  assert.ok(!set.isError, set.content[0].text);
  assert.equal((await call("step")).outputs.numbers[1], 9);
});

test("an integration that overflows is an error naming the tick, not a pose of nulls", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await call("set_pose", { position: [0, 0, 0], velocity: [1e308, 0, 0] });
  await assert.rejects(call("step", { ticks: 2, motion: "integrate", acceleration: [1e308, 0, 0] }), /overflowed while integrating tick 1/);
  const status = await call("get_status");
  assert.deepEqual(status.pose.velocity, [1e308, 0, 0]);
  await call("set_pose", { velocity: [0, 0, 0] });
});

test("a PhySim window with the workspace open is shown the run: pose, monitors and pictures", async t => {
  const { MirrorServer } = require("../out/mirrorServer.js");
  const updates = [];
  const window_ = new MirrorServer({ connected: () => {}, update: u => updates.push(u), disconnected: () => {} }, { home: HOME });
  t.after(() => window_.dispose());
  await window_.setFolders([dir]);
  assert.equal(window_.endpoints().length, 1);
  const until = async n => {
    for (let i = 0; updates.length < n; i++) {
      if (i > 100) throw new Error(`timed out waiting for ${n} updates; got ${updates.map(u => u.tool).join(", ")}`);
      await new Promise(r => setTimeout(r, 50));
    }
  };

  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await until(1);
  assert.deepEqual([updates[0].tool, updates[0].status, updates[0].script], ["start_script", "running", MAIN]);
  await call("set_pose", { position: [7, 8, 9], velocity: [0, 0, 0] });
  await call("set_inputs", { numbers: { 20: 10 } });
  await call("step", { ticks: 3 });
  await until(4);
  assert.deepEqual(updates.map(u => u.tool), ["start_script", "set_pose", "set_inputs", "step"]);
  assert.deepEqual(updates[1].pose.position, [7, 8, 9]);
  assert.equal(updates[3].tick, 3);
  assert.deepEqual(updates[3].frames.map(f => [f.screen, f.width, f.height]), [[1, 96, 96]]);
  // The same picture the agent is told about in numbers.
  const region = await call("monitor_region");
  let lit = 0;
  for (let i = 0; i < updates[3].frames[0].pixels.length; i += 4) if (updates[3].frames[0].pixels[i]) lit++;
  assert.equal(lit, region.lit);

  // Reading tools and a build change nothing the window shows, and say nothing.
  await call("get_status");
  await call("get_io");
  await call("monitor_grid", { width: 8, height: 8 });
  await call("build_script", { script: "main.lua" });
  await call("stop_script");
  await until(5);
  assert.equal(updates.length, 5);
  assert.deepEqual([updates[4].tool, updates[4].status], ["stop_script", "none"]);
});

test("a build that fails is an error result carrying the compiler's problems", async () => {
  const bad = file("syntax.lua", "function onTick(\n");
  await assert.rejects(call("build_script", { script: bad }), err => {
    const body = JSON.parse(err.message);
    assert.equal(body.ok, false);
    assert.ok(body.problems.some(p => p.severity === "error"));
    return true;
  });
});

test("wrong arguments are answered with what was expected, and change nothing", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  const cases = [
    ["start_script", {}, /script must be a non-empty string/],
    ["start_script", { script: "nope.lua" }, /there is no file/],
    ["start_script", { script: "flight.csv" }, /must be a \.lua file/],
    ["start_script", { script: "main.lua", monitors: [{ size: "0x1" }] }, /monitors\[0\]: size must be/],
    ["start_script", { script: "main.lua", properties: { a: [1] } }, /property "a" must be/],
    ["set_pose", { position: [1, 2] }, /position must be three numbers/],
    ["set_pose", { rotation: [1, 2, "3"] }, /rotation must be three numbers/],
    ["step", { ticks: 0 }, /ticks must be at least 1/],
    ["step", { ticks: 1.5 }, /ticks must be a whole number/],
    ["step", { ticks: 36001 }, /ticks must be at most 36000/],
    ["step", { motion: "fly" }, /motion must be "hold" or "integrate"/],
    ["step", { acceleration: [1, 0, 0] }, /only applies with motion "integrate"/],
    ["set_inputs", {}, /nothing to set/],
    ["set_inputs", { numbers: { 33: 1 } }, /"33" is not a channel from 1 to 32/],
    ["set_inputs", { numbers: { 5: 1, 6: "x" } }, /numbers\["6"\] must be a finite number/],
    ["set_inputs", { booleans: { 1: 1 } }, /booleans\["1"\] must be true or false/],
    ["set_inputs", { releaseNumbers: [0] }, /0 is not a channel/],
    ["set_properties", { values: {} }, /values is empty/],
    ["touch_monitor", {}, /pressed must be true or false/],
    ["touch_monitor", { pressed: true }, /x must be a number/],
    ["monitor_region", { monitor: 9 }, /no monitor 9/],
    ["monitor_region", { x: 200 }, /outside the 96x96 monitor/],
    ["monitor_grid", {}, /at most 4096 pixels/],
    ["monitor_check", { checks: [] }, /checks is empty/],
    ["monitor_check", { checks: [{ expect: "maybe" }] }, /checks\[0\]\.expect must be/],
    ["monitor_check", { checks: [{ expect: "only" }] }, /needs a color/],
    ["monitor_check", { checks: [{ expect: "some", color: [256, 0, 0] }] }, /checks\[0\]\.color must be \[r, g, b\]/],
    ["monitor_image", { scale: 17 }, /scale must be at most 16/],
    ["get_logs", { since: -1 }, /since must be at least 0/]
  ];
  // The first cases restart nothing because they fail before the session is touched; step once so monitors exist.
  await call("step");
  for (const [name, args, pattern] of cases) await assert.rejects(call(name, args), pattern, `${name} ${JSON.stringify(args)}`);
  const status = await call("get_status");
  assert.equal(status.status, "running");
  assert.equal(status.tick, 1);
  assert.deepEqual(status.heldInputs, { numbers: {}, booleans: {} }, "the half-wrong set_inputs held nothing");
});

test("the server survives a line that is not JSON and keeps the run", async () => {
  await call("start_script", { script: "main.lua", properties: { Gain: 0 } });
  await call("step", { ticks: 2 });
  // The official client never sends garbage; go around it on the same pipe.
  client.transport._process.stdin.write("this is not json\n");
  assert.equal((await call("get_status")).tick, 2);
});
