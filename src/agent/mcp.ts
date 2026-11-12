// The Model Context Protocol, as much of it as a tools-only server over stdio
// needs: JSON-RPC 2.0 messages, one per line, with `initialize`, `ping`,
// `tools/list` and `tools/call`. Written out here rather than taken from the
// SDK so the extension ships no dependency for it; test/mcpServer.test.mjs
// drives it with the official client to keep it honest.
//
// No vscode import and no process globals: `handleLine` takes a line and
// returns the line to answer with, so the tests need no child process.

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  /** Base64, for an image. */
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint and friends). */
  annotations?: Record<string, unknown>;
  call(args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Shown to the model by clients that pass server instructions on. */
  instructions?: string;
}

/** Newest first. The server answers with the client's version when it knows it, else its newest. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;

interface RpcError { code: number; message: string }

class RpcFailure extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * @param afterCall told of every tool call once it has returned or thrown —
   *   the hook the panel mirror hangs on. What it throws is swallowed.
   */
  constructor(
    private readonly info: ServerInfo,
    tools: readonly ToolDefinition[],
    private readonly afterCall?: (tool: ToolDefinition) => void
  ) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool name ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  /**
   * One line in, one line out — or null when the line needs no answer (a
   * notification, a blank line). Never throws: whatever goes wrong becomes a
   * JSON-RPC error, because a server that dies on bad input takes the agent's
   * whole session with it.
   */
  async handleLine(line: string): Promise<string | null> {
    if (line.trim() === "") return null;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return JSON.stringify(failure(null, { code: PARSE_ERROR, message: "the line is not valid JSON" }));
    }
    if (Array.isArray(message)) {
      // Batches existed in the 2025-03-26 revision only; answering them costs nothing.
      if (message.length === 0) {
        return JSON.stringify(failure(null, { code: INVALID_REQUEST, message: "an empty batch" }));
      }
      const answers = [];
      for (const m of message) {
        const a = await this.handleMessage(m);
        if (a) answers.push(a);
      }
      return answers.length > 0 ? JSON.stringify(answers) : null;
    }
    const answer = await this.handleMessage(message);
    return answer ? JSON.stringify(answer) : null;
  }

  private async handleMessage(message: unknown): Promise<Record<string, unknown> | null> {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return failure(null, { code: INVALID_REQUEST, message: "not a JSON-RPC 2.0 message" });
    }
    // A response to something this server never asked: nothing to do with it.
    if (!("method" in message)) return null;
    const hasId = "id" in message;
    const id = message.id;
    if (hasId && typeof id !== "string" && typeof id !== "number") {
      return failure(null, { code: INVALID_REQUEST, message: "id must be a string or a number" });
    }
    if (typeof message.method !== "string") {
      return hasId ? failure(id as Id, { code: INVALID_REQUEST, message: "method must be a string" }) : null;
    }
    try {
      const result = await this.dispatch(message.method, message.params);
      return hasId ? { jsonrpc: "2.0", id, result } : null;
    } catch (err) {
      if (!hasId) return null;
      if (err instanceof RpcFailure) return failure(id as Id, { code: err.code, message: err.message });
      return failure(id as Id, { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = isObject(params) ? params.protocolVersion : undefined;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          ...(this.info.instructions ? { instructions: this.info.instructions } : {})
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: Array.from(this.tools.values(), t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {})
          }))
        };
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string") {
          throw new RpcFailure(INVALID_PARAMS, "tools/call needs a tool name");
        }
        const tool = this.tools.get(params.name);
        if (!tool) throw new RpcFailure(INVALID_PARAMS, `unknown tool: ${params.name}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(args)) throw new RpcFailure(INVALID_PARAMS, "tool arguments must be an object");
        try {
          return await tool.call(args);
        } catch (err) {
          // A failed tool call is a result the model reads and reacts to, not a protocol error.
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        } finally {
          try { this.afterCall?.(tool); } catch { /* an observer never fails a call */ }
        }
      }
      default:
        if (method.startsWith("notifications/")) return {};
        throw new RpcFailure(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
}

function failure(id: Id, error: RpcError): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error };
}
