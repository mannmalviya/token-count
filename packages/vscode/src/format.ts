// Shared formatting helpers used by both status bar items and the sidebar
// view. Kept as plain functions (no class) so they can be imported without
// any setup cost.

import * as vscode from "vscode";

/**
 * Read the user's `tokenCount.useLocalTimezone` setting. Default is
 * true so that out-of-the-box, day buckets line up with the user's
 * actual local calendar (the more intuitive behavior). Users who want
 * UTC bucketing — e.g. for parity with `token-count stats --utc` — can
 * flip the setting off.
 *
 * Centralized here so we can't accidentally drift between surfaces (every
 * surface that does day math has to read this same flag).
 */
export function useLocalTimezone(): boolean {
  return vscode.workspace
    .getConfiguration("tokenCount")
    .get<boolean>("useLocalTimezone", true);
}

/**
 * Midnight at the start of "today" in either UTC or the user's local
 * timezone. Pass the result of `useLocalTimezone()` so all surfaces stay
 * in sync with the setting.
 */
export function startOfToday(localTime: boolean): Date {
  const now = new Date();
  if (localTime) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Humanize a token count for tight spaces (status bar, sidebar). Examples:
 *   987     → "987"
 *   12400   → "12.4k"
 *   1500000 → "1.5M"
 */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Full-width number with thousands separators, for tooltips and the sidebar. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
