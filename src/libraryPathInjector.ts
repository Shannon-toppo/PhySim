import * as vscode from "vscode";
import * as path from "path";

const LIB_KEY = "libraryPaths";
const LIB_SECTION = "lifeboatapi.stormworks.libs";
const MC_FLAG = "lifeboatapi.stormworks.isMicrocontrollerProject";
const ADDON_FLAG = "lifeboatapi.stormworks.isAddonProject";

function normalize(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, "/");
}

export async function ensureInjected(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  if (!cfg.get<boolean>("physim.autoInjectLibraryPath", true)) return;

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;

  const luaDir = vscode.Uri.joinPath(ctx.extensionUri, "lua").fsPath;
  const luaDirNorm = normalize(luaDir);

  for (const folder of folders) {
    const scoped = vscode.workspace.getConfiguration(undefined, folder.uri);
    const isMc = scoped.get<boolean>(MC_FLAG, false);
    const isAddon = scoped.get<boolean>(ADDON_FLAG, false);
    if (!isMc && !isAddon) continue;

    const libCfg = vscode.workspace.getConfiguration(LIB_SECTION, folder.uri);
    const current = libCfg.get<string[]>(LIB_KEY, []) ?? [];
    const already = current.some(p => normalize(p) === luaDirNorm);
    if (already) continue;

    const next = [...current, luaDir];
    try {
      await libCfg.update(LIB_KEY, next, vscode.ConfigurationTarget.WorkspaceFolder);
    } catch {
      // fallback: workspace-wide
      try {
        await libCfg.update(LIB_KEY, next, vscode.ConfigurationTarget.Workspace);
      } catch (err) {
        vscode.window.showWarningMessage(
          "PhySim: could not add lua/ to lifeboatapi libraryPaths. Add it manually: " + luaDir
        );
      }
    }
  }
}
