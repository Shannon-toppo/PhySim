import * as vscode from "vscode";

// A plain Output channel rather than notifications: what PhySim did and why,
// for when something "just doesn't do anything" — which folders a run's
// `require` searched, how a run ended, what a build reported.

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
