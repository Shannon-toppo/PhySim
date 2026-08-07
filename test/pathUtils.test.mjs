// Path canonicalisation used to dedup config.arg entries and libraryPaths
// settings entries.
//
// normalize() delegates to path.resolve, which is platform-specific: "C:\foo"
// is only an absolute path on Windows, and "\" is an ordinary filename
// character on POSIX. So the drive-letter/backslash cases can only be asserted
// on win32 — on macOS/Linux path.resolve prepends process.cwd() and the old
// hardcoded expectations failed. Inputs are therefore built from the host
// platform, and the platform-neutral properties are asserted by comparing
// normalize() against normalize() instead of against a literal.
import test from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../out/pathUtils.js";

const isWindows = process.platform === "win32";

/** An absolute path on the host platform, in that platform's native form. */
const ABS = isWindows ? "C:\\foo\\bar" : "/foo/bar";

const winOnly = isWindows
  ? false
  : "drive letters and backslash separators are Windows-only";

test("canonical form is absolute, forward-slashed and lower-cased", () => {
  assert.equal(normalize(ABS), isWindows ? "c:/foo/bar" : "/foo/bar");
});

test("backslashes become forward slashes", { skip: winOnly }, () => {
  assert.equal(normalize("C:\\foo\\bar"), "c:/foo/bar");
});

test("case-folds for comparison", () => {
  assert.equal(normalize(ABS.toUpperCase()), normalize(ABS.toLowerCase()));
});

test("trailing separators are equivalent", () => {
  assert.equal(normalize(ABS + "/"), normalize(ABS));
  assert.equal(normalize(ABS + "///"), normalize(ABS));
});

test("trailing backslashes are equivalent", { skip: winOnly }, () => {
  assert.equal(normalize("C:\\foo\\"), normalize("C:\\foo"));
});

test("dot segments resolve", () => {
  assert.equal(normalize(`${ABS}/./baz/..`), normalize(ABS));
});

test("mixed separators and dot segments resolve", { skip: winOnly }, () => {
  assert.equal(normalize("C:\\foo\\.\\baz\\..\\bar"), "c:/foo/bar");
});
