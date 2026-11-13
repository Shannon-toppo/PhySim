import * as vscode from "vscode";
import * as path from "path";
import { PhysSimPanelManager } from "./physSimPanel";
import { MirrorServer } from "./mirrorServer";
import { Simulation } from "./simulation";
import { requireRoots } from "./runTarget";
import { runBuild } from "./buildRunner";
import { BuildProblem, GAME_SCRIPT_LIMIT } from "./build";
import { DebugHost, PhysimDebugSession } from "./debugSession";
import { log, showLog, disposeLog } from "./log";

/** Context key behind the Stop command's visibility and the editor title buttons. */
const RUNNING_CONTEXT = "physim.running";
/** The debugger type contributed in package.json. */
const DEBUG_TYPE = "physim";

function toDiagnostic(p: BuildProblem): vscode.Diagnostic {
  // The compiler counts lines and columns from 1; a problem without a range
  // belongs to the file as a whole and is pinned to its first line.
  const line = Math.max(0, (p.line ?? 1) - 1);
  const col = Math.max(0, (p.column ?? 1) - 1);
  const endLine = Math.max(line, (p.endLine ?? p.line ?? 1) - 1);
  const endCol = p.endColumn !== undefined ? Math.max(0, p.endColumn - 1) : (p.line === undefined ? 0 : col + 1);
  const severity = p.severity === "error" ? vscode.DiagnosticSeverity.Error
    : p.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const d = new vscode.Diagnostic(new vscode.Range(line, col, endLine, endCol), p.message, severity);
  d.source = "PhySim build";
  return d;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const sim = new Simulation();
  const panel = new PhysSimPanelManager(ctx, sim);
  const bundledLua = vscode.Uri.joinPath(ctx.extensionUri, "lua").fsPath;
  /** The debug session driving the current run. Every run is one. */
  let debugSession: PhysimDebugSession | null = null;

  log(`PhySim ${ctx.extension.packageJSON.version ?? "?"} activated on ${process.platform}.`);

  const setRunning = (running: boolean) =>
    vscode.commands.executeCommand("setContext", RUNNING_CONTEXT, running);

  function rootsFor(file: string): { base: string; roots: string[] } {
    const uri = vscode.Uri.file(file);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const scoped = vscode.workspace.getConfiguration(undefined, uri);
    const list = (section: string): unknown[] => {
      const v = scoped.get<unknown>(section);
      return Array.isArray(v) ? v : [];
    };
    const roots = requireRoots({
      file,
      workspaceFolder,
      libraryPaths: list("physim.libraryPaths"),
      legacyLibraryPaths: list("lifeboatapi.stormworks.libs.libraryPaths"),
      bundledLua
    });
    return { base: workspaceFolder ?? path.dirname(file), roots };
  }

  // --- An AI agent's run, shown in this window (agent/mirrorLink.ts) ----------
  //
  // The MCP server is another process and owns its run; it tells this window
  // what to show, and the window has no way to answer.
  const agentStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  agentStatus.command = "physim.open";
  const mirror = new MirrorServer({
    connected: server => log(`[agent] an AI agent's PhySim server (${server}) connected.`),
    update: u => {
      log(`[agent] ${u.tool}: ${u.status}${u.script ? ` ${path.basename(u.script)}` : ""}, tick ${u.tick}${u.error ? ` — ${u.error.split("\n")[0]}` : ""}`);
      if (u.status === "none") {
        sim.clearMirror();
        agentStatus.hide();
        return;
      }
      sim.showMirror(u.screens, u.frames, u.controls);
      agentStatus.text = `$(hubot) ${vscode.l10n.t("PhySim: AI agent — tick {0}", u.tick)}`;
      agentStatus.tooltip = u.script ?? undefined;
      agentStatus.show();
      // The agent's run is only worth opening the panel for when it starts, and not over the user's own run.
      const open = u.tool === "start_script" && !panel.isOpen() && !sim.isRunning()
        && vscode.workspace.getConfiguration().get<boolean>("physim.autoOpenOnSimulate", true);
      void (open ? panel.openOrReveal() : Promise.resolve()).then(() => {
        if (sim.isShowingMirror()) panel.showAgentPose(u.pose);
      });
    },
    disconnected: () => {
      log("[agent] the AI agent's PhySim server disconnected.");
      sim.clearMirror();
      agentStatus.hide();
    }
  }, { log });
  const mirrorFolders = (): string[] =>
    vscode.workspace.getConfiguration().get<boolean>("physim.agent.showInPanel", true)
      ? (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === "file").map(f => f.uri.fsPath)
      : [];
  const listenForAgents = (): void => {
    void mirror.setFolders(mirrorFolders()).then(() => {
      const endpoints = mirror.endpoints();
      if (endpoints.length > 0) log(`[agent] listening for an AI agent's PhySim server on ${endpoints.join(", ")}`);
    });
  };
  listenForAgents();
  ctx.subscriptions.push(
    agentStatus,
    vscode.workspace.onDidChangeWorkspaceFolders(listenForAgents),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration("physim.agent.showInPanel")) listenForAgents(); }),
    { dispose: () => mirror.dispose() }
  );

  sim.onStarted = (entry, files) => {
    log(`Running ${entry} (${files.length} file${files.length === 1 ? "" : "s"} loaded).`);
  };
  // print() and debug.log() go to the Debug Console, where each line links to
  // the call that wrote it.
  sim.onLog = line => debugSession?.scriptLog(line);
  sim.onStopped = reason => debugSession?.scriptStopped(reason);
  sim.onContinued = () => debugSession?.scriptContinued();
  sim.onEnded = (reason, message) => {
    void setRunning(false);
    if (reason === "stopped") {
      log("Stopped.");
      return;
    }
    if (reason === "exit") {
      log("The script ended the simulation (simulator:exit()).");
    } else {
      log(`${reason === "crash" ? "The engine stopped unexpectedly" : "Lua error"}: ${message ?? "(no message)"}`);
      const firstLine = (message ?? "").split("\n")[0];
      vscode.window.showErrorMessage(vscode.l10n.t("PhySim: the script stopped: {0}", firstLine));
    }
    debugSession?.scriptEnded(reason, message);
  };

  const debugHost: DebugHost = {
    launch: async request => {
      const { roots } = rootsFor(request.program);
      panel.simulatorStarted();
      await sim.start({ entry: request.program, roots, breakpoints: request.breakpoints });
      await setRunning(true);
      log(`Starting ${path.basename(request.program)}; require searches: ${roots.join(", ")}`);
      const auto = vscode.workspace.getConfiguration().get<boolean>("physim.autoOpenOnSimulate", true);
      if (auto) await panel.openOrReveal();
    },
    stop: () => sim.stop(),
    request: (name, args) => {
      const session = sim.current();
      if (!session) return Promise.reject(new Error("the script is not running"));
      return session.request(name, args);
    }
  };

  /**
   * The script in the active editor and where its `require` looks, with the
   * project saved to disk — or undefined, after telling the user why.
   */
  async function activeScript(): Promise<{ file: string; base: string; roots: string[] } | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== "file" || doc.languageId !== "lua") {
      vscode.window.showWarningMessage(vscode.l10n.t("PhySim: open the microcontroller's Lua file in the editor first."));
      return undefined;
    }
    // What runs (and what is built) is what is on disk — `require`d files are
    // read from there too — so unsaved edits anywhere in the project are saved first.
    if (!(await vscode.workspace.saveAll(false))) return undefined;

    const file = doc.uri.fsPath;
    return { file, ...rootsFor(file) };
  }

  const buildDiagnostics = vscode.languages.createDiagnosticCollection("physim-build");

  async function build(): Promise<void> {
    const target = await activeScript();
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration();
    const minify = cfg.get<boolean>("physim.build.minify", true);
    const outDir = path.resolve(target.base, cfg.get<string>("physim.build.outputDirectory", "_build/release") || "_build/release");
    const name = path.basename(target.file);

    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("PhySim: building {0}…", name) },
      () => runBuild({ entry: target.file, roots: target.roots, minify })
    );

    buildDiagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const p of outcome.problems) {
      log(`[build] ${p.severity}: ${p.file ? `${p.file}${p.line ? `:${p.line}` : ""}: ` : ""}${p.message}`);
      // A problem the compiler did not tie to a module is shown on the script being built.
      const file = p.file ?? target.file;
      byFile.set(file, [...(byFile.get(file) ?? []), toDiagnostic(p)]);
    }
    for (const [file, list] of byFile) buildDiagnostics.set(vscode.Uri.file(file), list);

    if (!outcome.ok || outcome.code === undefined) {
      const first = outcome.problems.find(p => p.severity === "error")?.message ?? "";
      const show = vscode.l10n.t("Show Log");
      vscode.window.showErrorMessage(vscode.l10n.t("PhySim: build failed: {0}", first), show)
        .then(choice => { if (choice === show) showLog(); });
      return;
    }

    const outFile = vscode.Uri.file(path.join(outDir, name));
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(outDir));
      await vscode.workspace.fs.writeFile(outFile, Buffer.from(outcome.code, "utf8"));
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("PhySim: could not write {0}: {1}", outFile.fsPath, err instanceof Error ? err.message : String(err))
      );
      return;
    }
    const size = outcome.size ?? 0;
    log(`[build] ${name}: ${size} / ${GAME_SCRIPT_LIMIT} characters from ${outcome.usedFiles.length} file(s) -> ${outFile.fsPath}`);
    const copy = vscode.l10n.t("Copy to Clipboard");
    const open = vscode.l10n.t("Open");
    const message = vscode.l10n.t("PhySim: built {0} — {1} / {2} characters.", name, size, GAME_SCRIPT_LIMIT);
    const choice = size > GAME_SCRIPT_LIMIT
      ? await vscode.window.showWarningMessage(
        vscode.l10n.t("PhySim: built {0}, but it is {1} characters and Stormworks accepts at most {2}.", name, size, GAME_SCRIPT_LIMIT), copy, open)
      : await vscode.window.showInformationMessage(message, copy, open);
    if (choice === copy) await vscode.env.clipboard.writeText(outcome.code);
    if (choice === open) await vscode.window.showTextDocument(outFile);
  }

  /** Run the script in the active editor, as a debug session. */
  async function run(noDebug: boolean): Promise<void> {
    const target = await activeScript();
    if (!target) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.file));
    await vscode.debug.startDebugging(
      folder,
      { type: DEBUG_TYPE, request: "launch", name: `PhySim: ${path.basename(target.file)}`, program: target.file },
      { noDebug }
    );
  }

  const adapterFactory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor: () => {
      const out = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
      const session = new PhysimDebugSession(debugHost, m => out.fire(m as vscode.DebugProtocolMessage));
      // One script runs at a time. Starting another ends the debug session of
      // the one it replaces, which would otherwise sit in the UI as running.
      debugSession?.scriptEnded("exit");
      debugSession = session;
      return new vscode.DebugAdapterInlineImplementation({
        onDidSendMessage: out.event,
        handleMessage: m => session.handleMessage(m),
        dispose: () => {
          if (debugSession === session) {
            debugSession = null;
            // The debug session is gone however it ended; the script goes with it.
            void sim.stop();
          }
          out.dispose();
        }
      });
    }
  };

  const configProvider: vscode.DebugConfigurationProvider = {
    // Also reached with an empty config: F5 in a project that has no launch.json.
    async resolveDebugConfiguration(_folder, config) {
      if (!config.type && !config.request && !config.name) {
        config.type = DEBUG_TYPE;
        config.request = "launch";
        config.name = "PhySim";
      }
      if (typeof config.program !== "string" || config.program === "") {
        const target = await activeScript();
        if (!target) return undefined;
        config.program = target.file;
      } else if (!(await vscode.workspace.saveAll(false))) {
        return undefined;
      }
      return config;
    }
  };

  ctx.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, adapterFactory),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configProvider),
    vscode.commands.registerCommand("physim.run", () => run(false)),
    vscode.commands.registerCommand("physim.runWithoutDebugging", () => run(true)),
    vscode.commands.registerCommand("physim.stop", () => {
      const active = vscode.debug.activeDebugSession;
      return active?.type === DEBUG_TYPE ? vscode.debug.stopDebugging(active) : sim.stop();
    }),
    vscode.commands.registerCommand("physim.build", () => build()),
    buildDiagnostics,
    vscode.commands.registerCommand("physim.showLog", () => showLog()),
    vscode.commands.registerCommand("physim.copyMcpConfig", () => copyMcpConfig(ctx)),
    vscode.commands.registerCommand("physim.open", () => panel.openOrReveal()),
    vscode.commands.registerCommand("physim.openMonitors", () => panel.openMonitorWindow()),
    vscode.commands.registerCommand("physim.reset", () => panel.reset()),
    { dispose: () => { void sim.dispose(); panel.close(); disposeLog(); } }
  );
}

/**
 * The AI tools are a separate process the agent's client starts (src/agent/
 * server.ts); the extension's only part is telling the user where it is. The
 * path holds the extension's version, so it changes with every update — which
 * is why this is a command to run again and not a line in the README.
 */
async function copyMcpConfig(ctx: vscode.ExtensionContext): Promise<void> {
  const server = path.join(ctx.extensionPath, "out", "agent", "server.js");
  const config = { mcpServers: { physim: { command: "node", args: [server] } } };
  await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
  log(`[mcp] server: node ${server}`);
  vscode.window.showInformationMessage(
    vscode.l10n.t("PhySim: copied the MCP server config. Paste it into your AI agent's MCP settings (needs Node.js 22.18 or newer).")
  );
}

export function deactivate(): void {
  // disposables registered in activate handle teardown
}
