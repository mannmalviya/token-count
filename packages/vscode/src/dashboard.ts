// Dashboard webview.
//
// A single WebviewPanel (VSCode's built-in HTML panel) showing:
//   - Big totals for today / this week / all time
//   - A day-by-day bar chart for the last 30 days (rendered as inline SVG —
//     no external charting library, no network, no CSP headaches)
//   - A breakdown by model and by project
//
// Only ONE panel can exist at a time; calling `show()` a second time just
// reveals the existing one.

import * as vscode from "vscode";
import {
  readAllPrompts,
  readAllRecords,
  summarize,
  type Summary,
  type TotalsBlock,
} from "@token-count/core";

export class DashboardPanel {
  // Static singleton — we don't want multiple dashboard panels fighting for
  // the same data.
  private static current: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.refresh();

    // When the user closes the panel, drop our singleton reference.
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Open the panel (or bring it forward if it's already open). */
  static show(): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "tokenCountDashboard",
      "Token Count",
      vscode.ViewColumn.Active,
      {
        // We run a tiny inline <script> to toggle between chart timeframes
        // (week / month / year / all). Everything rendered is static HTML we
        // escape ourselves, so no external code ever runs here.
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    DashboardPanel.current = new DashboardPanel(panel);
  }

  /**
   * Re-render the HTML from the current usage.jsonl. Called by extension.ts
   * whenever the file changes (via FileSystemWatcher).
   */
  refresh(): void {
    if (!DashboardPanel.current) return;
    try {
      const records = readAllRecords();
      const prompts = readAllPrompts();
      this.panel.webview.html = renderHtml(records, prompts);
    } catch (err) {
      this.panel.webview.html = renderError(err);
    }
  }

  /** Called when the panel is closed. */
  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** extension.ts calls this so the dashboard can refresh when usage.jsonl updates. */
  static refreshIfOpen(): void {
    DashboardPanel.current?.refresh();
  }
}

// ---------------------------------------------------------------------------
// HTML rendering.
//
// Plain strings, no templating library. We escape any user-controlled values
// (model names, project paths) before interpolating.
// ---------------------------------------------------------------------------

function renderHtml(
  records: Parameters<typeof summarize>[0],
  prompts: ReturnType<typeof readAllPrompts>,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;

  const now = new Date();
  const startOfTodayUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  // --- Totals shown in the summary cards (unchanged). ---------------------
  const sevenDaysAgo = startOfTodayUTC - 6 * DAY_MS;
  const today = summarize(records, {
    groupBy: "day",
    since: new Date(startOfTodayUTC),
  });
  const week = summarize(records, {
    groupBy: "day",
    since: new Date(sevenDaysAgo),
  });
  const allTime = summarize(records, { groupBy: "day" });
  const byModel = summarize(records, { groupBy: "model" });
  const byProject = summarize(records, { groupBy: "project" });

  // --- Headline counts. ---------------------------------------------------
  // "API calls" = one per assistant response in the transcript. Each tool-use
  // round trip is its own response, so this number is much bigger than the
  // number of times you actually typed something.
  // "User messages" = one per unique prompt_id across prompts.jsonl. This
  // matches the "messages" number Claude Code's /insights reports.
  const apiCalls = allTime.totals.record_count;
  const userMessages = prompts.length;
  const sessions = new Set(records.map((r) => r.session_id)).size;
  const projects = new Set(records.map((r) => r.cwd)).size;
  const models = new Set(records.map((r) => r.model)).size;
  const activeDays = allTime.groups.length; // groups are bucketed by day
  const firstDay = activeDays > 0 ? allTime.groups[0]!.key : "—";

  // --- Chart timeframes. --------------------------------------------------
  // Each entry becomes one button + one hidden chart panel. We render all
  // four up front and toggle visibility in the browser, which means
  // switching timeframes has no round-trip to the extension host.
  //
  // "all" starts at the earliest recorded day so the chart spans exactly
  // the user's history. If there are no records we fall back to today
  // (produces an empty bar).
  const earliestMs = records.length
    ? Math.min(...records.map((r) => Date.parse(r.ts)))
    : startOfTodayUTC;
  const earliestDayUTC = Date.UTC(
    new Date(earliestMs).getUTCFullYear(),
    new Date(earliestMs).getUTCMonth(),
    new Date(earliestMs).getUTCDate(),
  );
  const ranges: { id: string; label: string; startMs: number }[] = [
    { id: "week", label: "Past week", startMs: startOfTodayUTC - 6 * DAY_MS },
    { id: "month", label: "Past month", startMs: startOfTodayUTC - 29 * DAY_MS },
    { id: "year", label: "Past year", startMs: startOfTodayUTC - 364 * DAY_MS },
    { id: "all", label: "All time", startMs: earliestDayUTC },
  ];

  // Default selection: month (matches the previous "Last 30 days" view).
  const defaultId = "month";

  const options = ranges
    .map(
      (r) =>
        `<option value="${r.id}"${r.id === defaultId ? " selected" : ""}>${escape(r.label)}</option>`,
    )
    .join("");

  const panels = ranges
    .map((r) => {
      const s = summarize(records, {
        groupBy: "day",
        since: new Date(r.startMs),
      });
      const hidden = r.id === defaultId ? "" : " hidden";
      return `<div class="chart-panel${hidden}" data-panel="${r.id}">${renderBarChart(s, r.startMs, startOfTodayUTC)}</div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Token Count</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px;
    line-height: 1.5;
  }
  h1, h2 { font-weight: 500; margin-top: 24px; }
  .totals { display: flex; gap: 32px; margin: 16px 0 32px; flex-wrap: wrap; }
  .totals .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    padding: 16px 20px;
    border-radius: 6px;
    min-width: 140px;
  }
  .card .label { font-size: 12px; opacity: 0.7; }
  .card .value { font-size: 24px; margin-top: 4px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
  th { font-weight: 500; opacity: 0.8; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { opacity: 0.6; margin: 32px 0; }
  svg .bar { fill: var(--vscode-charts-blue, #4a9eff); }
  svg .axis { stroke: var(--vscode-editorWidget-border); }
  svg text { fill: var(--vscode-foreground); font-size: 10px; }

  /* Timeframe dropdown above the chart. Uses VSCode's dropdown theme vars
     so it blends with the active color scheme. */
  .range-select { margin: 12px 0; }
  .range-select select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
    padding: 4px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .range-select select:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .chart-panel.hidden { display: none; }

  /* Compact stats row — one line of label/value pairs above the chart. */
  .stats {
    display: flex;
    gap: 28px;
    flex-wrap: wrap;
    margin: 8px 0 24px;
    padding: 12px 16px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 6px;
  }
  .stats .stat { display: flex; flex-direction: column; }
  .stats .stat .label { font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.5px; }
  .stats .stat .value { font-size: 16px; font-variant-numeric: tabular-nums; margin-top: 2px; }
</style>
</head>
<body>
  <h1>Token Count</h1>
  ${records.length === 0 ? `<p class="empty">No usage recorded yet. Start a Claude Code session — records show up here automatically.</p>` : ""}
  <div class="totals">
    ${totalCard("Today", today.totals)}
    ${totalCard("Last 7 days", week.totals)}
    ${totalCard("All time", allTime.totals)}
  </div>

  <div class="stats">
    ${statItem("User messages", formatNumber(userMessages), "How many times did I talk to Claude?")}
    ${statItem("API calls", formatNumber(apiCalls), "How many assistant responses were generated (one per API call, including tool-use rounds)")}
    ${statItem("Sessions", formatNumber(sessions))}
    ${statItem("Projects", formatNumber(projects))}
    ${statItem("Models", formatNumber(models))}
    ${statItem("Active days", formatNumber(activeDays))}
    ${statItem("First recorded", firstDay)}
  </div>

  <h2>Tokens per day</h2>
  <div class="range-select">
    <label for="range">Timeframe: </label>
    <select id="range">${options}</select>
  </div>
  ${panels}

  <h2>By model</h2>
  ${renderGroupTable("Model", byModel)}

  <h2>By project</h2>
  ${renderGroupTable("Project", byProject)}

  <script>
    // Timeframe toggle. All four chart panels are already in the DOM; the
    // <select> just flips the "hidden" class on everything but the chosen
    // one. No IPC to the extension, so the switch is instant.
    (function () {
      const select = document.getElementById("range");
      const panels = document.querySelectorAll(".chart-panel");
      select.addEventListener("change", function () {
        const range = select.value;
        panels.forEach(function (p) {
          p.classList.toggle("hidden", p.getAttribute("data-panel") !== range);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function totalCard(label: string, t: TotalsBlock): string {
  return `<div class="card"><div class="label">${escape(label)}</div><div class="value">${formatNumber(t.total_tokens)}</div><div class="label">${t.record_count} turns</div></div>`;
}

// One label/value pair in the compact stats row. `tooltip` is optional — when
// provided, it's surfaced via the native `title` attribute so hovering shows
// the explanation. No JS needed; browsers render this as a tooltip.
function statItem(label: string, value: string, tooltip?: string): string {
  const titleAttr = tooltip ? ` title="${escape(tooltip)}"` : "";
  const cursor = tooltip ? ' style="cursor: help;"' : "";
  return `<div class="stat"${titleAttr}${cursor}><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div></div>`;
}

function renderGroupTable(keyHeader: string, s: Summary): string {
  if (s.groups.length === 0) {
    return `<p class="empty">No data.</p>`;
  }
  const rows = s.groups
    .map((g) => {
      return `<tr>
        <td>${escape(g.key)}</td>
        <td class="num">${formatNumber(g.totals.input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.output_tokens)}</td>
        <td class="num">${formatNumber(g.totals.cache_creation_input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.cache_read_input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.total_tokens)}</td>
        <td class="num">${g.totals.record_count}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead>
      <tr>
        <th>${escape(keyHeader)}</th>
        <th class="num">Input</th>
        <th class="num">Output</th>
        <th class="num">Cache create</th>
        <th class="num">Cache read</th>
        <th class="num">Total</th>
        <th class="num">Turns</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Render an inline-SVG bar chart of tokens-per-day. We walk the full 30-day
 * window (not just the days we have data for) so the chart doesn't lie about
 * "quiet days" by skipping them.
 */
function renderBarChart(summary: Summary, startMs: number, endMs: number): string {
  // Build a map from "YYYY-MM-DD" → total_tokens for O(1) lookup.
  const byDay = new Map(summary.groups.map((g) => [g.key, g.totals.total_tokens]));

  // Enumerate each day in the [startMs, endMs] inclusive range.
  const days: { key: string; value: number }[] = [];
  for (let d = startMs; d <= endMs; d += 24 * 60 * 60 * 1000) {
    const key = new Date(d).toISOString().slice(0, 10);
    days.push({ key, value: byDay.get(key) ?? 0 });
  }

  const width = 900;
  const height = 180;
  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const max = Math.max(1, ...days.map((d) => d.value)); // avoid divide-by-zero
  const barW = chartW / days.length;

  // Bar width math: we leave a 1px gap between bars when there's room, but
  // for dense views (e.g. 365 bars in 900px) we shrink the gap so bars don't
  // vanish. Clamped to a minimum of 0.5px so every day is still visible.
  const gap = Math.min(1, barW * 0.2);
  const innerW = Math.max(0.5, barW - gap);

  const bars = days
    .map((d, i) => {
      const h = (d.value / max) * chartH;
      const x = padding.left + i * barW;
      const y = padding.top + (chartH - h);
      return `<rect class="bar" x="${x + gap / 2}" y="${y}" width="${innerW}" height="${h}"><title>${escape(d.key)}: ${formatNumber(d.value)}</title></rect>`;
    })
    .join("");

  // X-axis labels: first, middle, last day only (prevents clutter).
  const xLabel = (i: number) => {
    const d = days[i];
    if (!d) return "";
    const x = padding.left + i * barW + barW / 2;
    return `<text x="${x}" y="${height - 10}" text-anchor="middle">${escape(d.key.slice(5))}</text>`;
  };

  const yLabel = `<text x="${padding.left - 8}" y="${padding.top + 10}" text-anchor="end">${formatNumber(max)}</text><text x="${padding.left - 8}" y="${padding.top + chartH}" text-anchor="end">0</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartH}" />
    <line class="axis" x1="${padding.left}" y1="${padding.top + chartH}" x2="${padding.left + chartW}" y2="${padding.top + chartH}" />
    ${bars}
    ${xLabel(0)}
    ${xLabel(Math.floor(days.length / 2))}
    ${xLabel(days.length - 1)}
    ${yLabel}
  </svg>`;
}

function renderError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px;">
    <h2>Token Count: error reading usage.jsonl</h2>
    <pre>${escape(msg)}</pre>
  </body></html>`;
}

// Very small HTML escaper. We never insert user content outside of text
// nodes or attribute values, so this handles both.
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
