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

export interface StatsOptions {
  by: GroupBy;
  since?: Date;
  until?: Date;
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
  const header = [keyHeader, "Input", "Output", "Cache create", "Cache read", "Total", "Turns"];

  const body = summary.groups.map((g) => row(g.key, g.totals));
  const footer = row("all", summary.totals);

  const output =
    renderTable(header, body) + "\n" + renderTable(["Totals", ...header.slice(1)], [footer]) + "\n";

  return { summary, output };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function row(key: string, t: TotalsBlock): string[] {
  return [
    key,
    fmt(t.input_tokens),
    fmt(t.output_tokens),
    fmt(t.cache_creation_input_tokens),
    fmt(t.cache_read_input_tokens),
    fmt(t.total_tokens),
    String(t.record_count),
  ];
}

// Format ints with en-US thousands separators. Fixed locale so test assertions
// don't depend on the machine's locale.
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Render a simple left/right-aligned text table. First column is left-aligned
 * (labels, paths), numeric columns are right-aligned for easy eyeballing.
 */
function renderTable(header: string[], rows: string[][]): string {
  // Compute the widest value in each column so content never truncates.
  const allRows = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...allRows.map((r) => (r[i] ?? "").length)),
  );

  const sep = "  "; // two-space column separator — visually clean, no box drawing
  const lines: string[] = [];

  lines.push(formatRow(header, widths, sep));
  // A divider under the header for visual separation.
  lines.push(widths.map((w) => "-".repeat(w)).join(sep));
  for (const r of rows) lines.push(formatRow(r, widths, sep));

  return lines.join("\n") + "\n";
}

function formatRow(cells: string[], widths: number[], sep: string): string {
  return cells
    .map((cell, i) => {
      const w = widths[i]!;
      // First column = labels (left-aligned). Rest = numbers (right-aligned).
      return i === 0 ? cell.padEnd(w) : cell.padStart(w);
    })
    .join(sep)
    .trimEnd();
}
