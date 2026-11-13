// Turning a development script into the one file that goes into the game:
// link what it `require`s, drop the simulator-only parts, minify.
//
// The work is Storm Lua Engine's compiler (`buildLifeboat`), which keeps
// LifeBoatAPI's conventions: include-once `require`, `---@section` regions
// removed when unused, and `__LB_SIMULATOR_ONLY__` blocks always removed.
// This module only gathers the sources for it. Pure (no vscode, no worker):
// the compiler and the file system are passed in.

import * as path from "path";
import type {
  Compiler, Diagnostic, ProjectCompileResult
} from "@stormcat-works/storm-lua-engine/compiler" with { "resolution-mode": "import" };
import { SourceRoots } from "./engine/sourceRoots";

/** Stormworks refuses a microcontroller script longer than this many characters. */
export const GAME_SCRIPT_LIMIT = 8192;

/** Bound on the files one build may pull in — a runaway include chain fails, it doesn't hang. */
const MAX_MODULES = 1024;

export interface BuildFiles {
  isFile(file: string): boolean;
  read(file: string): Uint8Array;
}

export interface BuildRequest {
  /** Absolute path of the script to build. */
  entry: string;
  /** Directories `require` searches, in precedence order. */
  roots: readonly string[];
  /** false = link and strip only, keeping the code readable. */
  minify: boolean;
}

export interface BuildProblem {
  severity: "error" | "warning" | "info";
  message: string;
  /** The source file the problem is in, when the compiler tied it to a module. */
  file?: string;
  /** 1-based, as the compiler reports them. */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface BuildOutcome {
  ok: boolean;
  /** The script to paste into the game. Present when ok. */
  code?: string;
  /** Characters in `code`, the unit the game's limit is counted in. */
  size?: number;
  /** Characters of the linked source before minifying. */
  originalSize?: number;
  /** Files that ended up in the output, in execution order. */
  usedFiles: string[];
  problems: BuildProblem[];
}

/**
 * Every string literal handed to `require` in the text, by pattern. It also
 * matches inside comments, strings and simulator-only blocks, which is fine:
 * this only decides which files to offer the compiler. A module offered but
 * never really required is left out of the output, and one really required
 * but missing is the compiler's error to report, with its location.
 */
const REQUIRE_RE = /\brequire\s*\(?\s*(["'])([^"'\r\n]+)\1/g;

export function requiredNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(REQUIRE_RE)) names.add(m[2]);
  return Array.from(names);
}

export interface CollectedProject {
  entryKey: string;
  /** Module key (the name `require` uses) → source text. */
  modules: Record<string, string>;
  /** Module key → the file it came from. */
  files: Record<string, string>;
}

const decoder = new TextDecoder("utf-8");

/** The entry and everything reachable from it through literal `require`s. */
export function collectProject(entry: string, roots: readonly string[], files: BuildFiles): CollectedProject {
  const resolver = new SourceRoots(roots, files);
  // A key no `require` can spell (module names never contain a slash), so the
  // entry cannot collide with a module of the same base name.
  const entryKey = `/${path.basename(entry)}`;
  const modules: Record<string, string> = { [entryKey]: decoder.decode(files.read(entry)) };
  const sources: Record<string, string> = { [entryKey]: entry };
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    for (const name of requiredNames(modules[key])) {
      if (name in modules) continue;
      const file = resolver.resolve(name);
      if (!file) continue;
      if (Object.keys(modules).length >= MAX_MODULES) {
        throw new Error(`the build pulls in more than ${MAX_MODULES} files`);
      }
      modules[name] = decoder.decode(files.read(file));
      sources[name] = file;
      queue.push(name);
    }
  }
  return { entryKey, modules, files: sources };
}

function toProblem(d: Diagnostic, project: CollectedProject): BuildProblem {
  return {
    severity: d.severity,
    message: d.message,
    file: d.module !== undefined ? project.files[d.module] : undefined,
    line: d.range?.line,
    column: d.range?.col,
    endLine: d.range?.endLine,
    endColumn: d.range?.endCol
  };
}

export function buildScript(compiler: Compiler, request: BuildRequest, files: BuildFiles): BuildOutcome {
  const project = collectProject(request.entry, request.roots, files);
  const result: ProjectCompileResult = compiler.buildLifeboat(
    { entry: project.entryKey, modules: project.modules },
    // game: the output must run where pcall, print and require do not exist.
    { environment: "game", minify: request.minify }
  );
  const problems = (result.diagnostics ?? []).map(d => toProblem(d, project));
  if (!result.ok || result.code === undefined) {
    if (!problems.some(p => p.severity === "error")) {
      problems.push({ severity: "error", message: result.error ?? "the build failed without a diagnostic" });
    }
    return { ok: false, usedFiles: [], problems };
  }
  // Counted in characters, not bytes: that is how the game counts.
  const size = Array.from(result.code).length;
  if (size > GAME_SCRIPT_LIMIT) {
    problems.push({
      severity: "warning",
      message: `the built script is ${size} characters; Stormworks accepts at most ${GAME_SCRIPT_LIMIT}`
    });
  }
  return {
    ok: true,
    code: result.code,
    size,
    originalSize: result.original,
    usedFiles: (result.usedModules ?? []).map(key => project.files[key]).filter((f): f is string => f !== undefined),
    problems
  };
}
