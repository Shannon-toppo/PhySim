// Which script "PhySim: Run" runs, and where its `require` looks. Pure module
// (no vscode): the caller passes in what it read from the editor and settings.

import * as path from "path";

/** Where LifeBoatAPI puts git libraries, relative to the workspace folder. */
export const LIFEBOAT_GIT_LIBS = path.join("_build", "libs");

export interface RunTargetInput {
  /** The file to run: the active editor's document. */
  file: string;
  /** The workspace folder containing it, if any. */
  workspaceFolder: string | undefined;
  /** `physim.libraryPaths`. Relative entries are taken from the workspace folder. */
  libraryPaths: readonly unknown[];
  /**
   * `lifeboatapi.stormworks.libs.libraryPaths`, when the workspace still has
   * it from LifeBoatAPI days. Read as plain settings data so a project set up
   * there keeps finding its libraries; LifeBoatAPI itself is not involved.
   */
  legacyLibraryPaths: readonly unknown[];
  /** The extension's own lua/ directory (PhySim.lua). */
  bundledLua: string;
}

/**
 * Directories `require` searches, in precedence order: the project first, then
 * `physim.libraryPaths`, then PhySim's own module, then the legacy LifeBoatAPI
 * setting — so a project can shadow a library file, and nothing can
 * accidentally shadow the project.
 *
 * The legacy setting comes after the bundled directory on purpose. PhySim 1.x
 * wrote its own `lua/` directory into that setting (autoInjectLibraryPath), so
 * a workspace that ever ran 1.x still lists a 1.x PhySim.lua there — the
 * socket version, which defines no `PhySim` here. Searched first, it would
 * hide the bundled module from every such project.
 *
 * Last comes `_build/libs` under the project, where LifeBoatAPI keeps the
 * libraries it fetches with git — its own Lua library among them. LifeBoatAPI
 * always searched it (and last, as here), so a project set up there already
 * has `require("LifeBoatAPI")` working and should not need a setting to keep it.
 */
export function requireRoots(input: RunTargetInput): string[] {
  const base = input.workspaceFolder ?? path.dirname(input.file);
  const roots = [base];
  const add = (list: readonly unknown[]): void => {
    for (const raw of list) {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      roots.push(path.resolve(base, raw.trim()));
    }
  };
  add(input.libraryPaths);
  roots.push(input.bundledLua);
  add(input.legacyLibraryPaths);
  roots.push(path.join(base, LIFEBOAT_GIT_LIBS));
  return Array.from(new Set(roots.map(r => path.normalize(r))));
}
