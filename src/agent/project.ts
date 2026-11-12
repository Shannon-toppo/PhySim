// Which file an AI tool call means and where its `require` looks, worked out
// without VSCode. Pure apart from the file system passed in.
//
// "PhySim: Run" asks VSCode for the workspace folder and the settings. The MCP
// server has neither, so it finds the folder by walking up from the script and
// reads `.vscode/settings.json` itself — the same two settings, through the
// same `requireRoots`, so a script resolves its modules the same way under an
// agent as under F6. (User-level settings are out of reach here; the tool's
// `libraryPaths` argument covers them.)

import * as path from "path";
import { requireRoots } from "../runTarget";

export interface ProjectFiles {
  isFile(file: string): boolean;
  isDirectory(dir: string): boolean;
  readText(file: string): string;
}

export interface ProjectRequest {
  /** The script, absolute or relative to `cwd`. */
  script: string;
  cwd: string;
  /** Overrides the folder found by walking up. Absolute or relative to `cwd`. */
  workspaceFolder?: string;
  /** Extra `require` folders, searched before the settings' own. */
  libraryPaths?: readonly string[];
  /** The extension's lua/ directory (PhySim.lua). */
  bundledLua: string;
  /** The user's home directory: the walk never settles on it or goes above it. */
  home?: string;
}

export interface Project {
  entry: string;
  workspaceFolder: string;
  roots: string[];
  /** Settings file that was read, if there was one. */
  settingsFile?: string;
  /** Why the settings file could not be used, when it exists but does not parse. */
  settingsProblem?: string;
}

/**
 * JSON with comments and trailing commas, as VSCode writes its settings.
 * Comments are blanked rather than cut, strings are left alone.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  // A comma followed only by white space and a closing bracket. Strings were
  // copied whole above, but may still contain ",]" — so walk again, skipping them.
  let clean = "";
  for (i = 0; i < out.length;) {
    const c = out[i];
    if (c === '"') {
      const start = i++;
      while (i < out.length && out[i] !== '"') i += out[i] === "\\" ? 2 : 1;
      clean += out.slice(start, ++i);
    } else if (c === "," && /^\s*[}\]]/.test(out.slice(i + 1))) {
      i++;
    } else {
      clean += c;
      i++;
    }
  }
  return JSON.parse(clean.charCodeAt(0) === 0xfeff ? clean.slice(1) : clean);
}

/** Files that make a `.vscode` folder a project's and not just a folder VSCode happens to keep. */
const VSCODE_PROJECT_FILES = ["settings.json", "launch.json", "tasks.json", "extensions.json"];

function isProjectRoot(dir: string, files: ProjectFiles): boolean {
  // In a git worktree or submodule `.git` is a file.
  const git = path.join(dir, ".git");
  if (files.isDirectory(git) || files.isFile(git)) return true;
  return VSCODE_PROJECT_FILES.some(f => files.isFile(path.join(dir, ".vscode", f)));
}

/**
 * The nearest folder at or above `dir` that looks like a project root; `dir`
 * itself when none does.
 *
 * A bare `.vscode` folder is not a sign of one: VSCode keeps its extensions in
 * `~/.vscode`, so on any machine with VSCode the home directory has one, and a
 * script outside any project would get the whole home directory as its
 * workspace — its `require` roots, and the boundary `build_script` writes
 * inside. For the same reason the walk stops below `home` whatever is there.
 */
export function findWorkspaceFolder(dir: string, files: ProjectFiles, home?: string): string {
  const stop = home === undefined ? undefined : path.resolve(home);
  for (let d = dir; ;) {
    if (stop !== undefined && path.resolve(d) === stop) return dir;
    if (isProjectRoot(d, files)) return d;
    const parent = path.dirname(d);
    if (parent === d) return dir;
    d = parent;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function resolveProject(request: ProjectRequest, files: ProjectFiles): Project {
  const entry = path.resolve(request.cwd, request.script);
  if (path.extname(entry).toLowerCase() !== ".lua") throw new Error(`the script must be a .lua file: ${entry}`);
  if (!files.isFile(entry)) throw new Error(`there is no file ${entry}`);

  let workspaceFolder: string;
  if (request.workspaceFolder !== undefined) {
    workspaceFolder = path.resolve(request.cwd, request.workspaceFolder);
    if (!files.isDirectory(workspaceFolder)) throw new Error(`workspaceFolder is not a directory: ${workspaceFolder}`);
  } else {
    workspaceFolder = findWorkspaceFolder(path.dirname(entry), files, request.home);
  }

  const project: Project = { entry, workspaceFolder, roots: [] };
  let settings: Record<string, unknown> = {};
  const settingsFile = path.join(workspaceFolder, ".vscode", "settings.json");
  if (files.isFile(settingsFile)) {
    project.settingsFile = settingsFile;
    try {
      const parsed = parseJsonc(files.readText(settingsFile));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch (err) {
      project.settingsProblem = err instanceof Error ? err.message : String(err);
    }
  }

  project.roots = requireRoots({
    file: entry,
    workspaceFolder,
    libraryPaths: [
      // The caller's paths are relative to where the caller is, not to the workspace.
      ...(request.libraryPaths ?? []).map(p => path.resolve(request.cwd, p)),
      ...stringList(settings["physim.libraryPaths"])
    ],
    legacyLibraryPaths: stringList(settings["lifeboatapi.stormworks.libs.libraryPaths"]),
    bundledLua: request.bundledLua
  });
  return project;
}
