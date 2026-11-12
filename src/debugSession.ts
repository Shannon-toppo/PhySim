// The debug adapter: VSCode's Debug Adapter Protocol on one side, the engine's
// debugger on the other. Speaks DAP as plain JSON messages and imports no
// vscode, so the tests drive it in Node; extension.ts wraps it in the few
// lines VSCode needs for an inline adapter.
//
// What the engine offers, and so what this offers: line breakpoints, step
// into / over / out, the call stack, locals and upvalues, table expansion and
// expression evaluation while stopped. What it does not:
//   - Pause. The engine suspends only at a breakpoint or step, never on
//     request from outside, so the pause button is refused rather than faked.
//   - Stepping across ticks. A step that runs off the end of onTick or onDraw
//     finishes the tick and the script runs on; set a breakpoint to stop in
//     the next tick.
//
// A stopped script holds the whole simulation: ticks, and with them the
// monitors, wait until it continues. The panel stays usable and its changes
// are picked up by the next tick.

import type {
  Breakpoint, DebugHandle, DebugValue, StepMode, Variable
} from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };
import type { RequestName, Requests } from "./engine/protocol";
import type { LogLine } from "./engine/runner";
import { chunkFile, chunkName } from "./engine/sourceRoots";

/** The one Lua thread a microcontroller has. */
const THREAD_ID = 1;
/** Table entries fetched per engine request, and the most shown for one table. */
const TABLE_PAGE = 200;
const TABLE_LIMIT = 2000;

export interface LaunchRequest {
  program: string;
  breakpoints: Breakpoint[];
}

/** What the adapter needs from the extension: a way to run, stop and question the script. */
export interface DebugHost {
  /** Start the script. Rejects if it cannot be started at all. */
  launch(request: LaunchRequest): Promise<void>;
  stop(): Promise<void>;
  /** Ask the running script's debugger. Rejects when nothing is running. */
  request<K extends RequestName>(name: K, args: Requests[K]["args"]): Promise<Requests[K]["result"]>;
}

interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
}
interface DapRequest extends DapMessage {
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
}

/** What a `variablesReference` stands for. Valid for one stop only. */
type VariableScope =
  | { kind: "locals"; level: number }
  | { kind: "upvalues"; level: number }
  | { kind: "table"; handle: DebugHandle };

const decoder = new TextDecoder("utf-8", { fatal: false });

function text(bytes: Uint8Array): string { return decoder.decode(bytes); }

/** A float the way Lua prints it: integral values keep their ".0". */
function formatNumber(n: number): string {
  if (Number.isNaN(n)) return n < 0 ? "-nan" : "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  // %.14g, Lua's own number format.
  return Number(n.toPrecision(14)).toString();
}

function quote(s: string): string {
  return '"' + s.replace(/[\\"\n\r\t\0]/g, c =>
    ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\0": "\\0" } as Record<string, string>)[c]) + '"';
}

/** How a value reads in the Variables view. */
export function formatValue(v: DebugValue): { value: string; type: string } {
  switch (v.kind) {
    case "nil": return { value: "nil", type: "nil" };
    case "bool": return { value: String(v.value), type: "boolean" };
    case "integer": return { value: v.value.toString(), type: "integer" };
    case "number": return { value: formatNumber(v.value), type: "number" };
    case "bytes": return { value: quote(text(v.value)), type: "string" };
    case "table": return { value: "table", type: "table" };
    case "opaque": return { value: v.typeName, type: v.typeName };
  }
}

/** A table key as it would be written in an index expression: `name` or `[1]`. */
function formatKey(key: DebugValue): string {
  if (key.kind === "bytes") {
    const s = text(key.value);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `[${quote(s)}]`;
  }
  return `[${formatValue(key).value}]`;
}

export class PhysimDebugSession {
  private seq = 1;
  private program: string | undefined;
  private noDebug = false;
  private launched = false;
  private ended = false;
  /** Breakpoints as last set by the client, per source file. */
  private breakpoints = new Map<string, Breakpoint[]>();
  private scopes = new Map<number, VariableScope>();
  private nextScope = 1;

  constructor(private readonly host: DebugHost, private readonly emit: (message: unknown) => void) {}

  // --- Events from the running script ----------------------------------------

  scriptStopped(reason: "breakpoint" | "step"): void {
    this.scopes.clear();
    this.event("stopped", { reason, threadId: THREAD_ID, allThreadsStopped: true });
  }

  scriptContinued(): void {
    this.scopes.clear();
    this.event("continued", { threadId: THREAD_ID, allThreadsContinued: true });
  }

  scriptLog(line: LogLine): void {
    const file = line.chunk ? chunkFile(line.chunk) : null;
    this.event("output", {
      category: "stdout",
      output: line.text + "\n",
      ...(file ? { source: { path: file }, line: line.line } : {})
    });
  }

  /** The run is over, by an error or by the script's own choice. */
  scriptEnded(reason: "error" | "exit" | "crash", message?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (reason !== "exit") {
      const what = reason === "crash" ? "The engine stopped unexpectedly" : "Lua error";
      this.event("output", { category: "stderr", output: `${what}: ${message ?? "(no message)"}\n` });
    }
    this.event("terminated", {});
  }

  // --- Requests from VSCode ----------------------------------------------------

  handleMessage(message: unknown): void {
    const m = message as DapRequest;
    if (!m || m.type !== "request" || typeof m.command !== "string") return;
    this.dispatch(m).then(
      body => this.respond(m, true, body),
      err => this.respond(m, false, undefined, err instanceof Error ? err.message : String(err))
    );
  }

  private async dispatch(request: DapRequest): Promise<unknown> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case "initialize":
        // Sent after the response (queued behind it): breakpoints may now be configured.
        queueMicrotask(() => this.event("initialized", {}));
        return {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportTerminateDebuggee: true
        };

      case "launch":
        if (typeof args.program !== "string" || args.program === "") {
          throw new Error("the launch configuration has no \"program\" (the Lua file to run)");
        }
        this.program = args.program;
        this.noDebug = args.noDebug === true;
        return undefined;

      case "setBreakpoints":
        return this.setBreakpoints(args);

      case "setExceptionBreakpoints":
        return undefined;

      case "configurationDone":
        if (!this.program) throw new Error("launch must come before configurationDone");
        this.launched = true;
        await this.host.launch({ program: this.program, breakpoints: this.allBreakpoints() });
        return undefined;

      case "threads":
        return { threads: [{ id: THREAD_ID, name: "Microcontroller" }] };

      case "stackTrace":
        return this.stackTrace();

      case "scopes": {
        const level = Number(args.frameId);
        return {
          scopes: [
            { name: "Locals", presentationHint: "locals", variablesReference: this.scope({ kind: "locals", level }), expensive: false },
            { name: "Upvalues", variablesReference: this.scope({ kind: "upvalues", level }), expensive: false }
          ]
        };
      }

      case "variables":
        return { variables: await this.variables(Number(args.variablesReference)) };

      case "evaluate": {
        const value = await this.host.request("evaluate", {
          expression: String(args.expression ?? ""),
          level: typeof args.frameId === "number" ? args.frameId : 0
        });
        const shown = formatValue(value);
        return { result: shown.value, type: shown.type, variablesReference: this.reference(value) };
      }

      case "continue":
        await this.resume("continue");
        return { allThreadsContinued: true };
      case "next":
        await this.resume("over");
        return undefined;
      case "stepIn":
        await this.resume("into");
        return undefined;
      case "stepOut":
        await this.resume("out");
        return undefined;

      case "pause":
        throw new Error("PhySim cannot pause a running script. Set a breakpoint instead.");

      case "terminate":
      case "disconnect":
        this.ended = true;
        if (this.launched) await this.host.stop();
        if (request.command === "terminate") queueMicrotask(() => this.event("terminated", {}));
        return undefined;

      default:
        throw new Error(`unsupported request: ${request.command}`);
    }
  }

  private async setBreakpoints(args: Record<string, unknown>): Promise<unknown> {
    const source = args.source as { path?: unknown } | undefined;
    const file = typeof source?.path === "string" ? source.path : undefined;
    const wanted = Array.isArray(args.breakpoints) ? args.breakpoints as { line?: unknown }[] : [];
    const lines = wanted.map(b => Math.round(Number(b.line))).filter(l => Number.isFinite(l) && l > 0);
    if (file) {
      this.breakpoints.set(file, lines.map(line => ({ source: chunkName(file), line })));
      // Before launch they travel with the launch itself; after it, straight to the run.
      if (this.launched && !this.ended) {
        await this.host.request("setBreakpoints", { points: this.allBreakpoints() });
      }
    }
    // The engine matches by file and line when a line executes; it cannot say
    // in advance whether a line holds code, so every breakpoint is accepted.
    return { breakpoints: wanted.map((_, i) => ({ verified: file !== undefined, line: lines[i] })) };
  }

  private allBreakpoints(): Breakpoint[] {
    if (this.noDebug) return [];
    return Array.from(this.breakpoints.values()).flat();
  }

  private async resume(mode: StepMode): Promise<void> {
    this.scopes.clear();
    await this.host.request("resume", { mode });
  }

  private async stackTrace(): Promise<unknown> {
    const frames = await this.host.request("stack", {});
    return {
      totalFrames: frames.length,
      stackFrames: frames.map(f => {
        const file = chunkFile(f.source);
        return {
          // The engine addresses a frame by its level; that is the id scopes() gets back.
          id: f.level,
          name: f.functionName ?? "(unnamed)",
          line: f.line,
          column: 1,
          ...(file
            ? { source: { name: file.replace(/^.*[\\/]/, ""), path: file } }
            // PhySim's own prelude: shown, but not something to step through.
            : { source: { name: f.source.replace(/^@/, ""), presentationHint: "deemphasize" }, presentationHint: "subtle" })
        };
      })
    };
  }

  private scope(scope: VariableScope): number {
    const id = this.nextScope++;
    this.scopes.set(id, scope);
    return id;
  }

  /** 0 for a value with nothing inside it; otherwise a reference that expands it. */
  private reference(value: DebugValue): number {
    return value.kind === "table" ? this.scope({ kind: "table", handle: value.handle }) : 0;
  }

  private async variables(reference: number): Promise<unknown[]> {
    const scope = this.scopes.get(reference);
    // A reference from before the last continue: the values it named are gone.
    if (!scope) return [];
    if (scope.kind === "table") return this.tableEntries(scope.handle);
    const list: Variable[] = await this.host.request(scope.kind, { level: scope.level });
    return list
      // The engine reports compiler temporaries as "(temporary)" and the like.
      .filter(v => !text(v.name).startsWith("("))
      .map(v => this.variable(text(v.name), v.value));
  }

  private async tableEntries(handle: DebugHandle): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let start = 0; start < TABLE_LIMIT; start += TABLE_PAGE) {
      const page = await this.host.request("expand", { handle, start, limit: TABLE_PAGE });
      for (const e of page) out.push(this.variable(formatKey(e.key), e.value));
      if (page.length < TABLE_PAGE) return out;
    }
    out.push({ name: "…", value: `only the first ${TABLE_LIMIT} entries are shown`, variablesReference: 0 });
    return out;
  }

  private variable(name: string, value: DebugValue): unknown {
    const shown = formatValue(value);
    return { name, value: shown.value, type: shown.type, variablesReference: this.reference(value) };
  }

  // --- Wire ----------------------------------------------------------------------

  private event(event: string, body: unknown): void {
    this.emit({ seq: this.seq++, type: "event", event, body });
  }

  private respond(request: DapRequest, success: boolean, body?: unknown, message?: string): void {
    this.emit({
      seq: this.seq++, type: "response", request_seq: request.seq, command: request.command, success,
      ...(body !== undefined ? { body } : {}),
      ...(message !== undefined ? { message, body: { error: { id: 1, format: message, showUser: true } } } : {})
    });
  }
}
