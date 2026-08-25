import * as fs from "fs";
import * as path from "path";

// CSV channel logging — the extension-host half. Deliberately dumb about what
// a channel is: the webview (media/logging.js + media/csv.js) owns the column
// set and sends the header as the first row, so adding a CH never touches
// this file. All this does is open the file the user picked, append the lines
// it is handed, and close cleanly.
//
// No `vscode` import — test/csvLogger.test.mjs drives it directly in Node.

/** RFC 4180 record separator. Excel is happier with it than with bare LF. */
export const CSV_EOL = "\r\n";

/**
 * A webview is still a renderer process, so treat its rows as data: keep the
 * strings, drop everything else, and strip embedded newlines — a row carrying
 * one would silently split into two records and shift every column after it.
 */
export function sanitizeRows(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r !== "string") continue;
    out.push(r.replace(/[\r\n]+/g, " "));
  }
  return out;
}

export interface CsvLogResult {
  path: string;
  /** Lines written, header included. */
  lines: number;
}

export class CsvLogger {
  private stream: fs.WriteStream | null = null;
  private filePath: string | null = null;
  private lines = 0;

  /** Reported when the file dies mid-log (disk full, volume unmounted, …). */
  onError: ((err: Error) => void) | null = null;

  isLogging(): boolean { return this.stream !== null; }
  getPath(): string | null { return this.filePath; }
  getLineCount(): number { return this.lines; }

  /**
   * Open (truncating) the log file. Throws synchronously if the path can't be
   * written — the caller wants to tell the user before the panel's button
   * lights up, not one tick later through an async error event.
   */
  start(filePath: string): void {
    if (this.stream) throw new Error("PhySim: CSV log already running");
    const fd = fs.openSync(filePath, "w");
    const stream = fs.createWriteStream(filePath, { fd });
    stream.on("error", err => {
      // The stream is unusable after an error; drop it so further rows are
      // ignored instead of throwing on every batch.
      if (this.stream === stream) { this.stream = null; }
      if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
    });
    this.stream = stream;
    this.filePath = filePath;
    this.lines = 0;
  }

  /** Append rows. Silently ignored when no log is running. Returns lines written. */
  write(rows: unknown): number {
    if (!this.stream) return 0;
    const clean = sanitizeRows(rows);
    if (clean.length === 0) return 0;
    this.stream.write(clean.join(CSV_EOL) + CSV_EOL);
    this.lines += clean.length;
    return clean.length;
  }

  /** Flush and close. Resolves null when nothing was running. */
  stop(): Promise<CsvLogResult | null> {
    const stream = this.stream;
    const path = this.filePath;
    const lines = this.lines;
    this.stream = null;
    this.filePath = null;
    this.lines = 0;
    if (!stream || !path) return Promise.resolve(null);
    return new Promise(resolve => {
      stream.end(() => resolve({ path, lines }));
    });
  }
}

/** `physim-log-20260826-142530.csv` — sorts chronologically, unique per second. */
export function defaultLogFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `physim-log-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.csv`;
}

/**
 * Where the save dialog should start, given the first workspace folder (if
 * any) and the user's home directory.
 *
 * The result must be ABSOLUTE. Handing the dialog a bare file name yields a
 * drive-relative `\name.csv` on Windows, which the native dialog refuses —
 * it never opens, and PhySim looks like it ignored the button. macOS resolves
 * the same input to `/name.csv` and opens happily, which is why this only
 * ever showed up on Windows.
 */
export function defaultLogPath(
  workspaceDir: string | null | undefined,
  homeDir: string,
  now?: Date
): string {
  const base = workspaceDir && workspaceDir.length > 0 ? workspaceDir : homeDir;
  return path.join(base, defaultLogFileName(now));
}
