// Windows-path canonicalisation used to dedup config.arg entries and
// libraryPaths settings entries.
import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../out/pathUtils.js";

test("backslashes become forward slashes", () => {
  assert.equal(normalize("C:\\foo\\bar"), "c:/foo/bar");
});

test("case-folds for comparison", () => {
  assert.equal(normalize("C:/FOO/Bar"), normalize("c:/foo/bar"));
});

test("trailing separators are equivalent", () => {
  assert.equal(normalize("C:\\foo\\"), normalize("C:\\foo"));
  assert.equal(normalize("C:/foo///"), normalize("C:/foo"));
});

test("mixed separators and dot segments resolve", () => {
  assert.equal(normalize("C:\\foo\\.\\baz\\..\\bar"), "c:/foo/bar");
});
