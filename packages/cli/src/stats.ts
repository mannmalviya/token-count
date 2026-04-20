// `token-count stats` — terminal-readable summary of `usage.jsonl`.
//
// Layered on purpose:
//   - runStats(): reads records, rolls them up via core.summarize, and
//     renders a string. Returns the structured Summary too so callers
//     (tests, future SDK) can skip the string.
//   - index.ts wires commander flags into runStats and prints the output.
//
// We render the table by hand (a few padStart/padEnd calls) instead of
// pulling in a dependency — it keeps long project paths from getting
// truncated by a library's column-sizing heuristics.

import {
  readAllPrompts,
  readAllRecords,
  summarize,
  type GroupBy,
  type PromptRecord,
  type Summary,
  type TotalsBlock,
  type UsageRecord,
} from "@token-count/core";
import { accentBold, dim } from "./color.js";

export interface StatsOptions {
  by: GroupBy;
  since?: Date;
  until?: Date;
  /** Show an estimated USD cost column. See core/pricing.ts for rates. */
  cost?: boolean;
}

export interface StatsResult {
  summary: Summary;
  output: string;
}

export function runStats(opts: StatsOptions): StatsResult {
  const records = readAllRecords();
  // Prompts (real user messages) are counted per group alongside the token
  // totals. `readAllPrompts` is safe to call even when the file doesn't
  // exist — it returns []. We read unconditionally so `stats` shows a "0"
  // column instead of omitting messages on fresh installs.
  const prompts = readAllPrompts();
  // Translate the cli-facing `by` flag into core's `groupBy` option.
  const summary = summarize(records, {
    groupBy: opts.by,
    since: opts.since,
    until: opts.until,
  });

  if (summary.totals.record_count === 0) {
    return {
      summary,
      output: "No usage recorded yet. Start a Claude Code session to collect data.\n",
    };
  }

  // Per-group message counts, respecting the same --since/--until window
  // that summarize applies to records. `primaryModelBySession` maps each
  // session to the model with the most assistant turns in that session,
  // which we use to attribute prompts (which don't carry a model field) to
  // a model for `--by model`. Same heuristic as the VSCode dashboard.
  const messageCounts = countPromptsByGroup(
    prompts,
    records,
    opts.by,
    opts.since,
    opts.until,
  );
  const totalMessages = Array.from(messageCounts.values()).reduce(
    (s, n) => s + n,
    0,
  );

  const keyHeader =
    opts.by === "day" ? "Day" : opts.by === "model" ? "Model" : "Project";
  const baseHeader = [keyHeader, "Messages", "Input", "Output", "Cache create", "Cache read", "Total", "Turns"];
  // Column label uses "API rate" rather than just "Cost" because Claude Code
  // subscriptions are flat-rate — this number is what the same tokens would
  // cost if billed per-token via the API, not what the user actually pays.
  const header = opts.cost ? [...baseHeader, "API rate (USD)"] : baseHeader;

  const body = summary.groups.map((g) =>
    row(g.key, g.totals, messageCounts.get(g.key) ?? 0, opts.cost),
  );
  const footer = row("all", summary.totals, totalMessages, opts.cost);

  // When --cost is active, print a one-line reminder under the totals so the
  // number doesn't look like a bill. See pricing.ts for the rate source.
  // Dimmed so it reads as a footnote rather than a primary claim.
  const costNote = opts.cost
    ? "\n" +
      dim(
        "API rate = Anthropic per-token API pricing. Claude Code subscriptions are flat-rate; this is the equivalent retail cost, not your bill.",
      ) +
      "\n"
    : "";

  const output =
    renderTable(header, body) +
    "\n" +
    renderTable(["Totals", ...header.slice(1)], [footer]) +
    costNote +
    "\n";

  return { summary, output };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function row(
  key: string,
  t: TotalsBlock,
  messages: number,
  withCost?: boolean,
): string[] {
  const base = [
    key,
    fmt(messages),
    fmt(t.input_tokens),
    fmt(t.output_tokens),
    fmt(t.cache_creation_input_tokens),
    fmt(t.cache_read_input_tokens),
    fmt(t.total_tokens),
    String(t.record_count),
  ];
  return withCost ? [...base, fmtCost(t.total_cost_usd)] : base;
}

/**
 * Count prompts grouped by the same dimension summarize() groups records by.
 * Returns a map of group-key → message count, respecting the same
 * --since/--until window. Prompts don't carry a model, so for --by model we
 * attribute each prompt to its session's primary model (the one with the
 * most assistant turns in that session — matches the VSCode dashboard).
 */
function countPromptsByGroup(
  prompts: PromptRecord[],
  records: UsageRecord[],
  by: GroupBy,
  since?: Date,
  until?: Date,
): Map<string, number> {
  const counts = new Map<string, number>();

  // Only build the per-session primary-model map if we actually need it —
  // saves a pass over records for the much more common --by day/project.
  let primaryModelBySession: Map<string, string> | undefined;
  if (by === "model") {
    const tallyBySession = new Map<string, Map<string, number>>();
    for (const r of records) {
      let tally = tallyBySession.get(r.session_id);
      if (!tally) {
        tally = new Map();
        tallyBySession.set(r.session_id, tally);
      }
      tally.set(r.model, (tally.get(r.model) ?? 0) + 1);
    }
    primaryModelBySession = new Map();
    for (const [sid, tally] of tallyBySession) {
      let top = "";
      let topCount = -1;
      for (const [model, count] of tally) {
        if (count > topCount) {
          top = model;
          topCount = count;
        }
      }
      primaryModelBySession.set(sid, top);
    }
  }

  const sinceMs = since?.getTime();
  const untilMs = until?.getTime();
  for (const p of prompts) {
    const t = Date.parse(p.ts);
    if (sinceMs !== undefined && t < sinceMs) continue;
    if (untilMs !== undefined && t >= untilMs) continue;

    let key: string | undefined;
    if (by === "day") {
      key = new Date(t).toISOString().slice(0, 10);
    } else if (by === "project") {
      key = p.cwd;
    } else {
      key = primaryModelBySession!.get(p.session_id);
    }
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Format ints with en-US thousands separators. Fixed locale so test assertions
// don't depend on the machine's locale.
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// USD with two decimals and thousands separators — "$1,234.56".
function fmtCost(usd: number): string {
  return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Render a simple left/right-aligned text table. First column is left-aligned
 * (labels, paths), numeric columns are right-aligned for easy eyeballing.
 *
 * Coloring is applied AFTER padding so ANSI escape codes don't inflate the
 * string length that `padStart`/`padEnd` use to compute column widths.
 * Otherwise headers and totals would misalign by ~10 invisible characters
 * per cell. Only the header row is accent-colored — data rows stay plain
 * so numbers remain easy to scan.
 */
function renderTable(header: string[], rows: string[][]): string {
  const allRows = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...allRows.map((r) => (r[i] ?? "").length)),
  );

  const sep = "  "; // two-space column separator — visually clean, no box drawing
  const lines: string[] = [];

  // Header row: bold + terracotta so the column titles read as the accent
  // for each table.
  lines.push(formatRow(header, widths, sep, accentBold));
  // Divider: dimmed so it recedes compared to the numbers. Still visually
  // separates the header from the data.
  lines.push(
    dim(widths.map((w) => "-".repeat(w)).join(sep)),
  );
  // Data rows: plain — leaving numbers uncolored keeps long tables scannable.
  for (const r of rows) lines.push(formatRow(r, widths, sep));

  return lines.join("\n") + "\n";
}

function formatRow(
  cells: string[],
  widths: number[],
  sep: string,
  styler?: (s: string) => string,
): string {
  return cells
    .map((cell, i) => {
      const w = widths[i]!;
      // First column = labels (left-aligned). Rest = numbers (right-aligned).
      const padded = i === 0 ? cell.padEnd(w) : cell.padStart(w);
      return styler ? styler(padded) : padded;
    })
    .join(sep)
    .trimEnd();
}
