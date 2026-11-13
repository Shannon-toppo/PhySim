// src/runTarget.ts: the directories `require` searches, in precedence order.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { requireRoots } = require("../out/runTarget.js");

const P = (...s) => path.resolve("/", ...s);
const BUNDLED = P("ext", "lua");
// Where LifeBoatAPI keeps git libraries: always searched, and always last.
const GIT = P("ws", "_build", "libs");
const GIT_SRC = P("ws", "src", "_build", "libs");

function roots(over = {}) {
  return requireRoots({
    file: P("ws", "src", "main.lua"),
    workspaceFolder: P("ws"),
    libraryPaths: [],
    legacyLibraryPaths: [],
    bundledLua: BUNDLED,
    ...over
  });
}

test("the project comes first, then PhySim's own lua/, then LifeBoatAPI's git libraries", () => {
  assert.deepEqual(roots(), [P("ws"), BUNDLED, GIT]);
});

test("without a workspace folder the script's own directory is the project", () => {
  assert.deepEqual(roots({ workspaceFolder: undefined }), [P("ws", "src"), BUNDLED, GIT_SRC]);
});

test("the workspace folder, not the script's directory, is the base when there is one", () => {
  assert.ok(!roots().includes(P("ws", "src")));
});

test("library paths follow the project in order; relative ones resolve from the base", () => {
  assert.deepEqual(
    roots({ libraryPaths: ["libs", "../shared", P("abs", "lib")] }),
    [P("ws"), P("ws", "libs"), P("shared"), P("abs", "lib"), BUNDLED, GIT]);
});

test("relative library paths resolve from the script's directory when there is no workspace", () => {
  assert.deepEqual(roots({ workspaceFolder: undefined, libraryPaths: ["lib"] }),
    [P("ws", "src"), P("ws", "src", "lib"), BUNDLED, GIT_SRC]);
});

test("physim.libraryPaths, then the bundled directory, then the legacy LifeBoatAPI setting", () => {
  assert.deepEqual(
    roots({ libraryPaths: ["new"], legacyLibraryPaths: ["old1", "old2"] }),
    [P("ws"), P("ws", "new"), BUNDLED, P("ws", "old1"), P("ws", "old2"), GIT]);
});

test("a 1.x PhySim.lua left in the legacy setting cannot hide the bundled one", () => {
  // 1.x wrote its own lua/ directory into LifeBoatAPI's setting.
  const old = P("home", ".vscode", "extensions", "shannon-toppo.physim-1.0.0", "lua");
  const r = roots({ legacyLibraryPaths: [old] });
  assert.ok(r.indexOf(BUNDLED) < r.indexOf(old));
});

test("entries that are not non-blank strings are skipped, the rest are trimmed", () => {
  assert.deepEqual(
    roots({ libraryPaths: ["", "   ", null, undefined, 5, {}, ["x"], true, "  libs  "], legacyLibraryPaths: ["\t", "ok\n"] }),
    [P("ws"), P("ws", "libs"), BUNDLED, P("ws", "ok"), GIT]);
});

test("duplicates are dropped, the earliest position wins", () => {
  assert.deepEqual(
    roots({ libraryPaths: [".", "libs", "./libs", "../ws/libs", "libs/../libs"], legacyLibraryPaths: ["libs", "other"] }),
    [P("ws"), P("ws", "libs"), BUNDLED, P("ws", "other"), GIT]);
});

test("a library path equal to the bundled directory does not search it twice", () => {
  assert.deepEqual(roots({ libraryPaths: [BUNDLED] }), [P("ws"), BUNDLED, GIT]);
});

test("a project can shadow a library, and a library can shadow PhySim.lua", () => {
  const r = roots({ libraryPaths: ["libs"] });
  assert.ok(r.indexOf(P("ws")) < r.indexOf(P("ws", "libs")));
  assert.ok(r.indexOf(P("ws", "libs")) < r.indexOf(BUNDLED));
});

test("the input is not mutated", () => {
  const libraryPaths = ["a", "a"];
  roots({ libraryPaths });
  assert.deepEqual(libraryPaths, ["a", "a"]);
});

test("_build/libs under the project is searched last, so LifeBoatAPI's own library is found without a setting", () => {
  const r = roots({ libraryPaths: ["libs"], legacyLibraryPaths: ["old"] });
  assert.equal(r.at(-1), GIT);
  assert.deepEqual(r, [P("ws"), P("ws", "libs"), BUNDLED, P("ws", "old"), GIT]);
});

test("naming _build/libs in a setting as well does not search it twice, and keeps the earlier position", () => {
  assert.deepEqual(roots({ libraryPaths: ["_build/libs"] }), [P("ws"), GIT, BUNDLED]);
});
