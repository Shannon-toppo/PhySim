import * as vscode from "vscode";
import { PhysServer } from "./physServer";
import { PhysSimPanelManager } from "./physSimPanel";
import { ensureInjected } from "./libraryPathInjector";
import { PhysimDebugPatcher } from "./debugConfigPatcher";
import { SimStubServer } from "./simStubServer";

function isLifeBoatSimulator(session: vscode.DebugSession): boolean {
  return session.type === "lua" && session.name === "Run Simulator";
}

function readPort(): number {
  const v = vscode.workspace.getConfiguration().get<number>("physim.port", 14239);
  return Number.isFinite(v) && v > 0 && v < 65536 ? v : 14239;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const server = new PhysServer();
  // Stand-in for LifeBoatAPI's Windows-only STORMWORKS_Simulator.exe: PhySim
  // answers on port 14238 and renders the microcontroller's monitors inside
  // the panel. Constructed on both platforms but only *started* when it is
  // actually in use — mandatory on macOS (the exe can't run), opt-in and
  // experimental on Windows. That decision is made per debug session in
  // debugConfigPatcher's useBuiltInMonitors(), so the setting takes effect
  // without a window reload; constructing the server binds nothing.
  const stub = process.platform === "darwin" || process.platform === "win32"
    ? new SimStubServer()
    : null;
  const panel = new PhysSimPanelManager(ctx, server, stub);

  await ensureInjected(ctx);

  ctx.subscriptions.push(
    // Re-run library-path injection when a new workspace folder is added, so
    // editor autocompletion picks up PhySim in projects opened after activate.
    vscode.workspace.onDidChangeWorkspaceFolders(() => { ensureInjected(ctx); }),
    vscode.debug.registerDebugConfigurationProvider("lua", new PhysimDebugPatcher(ctx.extensionUri, stub)),
    vscode.debug.onDidStartDebugSession(async session => {
      if (!isLifeBoatSimulator(session)) return;
      const port = readPort();
      try {
        await server.start(port);
      } catch (err) {
        vscode.window.showErrorMessage(
          `PhySim: failed to bind TCP port ${port}: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      const auto = vscode.workspace.getConfiguration().get<boolean>("physim.autoOpenOnSimulate", true);
      if (auto) panel.openOrReveal();
    }),
    vscode.debug.onDidTerminateDebugSession(async session => {
      if (!isLifeBoatSimulator(session)) return;
      await server.stop();
      if (stub) await stub.stop();
    }),
    vscode.commands.registerCommand("physim.open",  () => panel.openOrReveal()),
    vscode.commands.registerCommand("physim.reset", () => panel.reset()),
    { dispose: () => { server.stop(); if (stub) stub.stop(); panel.close(); } }
  );
}

export function deactivate(): void {
  // disposables registered in activate handle teardown
}
