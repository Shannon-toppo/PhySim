// src/csvLogger.ts — the file half of CSV logging. The interesting cases are
// the ones a plain "append lines" implementation gets wrong: rows arriving
// after the file closed, a row carrying its own newline (which would shift
// every column after it), and a stop that resolves before the bytes are on
// disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CsvLogger, CSV_EOL, sanitizeRows, defaultLogFileName, defaultLogPath
} from "../out/csvLogger.js";
import { CSV_HEADER, createLog, tickRow } from "../media/csv.js";

function tmpFile(name = "log.csv") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "physim-csv-"));
  return path.join(dir, name);
}

test("writes rows as CRLF-terminated records", async () => {
  const file = tmpFile();
  const logger = new CsvLogger();
  logger.start(file);
  logger.write(["a,b", "1,2"]);
  logger.write(["3,4"]);
  const result = await logger.stop();
  assert.deepEqual(result, { path: file, lines: 3 });
  assert.equal(fs.readFileSync(file, "utf8"), `a,b${CSV_EOL}1,2${CSV_EOL}3,4${CSV_EOL}`);
});

test("stop resolves only once the bytes are flushed", async () => {
  const file = tmpFile();
  const logger = new CsvLogger();
  logger.start(file);
  // enough to exceed the stream's internal buffer, so the write is genuinely async
  const rows = Array.from({ length: 5000 }, (_, i) => `${i},${i * 2}`);
  logger.write(rows);
  await logger.stop();
  assert.equal(fs.readFileSync(file, "utf8").split(CSV_EOL).length, 5001);
});

test("rows arriving with no log running are dropped, not thrown", () => {
  const logger = new CsvLogger();
  assert.equal(logger.isLogging(), false);
  assert.equal(logger.write(["1,2"]), 0);
});

test("stop is idempotent and reports null when nothing ran", async () => {
  const file = tmpFile();
  const logger = new CsvLogger();
  logger.start(file);
  logger.write(["x"]);
  assert.notEqual(await logger.stop(), null);
  assert.equal(await logger.stop(), null);
  assert.equal(logger.isLogging(), false);
  assert.equal(logger.getPath(), null);
});

test("starting twice would silently orphan the first file", () => {
  const logger = new CsvLogger();
  logger.start(tmpFile());
  assert.throws(() => logger.start(tmpFile()), /already running/);
  logger.stop();
});

test("an unwritable path throws synchronously so the caller can report it", () => {
  const logger = new CsvLogger();
  assert.throws(() => logger.start(path.join(tmpFile("nope"), "deeper", "x.csv")));
  assert.equal(logger.isLogging(), false);
});

test("start truncates — a re-run doesn't append to the previous session", async () => {
  const file = tmpFile();
  const first = new CsvLogger();
  first.start(file);
  first.write(["old,row"]);
  await first.stop();

  const second = new CsvLogger();
  second.start(file);
  second.write(["new,row"]);
  await second.stop();
  assert.equal(fs.readFileSync(file, "utf8"), `new,row${CSV_EOL}`);
});

test("sanitizeRows keeps strings, drops the rest, and strips embedded newlines", () => {
  assert.deepEqual(sanitizeRows(["a", 1, null, undefined, {}, "b"]), ["a", "b"]);
  assert.deepEqual(sanitizeRows("not an array"), []);
  assert.deepEqual(sanitizeRows(["1,2\r\n9,9"]), ["1,2 9,9"]);
});

test("a row that smuggles a newline can't add a record", async () => {
  const file = tmpFile();
  const logger = new CsvLogger();
  logger.start(file);
  logger.write(["a,b\nc,d"]);
  await logger.stop();
  assert.equal(fs.readFileSync(file, "utf8").split(CSV_EOL).filter(Boolean).length, 1);
});

test("defaultLogPath is absolute with a workspace folder and without one", () => {
  const at = new Date(2026, 7, 26, 9, 5, 3);
  const ws = path.join(path.sep, "work", "mc");
  assert.equal(
    defaultLogPath(ws, path.join(path.sep, "home", "u"), at),
    path.join(ws, "physim-log-20260826-090503.csv")
  );
  // No folder open — the dialog still needs somewhere real to start. A bare
  // file name here is what kept the Windows save dialog from ever opening.
  const home = path.join(path.sep, "home", "u");
  const fallback = defaultLogPath(undefined, home, at);
  assert.equal(fallback, path.join(home, "physim-log-20260826-090503.csv"));
  for (const p of [defaultLogPath(ws, home, at), fallback,
                   defaultLogPath(null, home, at), defaultLogPath("", home, at)]) {
    assert.ok(path.isAbsolute(p), `${p} must be absolute`);
    assert.notEqual(path.dirname(p), ".");
  }
});

test("default file name sorts chronologically and ends in .csv", () => {
  const name = defaultLogFileName(new Date(2026, 7, 26, 9, 5, 3));
  assert.equal(name, "physim-log-20260826-090503.csv");
  const later = defaultLogFileName(new Date(2026, 7, 26, 10, 5, 3));
  assert.ok(name < later, `${name} should sort before ${later}`);
});


test("end to end: what the webview batches parses back as one table", async () => {
  const file = tmpFile();
  const logger = new CsvLogger();
  logger.start(file);

  // media/logging.js sends the header first, then batches of tick rows.
  const log = createLog(0);
  logger.write([CSV_HEADER]);
  const state = t => ({
    position: [t * 0.5, 0, 0],
    rotation: [0, 0, 0],
    velocity: [0.5, 0, 0],
    angularVelocity: [0, 0, 0]
  });
  logger.write(Array.from({ length: 30 }, (_, i) => tickRow(log, i * 16.67, state(i))));
  logger.write(Array.from({ length: 30 }, (_, i) => tickRow(log, (30 + i) * 16.67, state(30 + i))));
  await logger.stop();

  const lines = fs.readFileSync(file, "utf8").split(CSV_EOL);
  assert.equal(lines.pop(), "", "the file ends with a record separator");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 61);
  const width = CSV_HEADER.split(",").length;
  for (const [i, line] of lines.entries()) {
    assert.equal(line.split(",").length, width, `line ${i} is a different width`);
  }
  // sample numbers are contiguous across the batch boundary
  assert.deepEqual(lines.slice(1).map(l => Number(l.split(",")[0])), [...Array(60).keys()]);
});
