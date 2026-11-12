// Where `require("a.b")` finds its source. Pure module: the file system is
// passed in, so the tests run it against a table.
//
// The naming rule is LifeBoatAPI's (its SimulatorSandbox indexes every file
// under each root directory): dots are directory separators, `init.lua` names
// its directory, `.luah` is a "hidden" Lua file, and an earlier root wins.
// Unlike LifeBoatAPI this looks the candidates up on demand instead of walking
// every root at start-up, so a file added between runs is found without any
// index to refresh.

import * as path from "path";

export interface FileProbe {
  /** True only for a regular file. */
  isFile(file: string): boolean;
}

/** `@`-prefixed, forward-slashed: the name a chunk carries in errors, logs and breakpoints. */
export function chunkName(file: string): string {
  // The drive letter is folded to lower case: VSCode spells it either way
  // depending on where the path came from, and a breakpoint only binds when
  // its chunk name is byte-for-byte the one the file was loaded under.
  return "@" + file.replace(/\\/g, "/").replace(/^[A-Z]:/, d => d.toLowerCase());
}

/** The file a chunk name stands for, or null for a chunk that isn't a file (the built-in prelude). */
export function chunkFile(chunk: string): string | null {
  if (!chunk.startsWith("@") || chunk.startsWith("@physim:")) return null;
  return path.normalize(chunk.slice(1));
}

/**
 * A module name is a dotted list of plain segments. Anything else — a slash,
 * an empty or `..` segment, a drive letter — is refused rather than resolved:
 * `require` must not become a way to read files outside the root directories.
 */
export function moduleSegments(name: string): string[] | null {
  if (name.length === 0 || name.length > 512) return null;
  const segments = name.split(".");
  for (const s of segments) {
    if (s.length === 0 || /[\\/:\0]/.test(s)) return null;
  }
  return segments;
}

export class SourceRoots {
  private readonly roots: string[];

  constructor(roots: readonly string[], private readonly probe: FileProbe) {
    // Order is precedence; a directory listed twice is only searched once.
    const seen = new Set<string>();
    this.roots = [];
    for (const r of roots) {
      const abs = path.resolve(r);
      if (seen.has(abs)) continue;
      seen.add(abs);
      this.roots.push(abs);
    }
  }

  list(): readonly string[] { return this.roots; }

  /** Absolute path of the file `require(name)` loads, or null. */
  resolve(name: string): string | null {
    const segments = moduleSegments(name);
    if (!segments) return null;
    const rel = path.join(...segments);
    for (const root of this.roots) {
      for (const candidate of [`${rel}.lua`, path.join(rel, "init.lua"), `${rel}.luah`]) {
        const file = path.join(root, candidate);
        if (this.probe.isFile(file)) return file;
      }
    }
    return null;
  }
}
