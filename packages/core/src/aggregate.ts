// Pure aggregation over an array of UsageRecords.
//
// Called by both the `stats` CLI and the VSCode webview. Keeping it pure
// (no fs, no i/o) means both consumers can share it and it's trivial to unit
// test. All IO happens in storage.ts.

import type { UsageRecord } from "./types.js";
import { estimateRecordCost } from "./pricing.js";
import { dayKey } from "./dates.js";

// ---------------------------------------------------------------------------
// Output shapes.
// ---------------------------------------------------------------------------

/** Sum of each token kind, the computed total, and how many records rolled in. */
export interface TotalsBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  /**
   * Estimated USD cost summed per-record using the record's model rate
   * (see pricing.ts). Always populated; stats CLI decides whether to show it.
   */
  total_cost_usd: number;
  record_count: number;
}

/** One row of a `groupBy` breakdown — e.g. one day, one model, one project. */
export interface GroupEntry {
  key: string;
  totals: TotalsBlock;
}

/** Full return value: grand totals + a list of group rows. */
export interface Summary {
  totals: TotalsBlock;
  groups: GroupEntry[];
}

export type GroupBy = "day" | "model" | "project";

export interface SummarizeOptions {
  groupBy: GroupBy;
  /** If set, records with ts < since are excluded (inclusive on `since`). */
  since?: Date;
  /** If set, records with ts >= until are excluded (exclusive on `until`). */
  until?: Date;
  /**
   * When `groupBy === "day"`, controls which calendar day boundary to
   * bucket on. False (default) keeps the historical UTC behavior so all
   * surfaces agree out-of-the-box. True buckets at the machine's local
   * midnight — useful when a user wants "11pm activity" to land on the
   * day they actually used the tool.
   *
   * Ignored when grouping by model or project (no day math involved).
   */
  localTime?: boolean;
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

/**
 * Roll an array of records up into grand totals + a `groupBy` breakdown.
 *
 * Sort order of `groups`:
 *   - "day": ascending by key (so a chart reads left→right chronologically)
 *   - "model", "project": descending by total_tokens (heaviest first)
 */
export function summarize(
  records: UsageRecord[],
  opts: SummarizeOptions,
): Summary {
  // 1. Apply since/until window first so all downstream math is on the
  //    filtered set. This mirrors how SQL WHERE happens before GROUP BY.
  const filtered = records.filter((r) => {
    const t = Date.parse(r.ts);
    if (opts.since && t < opts.since.getTime()) return false;
    if (opts.until && t >= opts.until.getTime()) return false;
    return true;
  });

  // 2. Grand totals over the whole filtered set.
  const totals = emptyTotals();
  for (const r of filtered) addInto(totals, r);

  // 3. Bucket by the requested key. localTime defaults to false so the
  //    historical UTC bucketing is preserved when callers don't pass it.
  const localTime = opts.localTime ?? false;
  const buckets = new Map<string, TotalsBlock>();
  for (const r of filtered) {
    const key = bucketKey(r, opts.groupBy, localTime);
    let t = buckets.get(key);
    if (!t) {
      t = emptyTotals();
      buckets.set(key, t);
    }
    addInto(t, r);
  }

  // 4. Turn the map into a sorted array so callers get stable ordering.
  const groups: GroupEntry[] = Array.from(buckets, ([key, totals]) => ({
    key,
    totals,
  }));
  if (opts.groupBy === "day") {
    // Chronological. "YYYY-MM-DD" sorts correctly as a plain string.
    groups.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    // Heaviest first.
    groups.sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
  }

  return { totals, groups };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function emptyTotals(): TotalsBlock {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    record_count: 0,
  };
}

// Fold one record into an accumulator. We recompute total_tokens from the
// components so adding new token kinds in the future is a one-line change.
function addInto(acc: TotalsBlock, r: UsageRecord): void {
  acc.input_tokens += r.input_tokens;
  acc.output_tokens += r.output_tokens;
  acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
  acc.cache_read_input_tokens += r.cache_read_input_tokens;
  acc.total_tokens +=
    r.input_tokens +
    r.output_tokens +
    r.cache_creation_input_tokens +
    r.cache_read_input_tokens;
  // Cost uses per-record rates (model-aware) so a daily bucket with mixed
  // Opus/Sonnet traffic adds up correctly.
  acc.total_cost_usd += estimateRecordCost(r);
  acc.record_count += 1;
}

// Pick the grouping key for a single record.
function bucketKey(r: UsageRecord, by: GroupBy, localTime: boolean): string {
  switch (by) {
    case "day":
      // Day key respects the localTime flag: in UTC mode we can shortcut
      // by slicing the ISO string (record ts is already in ISO/UTC form);
      // in local mode we go through dayKey() which uses local-time
      // accessors.
      return localTime ? dayKey(Date.parse(r.ts), true) : r.ts.slice(0, 10);
    case "model":
      return r.model;
    case "project":
      return r.cwd;
  }
}
