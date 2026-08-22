import * as vscode from "vscode";

// A plain Output channel rather than notifications. The monitor path has
// several outcomes that are silent by design — the Windows opt-in setting
// left off, port 14238 already held by a leftover STORMWORKS_Simulator.exe,
// an upstream template change that makes a patch a no-op — and from the
// outside they all look identical: "it just doesn't do anything". The log
// makes each of them say so.

let channel: vscode.OutputChannel | null = null;

export function log(message: string): void {
  if (!channel) channel = vscode.window.createOutputChannel("PhySim");
  channel.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** Bring the log forward without stealing focus from the editor. */
export function showLog(): void {
  log("---");
  channel?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = null;
}
