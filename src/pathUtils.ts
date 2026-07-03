import * as path from "path";

/**
 * Canonicalise a filesystem path for equality comparison on Windows:
 * resolve, lower-case, forward slashes, no trailing slash.
 *
 * Shared by debugConfigPatcher (dedup of config.arg entries) and
 * libraryPathInjector (dedup of libraryPaths settings entries).
 */
export function normalize(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}
