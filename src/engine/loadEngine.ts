// Loads Storm Lua Engine's runtime. The package is ESM-only and this code is
// compiled to CommonJS, hence the dynamic import (kept as a real `import()` by
// tsconfig's Node16 module setting). The WASM is read from disk and handed
// over: a fetch of a file: URL is not something every Node the extension host
// ships with can do.

import { readFileSync } from "fs";
import type { LuaEngine } from "@stormcat-works/storm-lua-engine" with { "resolution-mode": "import" };

const RUNTIME_WASM = "@stormcat-works/storm-lua-engine/wasm/storm_lua_wasm.wasm";

let loading: Promise<LuaEngine> | null = null;

/** One engine per thread; VMs created from it are independent of each other. */
export function loadEngine(): Promise<LuaEngine> {
  loading ??= (async () => {
    const { loadRuntime } = await import("@stormcat-works/storm-lua-engine");
    return loadRuntime({ wasmBinary: readFileSync(require.resolve(RUNTIME_WASM)) });
  })();
  return loading;
}
