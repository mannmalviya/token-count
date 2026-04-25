// Date helpers for "day" bucketing in either UTC or the user's local
// timezone.
//
// Why this exists: by default token-count buckets per UTC calendar day so
// every consumer (CLI, VSCode extension, hook) agrees on what "today"
// means regardless of where the user lives. That works, but it can feel
// off — a session you ran at 11pm Pacific gets bucketed into the *next*
// UTC day, so it shows up on tomorrow's bar in your chart.
//
// These helpers expose both modes via a `localTime: boolean` flag. Pass
// `false` (or omit it) to keep the original UTC behavior; pass `true` to
// bucket at the machine's local midnight instead.
//
// Conventions:
//   - All functions take a millisecond timestamp (number) for the date.
//     Callers convert with `Date.parse(record.ts)` or `dateObj.getTime()`.
//   - Day keys are always "YYYY-MM-DD" strings — sortable as plain
//     strings, which is what the rest of the codebase already assumes.

/**
 * Format a millisecond timestamp as a "YYYY-MM-DD" date key. When
 * `localTime` is false, the key reflects the UTC calendar day; when true,
 * the key reflects the local-machine calendar day.
 */
export function dayKey(ms: number, localTime: boolean): string {
  const d = new Date(ms);
  if (localTime) {
    // Local-time accessors: getFullYear / getMonth / getDate read the
    // browser's (or Node's) configured time zone. We pad the month and day
    // so "2026-04-09" sorts correctly as a string against "2026-04-10".
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  // UTC accessors via the ISO string. Slicing is faster than the
  // getUTC* + pad dance and matches what the rest of the codebase
  // already produces for record keys.
  return d.toISOString().slice(0, 10);
}

/**
 * Midnight at the start of the day containing `ms`, returned as a
 * millisecond timestamp. The boundary is computed in UTC (`localTime`
 * false) or local time (`localTime` true).
 *
 * Used for "start of today", "start of <range>" calculations where you
 * need a numeric anchor to compute relative day offsets from.
 */
export function startOfDayMs(ms: number, localTime: boolean): number {
  const d = new Date(ms);
  if (localTime) {
    // Local-time constructor: `new Date(y, m, d)` builds a Date at local
    // midnight on the given y/m/d. Then .getTime() gives the absolute
    // ms — useful because the rest of the chart code does ms math.
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  // UTC midnight: Date.UTC builds the ms directly.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Convenience: midnight of "now" in the chosen timezone, as ms. */
export function startOfTodayMs(localTime: boolean): number {
  return startOfDayMs(Date.now(), localTime);
}

/**
 * Day-of-week for `ms`: 0 = Sunday, 6 = Saturday. Picks UTC or local
 * accessor based on `localTime`. The heatmap uses this to align grid
 * columns to whole weeks.
 */
export function weekday(ms: number, localTime: boolean): number {
  const d = new Date(ms);
  return localTime ? d.getDay() : d.getUTCDay();
}

/**
 * Calendar month (0..11) for `ms`. Used by the heatmap to label the top
 * of each new month's column.
 */
export function monthOf(ms: number, localTime: boolean): number {
  const d = new Date(ms);
  return localTime ? d.getMonth() : d.getUTCMonth();
}
