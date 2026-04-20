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
  allRecords: Parameters<typeof summarize>[0],
  prompts: ReturnType<typeof readAllPrompts>,
): string {
  // Drop "<synthetic>" turns — Claude Code writes those locally when a real
  // API response didn't land (interrupts, network errors, etc.). They carry
  // zero/negligible usage and would otherwise pollute the model breakdown.
  const records = allRecords.filter((r) => r.model !== "<synthetic>");

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

  // --- Prompt counts per model / project. ---------------------------------
  // Prompts record session_id and cwd but not model. We approximate
  // "messages to model X" by: for each session, pick the model with the
  // most assistant turns in that session, then attribute every prompt in
  // that session to that model. This matches the common case where a
  // session sticks to one model; mixed-model sessions only misattribute
  // the minority-model prompts.
  const tallyBySession = new Map<string, Map<string, number>>();
  for (const r of records) {
    let tally = tallyBySession.get(r.session_id);
    if (!tally) {
      tally = new Map();
      tallyBySession.set(r.session_id, tally);
    }
    tally.set(r.model, (tally.get(r.model) ?? 0) + 1);
  }
  const primaryModelBySession = new Map<string, string>();
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
  const messagesByModel = new Map<string, number>();
  const messagesByProject = new Map<string, number>();
  for (const p of prompts) {
    const model = primaryModelBySession.get(p.session_id);
    if (model) {
      messagesByModel.set(model, (messagesByModel.get(model) ?? 0) + 1);
    }
    messagesByProject.set(p.cwd, (messagesByProject.get(p.cwd) ?? 0) + 1);
  }

  // --- Headline counts. ---------------------------------------------------
  // "API calls" = one per assistant response in the transcript. Each tool-use
  // round trip is its own response, so this number is much bigger than the
  // number of times you actually typed something.
  // "User messages" = one per unique prompt_id across prompts.jsonl. This
  // matches the "messages" number Claude Code's /insights reports.
  const userMessages = prompts.length;
  const sessions = new Set(records.map((r) => r.session_id)).size;
  const projects = new Set(records.map((r) => r.cwd)).size;
  const models = new Set(records.map((r) => r.model)).size;
  const activeDays = allTime.groups.length; // groups are bucketed by day
  const firstDay = activeDays > 0 ? allTime.groups[0]!.key : "—";
  // Average user messages per active day. Rounded to one decimal.
  const msgsPerDay = activeDays > 0 ? userMessages / activeDays : 0;

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
  // `bucketDays` is how many consecutive days each bar represents. The past
  // year view rolls up to weekly bars so the chart doesn't become a dense
  // 365-bar wall; shorter views stay daily.
  const ranges: {
    id: string;
    label: string;
    startMs: number;
    bucketDays: number;
  }[] = [
    { id: "week", label: "Past week", startMs: startOfTodayUTC - 6 * DAY_MS, bucketDays: 1 },
    { id: "month", label: "Past month", startMs: startOfTodayUTC - 29 * DAY_MS, bucketDays: 1 },
    { id: "year", label: "Past year", startMs: startOfTodayUTC - 364 * DAY_MS, bucketDays: 7 },
    { id: "all", label: "All time", startMs: earliestDayUTC, bucketDays: 1 },
  ];

  // Default selection: month (matches the previous "Last 30 days" view).
  const defaultId = "month";

  const options = ranges
    .map(
      (r) =>
        `<option value="${r.id}"${r.id === defaultId ? " selected" : ""}>${escape(r.label)}</option>`,
    )
    .join("");

  // --- Model selector. ----------------------------------------------------
  // Sentinel value "__all__" means "don't filter by model". We use a reserved
  // string instead of an empty one so it's impossible to collide with a real
  // model name like `claude-opus-4-7`.
  const ALL_MODELS = "__all__";
  const modelList = Array.from(new Set(records.map((r) => r.model))).sort();
  const modelOptions = [
    `<option value="${ALL_MODELS}" selected>All models</option>`,
    ...modelList.map(
      (m) => `<option value="${escape(m)}">${escape(m)}</option>`,
    ),
  ].join("");

  // Pre-render every (timeframe × model) combination so switching either
  // dropdown is instant in the browser. Data volume is tiny — at most a few
  // dozen panels of inline SVG — so this is cheaper than round-tripping to
  // the extension host on every change.
  const modelKeys = [ALL_MODELS, ...modelList];
  const panels = ranges
    .flatMap((r) =>
      modelKeys.map((m) => {
        const filtered =
          m === ALL_MODELS ? records : records.filter((rec) => rec.model === m);
        const s = summarize(filtered, {
          groupBy: "day",
          since: new Date(r.startMs),
        });
        const hidden = r.id === defaultId && m === ALL_MODELS ? "" : " hidden";
        return `<div class="chart-panel${hidden}" data-range="${r.id}" data-model="${escape(m)}">${renderBarChart(s, r.startMs, startOfTodayUTC, r.bucketDays)}</div>`;
      }),
    )
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
  h1 { display: flex; align-items: center; gap: 10px; }
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
  th, td {
    text-align: left;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    border-right: 1px solid var(--vscode-editorWidget-border);
  }
  th:last-child, td:last-child { border-right: none; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04)); }
  th { font-weight: 500; opacity: 0.8; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { opacity: 0.6; margin: 32px 0; }
  svg .bar { fill: var(--vscode-charts-blue, #4a9eff); }
  svg .bar:hover { fill: var(--vscode-charts-orange, #e8a33d); }
  svg .axis { stroke: var(--vscode-editorWidget-border); }
  svg .grid {
    stroke: var(--vscode-editorWidget-border);
    stroke-opacity: 0.4;
    stroke-dasharray: 2 3;
  }
  svg text { fill: var(--vscode-foreground); font-size: 10px; }

  /* Custom hover tooltip. Positioned with inline JS so it tracks the mouse.
     Kept hidden by default; shown when the .visible class is set. */
  #chart-tooltip {
    position: fixed;
    pointer-events: none;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #ccc);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 10;
    opacity: 0;
    transition: opacity 0.08s;
  }
  #chart-tooltip.visible { opacity: 1; }
  #chart-tooltip .date { opacity: 0.75; font-size: 11px; }
  #chart-tooltip .tokens { font-variant-numeric: tabular-nums; margin-top: 2px; }

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

  /* Live-dot next to the heading. Signals that the dashboard auto-refreshes
     when usage.jsonl changes (the extension watches the file). */
  .live-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #22c55e;
    animation: tc-pulse 1.6s ease-in-out infinite;
  }
  @keyframes tc-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
    100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
  }
</style>
</head>
<body>
  <h1>Token Count<span class="live-dot" title="Live — auto-refreshes as you use Claude Code" aria-hidden="true"></span></h1>
  ${records.length === 0 ? `<p class="empty">No usage recorded yet. Start a Claude Code session — records show up here automatically.</p>` : ""}
  <div class="totals">
    ${totalCard("Today", today.totals)}
    ${totalCard("Last 7 days", week.totals)}
    ${totalCard("All time", allTime.totals)}
  </div>

  <div class="stats">
    ${statItem("User messages", formatNumber(userMessages))}
    ${statItem("Msgs/day", msgsPerDay.toFixed(1))}
    ${statItem("Sessions", formatNumber(sessions))}
    ${statItem("Projects", formatNumber(projects))}
    ${statItem("Models", formatNumber(models))}
    ${statItem("Active days", formatNumber(activeDays))}
    ${statItem("First recorded", firstDay)}
  </div>

  <h2 id="tokens-per-day">Tokens per day</h2>
  <div class="range-select">
    <label for="range">Timeframe: </label>
    <select id="range">${options}</select>
    <label for="model" style="margin-left: 16px;">Model: </label>
    <select id="model">${modelOptions}</select>
  </div>
  ${panels}
  <div id="chart-tooltip" role="tooltip" aria-hidden="true"></div>

  <h2 id="by-model">By model</h2>
  ${renderGroupTable("Model", byModel, "model", false, messagesByModel)}

  <h2>By project</h2>
  ${renderGroupTable("Project", byProject, undefined, true, messagesByProject)}

  <script>
    // Timeframe + model toggle. All (range × model) chart panels are already
    // in the DOM; the two <select>s just flip the "hidden" class on everything
    // but the one whose data-range and data-model both match. No IPC to the
    // extension, so switching is instant.
    (function () {
      const rangeSel = document.getElementById("range");
      const modelSel = document.getElementById("model");
      const panels = document.querySelectorAll(".chart-panel");
      function update() {
        const r = rangeSel.value;
        const m = modelSel.value;
        panels.forEach(function (p) {
          const match =
            p.getAttribute("data-range") === r &&
            p.getAttribute("data-model") === m;
          p.classList.toggle("hidden", !match);
        });
      }
      rangeSel.addEventListener("change", update);
      modelSel.addEventListener("change", update);

      // Clicking a row in the "By model" table sets the model dropdown and
      // scrolls the chart into view so the user sees the effect immediately.
      document.querySelectorAll("tr.clickable").forEach(function (row) {
        row.addEventListener("click", function () {
          const model = row.getAttribute("data-select-model");
          if (!model) return;
          modelSel.value = model;
          update();
          const heading = document.getElementById("tokens-per-day");
          if (heading) heading.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
    })();

    // Bar hover tooltip. Listens globally on .chart-panel containers with
    // event delegation so we don't have to attach handlers to every <rect>.
    // We position the tooltip in viewport (fixed) coordinates near the cursor.
    (function () {
      const tooltip = document.getElementById("chart-tooltip");
      const panels = document.querySelectorAll(".chart-panel");
      panels.forEach(function (panel) {
        panel.addEventListener("mousemove", function (ev) {
          const target = ev.target;
          if (!(target instanceof SVGRectElement) || !target.classList.contains("bar")) {
            tooltip.classList.remove("visible");
            return;
          }
          const date = target.getAttribute("data-date");
          const tokens = target.getAttribute("data-tokens");
          tooltip.innerHTML =
            '<div class="date">' + date + '</div>' +
            '<div class="tokens">' + tokens + ' tokens</div>';
          // Offset the tooltip so it sits above/right of the cursor and
          // doesn't cover the bar itself.
          const x = ev.clientX + 12;
          const y = ev.clientY - 12;
          tooltip.style.left = x + "px";
          tooltip.style.top = y + "px";
          tooltip.classList.add("visible");
        });
        panel.addEventListener("mouseleave", function () {
          tooltip.classList.remove("visible");
        });
      });
    })();
  </script>
</body>
</html>`;
}

function totalCard(label: string, t: TotalsBlock): string {
  return `<div class="card"><div class="label">${escape(label)}</div><div class="value">${formatNumber(t.total_tokens)}</div><div class="label">tokens</div></div>`;
}

// One label/value pair in the compact stats row. `tooltip` is optional — when
// provided, it's surfaced via the native `title` attribute so hovering shows
// the explanation. No JS needed; browsers render this as a tooltip.
function statItem(label: string, value: string, tooltip?: string): string {
  const titleAttr = tooltip ? ` title="${escape(tooltip)}"` : "";
  const cursor = tooltip ? ' style="cursor: help;"' : "";
  return `<div class="stat"${titleAttr}${cursor}><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div></div>`;
}

function renderGroupTable(
  keyHeader: string,
  s: Summary,
  // When provided, each row becomes clickable: clicking it sets the value of
  // the <select> with matching id (e.g. "model") and re-renders the chart.
  selectOnClick?: "model",
  // When true, the key column displays only the last path segment prefixed
  // with ".../", and the full path shows up in a tooltip. Handy for the
  // project table where "/home/mann/..." eats horizontal space.
  shortenPaths?: boolean,
  // Optional map of key → user-message count. When supplied, a "Messages"
  // column is inserted between the key and the token columns.
  messageCounts?: Map<string, number>,
): string {
  if (s.groups.length === 0) {
    return `<p class="empty">No data.</p>`;
  }
  const showMessages = messageCounts !== undefined;
  const rows = s.groups
    .map((g) => {
      const rowAttr = selectOnClick
        ? ` class="clickable" data-select-${selectOnClick}="${escape(g.key)}"`
        : "";
      const keyCell = shortenPaths
        ? `<td title="${escape(g.key)}">${escape(shortenPath(g.key))}</td>`
        : `<td>${escape(g.key)}</td>`;
      const msgCell = showMessages
        ? `<td class="num">${formatNumber(messageCounts!.get(g.key) ?? 0)}</td>`
        : "";
      return `<tr${rowAttr}>
        ${keyCell}
        ${msgCell}
        <td class="num">${formatNumber(g.totals.input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.output_tokens)}</td>
        <td class="num">${formatNumber(g.totals.cache_creation_input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.cache_read_input_tokens)}</td>
        <td class="num">${formatNumber(g.totals.total_tokens)}</td>
      </tr>`;
    })
    .join("");
  const msgHeader = showMessages ? `<th class="num">Messages</th>` : "";
  return `<table>
    <thead>
      <tr>
        <th>${escape(keyHeader)}</th>
        ${msgHeader}
        <th class="num">Input</th>
        <th class="num">Output</th>
        <th class="num">Cache create</th>
        <th class="num">Cache read</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Render an inline-SVG bar chart of tokens per bucket. `bucketDays` controls
 * how many consecutive days each bar covers — 1 for daily, 7 for weekly, etc.
 * We walk the full window (not just days with data) so the chart doesn't lie
 * about "quiet days" by skipping them.
 */
function renderBarChart(
  summary: Summary,
  startMs: number,
  endMs: number,
  bucketDays: number = 1,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Build a map from "YYYY-MM-DD" → total_tokens for O(1) lookup.
  const byDay = new Map(summary.groups.map((g) => [g.key, g.totals.total_tokens]));

  // Each `day` here is actually a bucket — one bar on the chart. When
  // bucketDays === 1 it's literally one day; when it's 7 it's a week's sum.
  // We keep the variable name `days` to minimize downstream churn; the
  // `label` field is what the tooltip displays.
  const days: { key: string; label: string; value: number }[] = [];
  for (let bstart = startMs; bstart <= endMs; bstart += bucketDays * DAY_MS) {
    const bend = Math.min(bstart + (bucketDays - 1) * DAY_MS, endMs);
    let total = 0;
    for (let d = bstart; d <= bend; d += DAY_MS) {
      const key = new Date(d).toISOString().slice(0, 10);
      total += byDay.get(key) ?? 0;
    }
    const startKey = new Date(bstart).toISOString().slice(0, 10);
    const endKey = new Date(bend).toISOString().slice(0, 10);
    const label = bucketDays === 1 ? startKey : `${startKey} to ${endKey}`;
    days.push({ key: startKey, label, value: total });
  }

  const width = 900;
  const height = 180;
  const padding = { top: 10, right: 10, bottom: 30, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const rawMax = Math.max(1, ...days.map((d) => d.value)); // avoid divide-by-zero
  // Round the axis top up to a "nice" number (1/2/5 × 10^n) so tick values
  // like 250k / 500k / 750k / 1M look clean instead of weird fractions.
  const max = niceCeil(rawMax);
  const barW = chartW / days.length;

  // Bar width math: we leave a 1px gap between bars when there's room, but
  // for dense views (e.g. 365 bars in 900px) we shrink the gap so bars don't
  // vanish. Clamped to a minimum of 0.5px so every day is still visible.
  const gap = Math.min(1, barW * 0.2);
  const innerW = Math.max(0.5, barW - gap);

  // Each bar carries data-* attributes so the JS tooltip can read the date
  // and token count without re-parsing the SVG.
  const bars = days
    .map((d, i) => {
      const h = (d.value / max) * chartH;
      const x = padding.left + i * barW;
      const y = padding.top + (chartH - h);
      return `<rect class="bar" x="${x + gap / 2}" y="${y}" width="${innerW}" height="${h}" data-date="${escape(d.label)}" data-tokens="${formatNumber(d.value)}"></rect>`;
    })
    .join("");

  // X-axis labels. For short windows (week, month) we label each bar with
  // its weekday (Mon, Tue, ...). For longer windows that would just repeat
  // endlessly, so we fall back to MM-DD with a stride that keeps labels
  // ~60px apart and always pin the first + last day.
  const weekdayOf = (key: string) =>
    new Date(key + "T00:00:00Z").toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
  const xLabel = (i: number, text: string) => {
    const d = days[i];
    if (!d) return "";
    const x = padding.left + i * barW + barW / 2;
    return `<text x="${x}" y="${height - 10}" text-anchor="middle">${escape(text)}</text>`;
  };

  let labels = "";
  if (bucketDays === 1 && days.length <= 31) {
    // One weekday label per day (only meaningful for daily buckets).
    labels = days.map((d, i) => xLabel(i, weekdayOf(d.key))).join("");
  } else {
    // Pick a stride so labels sit ~60px apart; always include first + last.
    const stride = Math.max(1, Math.ceil(60 / barW));
    const indices = new Set<number>();
    for (let i = 0; i < days.length; i += stride) indices.add(i);
    indices.add(days.length - 1);
    labels = Array.from(indices)
      .map((i) => xLabel(i, days[i]!.key.slice(5)))
      .join("");
  }

  // Y-axis: 5 evenly-spaced ticks from 0 → max. Each tick gets a faint
  // horizontal gridline across the chart + a compact label like "1.2M".
  const tickCount = 4; // 5 values: 0, max/4, max/2, 3max/4, max
  const yTicks: string[] = [];
  const gridLines: string[] = [];
  for (let i = 0; i <= tickCount; i += 1) {
    const frac = i / tickCount;
    const value = max * frac;
    const y = padding.top + chartH * (1 - frac);
    yTicks.push(
      `<text x="${padding.left - 8}" y="${y + 3}" text-anchor="end">${escape(formatCompact(value))}</text>`,
    );
    if (i > 0) {
      gridLines.push(
        `<line class="grid" x1="${padding.left}" y1="${y}" x2="${padding.left + chartW}" y2="${y}" />`,
      );
    }
  }
  const yLabel = yTicks.join("");
  const grid = gridLines.join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    ${grid}
    <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartH}" />
    <line class="axis" x1="${padding.left}" y1="${padding.top + chartH}" x2="${padding.left + chartW}" y2="${padding.top + chartH}" />
    ${bars}
    ${labels}
    ${yLabel}
  </svg>`;
}

/**
 * Round `n` up to the nearest "nice" multiplier times a power of 10. We use a
 * fairly granular set of multipliers so the chart top sits just above the
 * tallest bar (e.g. raw max 51M → 60M, not 100M) while still yielding clean
 * quarter-point tick labels.
 */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const d = n / pow;
  const steps = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
  const nice = steps.find((s) => d <= s) ?? 10;
  return nice * pow;
}

/** Short human-readable number for axis labels. 1_234_567 → "1.2M". */
function formatCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
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

/**
 * "/home/mann/token-count/packages/cli" → ".../packages/cli" when the path
 * is deep, ".../token-count" when it's just under $HOME. We keep the last
 * two segments if they exist, because "packages/cli" is more meaningful
 * than just "cli". Non-path-looking keys are returned unchanged.
 */
function shortenPath(p: string): string {
  if (!p.includes("/")) return p;
  const parts = p.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return p;
  const last = parts[parts.length - 1]!;
  // If the immediate parent is "packages" (or similar scoping dir), include
  // it so e.g. "packages/cli" vs "packages/core" stays distinguishable.
  if (parts.length >= 2 && parts[parts.length - 2] === "packages") {
    return `.../${parts[parts.length - 2]}/${last}`;
  }
  return `.../${last}`;
}
