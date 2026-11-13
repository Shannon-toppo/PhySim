// The tools an AI agent gets: what each is called, what it takes, and how the
// request turns into calls on AgentSession. No vscode, no process globals —
// the environment comes in through ToolEnvironment, so the tests build the
// same tool set the server does.
//
// Arguments arrive from a language model, so every one is checked here and a
// wrong one is answered with a sentence saying what was expected. The schemas
// say the same thing in JSON Schema for clients that validate first; they are
// documentation, not the check.
//
// Answers are JSON text, kept small: 32 channels are reported as the non-zero
// ones, pictures as counts and bounds, floats rounded to what a float32 holds.

import * as path from "path";
import { PhysState, Triple } from "../engine/physState";
import { IO_CHANNELS, PropertyInput } from "../engine/runner";
import { MAX_CONTROLS } from "../engine/controls";
import { ScreenInfo, ScreenRequest, MAX_SCREENS, sanitizeScreenRequest } from "../engine/screens";
import type { BuildOutcome, BuildRequest } from "../build";
import { GAME_SCRIPT_LIMIT } from "../build";
import { AgentSession, MAX_STEP_TICKS, StepResult } from "./agentSession";
import type { ToolDefinition, ToolResult } from "./mcp";
import { Acceleration } from "./motion";
import {
  Check, Expectation, MAX_CHECKS, MAX_GRID_CELLS, Picture, Rect,
  checkExpectations, diffPictures, parseRgb, regionStats, textGrid
} from "./pixels";
import { MAX_PNG_SCALE, encodePng, fitPngScale } from "./png";
import { ProjectFiles, resolveProject } from "./project";
import { parseScenario } from "./scenario";

export interface ToolEnvironment {
  session: AgentSession;
  /** Relative paths in tool arguments are taken from here. */
  cwd: string;
  /** The extension's lua/ directory. */
  bundledLua: string;
  files: ProjectFiles;
  build(request: BuildRequest): Promise<BuildOutcome>;
  /** Write a build's output; creates the directory. */
  writeText(file: string, text: string): void;
  /**
   * The path with every symbolic link in it followed. The path may not exist
   * yet: the part that does is resolved and the rest appended.
   */
  realPath(file: string): string;
  /** The user's home directory, which is never taken for a workspace folder. */
  home?: string;
}

/** Log lines returned by one call; the rest are counted and fetched with get_logs. */
const LOGS_PER_ANSWER = 50;
const MAX_LOGS_PER_REQUEST = 500;

// --- Argument checking ---------------------------------------------------------

type Args = Record<string, unknown>;

function fail(message: string): never { throw new Error(message); }

function has(args: Args, name: string): boolean { return args[name] !== undefined && args[name] !== null; }

function numberArg(args: Args, name: string, opts: { min?: number; max?: number; whole?: boolean } = {}): number {
  const v = args[name];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number`);
  if (opts.whole && !Number.isInteger(v)) fail(`${name} must be a whole number`);
  if (opts.min !== undefined && v < opts.min) fail(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) fail(`${name} must be at most ${opts.max}`);
  return v;
}

function stringArg(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v === "") fail(`${name} must be a non-empty string`);
  return v;
}

function boolArg(args: Args, name: string, fallback: boolean): boolean {
  if (!has(args, name)) return fallback;
  const v = args[name];
  if (typeof v !== "boolean") fail(`${name} must be true or false`);
  return v;
}

function tripleArg(args: Args, name: string): Triple {
  const v = args[name];
  if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === "number" && Number.isFinite(n))) {
    fail(`${name} must be three numbers: [x, y, z]`);
  }
  return [v[0], v[1], v[2]];
}

function objectArg(args: Args, name: string): Args {
  const v = args[name];
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${name} must be an object`);
  return v as Args;
}

function monitorArg(args: Args): number {
  return has(args, "monitor") ? numberArg(args, "monitor", { whole: true, min: 1 }) : 1;
}

function rectArg(args: Args): Partial<Rect> | undefined {
  const rect: Partial<Rect> = {};
  for (const k of ["x", "y", "width", "height"] as const) {
    if (has(args, k)) rect[k] = numberArg(args, k, { whole: true });
  }
  return Object.keys(rect).length > 0 ? rect : undefined;
}

function channelKey(key: string, what: string): number {
  const n = Number(key);
  if (!/^\d+$/.test(key) || n < 1 || n > IO_CHANNELS) fail(`${what}: "${key}" is not a channel from 1 to ${IO_CHANNELS}`);
  return n;
}

function monitorRequest(raw: unknown, what: string): ScreenRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${what} must be an object`);
  const o = raw as Args;
  const number = has(o, "number") ? numberArg(o, "number", { whole: true, min: 1, max: MAX_SCREENS }) : 1;
  const request = sanitizeScreenRequest({
    number,
    size: stringArg(o, "size"),
    poweredOn: boolArg(o, "poweredOn", true),
    portrait: boolArg(o, "portrait", false)
  });
  if (!request) fail(`${what}: size must be "WxH" in blocks, each from 1 to 9, such as "3x3" or "5x3"`);
  return request;
}

function propertyValues(raw: Args, what: string): Record<string, PropertyInput> {
  // No prototype: on a plain object, a label of "__proto__" would be swallowed by the setter.
  const out = Object.create(null) as Record<string, PropertyInput>;
  for (const [label, value] of Object.entries(raw)) {
    if (label === "") fail(`${what}: a property label cannot be empty`);
    if (typeof value === "number" ? !Number.isFinite(value) : typeof value !== "boolean" && typeof value !== "string") {
      fail(`${what}: property "${label}" must be a number, true/false or a string`);
    }
    out[label] = value as PropertyInput;
  }
  return out;
}

// --- Answers ---------------------------------------------------------------------

/**
 * JSON, laid out for a reader that pays per token and still has to find things:
 * one top-level field per line, everything below it compact. A list of strings
 * (a text grid's rows) gets a line per string, so its columns line up.
 */
export function formatAnswer(value: Record<string, unknown>): string {
  const fields = Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => {
    const rows = Array.isArray(v) && v.length > 1 && v.every(s => typeof s === "string");
    const text = rows ? `[\n${(v as string[]).map(s => `  ${JSON.stringify(s)}`).join(",\n")}\n ]` : JSON.stringify(v);
    return ` ${JSON.stringify(k)}: ${text}`;
  });
  return `{\n${fields.join(",\n")}\n}`;
}

function answer(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: formatAnswer(value) }] };
}

/** Composite values are float32 in the engine; seven significant digits is all one holds. */
function f32(n: number): number { return Number.isFinite(n) ? Number(n.toPrecision(7)) : n; }

function sparseNumbers(values: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  values.forEach((v, i) => { if (v !== 0) out[String(i + 1)] = f32(v); });
  return out;
}

function onChannels(values: readonly boolean[]): number[] {
  const out: number[] = [];
  values.forEach((v, i) => { if (v) out.push(i + 1); });
  return out;
}

function roundPose(p: PhysState): PhysState {
  const r = (t: Triple): Triple => [Number(t[0].toFixed(6)), Number(t[1].toFixed(6)), Number(t[2].toFixed(6))];
  return { position: r(p.position), rotation: r(p.rotation), velocity: r(p.velocity), angularVelocity: r(p.angularVelocity) };
}

function describeScreens(screens: readonly ScreenInfo[]): unknown[] {
  return screens.map(s => ({
    number: s.number, width: s.width, height: s.height, poweredOn: s.poweredOn, portrait: s.portrait
  }));
}

function logAnswer(session: AgentSession, since: number, limit: number): Record<string, unknown> {
  const { lines, dropped, more } = session.logsSince(since, limit);
  const out: Record<string, unknown> = {
    lines: lines.map(l => ({
      seq: l.seq, tick: l.tick, text: l.text,
      ...(l.source === "debug.log" ? { source: l.source } : {}),
      ...(l.file ? { file: l.file, line: l.line } : {})
    }))
  };
  if (more > 0) out.more = `${more} more lines; call get_logs with since ${lines[lines.length - 1].seq + 1}`;
  if (dropped > 0) out.dropped = `${dropped} older lines were not kept`;
  return out;
}

function runAnswer(session: AgentSession): Record<string, unknown> {
  const status = session.getStatus();
  const out: Record<string, unknown> = { status, tick: session.getTicks() };
  const error = session.getError();
  if (error) out.error = error;
  return out;
}

function outputs(session: AgentSession): Record<string, unknown> {
  const io = session.io();
  return { numbers: sparseNumbers(io.outputNumbers), booleansOn: onChannels(io.outputBooleans) };
}

/** Per monitor: its size and how its picture differs from the one before the step. */
function monitorChanges(session: AgentSession): unknown[] {
  const pictures = session.pictures();
  return session.screens().map(s => {
    const base = { number: s.number, width: s.width, height: s.height };
    if (!s.poweredOn) return { ...base, poweredOn: false };
    const now = pictures.get(s.number);
    if (!now) return { ...base, picture: "none yet" };
    const lit = regionStats(now).lit;
    const before = session.pictureBeforeStep(s.number);
    if (!before) return { ...base, lit, changedPixels: "first picture" };
    const diff = diffPictures(before, now);
    if (!diff.comparable) return { ...base, lit, changedPixels: "the monitor was resized" };
    return { ...base, lit, changedPixels: diff.changed, ...(diff.changedBounds ? { changedBounds: diff.changedBounds } : {}) };
  });
}

function stepFields(session: AgentSession, result: StepResult, logsFrom: number): Record<string, unknown> {
  return {
    ticksRun: result.ticksRun,
    stopped: result.stopped,
    ...runAnswer(session),
    pose: roundPose(session.getPose()),
    outputs: outputs(session),
    monitors: monitorChanges(session),
    logs: logAnswer(session, logsFrom, LOGS_PER_ANSWER)
  };
}

// --- Schemas -----------------------------------------------------------------------

const TRIPLE = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const MONITOR = { type: "integer", minimum: 1, description: "Monitor number. Default 1." };
const RECT = {
  x: { type: "integer", description: "Left edge in pixels. Default 0." },
  y: { type: "integer", description: "Top edge in pixels. Default 0." },
  width: { type: "integer", description: "Default: to the right edge." },
  height: { type: "integer", description: "Default: to the bottom edge." }
};
const RGB = { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 };
const MONITOR_REQUEST = {
  type: "object",
  properties: {
    number: { type: "integer", minimum: 1, maximum: MAX_SCREENS, description: "Default 1." },
    size: { type: "string", description: 'Blocks as "WxH", each 1 to 9: "1x1", "3x3", "5x3", "9x5". One block is 32 pixels.' },
    portrait: { type: "boolean", description: "Swap width and height. Default false." },
    poweredOn: { type: "boolean", description: "Default true. An unpowered monitor is not drawn." }
  },
  required: ["size"]
};

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const READ_ONLY = { readOnlyHint: true };

// --- The tools -----------------------------------------------------------------------

export const SERVER_INSTRUCTIONS = [
  "PhySim runs a Stormworks microcontroller Lua script and feeds it a physics sensor's values (CH1-17 through require(\"PhySim\")).",
  "Time only moves when you call step or play_scenario; every run is repeatable.",
  "Typical loop: start_script, set_pose / set_inputs / set_controls, step, read outputs and logs, look at the monitor with monitor_region / monitor_grid / monitor_check, edit the Lua yourself, start_script again.",
  "To compare a monitor before and after an edit: save_snapshot, edit, start_script, step the same way, monitor_diff against the snapshot.",
  "Coordinates are Stormworks' left-handed frame: +X east, +Y up, +Z north. Rotations are Euler XYZ in radians. Velocities are per tick (60 ticks = 1 second).",
  "Monitor pixels: x right, y down, origin top-left. Colours are what is visible on the black monitor, as [r, g, b].",
  "Rules of this simulator: as in the real game, input.* / output.* inside onDraw and screen.* inside onTick stop the script with an error, so call input/output only in onTick, screen only in onDraw, and keep what the picture needs in variables. print / require / the simulator object exist only in the simulator, so build_script rejects them outside a ---@section __LB_SIMULATOR_ONLY__ block."
].join(" ");

export function createTools(env: ToolEnvironment): ToolDefinition[] {
  const { session } = env;

  const pictureOf = (args: Args): { monitor: number; picture: Picture } => {
    const monitor = monitorArg(args);
    return { monitor, picture: session.picture(monitor) };
  };

  return [
    {
      name: "start_script",
      description:
        "Load a microcontroller .lua file and run its top level, replacing any script already running. " +
        "No tick runs yet: call step next. A Lua error is reported in the answer (status \"failed\"). " +
        "The pose set earlier is kept; held inputs, touches and monitors start afresh. " +
        "require() searches the workspace folder, the library paths, then PhySim's own PhySim.lua.",
      inputSchema: schema({
        script: { type: "string", description: "Path of the .lua file, absolute or relative to the server's working directory." },
        workspaceFolder: { type: "string", description: "Root for require(). Default: the nearest folder above the script holding .vscode or .git, else the script's folder." },
        libraryPaths: { type: "array", items: { type: "string" }, description: "Extra folders for require(), searched after the workspace folder. .vscode/settings.json's physim.libraryPaths are added automatically." },
        monitors: { type: "array", items: MONITOR_REQUEST, description: "Monitors besides the default 3x3 monitor 1. The script's own simulator:setScreen calls override these." },
        properties: { type: "object", description: "Property values by label (number, boolean or string), as set on the microcontroller in the game. A simulator:setProperty in the script overrides them." }
      }, ["script"]),
      call(args) {
        const project = resolveProject({
          script: stringArg(args, "script"),
          cwd: env.cwd,
          workspaceFolder: has(args, "workspaceFolder") ? stringArg(args, "workspaceFolder") : undefined,
          libraryPaths: has(args, "libraryPaths") ? stringList(args, "libraryPaths") : undefined,
          bundledLua: env.bundledLua,
          home: env.home
        }, env.files);
        const monitors = has(args, "monitors") ? arrayArg(args, "monitors").map((m, i) => monitorRequest(m, `monitors[${i}]`)) : [];
        if (monitors.length > MAX_SCREENS) fail(`at most ${MAX_SCREENS} monitors`);
        const properties = has(args, "properties") ? propertyValues(objectArg(args, "properties"), "properties") : undefined;
        const logsFrom = session.logCursor();
        session.start({ entry: project.entry, roots: project.roots, screens: monitors, properties });
        return answer({
          ...runAnswer(session),
          script: project.entry,
          requireRoots: project.roots,
          ...(project.settingsProblem ? { settingsProblem: `${project.settingsFile}: ${project.settingsProblem}` } : {}),
          monitors: describeScreens(session.screens()),
          logs: logAnswer(session, logsFrom, LOGS_PER_ANSWER)
        });
      }
    },
    {
      name: "stop_script",
      description: "Stop the running script and discard its monitors. The pose and the snapshots are kept.",
      inputSchema: schema({}),
      call() {
        session.stop();
        return answer({ status: session.getStatus() });
      }
    },
    {
      name: "get_status",
      description: "Where things stand: run status, tick count, the Lua error if the run failed, the pose, monitors, held inputs and snapshots.",
      inputSchema: schema({}),
      annotations: READ_ONLY,
      call() {
        const held = session.heldInputs();
        return answer({
          ...runAnswer(session),
          script: session.getEntry(),
          pose: roundPose(session.getPose()),
          monitors: describeScreens(session.screens()),
          controls: session.controls(),
          heldInputs: {
            numbers: Object.fromEntries(held.numbers.map(([c, v]) => [String(c), v])),
            booleans: Object.fromEntries(held.booleans.map(([c, v]) => [String(c), v]))
          },
          snapshots: session.snapshotList()
        });
      }
    },
    {
      name: "set_pose",
      description:
        "Set the physics sensor's pose. Only the fields given change. The script reads it on its next tick. " +
        "With step's motion \"integrate\", velocity and angularVelocity then move the position and rotation every tick.",
      inputSchema: schema({
        position: { ...TRIPLE, description: "Metres: [x east, y up, z north]." },
        rotation: { ...TRIPLE, description: "Euler XYZ in radians." },
        velocity: { ...TRIPLE, description: "Metres per tick (multiply m/s by 1/60)." },
        angularVelocity: { ...TRIPLE, description: "Radians per tick." }
      }),
      call(args) {
        const pose = session.getPose();
        const next: PhysState = {
          position: has(args, "position") ? tripleArg(args, "position") : pose.position,
          rotation: has(args, "rotation") ? tripleArg(args, "rotation") : pose.rotation,
          velocity: has(args, "velocity") ? tripleArg(args, "velocity") : pose.velocity,
          angularVelocity: has(args, "angularVelocity") ? tripleArg(args, "angularVelocity") : pose.angularVelocity
        };
        session.setPose(next);
        return answer({ pose: roundPose(next) });
      }
    },
    {
      name: "step",
      description:
        `Run the script for a number of ticks (60 ticks = 1 second of game time; at most ${MAX_STEP_TICKS} per call). ` +
        "Each tick runs onLBSimulatorTick, onTick, then onDraw for every powered monitor. " +
        "Returns the outputs, new log lines and how many pixels of each monitor changed. " +
        "Stops early if the script fails or exits.",
      inputSchema: schema({
        ticks: { type: "integer", minimum: 1, maximum: MAX_STEP_TICKS, description: "Default 1." },
        motion: { type: "string", enum: ["hold", "integrate"], description: "hold (default): the pose stays as set. integrate: each tick the velocities take the accelerations, then the pose advances by the velocities, as the panel's Simulate does." },
        acceleration: { ...TRIPLE, description: "With integrate: metres per tick squared. Default [0, 0, 0]." },
        angularAcceleration: { ...TRIPLE, description: "With integrate: radians per tick squared. Default [0, 0, 0]." }
      }),
      call(args) {
        const ticks = has(args, "ticks") ? numberArg(args, "ticks", { whole: true, min: 1, max: MAX_STEP_TICKS }) : 1;
        const motion = has(args, "motion") ? stringArg(args, "motion") : "hold";
        if (motion !== "hold" && motion !== "integrate") fail('motion must be "hold" or "integrate"');
        const accelerated = has(args, "acceleration") || has(args, "angularAcceleration");
        if (accelerated && motion !== "integrate") fail('acceleration only applies with motion "integrate"');
        const acceleration: Acceleration | undefined = accelerated
          ? {
            linear: has(args, "acceleration") ? tripleArg(args, "acceleration") : [0, 0, 0],
            angular: has(args, "angularAcceleration") ? tripleArg(args, "angularAcceleration") : [0, 0, 0]
          }
          : undefined;
        const logsFrom = session.logCursor();
        return answer(stepFields(session, session.step({ ticks, motion, acceleration }), logsFrom));
      }
    },
    {
      name: "play_scenario",
      description:
        "Replay a recorded motion: one tick per row of a PhySim CSV log (the panel's CSV logging writes this format). " +
        "Each row's pose (columns ch1_pos_x to ch12_angvel_z) is set, then one tick runs. Returns what step returns.",
      inputSchema: schema({
        file: { type: "string", description: "Path of the CSV file, absolute or relative to the server's working directory." },
        startRow: { type: "integer", minimum: 1, description: "First data row to play, counting from 1. Default 1." },
        maxTicks: { type: "integer", minimum: 1, maximum: MAX_STEP_TICKS, description: `Rows to play at most. Default: to the end of the file, capped at ${MAX_STEP_TICKS}.` }
      }, ["file"]),
      call(args) {
        const file = path.resolve(env.cwd, stringArg(args, "file"));
        if (!env.files.isFile(file)) fail(`there is no file ${file}`);
        const states = parseScenario(env.files.readText(file));
        const startRow = has(args, "startRow") ? numberArg(args, "startRow", { whole: true, min: 1 }) : 1;
        if (startRow > states.length) fail(`startRow ${startRow} is past the end: the scenario has ${states.length} rows`);
        const maxTicks = has(args, "maxTicks") ? numberArg(args, "maxTicks", { whole: true, min: 1, max: MAX_STEP_TICKS }) : MAX_STEP_TICKS;
        const slice = states.slice(startRow - 1, startRow - 1 + maxTicks);
        const logsFrom = session.logCursor();
        const result = session.play(slice);
        const next = startRow + result.ticksRun;
        return answer({
          rows: states.length,
          ...(next <= states.length ? { nextRow: next } : { finished: true }),
          ...stepFields(session, result, logsFrom)
        });
      }
    },
    {
      name: "set_inputs",
      description:
        "Hold composite input channels at values, as if another block were wired to the microcontroller. " +
        "A held channel is written every tick until released. The script's own simulator:setInputNumber / setInputBool for a channel take precedence. " +
        "Note: the script's PhySim injectAsInputs(simulator, startCh) writes 17 channels from startCh, and monitor 1's touch fills booleans 1-2 and numbers 1-6 unless held.",
      inputSchema: schema({
        numbers: { type: "object", description: 'Channel (1-32) to number, e.g. {"20": 0.5}.', additionalProperties: { type: "number" } },
        booleans: { type: "object", description: 'Channel (1-32) to true/false, e.g. {"3": true}.', additionalProperties: { type: "boolean" } },
        releaseNumbers: { type: "array", items: { type: "integer", minimum: 1, maximum: IO_CHANNELS }, description: "Number channels to stop holding." },
        releaseBooleans: { type: "array", items: { type: "integer", minimum: 1, maximum: IO_CHANNELS }, description: "Boolean channels to stop holding." }
      }),
      call(args) {
        // Everything is checked before anything is applied: a request that is half wrong changes nothing.
        const numbers: Array<[number, number | null]> = [];
        const booleans: Array<[number, boolean | null]> = [];
        if (has(args, "numbers")) {
          for (const [k, v] of Object.entries(objectArg(args, "numbers"))) {
            if (typeof v !== "number" || !Number.isFinite(v)) fail(`numbers["${k}"] must be a finite number`);
            numbers.push([channelKey(k, "numbers"), v]);
          }
        }
        if (has(args, "booleans")) {
          for (const [k, v] of Object.entries(objectArg(args, "booleans"))) {
            if (typeof v !== "boolean") fail(`booleans["${k}"] must be true or false`);
            booleans.push([channelKey(k, "booleans"), v]);
          }
        }
        for (const [name, list] of [["releaseNumbers", numbers], ["releaseBooleans", booleans]] as const) {
          if (!has(args, name)) continue;
          for (const c of arrayArg(args, name)) {
            if (!Number.isInteger(c) || (c as number) < 1 || (c as number) > IO_CHANNELS) fail(`${name}: ${String(c)} is not a channel from 1 to ${IO_CHANNELS}`);
            list.push([c as number, null]);
          }
        }
        if (numbers.length + booleans.length === 0) fail("nothing to set: give numbers, booleans, releaseNumbers or releaseBooleans");
        // Touch the session only after the checks, so "no script is running" is the one way this fails late.
        for (const [c, v] of numbers) session.holdInputNumber(c, v);
        for (const [c, v] of booleans) session.holdInputBool(c, v);
        const held = session.heldInputs();
        return answer({
          heldNumbers: Object.fromEntries(held.numbers.map(([c, v]) => [String(c), v])),
          heldBooleans: Object.fromEntries(held.booleans.map(([c, v]) => [String(c), v]))
        });
      }
    },
    {
      name: "set_controls",
      description:
        `Work the simulator's buttons and sliders (numbers 1-${MAX_CONTROLS}), which a script reads with simulator:getIsClicked(n), simulator:getIsToggled(n) and simulator:getSlider(n). ` +
        "click presses and releases a button so that exactly the next tick sees it down; hold keeps it down (true) or lets it go (false) across ticks. " +
        "Every press, by click or hold, flips that button's toggle. Sliders take 0 to 1. " +
        "The answer lists the buttons and sliders the script has read so far; one it has not read yet can still be set.",
      inputSchema: schema({
        click: { type: "array", items: { type: "integer", minimum: 1, maximum: MAX_CONTROLS }, description: "Buttons to click once." },
        hold: { type: "object", description: 'Button number to true (down) or false (up), e.g. {"2": true}.', additionalProperties: { type: "boolean" } },
        sliders: { type: "object", description: 'Slider number to a value from 0 to 1, e.g. {"1": 0.25}.', additionalProperties: { type: "number", minimum: 0, maximum: 1 } }
      }),
      call(args) {
        const control = (key: string, what: string): number => {
          const n = Number(key);
          if (!/^\d+$/.test(key) || n < 1 || n > MAX_CONTROLS) fail(`${what}: "${key}" is not a number from 1 to ${MAX_CONTROLS}`);
          return n;
        };
        // Checked in full first, as set_inputs is: a half-wrong request changes nothing.
        const clicks: number[] = [];
        const holds: Array<[number, boolean]> = [];
        const sliders: Array<[number, number]> = [];
        if (has(args, "click")) {
          for (const n of arrayArg(args, "click")) {
            if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_CONTROLS) fail(`click: ${String(n)} is not a number from 1 to ${MAX_CONTROLS}`);
            clicks.push(n as number);
          }
        }
        if (has(args, "hold")) {
          for (const [k, v] of Object.entries(objectArg(args, "hold"))) {
            if (typeof v !== "boolean") fail(`hold["${k}"] must be true or false`);
            holds.push([control(k, "hold"), v]);
          }
        }
        if (has(args, "sliders")) {
          for (const [k, v] of Object.entries(objectArg(args, "sliders"))) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) fail(`sliders["${k}"] must be a number from 0 to 1`);
            sliders.push([control(k, "sliders"), v]);
          }
        }
        if (clicks.length + holds.length + sliders.length === 0) fail("nothing to set: give click, hold or sliders");
        if (clicks.some(c => holds.some(([h]) => h === c))) fail("a button cannot be both clicked and held in one request");
        for (const [n, down] of holds) session.pressButton(n, down);
        for (const n of clicks) session.clickButton(n);
        for (const [n, v] of sliders) session.setSlider(n, v);
        return answer({ controls: session.controls() });
      }
    },
    {
      name: "set_properties",
      description:
        "Set microcontroller properties (what property.getNumber / getBool / getText read) on the running script. " +
        "Takes effect at once. To have a value in place before the script's top level runs, pass properties to start_script instead.",
      inputSchema: schema({
        values: { type: "object", description: 'Label to value (number, boolean or string), e.g. {"Gain": 2.5, "Mode": "auto"}.' }
      }, ["values"]),
      call(args) {
        const values = propertyValues(objectArg(args, "values"), "values");
        if (Object.keys(values).length === 0) fail("values is empty");
        for (const [label, value] of Object.entries(values)) session.setProperty(label, value);
        return answer({ properties: Object.fromEntries(session.properties().map(p => [p.label, p.value])) });
      }
    },
    {
      name: "touch_monitor",
      description:
        "Press a monitor at a pixel, or release it. The touch stays down across ticks until released. " +
        "The script reads monitor 1's touch on booleans 1-2 and numbers 3-4 by default, and any monitor's through simulator:getTouchScreen(n).",
      inputSchema: schema({
        monitor: MONITOR,
        pressed: { type: "boolean", description: "true to press at x, y; false to release." },
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 }
      }, ["pressed"]),
      call(args) {
        const monitor = monitorArg(args);
        if (typeof args.pressed !== "boolean") fail("pressed must be true or false");
        if (args.pressed) {
          const x = numberArg(args, "x", { whole: true, min: 0 }), y = numberArg(args, "y", { whole: true, min: 0 });
          session.setTouch(monitor, { x, y });
          return answer({ monitor, pressed: true, x, y });
        }
        session.setTouch(monitor, null);
        return answer({ monitor, pressed: false });
      }
    },
    {
      name: "set_monitor",
      description:
        "Add a monitor to the running script or change one's size, orientation or power. It is drawn from the next tick. " +
        "A later simulator:setScreen call in the script for the same number overrides it.",
      inputSchema: MONITOR_REQUEST,
      call(args) {
        session.configureScreen(monitorRequest(args, "the monitor"));
        return answer({ monitors: describeScreens(session.screens()) });
      }
    },
    {
      name: "remove_monitor",
      description: "Take a monitor away from the running script. Monitor 1 cannot be removed.",
      inputSchema: schema({ monitor: { type: "integer", minimum: 2, maximum: MAX_SCREENS } }, ["monitor"]),
      call(args) {
        const monitor = numberArg(args, "monitor", { whole: true, min: 1, max: MAX_SCREENS });
        if (monitor === 1) fail("monitor 1 cannot be removed: its size and touch are what the default inputs carry");
        if (!session.screens().some(s => s.number === monitor)) fail(`there is no monitor ${monitor}`);
        session.removeScreen(monitor);
        return answer({ monitors: describeScreens(session.screens()) });
      }
    },
    {
      name: "get_io",
      description:
        "The composite inputs the script saw and the outputs it wrote, as of the last tick. " +
        "Numbers are listed for non-zero channels, booleans for channels that are on; every other channel is 0 / off.",
      inputSchema: schema({}),
      annotations: READ_ONLY,
      call() {
        const io = session.io();
        return answer({
          ...runAnswer(session),
          inputs: { numbers: sparseNumbers(io.inputNumbers), booleansOn: onChannels(io.inputBooleans) },
          outputs: { numbers: sparseNumbers(io.outputNumbers), booleansOn: onChannels(io.outputBooleans) }
        });
      }
    },
    {
      name: "get_logs",
      description:
        "Lines the script printed with print() or debug.log(), oldest first, each with the tick it was printed in and, when known, its file and line. " +
        "Every line has a sequence number; pass the next one as since to read on.",
      inputSchema: schema({
        since: { type: "integer", minimum: 0, description: "First sequence number wanted. Default 0." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LOGS_PER_REQUEST, description: `Default ${LOGS_PER_ANSWER}.` }
      }),
      annotations: READ_ONLY,
      call(args) {
        const since = has(args, "since") ? numberArg(args, "since", { whole: true, min: 0 }) : 0;
        const limit = has(args, "limit") ? numberArg(args, "limit", { whole: true, min: 1, max: MAX_LOGS_PER_REQUEST }) : LOGS_PER_ANSWER;
        return answer({ next: session.logCursor(), ...logAnswer(session, since, limit) });
      }
    },
    {
      name: "monitor_region",
      description:
        "What is drawn in a rectangle of a monitor (default: all of it): how many pixels are lit, the bounding box of the lit pixels, and each colour with its pixel count and bounding box. " +
        "Use it to check where something was drawn and whether it runs off the edge.",
      inputSchema: schema({ monitor: MONITOR, ...RECT }),
      annotations: READ_ONLY,
      call(args) {
        const { monitor, picture } = pictureOf(args);
        return answer({ monitor, monitorSize: [picture.width, picture.height], ...regionStats(picture, rectArg(args)) });
      }
    },
    {
      name: "monitor_diff",
      description:
        "Compare a monitor's current picture with an earlier one: how many pixels changed, the bounding box of the changes, how many appeared, disappeared or changed colour, and the first few changed pixels. " +
        "Against \"previous\" (default) compares with the picture before the last step or play_scenario call; against a snapshot name compares with that snapshot.",
      inputSchema: schema({
        monitor: MONITOR,
        against: { type: "string", description: 'A snapshot name, or "previous" (default).' },
        ...RECT
      }),
      annotations: READ_ONLY,
      call(args) {
        const { monitor, picture } = pictureOf(args);
        const against = has(args, "against") ? stringArg(args, "against") : "previous";
        let before: Picture;
        if (against === "previous") {
          before = session.pictureBeforeStep(monitor)
            ?? fail(`monitor ${monitor} had no picture before the last step, so there is nothing to compare with`);
        } else {
          before = session.snapshot(against, monitor);
        }
        return answer({ monitor, against, ...diffPictures(before, picture, rectArg(args)) });
      }
    },
    {
      name: "monitor_check",
      description:
        "Test a monitor's picture against expectations and get pass/fail for each, with the pixels that break it. Each check takes a rectangle (default: the whole monitor) and one of: " +
        "\"empty\" (no pixel lit), \"filled\" (every pixel lit, and with color every pixel that colour), " +
        "\"some\" (at least one pixel lit, or at least one of color), \"only\" (every lit pixel is color). " +
        "Use it to pin down a layout: this box is drawn, this margin is clear, this text is white.",
      inputSchema: schema({
        monitor: MONITOR,
        checks: {
          type: "array", minItems: 1, maxItems: MAX_CHECKS,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Echoed in the answer." },
              ...RECT,
              expect: { type: "string", enum: ["empty", "filled", "some", "only"] },
              color: { ...RGB, description: "[r, g, b] as visible on the monitor." },
              tolerance: { type: "integer", minimum: 0, maximum: 255, description: "How far each of r, g, b may be from color. Default 0." }
            },
            required: ["expect"]
          }
        }
      }, ["checks"]),
      annotations: READ_ONLY,
      call(args) {
        const { monitor, picture } = pictureOf(args);
        const raw = arrayArg(args, "checks");
        if (raw.length === 0) fail("checks is empty");
        const checks: Check[] = raw.map((c, i) => {
          if (typeof c !== "object" || c === null || Array.isArray(c)) fail(`checks[${i}] must be an object`);
          const o = c as Args;
          const expect = stringArg(o, "expect");
          if (!["empty", "filled", "some", "only"].includes(expect)) fail(`checks[${i}].expect must be "empty", "filled", "some" or "only"`);
          return {
            label: has(o, "label") ? String(o.label) : undefined,
            rect: rectArg(o),
            expect: expect as Expectation,
            color: has(o, "color") ? parseRgb(o.color, `checks[${i}].color`) : undefined,
            tolerance: has(o, "tolerance") ? numberArg(o, "tolerance", { whole: true, min: 0, max: 255 }) : undefined
          };
        });
        const results = checkExpectations(picture, checks);
        return answer({
          monitor,
          pass: results.every(r => r.pass),
          failed: results.filter(r => !r.pass).length,
          results: results.map(r => r.pass ? { label: r.label, expect: r.expect, rect: r.rect, pass: true, matching: r.matching, pixels: r.pixels } : r)
        });
      }
    },
    {
      name: "monitor_grid",
      description:
        `A small part of a monitor as text, one character per pixel: "#" lit, "." unlit. At most ${MAX_GRID_CELLS} pixels (64x64). ` +
        "With byColor, each colour gets its own letter and a legend, which shows where two shapes overlap. " +
        "Use it to read text and small shapes exactly.",
      inputSchema: schema({ monitor: MONITOR, ...RECT, byColor: { type: "boolean", description: "Default false." } }),
      annotations: READ_ONLY,
      call(args) {
        const { monitor, picture } = pictureOf(args);
        const grid = textGrid(picture, rectArg(args), boolArg(args, "byColor", false));
        return answer({ monitor, rect: grid.rect, ...(grid.legend ? { legend: grid.legend } : {}), rows: grid.rows });
      }
    },
    {
      name: "monitor_image",
      description:
        `A monitor's picture as a PNG, each pixel enlarged by a whole factor (default 4, at most ${MAX_PNG_SCALE}). ` +
        "For a person to look at, or a rough overall impression; for anything exact use monitor_region, monitor_grid or monitor_check.",
      inputSchema: schema({ monitor: MONITOR, scale: { type: "integer", minimum: 1, maximum: MAX_PNG_SCALE } }),
      annotations: READ_ONLY,
      call(args) {
        const { monitor, picture } = pictureOf(args);
        const wanted = has(args, "scale") ? numberArg(args, "scale", { whole: true, min: 1, max: MAX_PNG_SCALE }) : 4;
        const scale = fitPngScale(picture, wanted);
        return {
          content: [
            { type: "text", text: formatAnswer({ monitor, monitorSize: [picture.width, picture.height], scale }) },
            { type: "image", data: encodePng(picture, scale).toString("base64"), mimeType: "image/png" }
          ]
        };
      }
    },
    {
      name: "save_snapshot",
      description:
        "Remember every monitor's current picture under a name, to compare against later with monitor_diff. " +
        "Snapshots survive start_script, so one taken before editing the Lua can be compared with the picture after.",
      inputSchema: schema({ name: { type: "string" } }, ["name"]),
      call(args) {
        const name = stringArg(args, "name");
        if (name === "previous") fail('"previous" is reserved: it means the picture before the last step');
        if (name.length > 64) fail("a snapshot name is at most 64 characters");
        return answer({ name, monitors: session.saveSnapshot(name) });
      }
    },
    {
      name: "delete_snapshot",
      description: "Forget a snapshot saved with save_snapshot, freeing its place among the snapshots kept.",
      inputSchema: schema({ name: { type: "string" } }, ["name"]),
      call(args) {
        const name = stringArg(args, "name");
        if (!session.deleteSnapshot(name)) fail(`there is no snapshot named "${name}"`);
        return answer({ deleted: name, snapshots: session.snapshotList() });
      }
    },
    {
      name: "build_script",
      description:
        `Build a script for the game: link its require()s, remove simulator-only sections, and minify. Reports the size in characters against the game's limit of ${GAME_SCRIPT_LIMIT}, and any problems with file and line. ` +
        "Writes nothing unless write is true. Independent of the running script.",
      inputSchema: schema({
        script: { type: "string", description: "Path of the .lua file, absolute or relative to the server's working directory." },
        workspaceFolder: { type: "string", description: "As for start_script." },
        libraryPaths: { type: "array", items: { type: "string" }, description: "As for start_script." },
        minify: { type: "boolean", description: "Default true. false links and strips only, keeping the code readable." },
        write: { type: "boolean", description: "Default false. true writes the output to outputDirectory under the script's file name." },
        outputDirectory: { type: "string", description: 'With write: where to, inside the workspace folder. Default "_build/release" (what PhySim: Build uses).' },
        overwrite: { type: "boolean", description: "With outputDirectory: replace a file that is already there. Default false. A source file of the build is never replaced." },
        includeCode: { type: "boolean", description: "Default false. true returns the built code in the answer." }
      }, ["script"]),
      async call(args) {
        const project = resolveProject({
          script: stringArg(args, "script"),
          cwd: env.cwd,
          workspaceFolder: has(args, "workspaceFolder") ? stringArg(args, "workspaceFolder") : undefined,
          libraryPaths: has(args, "libraryPaths") ? stringList(args, "libraryPaths") : undefined,
          bundledLua: env.bundledLua,
          home: env.home
        }, env.files);
        const minify = boolArg(args, "minify", true);
        const write = boolArg(args, "write", false);
        const includeCode = boolArg(args, "includeCode", false);
        const outputDirectory = has(args, "outputDirectory") ? stringArg(args, "outputDirectory") : "_build/release";
        if (has(args, "outputDirectory") && !write) fail("outputDirectory only applies with write true");

        const outcome = await env.build({ entry: project.entry, roots: project.roots, minify });
        const out: Record<string, unknown> = {
          ok: outcome.ok,
          script: project.entry,
          minified: minify,
          problems: outcome.problems
        };
        if (!outcome.ok || outcome.code === undefined) return { ...answer(out), isError: true };
        const size = outcome.size ?? outcome.code.length;
        out.size = size;
        out.limit = GAME_SCRIPT_LIMIT;
        out.remaining = GAME_SCRIPT_LIMIT - size;
        out.fits = size <= GAME_SCRIPT_LIMIT;
        out.files = outcome.usedFiles;
        if (write) {
          const file = path.join(path.resolve(project.workspaceFolder, outputDirectory), path.basename(project.entry));
          // The one tool that writes to disk is kept to the project it was asked
          // to build. Compared after following links: a link inside the workspace
          // may point anywhere.
          const inside = path.relative(env.realPath(project.workspaceFolder), env.realPath(file));
          if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
            fail(`outputDirectory must be inside the workspace folder ${project.workspaceFolder}`);
          }
          // Not the entry, and not a module it was linked from either.
          const target = env.realPath(file);
          const source = [project.entry, ...outcome.usedFiles].find(f => env.realPath(f) === target);
          if (source) fail(`the output would overwrite a source file (${source}); choose another outputDirectory`);
          // In the default directory a file of this name is the last build. Anywhere
          // else it may be somebody's module that happens to share the name.
          if (has(args, "outputDirectory") && env.files.isFile(file) && !boolArg(args, "overwrite", false)) {
            fail(`${file} already exists; pass overwrite: true to replace it`);
          }
          env.writeText(file, outcome.code);
          out.written = file;
        }
        if (includeCode) out.code = outcome.code;
        return answer(out);
      }
    }
  ];
}

function arrayArg(args: Args, name: string): unknown[] {
  const v = args[name];
  if (!Array.isArray(v)) fail(`${name} must be an array`);
  return v;
}

function stringList(args: Args, name: string): string[] {
  const v = arrayArg(args, name);
  if (!v.every((s): s is string => typeof s === "string" && s !== "")) fail(`${name} must be an array of non-empty strings`);
  return v;
}
