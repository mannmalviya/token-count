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
  readAllRecords,
  summarize,
  type GroupBy,
  type Summary,
  type TotalsBlock,
} from "@token-count/core";
import { accent, accentBold, dim } from "./color.js";

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

  const keyHeader =
    opts.by === "day" ? "Day" : opts.by === "model" ? "Model" : "Project";
  const baseHeader = [keyHeader, "Input", "Output", "Cache create", "Cache read", "Total", "Turns"];
  // Column label uses "API rate" rather than just "Cost" because Claude Code
  // subscriptions are flat-rate — this number is what the same tokens would
  // cost if billed per-token via the API, not what the user actually pays.
  const header = opts.cost ? [...baseHeader, "API rate (USD)"] : baseHeader;

  const body = summary.groups.map((g) => row(g.key, g.totals, opts.cost));
  const footer = row("all", summary.totals, opts.cost);

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
    renderTable(["Totals", ...header.slice(1)], [footer], { totalsRow: true }) +
    costNote +
    "\n";

  return { summary, output };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function row(key: string, t: TotalsBlock, withCost?: boolean): string[] {
  const base = [
    key,
    fmt(t.input_tokens),
    fmt(t.output_tokens),
    fmt(t.cache_creation_input_tokens),
    fmt(t.cache_read_input_tokens),
    fmt(t.total_tokens),
    String(t.record_count),
  ];
  return withCost ? [...base, fmtCost(t.total_cost_usd)] : base;
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
 * per cell. The `totalsRow` flag highlights the whole single-row totals
 * table in the accent color instead of leaving it plain.
 */
function renderTable(
  header: string[],
  rows: string[][],
  opts: { totalsRow?: boolean } = {},
): string {
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
  // Data rows: either accent-colored (the Totals sub-table) or plain
  // (the main per-group table — leaving numbers uncolored keeps long
  // tables scannable).
  const rowStyler = opts.totalsRow ? accent : undefined;
  for (const r of rows) lines.push(formatRow(r, widths, sep, rowStyler));

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
