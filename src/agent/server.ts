// The PhySim MCP server: `node out/agent/server.js`, speaking the Model
// Context Protocol on stdin/stdout. An AI agent's client starts it as a child
// process; it has no window and needs no VSCode.
//
// stdout carries protocol lines and nothing else — one stray print there and
// the client stops understanding the server. Anything for a person goes to
// stderr.

import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import { createInterface } from "readline";
import { runBuild } from "../buildRunner";
import { loadEngine } from "../engine/loadEngine";
import { AgentSession } from "./agentSession";
import { McpServer } from "./mcp";
import { MirrorClient } from "./mirrorClient";
import { SERVER_INSTRUCTIONS, createTools } from "./tools";

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function isDirectory(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** Follows every link in the part of `file` that exists, and appends the part that does not. */
function realPath(file: string): string {
  const rest: string[] = [];
  for (let p = path.resolve(file); ;) {
    try {
      return path.join(realpathSync(p), ...rest);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return path.join(p, ...rest);
      rest.unshift(path.basename(p));
      p = parent;
    }
  }
}

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  // out/agent/server.js → the extension's root.
  const root = path.resolve(__dirname, "..", "..");
  const engine = await loadEngine();
  const session = new AgentSession(engine, { isFile, read: f => readFileSync(f) });
  const version = packageVersion(root);
  // A PhySim window with the script's folder open is shown what the agent
  // runs (mirrorClient.ts). PHYSIM_MIRROR=0 in the server's environment keeps
  // the server from looking for one.
  const mirror = process.env.PHYSIM_MIRROR === "0" ? null : new MirrorClient(session, { serverVersion: version });
  const server = new McpServer(
    { name: "physim", version, instructions: SERVER_INSTRUCTIONS },
    createTools({
      session,
      cwd: process.cwd(),
      bundledLua: path.join(root, "lua"),
      files: { isFile, isDirectory, readText: f => readFileSync(f, "utf8") },
      build: runBuild,
      realPath,
      home: homedir(),
      writeText: (file, text) => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      }
    }),
    // Tools that only read change nothing a window could show; neither does a build.
    tool => { if (!tool.annotations?.readOnlyHint && tool.name !== "build_script") mirror?.publish(tool.name); }
  );

  // One request at a time, in arrival order: the tools share one script run.
  let queue: Promise<void> = Promise.resolve();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", line => {
    queue = queue.then(async () => {
      const reply = await server.handleLine(line);
      if (reply !== null) process.stdout.write(reply + "\n");
    }).catch(err => {
      process.stderr.write(`physim-mcp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    });
  });
  // The client closing stdin is how a stdio server is told to stop.
  lines.on("close", () => {
    void queue.then(() => { mirror?.dispose(); session.dispose(); process.exit(0); });
  });
}

main().catch(err => {
  process.stderr.write(`physim-mcp: could not start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
