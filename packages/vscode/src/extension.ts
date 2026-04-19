// Extension entrypoint.
//
// activate() is called by VSCode when our activation event fires (we use
// `onStartupFinished`). deactivate() runs on window close.
//
// Responsibilities:
//   1. Create the status bar item (via StatusBarController).
//   2. Register the `tokenCount.showDashboard` command.
//   3. Watch `~/.token-count/usage.jsonl` and push updates to both.
//
// Disposal: everything we register goes into `context.subscriptions` so
// VSCode cleans up for us on deactivate.

import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { usageJsonlPath } from "@token-count/core";
import { StatusBarController } from "./status-bar.js";
import { DashboardPanel } from "./dashboard.js";

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // Compute the absolute path and the parent dir for the FS watcher. VSCode's
  // FileSystemWatcher wants a RelativePattern when watching files outside the
  // workspace — which is our case, since ~/.token-count isn't in the user's
  // project.
  const file = usageJsonlPath();
  const dir = path.dirname(file);
  const baseName = path.basename(file);

  // Initial refresh — don't make the user wait for the first hook to fire
  // to see any state.
  statusBar.refresh();

  // createFileSystemWatcher fires `onDidCreate/Change/Delete` events on the
  // extension host side. We refresh both the status bar and (if open) the
  // dashboard on any of them.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dir), baseName),
  );
  const onChange = () => {
    statusBar.refresh();
    DashboardPanel.refreshIfOpen();
  };
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenCount.showDashboard", () => {
      DashboardPanel.show();
    }),
  );

  // Friendly debug log so we can tell the extension loaded in the Extension
  // Host's console.
  const home = os.homedir();
  console.log(`[token-count] activated. Watching ${file.replace(home, "~")}`);
}

export function deactivate(): void {
  // Nothing to do — `context.subscriptions` disposes everything.
}
