// Right-side status bar controller.
//
// Companion to the existing left-side StatusBarController. Shows the same
// today total but its value is the *rich hover tooltip* — a MarkdownString
// with today / 7-day / all-time totals, message counts, and the top model.
// Clicking opens the full dashboard (same command as the left item).
//
// Disabled entirely if the user sets `tokenCount.rightStatusBar.enabled`
// to false in their settings.

import * as vscode from "vscode";
import {
  readAllPrompts,
  readAllRecords,
  summarize,
  type UsageRecord,
} from "@token-count/core";
import { formatCount, formatNumber, startOfTodayUTC } from "./format.js";

export class RightStatusBarController {
  private item: vscode.StatusBarItem;

  constructor() {
    // Right alignment. A low priority on the right side puts us near the
    // left edge of the right cluster (closer to the center of the bar, more
    // visible). VSCode right-side priority also works in reverse: higher
    // priority = further left, which for right-aligned items means closer
    // to the left edge of the right cluster.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "tokenCount.showDashboard";
    this.item.show();
  }

  /**
   * Re-read usage.jsonl and prompts.jsonl, update the compact label and
   * rebuild the hover tooltip. Safe to call often.
   */
  refresh(): void {
    try {
      const records = readAllRecords();
      const prompts = readAllPrompts();

      const DAY_MS = 24 * 60 * 60 * 1000;
      const today = startOfTodayUTC();
      const sevenDaysAgo = new Date(today.getTime() - 6 * DAY_MS);

      const todaySum = summarize(records, { groupBy: "day", since: today });
      const weekSum = summarize(records, { groupBy: "day", since: sevenDaysAgo });
      const allSum = summarize(records, { groupBy: "day" });

      // Use a different icon from the left item so users can tell at a
      // glance that these are two different views on the same data.
      this.item.text = `$(graph-line) ${formatCount(todaySum.totals.total_tokens)}`;
      this.item.tooltip = this.buildTooltip({
        records,
        prompts,
        todayStart: today,
        sevenDaysAgoStart: sevenDaysAgo,
        todayTokens: todaySum.totals.total_tokens,
        weekTokens: weekSum.totals.total_tokens,
        allTimeTokens: allSum.totals.total_tokens,
      });
    } catch (err) {
      this.item.text = "$(graph-line) —";
      this.item.tooltip = "Token Count: failed to read usage.jsonl";
      console.error("[token-count] right status bar refresh failed", err);
    }
  }

  /**
   * Build the hover tooltip as a VSCode MarkdownString. `isTrusted = true`
   * is required so the `command:` link at the bottom opens the dashboard
   * when clicked — we control the content so this is safe.
   */
  private buildTooltip(ctx: {
    records: UsageRecord[];
    prompts: ReturnType<typeof readAllPrompts>;
    todayStart: Date;
    sevenDaysAgoStart: Date;
    todayTokens: number;
    weekTokens: number;
    allTimeTokens: number;
  }): vscode.MarkdownString {
    // Count prompts in the matching time windows. Prompts are cheap to
    // filter in memory — there's one per user message, typically ~1000s.
    const todayMs = ctx.todayStart.getTime();
    const weekMs = ctx.sevenDaysAgoStart.getTime();
    const promptsToday = ctx.prompts.filter(
      (p) => Date.parse(p.ts) >= todayMs,
    ).length;
    const promptsAllTime = ctx.prompts.length;

    // Top model today by tokens. We restrict to today's records so the
    // "today" line is internally consistent.
    const todaysRecords = ctx.records.filter(
      (r) => Date.parse(r.ts) >= todayMs,
    );
    const byModelToday = summarize(todaysRecords, { groupBy: "model" });
    const topModel = byModelToday.groups[0];
    const topModelLine = topModel
      ? `**Top model today:** \`${topModel.key}\` (${formatNumber(topModel.totals.total_tokens)} tokens)`
      : `**Top model today:** —`;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(graph-line) Token Count\n\n`);
    md.appendMarkdown(
      `**Today:** ${formatNumber(ctx.todayTokens)} tokens · ${promptsToday} msgs\n\n`,
    );
    md.appendMarkdown(
      `**Last 7 days:** ${formatNumber(ctx.weekTokens)} tokens\n\n`,
    );
    md.appendMarkdown(
      `**All time:** ${formatNumber(ctx.allTimeTokens)} tokens · ${promptsAllTime} msgs\n\n`,
    );
    md.appendMarkdown(`${topModelLine}\n\n`);
    md.appendMarkdown(
      `---\n\n[Open full dashboard](command:tokenCount.showDashboard)`,
    );
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
