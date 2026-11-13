// src/engine/sourceRoots.ts: where require("a.b") looks, and how chunk names
// map to files. Run against a table instead of a file system.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { SourceRoots, chunkName, chunkFile, moduleSegments } = require("../out/engine/sourceRoots.js");

const R = p => path.resolve(p);
/** The engine reports a drive letter in lower case (chunkName / chunkFile). */
const lowerDrive = f => f.replace(/^[A-Z]:/, m => m.toLowerCase());
/** A roots object over a set of "existing" files (given as absolute-ish paths). */
function over(roots, existing) {
  const set = new Set(existing.map(R));
  const probed = [];
  const sr = new SourceRoots(roots, { isFile: f => { probed.push(f); return set.has(f); } });
  return { sr, probed };
}

test("a dotted name is a path: a.b -> a/b.lua", () => {
  const { sr } = over(["/p"], ["/p/a/b.lua"]);
  assert.equal(sr.resolve("a.b"), R("/p/a/b.lua"));
  assert.equal(sr.resolve("a"), null);
  assert.equal(sr.resolve("b"), null);
});

test("a plain name finds name.lua", () => {
  const { sr } = over(["/p"], ["/p/util.lua"]);
  assert.equal(sr.resolve("util"), R("/p/util.lua"));
});

test("a directory with init.lua is found by the directory's name", () => {
  const { sr } = over(["/p"], ["/p/pkg/init.lua", "/p/pkg/sub/init.lua"]);
  assert.equal(sr.resolve("pkg"), R("/p/pkg/init.lua"));
  assert.equal(sr.resolve("pkg.sub"), R("/p/pkg/sub/init.lua"));
});

test(".luah is a hidden Lua file and is found", () => {
  const { sr } = over(["/p"], ["/p/secret.luah", "/p/dir/inner.luah"]);
  assert.equal(sr.resolve("secret"), R("/p/secret.luah"));
  assert.equal(sr.resolve("dir.inner"), R("/p/dir/inner.luah"));
});

test("within one root: name.lua beats name/init.lua beats name.luah", () => {
  const all = ["/p/m.lua", "/p/m/init.lua", "/p/m.luah"];
  assert.equal(over(["/p"], all).sr.resolve("m"), R("/p/m.lua"));
  assert.equal(over(["/p"], all.slice(1)).sr.resolve("m"), R("/p/m/init.lua"));
  assert.equal(over(["/p"], all.slice(2)).sr.resolve("m"), R("/p/m.luah"));
});

test("an earlier root wins over a later one, even for a lower-priority spelling", () => {
  const { sr } = over(["/project", "/lib"], ["/lib/m.lua", "/project/m.luah", "/lib/only.lua"]);
  assert.equal(sr.resolve("m"), R("/project/m.luah"));
  assert.equal(sr.resolve("only"), R("/lib/only.lua"), "falls through to the later root");
});

test("a root listed twice is probed once; list() keeps first-seen order", () => {
  const { sr, probed } = over(["/a", "/b", "/a", "/a/../a", "/b/"], []);
  assert.deepEqual(sr.list(), [R("/a"), R("/b")]);
  assert.equal(sr.resolve("zzz"), null);
  assert.equal(probed.length, 3 * 2, "three candidates in each of the two distinct roots");
});

test("relative roots are made absolute", () => {
  const { sr } = over(["rel/dir"], []);
  assert.deepEqual(sr.list(), [path.resolve("rel/dir")]);
});

test("names that could leave the roots are refused without touching the file system", () => {
  const bad = [
    "a/b", "a\\b", "/etc/passwd", "../x", "a/../b", "..", ".", "a..b.", "a.", ".a", "a..b",
    "", "C:\\x", "c:x", "a:b", "a\0b", "a.b/c", "a.\\b"
  ];
  const { sr, probed } = over(["/p"], ["/p/a/b.lua", "/x.lua", "/p/b.lua"]);
  for (const name of bad) assert.equal(sr.resolve(name), null, JSON.stringify(name));
  assert.deepEqual(probed, [], "never even probed");
});

test("moduleSegments splits on dots and enforces the length cap", () => {
  assert.deepEqual(moduleSegments("a.b.c"), ["a", "b", "c"]);
  assert.deepEqual(moduleSegments("PhySim"), ["PhySim"]);
  assert.equal(moduleSegments("x".repeat(512))?.length, 1);
  assert.equal(moduleSegments("x".repeat(513)), null);
  assert.equal(moduleSegments("a b")?.[0], "a b", "spaces are legal file name characters");
});

test("chunkName is @-prefixed and forward-slashed", () => {
  assert.equal(chunkName("/p/main.lua"), "@/p/main.lua");
  // The drive letter is folded to lower case, so a breakpoint path from VSCode
  // ("C:" or "c:", depending on where it came from) names the loaded chunk.
  assert.equal(chunkName("C:\\proj\\lib\\m.lua"), "@c:/proj/lib/m.lua");
  assert.equal(chunkName("c:\\proj\\lib\\m.lua"), "@c:/proj/lib/m.lua");
  assert.equal(chunkName("a\\\\b"), "@a//b");
});

test("chunkFile maps a file chunk back, and is null for non-files", () => {
  const file = path.resolve("/p/dir/main.lua");
  assert.equal(chunkFile(chunkName(file)), lowerDrive(path.normalize(file)));
  assert.equal(chunkFile("@physim:prelude"), null, "the built-in prelude is not a file");
  assert.equal(chunkFile("@physim:anything"), null);
  assert.equal(chunkFile("=stdin"), null);
  assert.equal(chunkFile("print('x')"), null);
  assert.equal(chunkFile(""), null);
  assert.notEqual(chunkFile("@physimfoo/x.lua"), null, "only the exact @physim: prefix is reserved");
});

test("chunkName/chunkFile round trip, including backslashes", () => {
  // Backslashes are the Windows separator; chunkName forward-slashes them and
  // chunkFile normalises back to the platform's own.
  const files = [path.resolve("/p/a.lua"), path.resolve("/p/with space/b.lua"), path.join("rel", "c.lua")];
  for (const f of files) assert.equal(chunkFile(chunkName(f)), lowerDrive(path.normalize(f)), f);
  const win = "C:\\proj\\src\\main.lua";
  const back = chunkFile(chunkName(win));
  assert.equal(back, path.normalize("c:/proj/src/main.lua"));
  if (path.sep === "\\") assert.equal(back, lowerDrive(win));
  assert.ok(!chunkName(win).includes("\\"));
});
