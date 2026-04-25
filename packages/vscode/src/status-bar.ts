// Status-bar controller.
//
// Shows today's total tokens on the left side of the VSCode status bar.
// Clicking it opens the dashboard (via the `tokenCount.showDashboard`
// command we register in extension.ts).
//
// The status bar refreshes whenever `~/.token-count/usage.jsonl` changes —
// we set up a file watcher in extension.ts and call `refresh()` here.

import * as vscode from "vscode";
import { readAllRecords, summarize } from "@token-count/core";
import { formatCount, startOfToday, useLocalTimezone } from "./format.js";

/**
 * Small wrapper around a VSCode StatusBarItem. The class exists so we can
 * keep the formatting logic (token → "12.4k") and the click command tied
 * together in one place.
 */
export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor() {
    // Left-aligned item with a high priority number puts us near the start of
    // the status bar. Priority works in reverse in VSCode — higher = further
    // to the left.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "tokenCount.showDashboard";
    this.item.tooltip = "Click to open Token Count dashboard";
    this.item.show();
  }

  /**
   * Re-read usage.jsonl and update the label. Safe to call often — reading
   * the whole file is O(records) which is cheap at v1 scale (a few thousand
   * lines = sub-millisecond).
   */
  refresh(): void {
    try {
      const records = readAllRecords();
      // Honor the user's local-timezone setting for both "today" boundary
      // and the day bucketing inside summarize.
      const localTime = useLocalTimezone();
      const today = startOfToday(localTime);
      const summary = summarize(records, {
        groupBy: "day",
        since: today,
        localTime,
      });
      this.item.text = `$(symbol-number) ${formatCount(summary.totals.total_tokens)} today`;
    } catch (err) {
      // Never let a stale file crash the status bar.
      this.item.text = "$(symbol-number) —";
      console.error("[token-count] status bar refresh failed", err);
    }
  }

  /** VSCode calls this when the extension deactivates. */
  dispose(): void {
    this.item.dispose();
  }
}

