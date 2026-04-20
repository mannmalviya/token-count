// Extension entrypoint.
//
// activate() is called by VSCode when our activation event fires (we use
// `onStartupFinished`). deactivate() runs on window close.
//
// Responsibilities:
//   1. Create the left-side status bar item (always on).
//   2. Create the right-side status bar item (opt-out via settings).
//   3. Register the sidebar webview view provider (activity-bar entry).
//   4. Register the `tokenCount.showDashboard` command.
//   5. Watch `~/.token-count/usage.jsonl` and push updates to all surfaces.
//
// Disposal: everything we register goes into `context.subscriptions` so
// VSCode cleans up for us on deactivate.

import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { usageJsonlPath } from "@token-count/core";
import { StatusBarController } from "./status-bar.js";
import { RightStatusBarController } from "./right-status-bar.js";
import { SidebarViewProvider } from "./sidebar-view.js";
import { DashboardPanel } from "./dashboard.js";

export function activate(context: vscode.ExtensionContext): void {
  // ------------------------------------------------------------------------
  // 1. Left-side status bar (always shown).
  // ------------------------------------------------------------------------
  const leftStatus = new StatusBarController();
  context.subscriptions.push(leftStatus);

  // ------------------------------------------------------------------------
  // 2. Right-side status bar (respects user setting).
  // ------------------------------------------------------------------------
  let rightStatus: RightStatusBarController | undefined = createRightIfEnabled();
  if (rightStatus) context.subscriptions.push(rightStatus);

  // Watch for settings changes so toggling the right status bar takes
  // effect without requiring a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (!ev.affectsConfiguration("tokenCount.rightStatusBar.enabled")) return;
      if (rightStatus) {
        rightStatus.dispose();
        rightStatus = undefined;
      }
      rightStatus = createRightIfEnabled();
      if (rightStatus) {
        rightStatus.refresh();
        context.subscriptions.push(rightStatus);
      }
    }),
  );

  // ------------------------------------------------------------------------
  // 3. Sidebar webview view (activity-bar icon).
  // ------------------------------------------------------------------------
  const sidebar = new SidebarViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      sidebar,
    ),
  );

  // ------------------------------------------------------------------------
  // 4. Show-dashboard command.
  // ------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenCount.showDashboard", () => {
      DashboardPanel.show();
    }),
  );

  // ------------------------------------------------------------------------
  // 5. File watcher — refreshes every surface on any change.
  // ------------------------------------------------------------------------
  const file = usageJsonlPath();
  const dir = path.dirname(file);
  const baseName = path.basename(file);

  // Initial refresh so surfaces don't display empty until the first hook.
  leftStatus.refresh();
  rightStatus?.refresh();
  sidebar.refresh();

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dir), baseName),
  );
  const onChange = () => {
    leftStatus.refresh();
    rightStatus?.refresh();
    sidebar.refresh();
    DashboardPanel.refreshIfOpen();
  };
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  // Also watch prompts.jsonl — the right tooltip and sidebar need fresh
  // message counts when the hook appends a new prompt record.
  const promptsFile = path.join(dir, "prompts.jsonl");
  const promptsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(dir),
      path.basename(promptsFile),
    ),
  );
  promptsWatcher.onDidCreate(onChange);
  promptsWatcher.onDidChange(onChange);
  promptsWatcher.onDidDelete(onChange);
  context.subscriptions.push(promptsWatcher);

  const home = os.homedir();
  console.log(`[token-count] activated. Watching ${file.replace(home, "~")}`);
}

export function deactivate(): void {
  // Nothing to do — context.subscriptions disposes everything.
}

/**
 * Read the current setting and return a RightStatusBarController if the
 * user hasn't disabled it. Separated so the onDidChangeConfiguration
 * handler can reuse it.
 */
function createRightIfEnabled(): RightStatusBarController | undefined {
  const enabled = vscode.workspace
    .getConfiguration("tokenCount")
    .get<boolean>("rightStatusBar.enabled", true);
  return enabled ? new RightStatusBarController() : undefined;
}
