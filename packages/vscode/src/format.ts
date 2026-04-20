// Shared formatting helpers used by both status bar items and the sidebar
// view. Kept as plain functions (no class) so they can be imported without
// any setup cost.

/**
 * Midnight UTC of today. We use UTC so that "today" matches the aggregation
 * in the CLI and the dashboard — mixing time zones would produce numbers
 * that disagree between surfaces.
 */
export function startOfTodayUTC(): Date {
  const now = new Date();
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
