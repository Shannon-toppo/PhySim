// src/debugSession.ts: the Debug Adapter Protocol against a real run
// (Simulation + worker + engine), driven the way VSCode drives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { PhysimDebugSession, formatValue } = require("../out/debugSession.js");
const { Simulation } = require("../out/simulation.js");

/** A debug client: sends requests, collects events, waits on either. */
function client(t, source) {
  const dir = mkdtempSync(path.join(tmpdir(), "physim-dap-"));
  const program = path.join(dir, "main.lua");
  writeFileSync(program, source);
  const sim = new Simulation();
  const events = [];
  const waiting = new Map();
  let wake = () => {};
  let seq = 1;
  const session = new PhysimDebugSession({
    launch: r => sim.start({ entry: r.program, roots: [dir], breakpoints: r.breakpoints }),
    stop: () => sim.stop(),
    request: (name, args) => sim.current() ? sim.current().request(name, args) : Promise.reject(new Error("the script is not running"))
  }, m => {
    if (m.type === "response") { waiting.get(m.request_seq)?.(m); waiting.delete(m.request_seq); }
    else { events.push(m); wake(); }
  });
  sim.onLog = l => session.scriptLog(l);
  sim.onStopped = r => session.scriptStopped(r);
  sim.onContinued = () => session.scriptContinued();
  sim.onEnded = (reason, message) => { if (reason !== "stopped") session.scriptEnded(reason, message); };
  t.after(() => sim.dispose());

  const send = (command, args) => new Promise(resolve => {
    const id = seq++;
    waiting.set(id, resolve);
    session.handleMessage({ seq: id, type: "request", command, arguments: args });
  });
  const ok = async (command, args) => {
    const r = await send(command, args);
    assert.equal(r.success, true, `${command}: ${r.message}`);
    return r.body;
  };
  /** The next event named `name` at or after index `from`. */
  const event = (name, from = 0, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${name}" event`)), ms);
    const check = () => {
      const i = events.findIndex((e, k) => k >= from && e.event === name);
      if (i >= 0) { clearTimeout(timer); wake = () => {}; resolve({ index: i, body: events[i].body }); }
    };
    wake = check; check();
  });
  const launch = async (lines, extra = {}) => {
    await ok("initialize", { adapterID: "physim" });
    await event("initialized");
    await ok("launch", { program, ...extra });
    const set = await ok("setBreakpoints", { source: { path: program }, breakpoints: lines.map(line => ({ line })) });
    await ok("configurationDone");
    return set;
  };
  return { send, ok, event, events, launch, program, sim };
}

const SCRIPT = `n = 0
config = { name = "abc", list = { 10, 20 }, [true] = 1.5 }
function onTick()
  n = n + 1
  local half = n / 2
  local label = "tick"
  print("n", n)
  output.setNumber(1, n)
end`;

test("formatValue reads like Lua", () => {
  assert.deepEqual(formatValue({ kind: "number", value: 2 }), { value: "2.0", type: "number" });
  assert.equal(formatValue({ kind: "number", value: 0.1 }).value, "0.1");
  assert.equal(formatValue({ kind: "number", value: Infinity }).value, "inf");
  assert.equal(formatValue({ kind: "integer", value: 1n << 62n }).value, "4611686018427387904");
  assert.equal(formatValue({ kind: "bytes", value: new TextEncoder().encode('a"b\n') }).value, '"a\\"b\\n"');
  assert.equal(formatValue({ kind: "opaque", typeName: "function" }).value, "function");
});

test("breakpoint: stop, stack, scopes, variables, table expansion, evaluate, step, continue", async t => {
  const c = client(t, SCRIPT);
  const set = await c.launch([6]);
  assert.deepEqual(set.breakpoints, [{ verified: true, line: 6 }]);
  const stop = await c.event("stopped");
  assert.equal(stop.body.reason, "breakpoint");
  assert.deepEqual((await c.ok("threads")).threads.map(th => th.id), [stop.body.threadId]);

  const { stackFrames } = await c.ok("stackTrace", { threadId: 1 });
  assert.equal(stackFrames[0].line, 6);
  assert.equal(stackFrames[0].source.path, c.program.replace(/^[A-Z]:/, m => m.toLowerCase()), "the engine reports a drive letter in lower case");

  const { scopes } = await c.ok("scopes", { frameId: stackFrames[0].id });
  assert.deepEqual(scopes.map(s => s.name), ["Locals", "Upvalues"]);
  const locals = (await c.ok("variables", { variablesReference: scopes[0].variablesReference })).variables;
  assert.deepEqual(locals.map(v => [v.name, v.value, v.type]), [["half", "0.5", "number"]]);

  const cfg = await c.ok("evaluate", { expression: "config", frameId: stackFrames[0].id, context: "watch" });
  assert.equal(cfg.result, "table");
  assert.ok(cfg.variablesReference > 0);
  const fields = (await c.ok("variables", { variablesReference: cfg.variablesReference })).variables;
  const byName = Object.fromEntries(fields.map(v => [v.name, v]));
  assert.equal(byName.name.value, '"abc"');
  assert.equal(byName["[true]"].value, "1.5");
  const list = (await c.ok("variables", { variablesReference: byName.list.variablesReference })).variables;
  assert.deepEqual(list.map(v => [v.name, v.value]), [["[1]", "10"], ["[2]", "20"]]);
  assert.equal((await c.ok("evaluate", { expression: "n * 10", frameId: stackFrames[0].id })).result, "10");

  await c.ok("next", { threadId: 1 });
  const step = await c.event("stopped", stop.index + 1);
  assert.equal(step.body.reason, "step");
  assert.equal((await c.ok("stackTrace", { threadId: 1 })).stackFrames[0].line, 7);
  assert.deepEqual((await c.ok("variables", { variablesReference: scopes[0].variablesReference })).variables, [],
    "a reference from an earlier stop no longer names anything");

  await c.ok("setBreakpoints", { source: { path: c.program }, breakpoints: [] });
  assert.deepEqual(await c.ok("continue", { threadId: 1 }), { allThreadsContinued: true });
  const out = await c.event("output");
  assert.equal(out.body.output, "n\t1\n");
  assert.equal(out.body.source.path, c.program.replace(/^[A-Z]:/, m => m.toLowerCase()));
  assert.equal(out.body.line, 7);
});

test("a breakpoint added while running binds; noDebug ignores breakpoints", async t => {
  const c = client(t, SCRIPT);
  await c.launch([]);
  await c.event("output");
  await c.ok("setBreakpoints", { source: { path: c.program }, breakpoints: [{ line: 4 }] });
  await c.event("stopped");

  const quiet = client(t, SCRIPT);
  await quiet.launch([4], { noDebug: true });
  await quiet.event("output");
  assert.equal(quiet.events.some(e => e.event === "stopped"), false);
});

test("pause is refused; inspection while running fails cleanly", async t => {
  const c = client(t, SCRIPT);
  await c.launch([]);
  await c.event("output");
  const pause = await c.send("pause", { threadId: 1 });
  assert.equal(pause.success, false);
  assert.match(pause.message, /breakpoint/);
  assert.equal((await c.send("stackTrace", { threadId: 1 })).success, false);
});

test("a Lua error is written to stderr and terminates the session", async t => {
  const c = client(t, `function onTick() error("boom") end`);
  await c.launch([]);
  const term = await c.event("terminated");
  const err = c.events.slice(0, term.index).find(e => e.event === "output" && e.body.category === "stderr");
  assert.match(err.body.output, /main\.lua:1: boom/);
});

test("launch without a program fails; disconnect stops the script", async t => {
  const c = client(t, SCRIPT);
  await c.ok("initialize", {});
  assert.equal((await c.send("launch", {})).success, false);
  await c.ok("launch", { program: c.program });
  await c.ok("configurationDone");
  await c.event("output");
  assert.equal(c.sim.isRunning(), true);
  await c.ok("disconnect", {});
  assert.equal(c.sim.isRunning(), false);
});
