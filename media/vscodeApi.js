// acquireVsCodeApi() may only be called ONCE per webview session — this
// module is its single owner. Everything else imports { vscode } from here.
export const vscode = acquireVsCodeApi();
