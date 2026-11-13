// src/agent/project.ts: which script a tool call means and where its
// `require` looks, worked out from the file system instead of from VSCode.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { parseJsonc, findWorkspaceFolder, resolveProject } = require("../out/agent/project.js");

// Absolute on every platform (a drive letter on Windows).
const P = (...parts) => path.resolve(path.sep, ...parts);
const BUNDLED = P("ext", "lua");
/** LifeBoatAPI's git libraries under a workspace folder: always the last root. */
const git = (...ws) => P(...ws, "_build", "libs");

/** A file system that is a table: paths ending in a separator-free name map to text; `dirs` are directories. */
function fs(fileTable, dirs = []) {
  const files = new Map(Object.entries(fileTable).map(([k, v]) => [path.normalize(k), v]));
  const directories = new Set(dirs.map(d => path.normalize(d)));
  for (const f of files.keys()) {
    for (let d = path.dirname(f); ; d = path.dirname(d)) {
      directories.add(d);
      if (path.dirname(d) === d) break;
    }
  }
  return {
    isFile: f => files.has(path.normalize(f)),
    isDirectory: d => directories.has(path.normalize(d)),
    readText: f => {
      if (!files.has(path.normalize(f))) throw new Error(`no such file ${f}`);
      return files.get(path.normalize(f));
    }
  };
}

test("parseJsonc: line comments, block comments and trailing commas", () => {
  assert.deepEqual(parseJsonc(`{
    // a line comment
    "a": 1, /* a block
    comment */ "b": [1, 2, 3,],
    "c": { "d": true, },
  }`), { a: 1, b: [1, 2, 3], c: { d: true } });
  assert.deepEqual(parseJsonc("[1, 2 /* two */, ] // done"), [1, 2]);
});

test("parseJsonc: what looks like a comment or a trailing comma inside a string is text", () => {
  assert.deepEqual(parseJsonc(`{ "url": "http://example.test/a//b", "glob": "/* not a comment */", "list": ",]", "obj": ", }" }`),
    { url: "http://example.test/a//b", glob: "/* not a comment */", list: ",]", obj: ", }" });
});

test("parseJsonc: escaped quotes and backslashes do not end a string early", () => {
  assert.deepEqual(parseJsonc(String.raw`{ "a": "say \"hi\" // still text", "b": "D:\\Lib\\", "c": 1, }`),
    { a: 'say "hi" // still text', b: "D:\\Lib\\", c: 1 });
});

test("parseJsonc: a BOM is ignored, plain JSON passes through, bad JSON throws", () => {
  assert.deepEqual(parseJsonc('\uFEFF{ "a": 1 }'), { a: 1 });
  assert.deepEqual(parseJsonc('{"a":[1,{"b":null}]}'), { a: [1, { b: null }] });
  assert.equal(parseJsonc(" 42 "), 42);
  assert.throws(() => parseJsonc("{ a: 1 }"), SyntaxError);
  assert.throws(() => parseJsonc('{ "a": 1 /* never closed'), SyntaxError);
  assert.throws(() => parseJsonc(""), SyntaxError);
});

test("findWorkspaceFolder: the nearest folder holding .git or a project's .vscode, the start itself included", () => {
  const files = fs({ [P("repo", "proj", ".vscode", "settings.json")]: "{}" }, [P("repo", ".git"), P("repo", "proj", "src", "deep")]);
  assert.equal(findWorkspaceFolder(P("repo", "proj", "src", "deep"), files), P("repo", "proj"));
  assert.equal(findWorkspaceFolder(P("repo", "proj"), files), P("repo", "proj"));
  assert.equal(findWorkspaceFolder(P("repo", "other"), files), P("repo"));
});

test("findWorkspaceFolder: any of VSCode's project files marks a .vscode folder; .git may be a file", () => {
  for (const name of ["settings.json", "launch.json", "tasks.json", "extensions.json"]) {
    const files = fs({ [P("a", ".vscode", name)]: "{}" }, [P("a", "b")]);
    assert.equal(findWorkspaceFolder(P("a", "b"), files), P("a"), name);
  }
  // A worktree or submodule: `.git` is a file pointing at the real directory.
  assert.equal(findWorkspaceFolder(P("w", "src"), fs({ [P("w", ".git")]: "gitdir: elsewhere" }, [P("w", "src")])), P("w"));
});

test("findWorkspaceFolder: with no marker anywhere, the start folder", () => {
  assert.equal(findWorkspaceFolder(P("a", "b", "c"), fs({}, [P("a", "b", "c")])), P("a", "b", "c"));
});

test("a bare .vscode folder is not a marker: VSCode keeps one in every home directory", () => {
  // ~/.vscode holds extensions/ and argv.json, never a project's settings.
  const files = fs({ [P("home", "me", ".vscode", "argv.json")]: "{}" }, [P("home", "me", ".vscode", "extensions"), P("home", "me", "docs", "proj")]);
  assert.equal(findWorkspaceFolder(P("home", "me", "docs", "proj"), files), P("home", "me", "docs", "proj"));
});

test("the walk never settles on the home directory or above it, whatever is there", () => {
  const files = fs({ [P("home", "me", ".vscode", "settings.json")]: "{}" }, [P("home", ".git"), P("home", "me", "docs", "proj")]);
  const home = P("home", "me");
  assert.equal(findWorkspaceFolder(P("home", "me", "docs", "proj"), files, home), P("home", "me", "docs", "proj"));
  assert.equal(findWorkspaceFolder(home, files, home), home, "a script in the home directory itself gets that directory, as the start folder");
  assert.equal(findWorkspaceFolder(P("home", "me", "docs", "proj"), files), P("home", "me"), "without a home to stop at, the marker counts");
  // A project below home is still found.
  const project = fs({ [P("home", "me", "p", ".vscode", "settings.json")]: "{}" }, [P("home", "me", "p", "src")]);
  assert.equal(findWorkspaceFolder(P("home", "me", "p", "src"), project, home), P("home", "me", "p"));
});

test("a .vscode that is a file, not a folder, is not a marker", () => {
  const files = fs({ [P("a", "b", ".vscode")]: "" }, [P("a", ".git")]);
  assert.equal(findWorkspaceFolder(P("a", "b"), files), P("a"));
});

test("resolveProject passes the home directory on to the walk", () => {
  const files = fs({ [P("home", "me", ".vscode", "settings.json")]: '{ "physim.libraryPaths": ["everything"] }', [P("home", "me", "x", "main.lua")]: "" });
  const project = resolveProject({ cwd: P("home", "me", "x"), bundledLua: BUNDLED, script: "main.lua", home: P("home", "me") }, files);
  assert.equal(project.workspaceFolder, P("home", "me", "x"));
  assert.deepEqual(project.roots, [P("home", "me", "x"), BUNDLED, git("home", "me", "x")], "the home directory's settings are not this project's");
});

const base = { cwd: P("ws"), bundledLua: BUNDLED };

test("the script is resolved from cwd and must be an existing .lua file", () => {
  const files = fs({ [P("ws", "src", "main.lua")]: "", [P("ws", "notes.txt")]: "", [P("ws", "UPPER.LUA")]: "" });
  assert.equal(resolveProject({ ...base, script: path.join("src", "main.lua") }, files).entry, P("ws", "src", "main.lua"));
  assert.equal(resolveProject({ ...base, script: P("ws", "src", "main.lua") }, files).entry, P("ws", "src", "main.lua"));
  assert.equal(resolveProject({ ...base, script: "UPPER.LUA" }, files).entry, P("ws", "UPPER.LUA"));
  assert.throws(() => resolveProject({ ...base, script: "notes.txt" }, files), /must be a \.lua file/);
  assert.throws(() => resolveProject({ ...base, script: "missing.lua" }, files), /there is no file/);
  assert.throws(() => resolveProject({ ...base, script: "src" }, files), /must be a \.lua file/);
});

test("with no marker and no settings: the script's folder, then PhySim's own lua/", () => {
  const files = fs({ [P("ws", "src", "main.lua")]: "" });
  const project = resolveProject({ ...base, script: path.join("src", "main.lua") }, files);
  assert.equal(project.workspaceFolder, P("ws", "src"));
  assert.deepEqual(project.roots, [P("ws", "src"), BUNDLED, git("ws", "src")]);
  assert.equal(project.settingsFile, undefined);
  assert.equal(project.settingsProblem, undefined);
});

test("an explicit workspaceFolder wins over the walk, and must be a directory", () => {
  const files = fs({ [P("ws", "src", "main.lua")]: "" }, [P("ws", ".git"), P("elsewhere")]);
  assert.equal(resolveProject({ ...base, script: path.join("src", "main.lua") }, files).workspaceFolder, P("ws"));
  const explicit = resolveProject({ ...base, script: path.join("src", "main.lua"), workspaceFolder: path.join("..", "elsewhere") }, files);
  assert.equal(explicit.workspaceFolder, P("elsewhere"));
  assert.equal(explicit.roots[0], P("elsewhere"));
  assert.throws(() => resolveProject({ ...base, script: path.join("src", "main.lua"), workspaceFolder: "nope" }, files), /not a directory/);
});

test("root order: workspace, the caller's paths, physim.libraryPaths, bundled lua/, then the legacy setting", () => {
  const files = fs({
    [P("ws", "proj", "main.lua")]: "",
    [P("ws", "proj", ".vscode", "settings.json")]: `{
      // written by VSCode, comments and all
      "physim.libraryPaths": ["libs", "${P("abs", "lib").replace(/\\/g, "\\\\")}", 5, null],
      "lifeboatapi.stormworks.libs.libraryPaths": ["old", {}, "${P("ext-1.0.0", "lua").replace(/\\/g, "\\\\")}"],
    }`
  });
  const project = resolveProject({ ...base, script: path.join("proj", "main.lua"), libraryPaths: ["mine", P("shared")] }, files);
  assert.equal(project.workspaceFolder, P("ws", "proj"));
  assert.equal(project.settingsFile, P("ws", "proj", ".vscode", "settings.json"));
  assert.deepEqual(project.roots, [
    P("ws", "proj"),
    P("ws", "mine"),            // the caller's, from cwd
    P("shared"),
    P("ws", "proj", "libs"),    // the settings', from the workspace folder
    P("abs", "lib"),
    BUNDLED,
    P("ws", "proj", "old"),
    P("ext-1.0.0", "lua"),
    git("ws", "proj")
  ]);
});

test("a settings file that does not parse is reported and otherwise ignored", () => {
  const files = fs({ [P("ws", "main.lua")]: "", [P("ws", ".vscode", "settings.json")]: "{ this is not json" });
  const project = resolveProject({ ...base, script: "main.lua" }, files);
  assert.equal(typeof project.settingsProblem, "string");
  assert.ok(project.settingsProblem.length > 0);
  assert.deepEqual(project.roots, [P("ws"), BUNDLED, git("ws")]);
});

test("settings that are not an object, or lists that are not arrays, contribute nothing", () => {
  for (const text of ["[1, 2]", '"text"', '{ "physim.libraryPaths": "libs", "lifeboatapi.stormworks.libs.libraryPaths": 3 }']) {
    const files = fs({ [P("ws", "main.lua")]: "", [P("ws", ".vscode", "settings.json")]: text });
    const project = resolveProject({ ...base, script: "main.lua" }, files);
    assert.deepEqual(project.roots, [P("ws"), BUNDLED, git("ws")], text);
    assert.equal(project.settingsProblem, undefined);
  }
});
