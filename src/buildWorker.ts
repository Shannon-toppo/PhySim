// One build per worker. Minifying searches for the smallest output and can
// take seconds; it must not hold up the extension host, and a worker that is
// thrown away afterwards leaves no compiler state to go stale.

import { parentPort, workerData } from "worker_threads";
import { readFileSync, statSync } from "fs";
import * as path from "path";
import { buildScript, BuildOutcome, BuildRequest } from "./build";

const RUNTIME_WASM = "@stormcat-works/storm-lua-engine/wasm/storm_lua_wasm.wasm";

async function main(): Promise<BuildOutcome> {
  const { loadCompiler } = await import("@stormcat-works/storm-lua-engine/compiler");
  // The package exports the runtime's WASM path but not the compiler's; they
  // sit in sibling directories of its dist/.
  const wasm = path.join(path.dirname(require.resolve(RUNTIME_WASM)), "..", "compiler-wasm", "compiler_bg.wasm");
  const compiler = await loadCompiler({ wasmBinary: readFileSync(wasm) });
  return buildScript(compiler, workerData as BuildRequest, {
    isFile: f => { try { return statSync(f).isFile(); } catch { return false; } },
    read: f => readFileSync(f)
  });
}

main().then(
  outcome => parentPort?.postMessage(outcome),
  err => parentPort?.postMessage({
    ok: false, usedFiles: [],
    problems: [{ severity: "error", message: err instanceof Error ? err.message : String(err) }]
  } satisfies BuildOutcome)
);
