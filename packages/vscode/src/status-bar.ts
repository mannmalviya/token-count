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
      const today = startOfTodayUTC();
      const summary = summarize(records, { groupBy: "day", since: today });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Midnight UTC of today, used as the `since` bound so "today" means "records
 * whose day bucket is today in UTC". We intentionally use UTC so that the
 * status bar matches the aggregation in the CLI and the dashboard — mixing
 * time zones would produce numbers that disagree.
 */
function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Humanize a token count. Examples:
 *   987       → "987"
 *   12400     → "12.4k"
 *   1500000   → "1.5M"
 */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
