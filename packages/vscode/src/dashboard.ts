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
import * as fs from "node:fs";
import {
  dayKey,
  monthOf,
  promptsJsonlPath,
  readAllPrompts,
  readAllRecords,
  startOfDayMs,
  summarize,
  usageJsonlPath,
  weekday,
  type Summary,
  type TotalsBlock,
} from "@token-count/core";
import { useLocalTimezone } from "./format.js";

// Module-level cache of the last rendered dashboard HTML. Survives panel
// close/reopen within the same VSCode session, so closing the dashboard
// and immediately reopening it is effectively free when nothing has
// changed since.
//
// Cache key components — any of these changing forces a rebuild:
//   - usageMtime / promptsMtime: a new record/prompt was appended.
//   - localTime: the user toggled `tokenCount.useLocalTimezone`, which
//     changes day boundaries everywhere.
//
// We deliberately don't track byte size or content hashes — mtime is
// sufficient because the data files are append-only (per CLAUDE.md);
// any new content guarantees a newer mtime.
interface DashboardCache {
  html: string;
  usageMtime: number;
  promptsMtime: number;
  localTime: boolean;
}
let dashboardCache: DashboardCache | undefined;

/**
 * Modification time of a file in ms, or 0 if the file doesn't exist
 * yet. Returning 0 (rather than throwing) lets the cache key be stable
 * for fresh installs that haven't yet written usage.jsonl.
 */
function mtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export class DashboardPanel {
  // Static singleton — we don't want multiple dashboard panels fighting for
  // the same data.
  private static current: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  // True until the panel has shown its first real (non-loading) frame.
  // Used to gate the loading animation: we always show it on the first
  // paint of a new panel (covers "open after close", which is the case
  // the user noticed was missing the loader), but skip it for reveals
  // of an already-painted panel and for file-watcher refreshes — those
  // already have visible content and a loader flash would just disrupt
  // the user's view.
  private firstPaint = true;

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
   * whenever the file changes (via FileSystemWatcher), and on every panel
   * open / reveal.
   *
   * Two paths through this function:
   *
   * 1. **First paint of a new panel** (firstPaint === true). The webview
   *    is empty, so we always show the loading animation first — even
   *    on a cache hit — and hold it for a minimum display time so the
   *    animation is actually visible. Then we swap in the real HTML.
   *    This covers both "open for the first time" and "close + reopen".
   *
   * 2. **Subsequent refreshes** (firstPaint === false): file-watcher
   *    updates and reveals of an already-painted panel. The webview
   *    already has visible content — flashing the loader here would
   *    disrupt the user's view. We swap in the new HTML directly.
   *
   * Uses a module-level cache keyed on file mtimes + the localTime
   * setting — if nothing has changed since the last render, we reuse
   * the cached HTML string and skip the rebuild work entirely. The
   * cache survives panel close/reopen within the same VSCode session.
   */
  refresh(): void {
    try {
      const usageMtime = mtimeMs(usageJsonlPath());
      const promptsMtime = mtimeMs(promptsJsonlPath());
      const localTime = useLocalTimezone();

      // Build (or reuse) the real HTML. Cheap on cache hits.
      const buildReal = (): string => {
        if (
          dashboardCache &&
          dashboardCache.usageMtime === usageMtime &&
          dashboardCache.promptsMtime === promptsMtime &&
          dashboardCache.localTime === localTime
        ) {
          return dashboardCache.html;
        }
        const records = readAllRecords();
        const prompts = readAllPrompts();
        const html = renderHtml(records, prompts);
        dashboardCache = { html, usageMtime, promptsMtime, localTime };
        return html;
      };

      if (!this.firstPaint) {
        // Path 2: panel already showing real content. Just swap.
        this.panel.webview.html = buildReal();
        return;
      }

      // Path 1: new panel. Show loader, then swap to real after a
      // minimum display time so the user actually sees the animation
      // even when the build is fast (cache hit ≈ 0ms, cold ≈ 100ms).
      // 600ms gives the orange dots roughly half a pulse cycle and is
      // long enough to register the quote without feeling slow.
      this.panel.webview.html = renderLoading();
      this.firstPaint = false;
      const startTs = Date.now();
      const MIN_LOADING_MS = 600;

      // Defer the heavy work to setImmediate so the webview has a tick
      // to actually paint the loading frame before we lock the event
      // loop building the dashboard HTML.
      setImmediate(() => {
        if (DashboardPanel.current !== this) return;
        let html: string;
        try {
          html = buildReal();
        } catch (err) {
          html = renderError(err);
        }
        const elapsed = Date.now() - startTs;
        const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
        setTimeout(() => {
          if (DashboardPanel.current !== this) return;
          try {
            this.panel.webview.html = html;
          } catch {
            /* webview disposed mid-build — nothing to do. */
          }
        }, remaining);
      });
    } catch (err) {
      try {
        this.panel.webview.html = renderError(err);
      } catch {
        /* webview disposed — nothing to do. */
      }
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

  // Read the user's `tokenCount.useLocalTimezone` setting once. Threaded
  // through every summarize() call below and into the chart renderers so
  // day boundaries, x-axis labels, and the heatmap grid all agree.
  const localTime = useLocalTimezone();

  // "Today" = midnight in the chosen timezone, expressed as ms. We keep
  // the variable name `startOfTodayUTC` for legacy reasons (lots of math
  // below references it); when localTime is true, it's actually local
  // midnight, not UTC. Renaming would churn ~30 lines for no gain.
  const startOfTodayUTC = startOfDayMs(Date.now(), localTime);

  // --- Totals shown in the summary cards (unchanged). ---------------------
  const sevenDaysAgo = startOfTodayUTC - 6 * DAY_MS;
  const today = summarize(records, {
    groupBy: "day",
    since: new Date(startOfTodayUTC),
    localTime,
  });
  const week = summarize(records, {
    groupBy: "day",
    since: new Date(sevenDaysAgo),
    localTime,
  });
  const allTime = summarize(records, { groupBy: "day", localTime });
  const byModel = summarize(records, { groupBy: "model" });
  const byProject = summarize(records, { groupBy: "project" });

  // Per-card prompt counts. Same windows as the token totals above so
  // the cards can toggle between tokens and messages without recomputing
  // anything client-side.
  const promptsToday = prompts.filter(
    (p) => Date.parse(p.ts) >= startOfTodayUTC,
  ).length;
  const promptsWeek = prompts.filter(
    (p) => Date.parse(p.ts) >= sevenDaysAgo,
  ).length;
  const promptsAllTime = prompts.length;

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

  // --- Pre-grouped record/prompt indexes. ---------------------------------
  // The dashboard renders a panel for every (range × model × project ×
  // chart × metric) combination. Without indexes, each panel re-scans the
  // full records array twice (once per filter), which becomes the
  // dominant cost when the cross-product is hundreds of panels deep. The
  // maps below let buildPanel pick a record/prompt subset in O(1)
  // instead of O(N).
  //
  // The intersection key uses "\x1f" (ASCII unit separator) as a
  // delimiter so it can't ever collide with a real model name or path.
  const SEP = "\x1f";
  const recordsByModel = new Map<string, typeof records>();
  const recordsByProject = new Map<string, typeof records>();
  const recordsByModelProject = new Map<string, typeof records>();
  for (const rec of records) {
    let arr = recordsByModel.get(rec.model);
    if (!arr) { arr = []; recordsByModel.set(rec.model, arr); }
    arr.push(rec);

    arr = recordsByProject.get(rec.cwd);
    if (!arr) { arr = []; recordsByProject.set(rec.cwd, arr); }
    arr.push(rec);

    const xKey = rec.model + SEP + rec.cwd;
    arr = recordsByModelProject.get(xKey);
    if (!arr) { arr = []; recordsByModelProject.set(xKey, arr); }
    arr.push(rec);
  }
  // Same idea for prompts. Prompts don't carry a model field, so the
  // model-aware indexes use primaryModelBySession to attribute each
  // prompt to a model — same heuristic as messagesByModel above.
  const promptsByProject = new Map<string, typeof prompts>();
  const promptsByModel = new Map<string, typeof prompts>();
  const promptsByModelProject = new Map<string, typeof prompts>();
  for (const p of prompts) {
    let arr = promptsByProject.get(p.cwd);
    if (!arr) { arr = []; promptsByProject.set(p.cwd, arr); }
    arr.push(p);

    const m = primaryModelBySession.get(p.session_id);
    if (m) {
      arr = promptsByModel.get(m);
      if (!arr) { arr = []; promptsByModel.set(m, arr); }
      arr.push(p);

      const xKey = m + SEP + p.cwd;
      arr = promptsByModelProject.get(xKey);
      if (!arr) { arr = []; promptsByModelProject.set(xKey, arr); }
      arr.push(p);
    }
  }
  // Set of (model, project) pairs that actually have data — used to
  // skip empty intersection panels in the cross-product loop. Both
  // records and prompts contribute, so a project with zero token records
  // but a few prompts (e.g. interrupted sessions) still gets a panel.
  const nonEmptyIntersections = new Set<string>();
  for (const k of recordsByModelProject.keys()) nonEmptyIntersections.add(k);
  for (const k of promptsByModelProject.keys()) nonEmptyIntersections.add(k);

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
  // Snap to the start of the earliest day in the chosen timezone, so
  // chart x-axes line up cleanly with the rest of the day buckets.
  const earliestDayUTC = startOfDayMs(earliestMs, localTime);
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

  // Default selection: past year. The heatmap is the default chart and
  // it's most informative at the year-at-a-glance scale; matching the
  // dropdown to that gives the best first impression on open.
  const defaultId = "year";

  const rangeOptions: { value: string; label: string }[] = ranges
    .map((r) => ({ value: r.id, label: r.label }));

  // --- Model selector. ----------------------------------------------------
  // Sentinel value "__all__" means "don't filter by model". We use a reserved
  // string instead of an empty one so it's impossible to collide with a real
  // model name like `claude-opus-4-7`.
  const ALL_MODELS = "__all__";
  const modelList = Array.from(new Set(records.map((r) => r.model))).sort();
  const modelOptions: { value: string; label: string }[] = [
    { value: ALL_MODELS, label: "All models" },
    ...modelList.map((m) => ({ value: m, label: m })),
  ];

  // Chart-type toggle. "bars" is the historical default; "line" draws a
  // connected line with an area fill and hover dots on each data point;
  // "heatmap" is a GitHub-style calendar grid (weeks-as-columns, days as
  // rows) tinted in the Claude orange palette. Rendered as a segmented
  // control, not a dropdown, so the active mode is visible at a glance
  // and switching is one click.
  const chartTypes = ["heatmap", "bars", "line"] as const;
  const defaultChart: (typeof chartTypes)[number] = "heatmap";
  // Display label per chart type. `as const` plus the `Record` type pin the
  // map's keys to exactly the chartTypes tuple, so TS will flag us if we
  // ever add a new chart type and forget to give it a button label.
  const chartLabels: Record<(typeof chartTypes)[number], string> = {
    bars: "Bars",
    line: "Line",
    heatmap: "Heatmap",
  };
  const chartToggle = chartTypes
    .map(
      (c) =>
        `<button type="button" class="toggle-btn${c === defaultChart ? " active" : ""}" data-chart="${c}">${chartLabels[c]}</button>`,
    )
    .join("");

  // Metric toggle — tokens (historical default) vs. user-message counts.
  // Messages are attributed to models via each session's primary model, the
  // same heuristic used by the by-model table further down the page.
  const metrics = ["tokens", "messages"] as const;
  const defaultMetric: (typeof metrics)[number] = "tokens";
  const metricToggle = metrics
    .map(
      (m) =>
        `<button type="button" class="toggle-btn${m === defaultMetric ? " active" : ""}" data-metric="${m}">${m === "tokens" ? "Tokens" : "Messages"}</button>`,
    )
    .join("");
  // Second copy of the same toggle, with its own id, used to drive the
  // project pie chart below. Kept separate so flipping one doesn't affect
  // the other — the line/bar chart lives up top with its own filters.
  const pieMetricToggle = metrics
    .map(
      (m) =>
        `<button type="button" class="toggle-btn${m === defaultMetric ? " active" : ""}" data-metric="${m}">${m === "tokens" ? "Tokens" : "Messages"}</button>`,
    )
    .join("");

  // Project pie data. Sorted descending, top 8 kept as-is and the tail is
  // rolled up into an "Other" wedge so the chart stays readable no matter
  // how many projects you've touched.
  const PIE_TOP_N = 8;
  const topNWithOther = (pairs: [string, number][]): [string, number][] => {
    const sorted = [...pairs].sort((a, b) => b[1] - a[1]);
    if (sorted.length <= PIE_TOP_N) return sorted.filter(([, v]) => v > 0);
    const top = sorted.slice(0, PIE_TOP_N);
    const rest = sorted.slice(PIE_TOP_N);
    const otherSum = rest.reduce((s, [, v]) => s + v, 0);
    if (otherSum > 0) top.push(["Other", otherSum]);
    return top.filter(([, v]) => v > 0);
  };
  const pieTokens = topNWithOther(
    byProject.groups.map((g): [string, number] => [g.key, g.totals.total_tokens]),
  );
  const pieMessages = topNWithOther(
    Array.from(messagesByProject.entries()),
  );

  // Project filter. Mirrors the model filter: a dropdown with an "All"
  // sentinel plus every distinct cwd we've seen. We pre-render every
  // (model × project) combination — including both filters set at once
  // — so a user can ask "Opus usage in token-count" and get the
  // intersection rather than having one filter reset the other. Empty
  // intersections render as a chart with no bars (not a special "empty"
  // state) so the axes are still in the expected position.
  const ALL_PROJECTS = "__all__";
  const projectList = Array.from(new Set(records.map((r) => r.cwd))).sort();
  // Project labels show the shortened path but each option carries the
  // full path as a `title` (rendered via the `<li>` title attribute) so
  // hovering surfaces the absolute cwd for disambiguation.
  const projectOptions: { value: string; label: string; title?: string }[] = [
    { value: ALL_PROJECTS, label: "All projects" },
    ...projectList.map((p) => ({
      value: p,
      label: shortenPath(p),
      title: p,
    })),
  ];

  // Helper that builds a single chart panel. Factored out so we can emit two
  // families of panels (per-model and per-project) without duplicating the
  // byDay + svg logic.
  const modelKeys = [ALL_MODELS, ...modelList];

  const buildPanel = (
    r: (typeof ranges)[number],
    m: string,
    pk: string,
    c: (typeof chartTypes)[number],
    metric: (typeof metrics)[number],
  ): string => {
    // Tokens: sum total_tokens per day from filtered records. Messages:
    // count prompts per day. We pick the right pre-built subset via the
    // record/prompt indexes (O(1)) instead of re-filtering the full
    // arrays per panel. Same data window for all chart types — driven
    // by the timeframe selector.
    let byDay: Map<string, number>;
    if (metric === "tokens") {
      let scope: typeof records;
      if (m === ALL_MODELS && pk === ALL_PROJECTS) {
        scope = records;
      } else if (m === ALL_MODELS) {
        scope = recordsByProject.get(pk) ?? [];
      } else if (pk === ALL_PROJECTS) {
        scope = recordsByModel.get(m) ?? [];
      } else {
        scope = recordsByModelProject.get(m + SEP + pk) ?? [];
      }
      const s = summarize(scope, {
        groupBy: "day",
        since: new Date(r.startMs),
        localTime,
      });
      byDay = new Map(s.groups.map((g) => [g.key, g.totals.total_tokens]));
    } else {
      // Pick the prompt subset the same way; then walk it once instead
      // of the full prompts array.
      let scope: typeof prompts;
      if (m === ALL_MODELS && pk === ALL_PROJECTS) {
        scope = prompts;
      } else if (m === ALL_MODELS) {
        scope = promptsByProject.get(pk) ?? [];
      } else if (pk === ALL_PROJECTS) {
        scope = promptsByModel.get(m) ?? [];
      } else {
        scope = promptsByModelProject.get(m + SEP + pk) ?? [];
      }
      byDay = new Map();
      for (const p of scope) {
        const ts = Date.parse(p.ts);
        if (ts < r.startMs) continue;
        // dayKey honors localTime so message-day buckets line up with the
        // token-day buckets summarize() produces above.
        const day = dayKey(ts, localTime);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
    }
    const unit = metric === "tokens" ? "tokens" : "msgs";
    const hidden =
      r.id === defaultId &&
      m === ALL_MODELS &&
      pk === ALL_PROJECTS &&
      c === defaultChart &&
      metric === defaultMetric
        ? ""
        : " hidden";
    // Dispatch on chart type. Bar + line use `bucketDays` (so the year
    // view rolls up into weekly bars). The heatmap is inherently a daily
    // grid — weekly buckets would defeat the point — so it ignores
    // bucketDays and walks the range one day at a time. All three share
    // the same r.startMs..startOfTodayUTC window so the timeframe
    // selector drives every chart type uniformly.
    let svg: string;
    if (c === "bars") {
      svg = renderBarChart(byDay, r.startMs, startOfTodayUTC, r.bucketDays, unit, localTime);
    } else if (c === "line") {
      svg = renderLineChart(byDay, r.startMs, startOfTodayUTC, r.bucketDays, unit, localTime);
    } else {
      svg = renderHeatmap(byDay, r.startMs, startOfTodayUTC, unit, localTime);
    }
    return `<div class="chart-panel${hidden}" data-range="${r.id}" data-model="${escape(m)}" data-project="${escape(pk)}" data-chart="${c}" data-metric="${metric}">${svg}</div>`;
  };

  // Pre-render panel combinations. The single-filter rows always emit:
  //   - (ALL × ALL):           1 baseline panel set
  //   - (specific × ALL):      one set per known model
  //   - (ALL × specific):      one set per known project
  // Specific × specific intersections only emit when the user actually
  // has data for that pair — the typical user has touched 5–10 of the
  // M*P possible combinations, so this skips the vast majority of empty
  // panels and keeps the DOM size proportional to real activity rather
  // than to the cross-product size.
  const projectKeys = [ALL_PROJECTS, ...projectList];
  const panelParts: string[] = [];
  for (const r of ranges) {
    for (const m of modelKeys) {
      for (const pk of projectKeys) {
        // Skip empty (specific model × specific project) intersections.
        // Single-filter rows always emit so the most common paths
        // through the UI never show a blank state.
        if (
          m !== ALL_MODELS &&
          pk !== ALL_PROJECTS &&
          !nonEmptyIntersections.has(m + SEP + pk)
        ) {
          continue;
        }
        for (const c of chartTypes) {
          for (const metric of metrics) {
            panelParts.push(buildPanel(r, m, pk, c, metric));
          }
        }
      }
    }
  }
  const panels = panelParts.join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Token Count</title>
<style>
  /* Claude-Code-inspired orange palette. Defined once up top so every
     chart / toggle / highlight reads from the same accent. --tc-accent is
     the terracotta that matches Claude Code's branded orange; the
     -strong / -soft variants are pre-computed lighter / darker tints so
     hover and area-fill effects don't need runtime color math. */
  :root {
    --tc-accent: #D97757;
    --tc-accent-strong: #C26240;
    --tc-accent-soft: rgba(217, 119, 87, 0.15);
    /* Heatmap palette: 0 = no activity (faint neutral so the grid is
       still visible on both light and dark themes); 1-4 = increasing
       intensities of the Claude orange. We use rgba on the same hex so
       all four steps share a hue and just differ in opacity. */
    --tc-heatmap-0: rgba(127, 127, 127, 0.14);
    --tc-heatmap-1: rgba(217, 119, 87, 0.30);
    --tc-heatmap-2: rgba(217, 119, 87, 0.55);
    --tc-heatmap-3: rgba(217, 119, 87, 0.80);
    --tc-heatmap-4: #D97757;
  }
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
  /* Clickable summary cards. The whole card is the click target so a
     subtle hover highlight + cursor: pointer makes the affordance
     discoverable without adding visual noise. */
  .totals .card.clickable { cursor: pointer; transition: background 0.12s, border-color 0.12s; }
  .totals .card.clickable:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
    border-color: var(--tc-accent);
  }
  /* Show the focus outline only for keyboard focus (Tab/Enter/Space)
     so mouse clicks don't leave a sticky border after the toggle.
     :focus-visible is the standard knob for this. Orange ring keeps
     the dashboard's accent palette consistent. */
  .totals .card.clickable:focus { outline: none; }
  .totals .card.clickable:focus-visible {
    outline: 1px solid var(--tc-accent);
    outline-offset: -1px;
  }
  /* Metric toggle: the parent .totals carries data-metric="tokens" or
     "messages" and we hide whichever <span> is the inactive metric. The
     two spans live side-by-side in the markup so swapping is a pure CSS
     visibility change — no innerText rewriting needed. */
  .totals[data-metric="tokens"] .metric-messages { display: none; }
  .totals[data-metric="messages"] .metric-tokens { display: none; }
  /* Compact / full number swap. Each value is rendered both ways
     ("43,971,619" + "44M"); the full version is visible by default,
     the compact one shows on hover. Lets the user glance for a magnitude
     without losing the exact figure in the default view. */
  .totals .card .num-compact { display: none; }
  .totals .card.clickable:hover .num-full { display: none; }
  .totals .card.clickable:hover .num-compact { display: inline; }
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
  /* Sortable column headers. Clicking toggles sort direction; the little
     caret beside the label shows which column is currently active and which
     way it's sorted. We keep a baseline faint caret on inactive columns so
     the UI signals "this is clickable" on hover. */
  table.sortable th[data-sort-col] {
    cursor: pointer;
    user-select: none;
  }
  table.sortable th[data-sort-col]:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }
  table.sortable th .sort-indicator {
    display: inline-block;
    margin-left: 4px;
    opacity: 0.35;
    font-size: 10px;
    min-width: 8px;
  }
  table.sortable th.sort-active .sort-indicator {
    opacity: 1;
  }
  .empty { opacity: 0.6; margin: 32px 0; }
  svg .bar { fill: var(--tc-accent); }
  svg .bar:hover { fill: var(--tc-accent-strong); }
  svg .line {
    fill: none;
    stroke: var(--tc-accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  svg .area { fill: var(--tc-accent); fill-opacity: 0.18; }
  svg circle.bar { stroke: var(--vscode-editor-background); stroke-width: 1.5; }
  svg .axis { stroke: var(--vscode-editorWidget-border); }
  svg .grid {
    stroke: var(--vscode-editorWidget-border);
    stroke-opacity: 0.4;
    stroke-dasharray: 2 3;
  }
  svg text { fill: var(--vscode-foreground); font-size: 10px; }

  /* Heatmap (GitHub-style calendar grid).
     The fill is set inline per-cell via the SVG fill attribute pointing
     at one of these CSS variables, so the cell's intensity bucket is
     purely a CSS concern (themes can retint without touching the
     renderer). Bucket 0 (no activity) is a faint neutral so empty cells
     still read as a grid; buckets 1-4 are increasing strengths of the
     Claude orange. */
  svg .heatmap-cell {
    stroke: transparent;
    stroke-width: 1;
    transition: filter 0.1s, stroke 0.1s;
  }
  svg .heatmap-cell:hover {
    filter: brightness(1.15);
    stroke: var(--vscode-foreground);
  }
  svg .hm-label {
    fill: var(--vscode-foreground);
    font-size: 10px;
    opacity: 0.6;
  }
  /* Multi-year heatmap stack. Each year is a wrapper with a heading
     above the SVG; spacing between wrappers separates the year-grids. */
  .hm-year {
    margin-top: 16px;
  }
  .hm-year:first-child {
    margin-top: 0;
  }
  .hm-year-label {
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 4px;
    opacity: 0.85;
  }

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
     so it blends with the active color scheme.

     Layout note: .range-select is a flex row with flex-wrap: wrap and a
     row/column gap. When the panel gets too narrow for all the controls
     to fit on one line, items spill onto a second row with the same
     vertical breathing room (the row-gap, 8px) as the horizontal spacing
     between controls (the column-gap, 16px). Without this, the wrapped
     controls would just butt up against the row above with only
     line-height spacing and look cramped. */
  .range-select {
    margin: 12px 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
  }
  /* Each label+select pair is wrapped in a .range-control span so the
     label can't wrap away from its <select> when the row breaks. The
     span is the flex item; the label/select inside it stay inline. */
  .range-control { display: inline-flex; align-items: center; gap: 6px; }
  .range-control label { white-space: nowrap; }
  /* Custom dropdown built to replace the native <select>. We own the
     popup, so the hover highlight uses the Claude orange instead of
     Chromium's blue and we get consistent styling across platforms. */
  .dropdown { position: relative; display: inline-block; min-width: 110px; }
  .dropdown-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
    padding: 4px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .dropdown-trigger:hover { border-color: var(--tc-accent); }
  .dropdown-trigger:focus { outline: none; }
  .dropdown-trigger:focus-visible {
    outline: 1px solid var(--tc-accent);
    outline-offset: -1px;
  }
  .dropdown-chevron { font-size: 10px; opacity: 0.7; }
  .dropdown-menu {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    min-width: 100%;
    max-height: 280px;
    overflow-y: auto;
    background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    list-style: none;
    margin: 0;
    padding: 4px 0;
    z-index: 100;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .dropdown-menu[hidden] { display: none; }
  .dropdown-menu li {
    padding: 5px 12px;
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    user-select: none;
  }
  /* Hover and the keyboard-active row both light up in Claude orange. */
  .dropdown-menu li:hover,
  .dropdown-menu li.kbd-active {
    background: var(--tc-accent);
    color: #ffffff;
  }
  /* The currently-selected row gets a soft tint when not hovered, so
     users can see at a glance which value is chosen. */
  .dropdown-menu li[aria-selected="true"] {
    background: var(--tc-accent-soft);
  }
  .dropdown-menu li[aria-selected="true"]:hover,
  .dropdown-menu li[aria-selected="true"].kbd-active {
    background: var(--tc-accent);
  }
  .chart-panel.hidden { display: none; }
  /* Empty-state placeholder when the user picks an unused (model × project)
     combination. We don't pre-render panels for empty intersections so the
     normal "all panels hidden" state would otherwise look broken; this
     gives the user a clear, actionable message. */
  .chart-empty {
    padding: 32px 16px;
    text-align: center;
    opacity: 0.7;
    background: var(--vscode-editorWidget-background);
    border: 1px dashed var(--vscode-editorWidget-border);
    border-radius: 6px;
    margin: 12px 0;
  }
  .chart-empty.hidden { display: none; }

  /* Segmented toggle for chart type. Two buttons rendered side-by-side with
     shared borders so they read as one control; the active one fills with
     the VSCode button color. */
  .toggle-group {
    display: inline-flex;
    vertical-align: middle;
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    overflow: hidden;
  }
  .toggle-btn {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: none;
    padding: 4px 12px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    line-height: 1.4;
  }
  .toggle-btn + .toggle-btn {
    border-left: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border));
  }
  .toggle-btn:hover:not(.active) {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }
  .toggle-btn.active {
    background: var(--tc-accent);
    color: #ffffff;
  }
  /* Outline only on keyboard focus, not on click. Orange to match the
     active state and the dropdown focus ring. */
  .toggle-btn:focus { outline: none; }
  .toggle-btn:focus-visible { outline: 1px solid var(--tc-accent); outline-offset: -1px; }

  /* Project pie chart: SVG on the left, color-matched legend on the right.
     Wraps on narrow windows so the legend slides under the pie. */
  .pie-panel.hidden { display: none; }
  .pie-chart {
    display: flex;
    gap: 24px;
    align-items: center;
    margin: 12px 0 24px;
    padding: 16px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 6px;
    flex-wrap: wrap;
  }
  .pie-chart svg { flex-shrink: 0; }
  .pie-chart .slice {
    stroke: var(--vscode-editor-background);
    stroke-width: 2;
    cursor: pointer;
    transition: transform 0.18s ease-out, opacity 0.1s, filter 0.15s, stroke-width 0.15s;
  }
  /* Hover-explode: slide the wedge outward along its precomputed angle
     bisector. --ex/--ey are set inline per-wedge in renderProjectPie.
     Fallback to 0 so the single-slice donut (which doesn't set them) stays
     put on hover. */
  .pie-chart .slice:hover {
    transform: translate(var(--ex, 0px), var(--ey, 0px));
    filter: brightness(1.08);
  }
  /* Applied by JS when the user clicks a project row — also explodes the
     wedge (same --ex/--ey vector) plus brightens + drop-shadows it so the
     selection stands out whether or not the pointer is hovering. The
     drop-shadow tint picks up the Claude orange so the highlight reads as
     "selected" against the multicolor pie. */
  .pie-chart .slice.highlighted {
    transform: translate(var(--ex, 0px), var(--ey, 0px));
    filter: brightness(1.12) drop-shadow(0 0 5px rgba(217, 119, 87, 0.55));
  }
  /* Donut center label: big total + compact unit beneath. pointer-events
     off so the text doesn't eat hover events on wedge edges behind it. */
  .pie-chart .donut-total {
    font-size: 24px;
    font-weight: 600;
    fill: var(--vscode-foreground);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .pie-chart .donut-unit {
    font-size: 10px;
    fill: var(--vscode-foreground);
    opacity: 0.6;
    text-transform: uppercase;
    letter-spacing: 1px;
    pointer-events: none;
  }
  /* Legend uses CSS grid with auto-fit so the number of columns adapts to
     the dashboard width: narrow pane → 1 column, wide → 3-4. Each cell is
     at least 260px so names + numbers fit without clipping. Inside a cell
     the name and value sit next to each other (no margin-left:auto push)
     so there's no dead space between them. */
  .pie-legend {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 4px 24px;
    flex: 1;
    min-width: 260px;
  }
  .pie-legend li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    line-height: 1.6;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid transparent;
    transition: background 0.1s, border-color 0.15s;
  }
  /* Clickable legend rows — cursor + subtle hover tint so users discover
     that the legend is interactive. "Other" stays non-clickable (no class)
     since it's an aggregate of many projects. */
  .pie-legend li.clickable { cursor: pointer; }
  .pie-legend li.clickable:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }
  /* Applied by JS when a project is selected (via legend, slice, or the
     filter dropdown). Tinted with the Claude accent so it matches the
     wedge drop-shadow on the pie — the two highlights read as one thing. */
  .pie-legend li.highlighted {
    background: var(--tc-accent-soft);
    border-color: var(--tc-accent);
  }
  .pie-legend .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .pie-legend .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  .pie-legend .val {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

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
     when usage.jsonl changes (the extension watches the file). Tinted with
     the Claude orange so it ties into the rest of the palette. */
  .live-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--tc-accent);
    animation: tc-pulse 1.6s ease-in-out infinite;
  }
  @keyframes tc-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(217, 119, 87, 0.7); }
    70%  { box-shadow: 0 0 0 8px rgba(217, 119, 87, 0); }
    100% { box-shadow: 0 0 0 0 rgba(217, 119, 87, 0); }
  }
</style>
</head>
<body>
  <h1>Token Count<span class="live-dot" title="Live — auto-refreshes as you use Claude Code" aria-hidden="true"></span></h1>
  ${records.length === 0 ? `<p class="empty">No usage recorded yet. Start a Claude Code session — records show up here automatically.</p>` : ""}
  <div class="totals" id="totals" data-metric="tokens">
    ${totalCard("Today", today.totals, promptsToday)}
    ${totalCard("Last 7 days", week.totals, promptsWeek)}
    ${totalCard("All time", allTime.totals, promptsAllTime)}
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
    <span class="range-control"><label for="range">Timeframe:</label>${dropdown("range", "Timeframe", rangeOptions, defaultId)}</span>
    <span class="range-control"><label for="model">Model:</label>${dropdown("model", "Model", modelOptions, ALL_MODELS)}</span>
    <span class="range-control"><label for="project">Project:</label>${dropdown("project", "Project", projectOptions, ALL_PROJECTS)}</span>
    <span class="toggle-group" role="group" aria-label="Chart type" id="chart-toggle">${chartToggle}</span>
    <span class="toggle-group" role="group" aria-label="Metric" id="metric-toggle">${metricToggle}</span>
  </div>
  ${panels}
  <!-- Fallback shown when the user's filter combination has no
       pre-rendered panel — i.e. they picked a (model × project) pair
       they've never used together. Stays hidden by default; the JS
       update() function flips it on whenever no chart-panel matches. -->
  <div id="chart-empty" class="chart-empty hidden">No data for this combination — try a different model or project.</div>
  <div id="chart-tooltip" role="tooltip" aria-hidden="true"></div>

  <h2 id="by-model">By model</h2>
  ${renderGroupTable("Model", byModel, "model", false, messagesByModel)}

  <h2 id="project-pie">Project breakdown</h2>
  <div class="range-select">
    <span class="toggle-group" role="group" aria-label="Metric" id="pie-metric-toggle">${pieMetricToggle}</span>
  </div>
  <div class="pie-panel" data-metric="tokens">${renderProjectPie(pieTokens, "tokens")}</div>
  <div class="pie-panel hidden" data-metric="messages">${renderProjectPie(pieMessages, "msgs")}</div>

  <h2>By project</h2>
  ${renderGroupTable("Project", byProject, "project", true, messagesByProject)}

  <script>
    // Custom dropdown wiring. Each .dropdown element gets:
    //   - A "value" getter/setter so existing code that does
    //     rangeSel.value = ... keeps working without changes.
    //   - Click on trigger toggles the menu open/closed.
    //   - Click on an option selects it, fires a "change" event on the
    //     root, and closes the menu — same semantics as native select.
    //   - Click outside any open dropdown closes them all.
    //   - Keyboard: Space/Enter on the trigger opens, ArrowUp/Down
    //     navigates, Enter selects, Escape closes.
    //
    // Replacing the native select was needed because the popup hover
    // highlight is partly browser/OS-controlled and CSS overrides
    // (option:hover, accent-color, etc.) couldn't reliably beat
    // Chromium's default blue.
    (function () {
      function closeAllDropdowns() {
        document.querySelectorAll(".dropdown-menu:not([hidden])").forEach(function (m) {
          m.setAttribute("hidden", "");
          const t = m.parentElement.querySelector(".dropdown-trigger");
          if (t) t.setAttribute("aria-expanded", "false");
          m.querySelectorAll("li.kbd-active").forEach(function (li) {
            li.classList.remove("kbd-active");
          });
        });
      }
      document.querySelectorAll(".dropdown").forEach(function (el) {
        const trigger = el.querySelector(".dropdown-trigger");
        const menu = el.querySelector(".dropdown-menu");
        const labelEl = trigger.querySelector(".dropdown-label");
        const items = menu.querySelectorAll("li[data-value]");

        // Define a "value" property so the rest of the dashboard code
        // can read + write it just like a native select. The setter
        // does NOT dispatch a change event (matching native semantics
        // — only user-initiated selection fires "change").
        Object.defineProperty(el, "value", {
          get: function () { return el.dataset.value; },
          set: function (v) {
            el.dataset.value = v;
            items.forEach(function (li) {
              const match = li.getAttribute("data-value") === v;
              li.setAttribute("aria-selected", match ? "true" : "false");
              if (match) labelEl.textContent = li.textContent;
            });
          },
          configurable: true,
        });

        // Trigger click: toggle menu, closing any other open ones first.
        trigger.addEventListener("click", function (ev) {
          ev.stopPropagation();
          const isOpen = !menu.hasAttribute("hidden");
          closeAllDropdowns();
          if (!isOpen) {
            menu.removeAttribute("hidden");
            trigger.setAttribute("aria-expanded", "true");
          }
        });

        // Option click: select + fire change + close.
        items.forEach(function (li) {
          li.addEventListener("click", function (ev) {
            ev.stopPropagation();
            el.value = li.getAttribute("data-value");
            el.dispatchEvent(new Event("change"));
            closeAllDropdowns();
          });
          li.addEventListener("mouseenter", function () {
            // Mouse hover clears any keyboard-active highlight so the
            // two indicators don't fight.
            menu.querySelectorAll("li.kbd-active").forEach(function (x) {
              x.classList.remove("kbd-active");
            });
          });
        });

        // Keyboard nav on the trigger.
        trigger.addEventListener("keydown", function (ev) {
          const isOpen = !menu.hasAttribute("hidden");
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            if (!isOpen) {
              closeAllDropdowns();
              menu.removeAttribute("hidden");
              trigger.setAttribute("aria-expanded", "true");
            }
            // Move keyboard cursor.
            const list = Array.prototype.slice.call(items);
            let active = list.findIndex(function (x) { return x.classList.contains("kbd-active"); });
            if (active === -1) {
              active = list.findIndex(function (x) { return x.getAttribute("aria-selected") === "true"; });
              if (active === -1) active = 0;
            } else if (ev.key === "ArrowDown") {
              active = Math.min(list.length - 1, active + 1);
            } else if (ev.key === "ArrowUp") {
              active = Math.max(0, active - 1);
            } else if (ev.key === "Enter" || ev.key === " ") {
              // Confirm on Enter/Space when already open with a kbd-active row.
              if (isOpen) {
                list[active].click();
                return;
              }
            }
            list.forEach(function (x) { x.classList.remove("kbd-active"); });
            list[active].classList.add("kbd-active");
            list[active].scrollIntoView({ block: "nearest" });
          } else if (ev.key === "Escape") {
            closeAllDropdowns();
          }
        });
      });

      // Click outside: close every open dropdown.
      document.addEventListener("click", function (ev) {
        if (!ev.target.closest(".dropdown")) closeAllDropdowns();
      });
    })();

    // Timeframe + model + chart-type toggle. All (range × model × chart)
    // panels are already in the DOM; the three dropdowns just flip the
    // "hidden" class on everything but the one whose three data-attributes
    // all match. No IPC to the extension, so switching is instant.
    (function () {
      const rangeSel = document.getElementById("range");
      const modelSel = document.getElementById("model");
      const projectSel = document.getElementById("project");
      const chartBtns = document.querySelectorAll("#chart-toggle .toggle-btn");
      const metricBtns = document.querySelectorAll("#metric-toggle .toggle-btn");
      const panels = document.querySelectorAll(".chart-panel");
      const ALL = "__all__";
      // Each segmented toggle stores its value as the "active" class on one
      // of its buttons; read it back by scanning and extracting the named
      // data attribute.
      function activeValue(nodes, attr, fallback) {
        for (let i = 0; i < nodes.length; i += 1) {
          if (nodes[i].classList.contains("active")) {
            return nodes[i].getAttribute(attr);
          }
        }
        return fallback;
      }
      // Highlight (or un-highlight) a project across both pie variants —
      // both the slice and its legend row get the "highlighted" class. The
      // full project path is stored on each as data-key so we don't have to
      // deal with shortened display names.
      function highlightPie(projectKey) {
        document.querySelectorAll(".pie-panel .slice").forEach(function (s) {
          const match = projectKey && s.getAttribute("data-key") === projectKey;
          s.classList.toggle("highlighted", !!match);
        });
        document.querySelectorAll(".pie-legend .legend-item").forEach(function (li) {
          const match = projectKey && li.getAttribute("data-key") === projectKey;
          li.classList.toggle("highlighted", !!match);
        });
      }
      // Empty-state element that appears when no panel matches (i.e.
      // user picked an unused (model × project) combination — those
      // intersections aren't pre-rendered as a perf win).
      const emptyState = document.getElementById("chart-empty");
      function update() {
        const r = rangeSel.value;
        const m = modelSel.value;
        const pj = projectSel.value;
        const c = activeValue(chartBtns, "data-chart", "heatmap");
        const metric = activeValue(metricBtns, "data-metric", "tokens");
        let anyMatch = false;
        panels.forEach(function (p) {
          const match =
            p.getAttribute("data-range") === r &&
            p.getAttribute("data-model") === m &&
            p.getAttribute("data-project") === pj &&
            p.getAttribute("data-chart") === c &&
            p.getAttribute("data-metric") === metric;
          if (match) anyMatch = true;
          p.classList.toggle("hidden", !match);
        });
        if (emptyState) emptyState.classList.toggle("hidden", anyMatch);
        // Pie highlight follows the project filter: reflect the current
        // project selection on the pies so the two views stay in sync.
        highlightPie(pj !== ALL ? pj : null);
      }
      rangeSel.addEventListener("change", update);
      // Model and project filters are independent — every (model ×
      // project) combination has its own panel, so the chart can show
      // their intersection (e.g. "Opus usage in /path/to/project")
      // without one filter resetting the other.
      modelSel.addEventListener("change", update);
      projectSel.addEventListener("change", update);
      function wireToggle(btns) {
        btns.forEach(function (btn) {
          btn.addEventListener("click", function () {
            btns.forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            update();
          });
        });
      }
      wireToggle(chartBtns);
      wireToggle(metricBtns);

      // Clicking a row in a clickable table sets the matching dropdown, resets
      // the other filter to "all", and scrolls the chart into view. Project
      // rows also highlight the matching slice in the pie chart.
      document.querySelectorAll("tr.clickable").forEach(function (row) {
        row.addEventListener("click", function () {
          const model = row.getAttribute("data-select-model");
          const project = row.getAttribute("data-select-project");
          if (model) {
            modelSel.value = model;
            projectSel.value = ALL;
          } else if (project) {
            projectSel.value = project;
            modelSel.value = ALL;
          } else {
            return;
          }
          update();
          const heading = document.getElementById("tokens-per-day");
          if (heading) heading.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      // Clicking a pie slice — or its matching legend row — filters the top
      // chart by that project. Same behavior as clicking its row in the By
      // project table. The "Other" aggregate wedge/legend row is skipped
      // because it isn't a single real project. Only keys that exist as an
      // option in the project dropdown are actionable (guards against
      // stale data). Clicking the already-selected project toggles back to
      // "all" so users can easily clear the filter from the pie.
      function selectProjectFromPie(key) {
        if (!key || key === "Other") return;
        // Custom dropdowns expose options as <li data-value> rather than
        // the native <option> elements, so we lookup against those.
        const opts = projectSel.querySelectorAll("li[data-value]");
        const hasOption = Array.from(opts).some(function (o) {
          return o.getAttribute("data-value") === key;
        });
        if (!hasOption) return;
        if (projectSel.value === key) {
          projectSel.value = ALL;
        } else {
          projectSel.value = key;
          modelSel.value = ALL;
        }
        update();
        const heading = document.getElementById("tokens-per-day");
        if (heading) heading.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      document.querySelectorAll(".pie-panel .slice").forEach(function (slice) {
        slice.addEventListener("click", function () {
          selectProjectFromPie(slice.getAttribute("data-key"));
        });
      });
      document.querySelectorAll(".pie-legend .legend-item.clickable").forEach(function (li) {
        li.addEventListener("click", function () {
          selectProjectFromPie(li.getAttribute("data-key"));
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
          // Bars (rects) and line-chart points (circles) use class="bar"
          // as the hover marker; heatmap cells use class="heatmap-cell"
          // (different class so they don't pick up the bar's solid-orange
          // fill rule). Either one triggers the tooltip; anything else
          // hides it.
          if (
            !(target instanceof Element) ||
            !(
              target.classList.contains("bar") ||
              target.classList.contains("heatmap-cell")
            )
          ) {
            tooltip.classList.remove("visible");
            return;
          }
          const date = target.getAttribute("data-date");
          const value = target.getAttribute("data-value");
          tooltip.innerHTML =
            '<div class="date">' + date + '</div>' +
            '<div class="tokens">' + value + '</div>';
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

    // Summary cards (Today / Last 7 days / All time): clicking any card
    // flips all three between the tokens view and the messages view.
    // Both numbers are pre-rendered inside each card; CSS picks which
    // span is visible based on data-metric on the parent #totals.
    (function () {
      const totals = document.getElementById("totals");
      if (!totals) return;
      const cards = totals.querySelectorAll(".card.clickable");
      const flip = function () {
        const next = totals.getAttribute("data-metric") === "tokens"
          ? "messages"
          : "tokens";
        totals.setAttribute("data-metric", next);
      };
      cards.forEach(function (card) {
        card.addEventListener("click", flip);
        // Keyboard parity with the role="button" semantics — Enter or
        // Space should activate the card just like a click does.
        card.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            flip();
          }
        });
      });
    })();

    // Project pie: Tokens/Messages toggle. Flips the .hidden class between
    // the two pre-rendered <div class="pie-panel"> variants.
    (function () {
      const toggle = document.getElementById("pie-metric-toggle");
      if (!toggle) return;
      const btns = toggle.querySelectorAll(".toggle-btn");
      const panels = document.querySelectorAll(".pie-panel");
      btns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          btns.forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          const m = btn.getAttribute("data-metric");
          panels.forEach(function (p) {
            p.classList.toggle("hidden", p.getAttribute("data-metric") !== m);
          });
        });
      });
    })();

    // Sortable tables (By model, By project). Clicking a column header sorts
    // descending on the first click and flips to ascending on the next. The
    // <th>'s data-sort-type tells us "string" (localeCompare) or "number"
    // (parseFloat); each <td>'s data-sort-value holds the raw value so we
    // don't have to re-parse "1,234,567"-style display strings. We store the
    // active column + direction on the <table> itself so repeat clicks on
    // the same column toggle correctly.
    (function () {
      const tables = document.querySelectorAll("table.sortable");
      tables.forEach(function (table) {
        const headers = table.querySelectorAll("th[data-sort-col]");
        headers.forEach(function (th) {
          th.addEventListener("click", function () {
            const col = th.getAttribute("data-sort-col");
            const type = th.getAttribute("data-sort-type") || "string";
            const currentCol = table.getAttribute("data-sort-col");
            const currentDir = table.getAttribute("data-sort-dir");
            // Same column again → flip direction. Otherwise start at "desc"
            // since users almost always want "biggest first" on a fresh sort.
            const dir =
              currentCol === col && currentDir === "desc" ? "asc" : (currentCol === col ? "desc" : "desc");
            table.setAttribute("data-sort-col", col);
            table.setAttribute("data-sort-dir", dir);

            // Update every header's indicator: arrow on the active one, clear
            // on everyone else. We mark the active header with .sort-active
            // so the CSS can bump its opacity.
            headers.forEach(function (h) {
              const ind = h.querySelector(".sort-indicator");
              if (h === th) {
                h.classList.add("sort-active");
                if (ind) ind.textContent = dir === "desc" ? "▼" : "▲";
              } else {
                h.classList.remove("sort-active");
                if (ind) ind.textContent = "";
              }
            });

            // Sort the tbody rows in memory then re-append in the new order.
            // appendChild on an existing node moves it, so we don't have to
            // detach first — the browser handles the reorder.
            const tbody = table.querySelector("tbody");
            if (!tbody) return;
            const rows = Array.from(tbody.querySelectorAll("tr"));
            const colIdx = parseInt(col || "0", 10);
            rows.sort(function (a, b) {
              const aCell = a.children[colIdx];
              const bCell = b.children[colIdx];
              const aVal = aCell ? aCell.getAttribute("data-sort-value") || "" : "";
              const bVal = bCell ? bCell.getAttribute("data-sort-value") || "" : "";
              let cmp;
              if (type === "number") {
                cmp = parseFloat(aVal) - parseFloat(bVal);
              } else {
                cmp = aVal.localeCompare(bVal);
              }
              return dir === "desc" ? -cmp : cmp;
            });
            rows.forEach(function (r) { tbody.appendChild(r); });
          });
        });
      });
    })();

    // Pie-slice hover tooltip. Reuses the same #chart-tooltip div as the
    // bar/line chart above, just with a "project · pct" payload.
    (function () {
      const tooltip = document.getElementById("chart-tooltip");
      const pies = document.querySelectorAll(".pie-panel");
      pies.forEach(function (panel) {
        panel.addEventListener("mousemove", function (ev) {
          const target = ev.target;
          if (
            !(target instanceof Element) ||
            !target.classList.contains("slice")
          ) {
            tooltip.classList.remove("visible");
            return;
          }
          const label = target.getAttribute("data-label");
          const value = target.getAttribute("data-value");
          tooltip.innerHTML =
            '<div class="date">' + label + '</div>' +
            '<div class="tokens">' + value + '</div>';
          tooltip.style.left = (ev.clientX + 12) + "px";
          tooltip.style.top = (ev.clientY - 12) + "px";
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

/**
 * One summary card. Renders both the token total and the message count;
 * a CSS class on the parent `.totals` flips which set is visible. The
 * card itself doesn't know which metric is "active" — that's owned by
 * the click handler in the page-level script.
 *
 * Each value is also rendered twice: the full format (`43,971,619`) and
 * a compact form (`44M`). CSS swaps to the compact form on hover so the
 * user can quickly eyeball orders of magnitude without losing the
 * exact number in the default view.
 */
function totalCard(label: string, t: TotalsBlock, messages: number): string {
  const tokensFull = formatNumber(t.total_tokens);
  const tokensCompact = formatCompact(t.total_tokens);
  const msgsFull = formatNumber(messages);
  const msgsCompact = formatCompact(messages);
  return `<div class="card clickable" role="button" tabindex="0" aria-label="${escape(label)} — click to toggle tokens / messages">
    <div class="label">${escape(label)}</div>
    <div class="value">
      <span class="metric-tokens">
        <span class="num-full">${tokensFull}</span>
        <span class="num-compact">${tokensCompact}</span>
      </span>
      <span class="metric-messages">
        <span class="num-full">${msgsFull}</span>
        <span class="num-compact">${msgsCompact}</span>
      </span>
    </div>
    <div class="label">
      <span class="metric-tokens">tokens</span>
      <span class="metric-messages">messages</span>
    </div>
  </div>`;
}

// One label/value pair in the compact stats row. `tooltip` is optional — when
// provided, it's surfaced via the native `title` attribute so hovering shows
// the explanation. No JS needed; browsers render this as a tooltip.
function statItem(label: string, value: string, tooltip?: string): string {
  const titleAttr = tooltip ? ` title="${escape(tooltip)}"` : "";
  const cursor = tooltip ? ' style="cursor: help;"' : "";
  return `<div class="stat"${titleAttr}${cursor}><div class="label">${escape(label)}</div><div class="value">${escape(value)}</div></div>`;
}

/**
 * Render a custom dropdown to replace a native <select>. The native one
 * was leaking Chromium's blue hover highlight in the popup — that's
 * partly browser/OS-controlled and not reliably overridable with CSS,
 * so this builds the dropdown from plain elements where we own every
 * pixel.
 *
 * The trigger is a real <button> so it's keyboard-focusable for free.
 * The popup is a <ul role="listbox"> with <li role="option"> rows.
 *
 * The init JS (added separately, in the page-level script block)
 * defines a `value` getter/setter on the root element so the rest of
 * the dashboard's code (`rangeSel.value`, `modelSel.value = ALL`, etc.)
 * keeps working unchanged. A "change" event is dispatched whenever the
 * user clicks an option, mirroring native <select> semantics.
 */
function dropdown(
  id: string,
  ariaLabel: string,
  items: { value: string; label: string; title?: string }[],
  defaultValue: string,
): string {
  const defaultItem = items.find((i) => i.value === defaultValue) ?? items[0]!;
  const optionsHtml = items
    .map((i) => {
      const titleAttr = i.title ? ` title="${escape(i.title)}"` : "";
      const selected = i.value === defaultValue ? "true" : "false";
      return `<li role="option" data-value="${escape(i.value)}" aria-selected="${selected}"${titleAttr}>${escape(i.label)}</li>`;
    })
    .join("");
  return `<div class="dropdown" id="${id}" data-value="${escape(defaultValue)}" aria-label="${escape(ariaLabel)}">
    <button type="button" class="dropdown-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="dropdown-label">${escape(defaultItem.label)}</span>
      <span class="dropdown-chevron" aria-hidden="true">▾</span>
    </button>
    <ul class="dropdown-menu" role="listbox" hidden>${optionsHtml}</ul>
  </div>`;
}

function renderGroupTable(
  keyHeader: string,
  s: Summary,
  // When provided, each row becomes clickable: clicking it sets the value of
  // the <select> with matching id ("model" or "project") and re-renders the
  // chart. Project clicks additionally highlight the matching pie slice.
  selectOnClick?: "model" | "project",
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

  // Pre-sort rows by Total descending so the table ships in the most
  // interesting order on first paint. The sort-indicator and <table>
  // data attributes below reflect this initial state, so a user's first
  // click on "Total" flips it to ascending (instead of re-descending).
  const sortedGroups = [...s.groups].sort(
    (a, b) => b.totals.total_tokens - a.totals.total_tokens,
  );

  // Every <td> carries data-sort-value so the sort JS can order rows by raw
  // numeric/string values without re-parsing the rendered text (which would
  // break once we format numbers as "1,234,567"). Strings sort with
  // localeCompare; numbers sort numerically.
  const rows = sortedGroups
    .map((g) => {
      const rowAttr = selectOnClick
        ? ` class="clickable" data-select-${selectOnClick}="${escape(g.key)}"`
        : "";
      const keyDisplay = shortenPaths ? shortenPath(g.key) : g.key;
      const keyCell = shortenPaths
        ? `<td title="${escape(g.key)}" data-sort-value="${escape(keyDisplay.toLowerCase())}">${escape(keyDisplay)}</td>`
        : `<td data-sort-value="${escape(g.key.toLowerCase())}">${escape(g.key)}</td>`;
      const msgCount = messageCounts?.get(g.key) ?? 0;
      const msgCell = showMessages
        ? `<td class="num" data-sort-value="${msgCount}">${formatNumber(msgCount)}</td>`
        : "";
      return `<tr${rowAttr}>
        ${keyCell}
        ${msgCell}
        <td class="num" data-sort-value="${g.totals.input_tokens}">${formatNumber(g.totals.input_tokens)}</td>
        <td class="num" data-sort-value="${g.totals.output_tokens}">${formatNumber(g.totals.output_tokens)}</td>
        <td class="num" data-sort-value="${g.totals.cache_creation_input_tokens}">${formatNumber(g.totals.cache_creation_input_tokens)}</td>
        <td class="num" data-sort-value="${g.totals.cache_read_input_tokens}">${formatNumber(g.totals.cache_read_input_tokens)}</td>
        <td class="num" data-sort-value="${g.totals.total_tokens}">${formatNumber(g.totals.total_tokens)}</td>
      </tr>`;
    })
    .join("");

  // Headers use data-sort-col (column index as a string) + data-sort-type so
  // the JS knows which column to sort and how. The .sort-indicator span is
  // toggled between "", " ▼", " ▲" by JS to show the active direction.
  // Index 0 is always the key column; when showMessages is true, index 1 is
  // Messages and everything else shifts down by one.
  let colIdx = 0;
  const keyTh = `<th data-sort-col="${colIdx++}" data-sort-type="string">${escape(keyHeader)}<span class="sort-indicator"></span></th>`;
  const msgTh = showMessages
    ? `<th class="num" data-sort-col="${colIdx++}" data-sort-type="number">Messages<span class="sort-indicator"></span></th>`
    : "";
  const inputTh = `<th class="num" data-sort-col="${colIdx++}" data-sort-type="number">Input<span class="sort-indicator"></span></th>`;
  const outputTh = `<th class="num" data-sort-col="${colIdx++}" data-sort-type="number">Output<span class="sort-indicator"></span></th>`;
  const cacheCreateTh = `<th class="num" data-sort-col="${colIdx++}" data-sort-type="number">Cache create<span class="sort-indicator"></span></th>`;
  const cacheReadTh = `<th class="num" data-sort-col="${colIdx++}" data-sort-type="number">Cache read<span class="sort-indicator"></span></th>`;
  const totalColIdx = colIdx;
  const totalTh = `<th class="num sort-active" data-sort-col="${colIdx++}" data-sort-type="number">Total<span class="sort-indicator">▼</span></th>`;

  return `<table class="sortable" data-sort-col="${totalColIdx}" data-sort-dir="desc">
    <thead>
      <tr>
        ${keyTh}
        ${msgTh}
        ${inputTh}
        ${outputTh}
        ${cacheCreateTh}
        ${cacheReadTh}
        ${totalTh}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Render an inline-SVG bar chart of per-bucket values. `bucketDays` controls
 * how many consecutive days each bar covers — 1 for daily, 7 for weekly, etc.
 * We walk the full window (not just days with data) so the chart doesn't lie
 * about "quiet days" by skipping them. `unit` is appended to the per-bar
 * tooltip label (e.g. "tokens", "msgs").
 */
function renderBarChart(
  byDay: Map<string, number>,
  startMs: number,
  endMs: number,
  bucketDays: number = 1,
  unit: string = "tokens",
  localTime: boolean = false,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Each `day` here is actually a bucket — one bar on the chart. When
  // bucketDays === 1 it's literally one day; when it's 7 it's a week's sum.
  // We keep the variable name `days` to minimize downstream churn; the
  // `label` field is what the tooltip displays.
  const days: { key: string; label: string; value: number }[] = [];
  for (let bstart = startMs; bstart <= endMs; bstart += bucketDays * DAY_MS) {
    const bend = Math.min(bstart + (bucketDays - 1) * DAY_MS, endMs);
    let total = 0;
    for (let d = bstart; d <= bend; d += DAY_MS) {
      // Day keys honor localTime so the lookup hits the same key
      // summarize() produced for byDay.
      const key = dayKey(d, localTime);
      total += byDay.get(key) ?? 0;
    }
    const startKey = dayKey(bstart, localTime);
    const endKey = dayKey(bend, localTime);
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
  // and pre-formatted value (e.g. "1,234 tokens") without re-parsing the SVG.
  const bars = days
    .map((d, i) => {
      const h = (d.value / max) * chartH;
      const x = padding.left + i * barW;
      const y = padding.top + (chartH - h);
      return `<rect class="bar" x="${x + gap / 2}" y="${y}" width="${innerW}" height="${h}" data-date="${escape(d.label)}" data-value="${formatNumber(d.value)} ${escape(unit)}"></rect>`;
    })
    .join("");

  // X-axis labels. For short windows (week, month) we label each bar with
  // its weekday (Mon, Tue, ...). For longer windows that would just repeat
  // endlessly, so we fall back to MM-DD with a stride that keeps labels
  // ~60px apart and always pin the first + last day.
  // Weekday rendering: when localTime is on we parse the YYYY-MM-DD as a
  // local-midnight Date (no Z suffix); when off we parse as UTC and force
  // the formatter to UTC. The result is the weekday name corresponding
  // to the bucket's start in the chosen timezone.
  const weekdayOf = (key: string) => {
    if (localTime) {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", {
        weekday: "short",
      });
    }
    return new Date(key + "T00:00:00Z").toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
  };
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
  } else if (bucketDays > 1) {
    // Multi-day buckets (today only the "Past year" view, which uses
    // weekly buckets). Label each month boundary with the month name.
    // Two-pass approach: (1) collect every month-start index, (2) drop
    // labels that would overlap a neighbor. The overlap case fires
    // when the year window starts late in a month — "Apr" lands on
    // bucket 0, "May" on bucket 1, only ~one bar-width apart, and the
    // text needs ~3 bar-widths to not collide.
    const candidates: number[] = [];
    let lastMonth = "";
    for (let i = 0; i < days.length; i += 1) {
      const month = days[i]!.key.slice(5, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        candidates.push(i);
      }
    }
    const filtered: number[] = [];
    const minBucketSpacing = Math.max(2, Math.ceil(28 / barW));
    for (const i of candidates) {
      if (
        filtered.length > 0 &&
        i - filtered[filtered.length - 1]! < minBucketSpacing
      ) {
        // Drop the earlier label (replace with the later one) so the
        // partial leading-month doesn't squish against its neighbor.
        filtered.pop();
      }
      filtered.push(i);
    }
    labels = filtered
      .map((i) => xLabel(i, monthShortFromKey(days[i]!.key)))
      .join("");
  } else {
    // Daily buckets, > 31 days (e.g. "All time" with lots of history).
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
 * Line-chart variant of `renderBarChart`. Same axes / grid / labels, but
 * instead of rectangles we draw a polyline connecting each bucket's value,
 * a faint area fill underneath, and a circle at every point so the existing
 * hover-tooltip code has a hit target per bucket.
 */
function renderLineChart(
  byDay: Map<string, number>,
  startMs: number,
  endMs: number,
  bucketDays: number = 1,
  unit: string = "tokens",
  localTime: boolean = false,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;

  const days: { key: string; label: string; value: number }[] = [];
  for (let bstart = startMs; bstart <= endMs; bstart += bucketDays * DAY_MS) {
    const bend = Math.min(bstart + (bucketDays - 1) * DAY_MS, endMs);
    let total = 0;
    for (let d = bstart; d <= bend; d += DAY_MS) {
      const key = dayKey(d, localTime);
      total += byDay.get(key) ?? 0;
    }
    const startKey = dayKey(bstart, localTime);
    const endKey = dayKey(bend, localTime);
    const label = bucketDays === 1 ? startKey : `${startKey} to ${endKey}`;
    days.push({ key: startKey, label, value: total });
  }

  const width = 900;
  const height = 180;
  const padding = { top: 10, right: 10, bottom: 30, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const rawMax = Math.max(1, ...days.map((d) => d.value));
  const max = niceCeil(rawMax);

  // Evenly space points across the chart width. With N buckets we place them
  // at column centers (i + 0.5) so the line visually aligns with where the
  // matching bar would sit in the bar-chart view.
  const colW = days.length > 0 ? chartW / days.length : chartW;
  const points = days.map((d, i) => {
    const x = padding.left + (i + 0.5) * colW;
    const y = padding.top + chartH * (1 - d.value / max);
    return { x, y, d };
  });

  const linePath = points.map((p) => `${p.x},${p.y}`).join(" ");
  // Area polygon: same path but closed along the x-axis so fill sits under
  // the line. Only draw when we have at least one point.
  const areaPath =
    points.length > 0
      ? `${points[0]!.x},${padding.top + chartH} ${linePath} ${points[points.length - 1]!.x},${padding.top + chartH}`
      : "";

  // Circle radius scales down when there are lots of points so 365 weekly
  // buckets don't overlap into a blob. Clamped so small views still have a
  // visible dot.
  const dotR = Math.max(1.5, Math.min(3.5, colW * 0.3));
  const dots = points
    .map(
      (p) =>
        `<circle class="bar" cx="${p.x}" cy="${p.y}" r="${dotR}" data-date="${escape(p.d.label)}" data-value="${formatNumber(p.d.value)} ${escape(unit)}"></circle>`,
    )
    .join("");

  // X-axis labels mirror renderBarChart exactly so swapping chart types
  // doesn't shift the x-axis reading of the data.
  const weekdayOf = (key: string) => {
    if (localTime) {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", {
        weekday: "short",
      });
    }
    return new Date(key + "T00:00:00Z").toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
  };
  const xLabel = (i: number, text: string) => {
    if (!days[i]) return "";
    const x = padding.left + (i + 0.5) * colW;
    return `<text x="${x}" y="${height - 10}" text-anchor="middle">${escape(text)}</text>`;
  };
  let labels = "";
  if (bucketDays === 1 && days.length <= 31) {
    labels = days.map((d, i) => xLabel(i, weekdayOf(d.key))).join("");
  } else if (bucketDays > 1) {
    // Year view (weekly buckets): one label per month boundary, using
    // the month's short name. Mirrors renderBarChart so swapping chart
    // types keeps the same x-axis scheme — including the overlap
    // filter that drops a partial leading-month label when it would
    // squish against its neighbor.
    const candidates: number[] = [];
    let lastMonth = "";
    for (let i = 0; i < days.length; i += 1) {
      const month = days[i]!.key.slice(5, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        candidates.push(i);
      }
    }
    const filtered: number[] = [];
    const minBucketSpacing = Math.max(2, Math.ceil(28 / colW));
    for (const i of candidates) {
      if (
        filtered.length > 0 &&
        i - filtered[filtered.length - 1]! < minBucketSpacing
      ) {
        filtered.pop();
      }
      filtered.push(i);
    }
    labels = filtered
      .map((i) => xLabel(i, monthShortFromKey(days[i]!.key)))
      .join("");
  } else {
    const stride = Math.max(1, Math.ceil(60 / colW));
    const indices = new Set<number>();
    for (let i = 0; i < days.length; i += stride) indices.add(i);
    indices.add(days.length - 1);
    labels = Array.from(indices)
      .map((i) => xLabel(i, days[i]!.key.slice(5)))
      .join("");
  }

  // Y-axis ticks + gridlines — identical to the bar chart so the two views
  // are visually interchangeable.
  const tickCount = 4;
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

  const area = areaPath ? `<polygon class="area" points="${areaPath}" />` : "";
  const line = linePath ? `<polyline class="line" points="${linePath}" />` : "";

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    ${gridLines.join("")}
    <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartH}" />
    <line class="axis" x1="${padding.left}" y1="${padding.top + chartH}" x2="${padding.left + chartW}" y2="${padding.top + chartH}" />
    ${area}
    ${line}
    ${dots}
    ${labels}
    ${yTicks.join("")}
  </svg>`;
}

/**
 * GitHub-style calendar heatmap. Days are arranged in a grid where each
 * column is one ISO week and each row is a weekday (Sun..Sat top→bottom).
 * Each cell is tinted by how much activity (tokens or messages) happened
 * that day, on a 5-step scale of the Claude orange accent.
 *
 * This is a dispatcher: when the data window fits within roughly one
 * year (≤ 53 weeks), it renders one continuous grid. When it exceeds
 * that — e.g. "All time" for a user with 2+ years of history — it
 * matches GitHub's behavior and emits one fixed-size grid per calendar
 * year, stacked vertically with a year heading. Splitting prevents the
 * single-grid path from clamping cells below the 8px minimum and
 * overflowing the 900px viewBox at multi-year scales.
 *
 * Color bucketing uses a single global max across all years so a busy
 * day in one year reads visually heavier than a quiet day in another —
 * lets you compare years at a glance.
 *
 * Data shape: `byDay` is keyed by ISO date string ("YYYY-MM-DD"). We
 * look each day up directly; missing days fall back to 0 (the empty
 * bucket).
 */
function renderHeatmap(
  byDay: Map<string, number>,
  startMs: number,
  endMs: number,
  unit: string = "tokens",
  localTime: boolean = false,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Dispatch: single grid vs multi-year stack. 371 days = 53 weeks +
  // change, which keeps "Past year" (365 days) on the single-grid path
  // even when the window crosses a Jan 1 boundary, while "All time"
  // with multi-year history goes through the splitter.
  const totalDays = (endMs - startMs) / DAY_MS;
  if (totalDays <= 371) {
    return renderHeatmapGrid(byDay, startMs, endMs, unit, localTime);
  }

  // Compute global dayMax once so all year-grids share a color scale.
  let globalMax = 0;
  for (const v of byDay.values()) if (v > globalMax) globalMax = v;

  // Walk calendar years from latest → earliest. Most-recent first puts
  // the year you most likely care about at the top, so users don't
  // scroll past old years to see today's activity.
  const firstYear = localTime
    ? new Date(startMs).getFullYear()
    : new Date(startMs).getUTCFullYear();
  const lastYear = localTime
    ? new Date(endMs).getFullYear()
    : new Date(endMs).getUTCFullYear();

  const sections: string[] = [];
  for (let y = lastYear; y >= firstYear; y -= 1) {
    // Calendar-year bounds, in the chosen timezone. The end-of-year
    // is Dec 31 23:59:59 so the last day's grid cell renders.
    const yearStart = localTime
      ? new Date(y, 0, 1).getTime()
      : Date.UTC(y, 0, 1);
    const yearEnd = localTime
      ? new Date(y, 11, 31, 23, 59, 59, 999).getTime()
      : Date.UTC(y, 11, 31, 23, 59, 59, 999);

    // Clamp to the actual data window. The first year may start
    // mid-year (user started using the tool then); the last year ends
    // at "today" rather than Dec 31 (no future cells, GitHub-style).
    const segStart = Math.max(yearStart, startMs);
    const segEnd = Math.min(yearEnd, endMs);

    const grid = renderHeatmapGrid(byDay, segStart, segEnd, unit, localTime, globalMax);
    sections.push(
      `<div class="hm-year"><div class="hm-year-label">${y}</div>${grid}</div>`,
    );
  }

  return sections.join("");
}

/**
 * Render one calendar grid. Used directly for windows ≤ 1 year, and as
 * the per-year building block for multi-year stacks. `dayMaxOverride`,
 * when set, replaces the locally-computed max so multiple grids in a
 * stack share a single color scale.
 */
function renderHeatmapGrid(
  byDay: Map<string, number>,
  startMs: number,
  endMs: number,
  unit: string = "tokens",
  localTime: boolean = false,
  dayMaxOverride?: number,
): string {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The grid's first column is the ISO week containing startMs. We back
  // up to the prior Sunday so every column is a full 7-day stack — cells
  // before startMs are simply not drawn (gridStartMs..startMs is just
  // empty whitespace at the top of the first column). The "Sunday"
  // boundary respects localTime so when the user opts into local time,
  // the week starts on their local Sunday rather than UTC's.
  const startDow = weekday(startMs, localTime); // 0 = Sunday
  const gridStartMs = startMs - startDow * DAY_MS;

  // Number of week columns we need to cover the whole [startMs, endMs]
  // window. ceil because a partial week at the right edge still gets a
  // column (the remaining days render; the trailing future days don't).
  const totalDays = Math.floor((endMs - gridStartMs) / DAY_MS) + 1;
  const numWeeks = Math.max(1, Math.ceil(totalDays / 7));

  // Sizing. We aim to match the bar/line chart's ~900px wide footprint so
  // all three chart types feel like they belong to the same page. Cell
  // size scales with the number of weeks: short ranges (1 column) cap at
  // MAX_CELL so cells don't blow up to absurd sizes, and long ranges
  // (53+ columns for "all time" with years of data) shrink to MIN_CELL
  // before we stop shrinking.
  const width = 900;
  const padding = { top: 22, right: 10, bottom: 12, left: 32 };
  const gap = 2;
  const MAX_CELL = 16;
  const MIN_CELL = 8;
  const availW = width - padding.left - padding.right - (numWeeks - 1) * gap;
  const cellSize = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(availW / numWeeks)));
  const gridH = 7 * cellSize + 6 * gap;
  const height = padding.top + gridH + padding.bottom;

  // Color bucket for a day. Linear scale by max non-zero day so the
  // hottest day always lands in bucket 4 — this matches user intuition
  // ("darkest = highest"). Quantile-based bucketing would smooth out
  // outliers but lose the "this was your peak day" signal we want here.
  // When called from the multi-year splitter, dayMaxOverride forces the
  // same scale across every year-grid so a busy day in one year reads
  // heavier than a quiet day in another.
  let dayMax = dayMaxOverride ?? 0;
  if (dayMaxOverride === undefined) {
    for (const v of byDay.values()) if (v > dayMax) dayMax = v;
  }
  const fillFor = (v: number): string => {
    if (v <= 0 || dayMax === 0) return "var(--tc-heatmap-0)";
    const frac = v / dayMax;
    if (frac <= 0.25) return "var(--tc-heatmap-1)";
    if (frac <= 0.5) return "var(--tc-heatmap-2)";
    if (frac <= 0.75) return "var(--tc-heatmap-3)";
    return "var(--tc-heatmap-4)";
  };

  // Walk every day in [gridStartMs, endMs]. Days outside [startMs, endMs]
  // are skipped (so the grid leaves blank space at the top of the first
  // column for the partial leading week). Each cell carries data-date /
  // data-value attributes so the existing chart-tooltip handler picks
  // them up — same convention as bar rects and line dots.
  const cells: string[] = [];
  // Month-label candidates (one per month change). We collect them first
  // and emit them in a second pass so we can drop labels that would
  // overlap their neighbor — happens when the heatmap window starts
  // late in a month, leaving only ~1 column of that month visible
  // before the next one starts. Without filtering, "Apr" and "May" land
  // in adjacent columns and squish on top of each other.
  const labelCandidates: { x: number; name: string }[] = [];
  let lastMonth = -1;
  for (let week = 0; week < numWeeks; week += 1) {
    for (let dow = 0; dow < 7; dow += 1) {
      const dayMs = gridStartMs + (week * 7 + dow) * DAY_MS;
      if (dayMs < startMs || dayMs > endMs) continue;
      const d = new Date(dayMs);
      // Day key + month read use localTime so the heatmap aligns with
      // the rest of the dashboard's day buckets.
      const key = dayKey(dayMs, localTime);
      const val = byDay.get(key) ?? 0;
      const x = padding.left + week * (cellSize + gap);
      const y = padding.top + dow * (cellSize + gap);
      cells.push(
        `<rect class="heatmap-cell" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" fill="${fillFor(val)}" data-date="${key}" data-value="${formatNumber(val)} ${escape(unit)}"></rect>`,
      );
      // Record a label candidate at the first cell of each new month
      // (anchored to whichever cell — Sunday or otherwise — is the
      // earliest visible day of the month). The dow !== 0 case matters
      // for the very first column when its Sunday is before startMs.
      const month = monthOf(dayMs, localTime);
      if (month !== lastMonth) {
        lastMonth = month;
        const monthName = d.toLocaleString("en-US", {
          month: "short",
          // No timeZone option in local mode → the formatter uses the
          // host's tz, matching the localTime month index above.
          ...(localTime ? {} : { timeZone: "UTC" }),
        });
        labelCandidates.push({ x, name: monthName });
      }
    }
  }

  // Filter overlapping labels. Walk left→right; if a candidate is too
  // close to the one we already kept, drop the *earlier* one (the new
  // one is later in the year and corresponds to a longer-visible month,
  // so it's the more useful label). 2 column-widths is enough room for
  // a 3-letter month name in the 10px label font.
  const minLabelSpacing = (cellSize + gap) * 2;
  const monthLabels: string[] = [];
  let lastX = -Infinity;
  for (const c of labelCandidates) {
    if (c.x - lastX < minLabelSpacing) {
      // Replace the previous label (drop the earlier one) so that when
      // months are squeezed together at the start, we keep the later
      // label and discard the partial leading-month one.
      if (monthLabels.length > 0) monthLabels.pop();
    }
    monthLabels.push(
      `<text class="hm-label" x="${c.x}" y="${padding.top - 8}">${escape(c.name)}</text>`,
    );
    lastX = c.x;
  }

  // Weekday labels on the left. We only label Mon/Wed/Fri (rows 1/3/5) —
  // labelling all seven crowds the gutter, and three labels is the
  // standard GitHub convention.
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayLabels = [1, 3, 5]
    .map((dow) => {
      const y = padding.top + dow * (cellSize + gap) + cellSize - 2;
      return `<text class="hm-label" x="${padding.left - 6}" y="${y}" text-anchor="end">${weekdayNames[dow]}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    ${monthLabels.join("")}
    ${weekdayLabels}
    ${cells.join("")}
  </svg>`;
}

/**
 * Color palette used for pie-chart slices (and anywhere else we need N
 * distinct categorical colors). Anchored on Claude Code's terracotta so
 * the biggest slice matches the rest of the dashboard accent, with a set
 * of warm/analogous tones for the remaining wedges so the palette reads
 * as one family rather than a random rainbow.
 */
const PIE_COLORS = [
  "#D97757", // tc-accent — Claude terracotta (biggest slice by default)
  "#E8B07A", // warm sand
  "#C26240", // deeper orange
  "#F2C894", // peach
  "#A8593F", // burnt sienna
  "#F4A07C", // coral
  "#8B4A33", // cocoa
  "#E8CBA7", // cream
  "#6DA3A8", // muted teal (cool contrast for long tails)
];

/**
 * Render a pie chart for projects with a color-matched legend. Each wedge
 * carries data-* attributes so the existing #chart-tooltip can show the
 * project path, raw value, and percentage on hover. `unit` is the metric
 * label ("tokens" or "msgs") appended to the tooltip and legend numbers.
 *
 * Edge cases: when only one item is non-zero we draw a full circle instead
 * of a path, because an SVG arc of exactly 360° collapses to a zero-length
 * segment. Zero-total data short-circuits to an empty-state message.
 */
function renderProjectPie(
  items: [string, number][],
  unit: string,
): string {
  const total = items.reduce((s, [, v]) => s + v, 0);
  if (total === 0 || items.length === 0) {
    return `<p class="empty">No data.</p>`;
  }
  // Donut geometry: outer radius R and inner radius IR carve out a ring. The
  // hole in the middle is where we drop the total-tokens label. The explode
  // distance is how far a slice translates outward on hover / when the row
  // it corresponds to is highlighted; tuned so motion reads clearly without
  // the wedge detaching from the ring.
  const cx = 110;
  const cy = 110;
  const R = 100;
  const IR = 62;
  const EXPLODE = 8;
  const wedges: string[] = [];
  const legendItems: string[] = [];
  // Start at 12 o'clock and go clockwise (matches what most users expect
  // when reading a pie chart).
  let angle = -Math.PI / 2;
  for (let i = 0; i < items.length; i += 1) {
    const [key, value] = items[i]!;
    const color = PIE_COLORS[i % PIE_COLORS.length]!;
    const displayKey = key === "Other" ? "Other" : shortenPath(key);
    const pct = (value / total) * 100;
    const pctLabel = pct < 0.1 ? "<0.1%" : pct.toFixed(1) + "%";
    const valueLabel = `${formatNumber(value)} ${unit}`;
    // Tooltip shows the short display name (last path segment) — the full
    // path is still visible on the legend row's title attribute for anyone
    // who needs it. `data-key` carries the full path (or "Other") so outside
    // code can match slices by project without depending on display text.
    const labelAttr = escape(displayKey);
    const valueAttr = escape(`${valueLabel} · ${pctLabel}`);
    const keyAttr = escape(key);

    if (items.length === 1) {
      // Single slice: drawing a donut ring with path math is fiddly because
      // an arc from point P back to P collapses. Easiest trick is a circle
      // of radius (R+IR)/2 stroked with width (R-IR) — no fill. Inline
      // style is used so `stroke-width` beats the `.slice { stroke-width: 2 }`
      // rule (CSS > attributes in modern browsers).
      const midR = (R + IR) / 2;
      const strokeW = R - IR;
      wedges.push(
        `<circle class="slice" cx="${cx}" cy="${cy}" r="${midR}" fill="none" style="stroke: ${color}; stroke-width: ${strokeW}px;" data-key="${keyAttr}" data-label="${labelAttr}" data-value="${valueAttr}"></circle>`,
      );
    } else {
      // Donut-wedge path: outer arc forward, drop to inner radius, inner
      // arc back, close. Inner arc sweeps in the opposite direction (flag
      // "0") so the path encloses the ring segment rather than crossing
      // through the center.
      const frac = value / total;
      const a = frac * Math.PI * 2;
      const start = angle;
      const end = angle + a;
      const mid = start + a / 2;
      const x1o = cx + R * Math.cos(start);
      const y1o = cy + R * Math.sin(start);
      const x2o = cx + R * Math.cos(end);
      const y2o = cy + R * Math.sin(end);
      const x1i = cx + IR * Math.cos(start);
      const y1i = cy + IR * Math.sin(start);
      const x2i = cx + IR * Math.cos(end);
      const y2i = cy + IR * Math.sin(end);
      const largeArc = a > Math.PI ? 1 : 0;
      const d = `M${x1o.toFixed(3)},${y1o.toFixed(3)} A${R},${R} 0 ${largeArc} 1 ${x2o.toFixed(3)},${y2o.toFixed(3)} L${x2i.toFixed(3)},${y2i.toFixed(3)} A${IR},${IR} 0 ${largeArc} 0 ${x1i.toFixed(3)},${y1i.toFixed(3)} Z`;
      // Precompute the per-slice explode vector as CSS custom properties.
      // The CSS hover / .highlighted rule reads --ex/--ey and translates
      // the wedge along its angle bisector so it appears to pop outward.
      const tx = Math.cos(mid) * EXPLODE;
      const ty = Math.sin(mid) * EXPLODE;
      angle = end;
      wedges.push(
        `<path class="slice" d="${d}" fill="${color}" style="--ex: ${tx.toFixed(2)}px; --ey: ${ty.toFixed(2)}px;" data-key="${keyAttr}" data-label="${labelAttr}" data-value="${valueAttr}"></path>`,
      );
    }

    // Legend entries carry data-key so the click handler can match them to
    // the dropdown + pie slice using the same logic we use for slice clicks.
    // "Other" is an aggregate — not a real project — so we leave its li
    // without the clickable class (CSS keeps the default cursor on it).
    const legendClass = key === "Other" ? "" : " clickable";
    legendItems.push(
      `<li class="legend-item${legendClass}" data-key="${keyAttr}"><span class="swatch" style="background: ${color};"></span><span class="name" title="${escape(key)}">${escape(displayKey)}</span><span class="val">${formatNumber(value)} ${escape(unit)} · ${pctLabel}</span></li>`,
    );
  }

  // Center label — big compact total + unit. Sits in the donut hole with
  // pointer-events disabled so it doesn't block hover/click on the slices
  // behind it (visually there's nothing behind, but the text bounding box
  // extends over wedge edges on narrow slices at 12 o'clock).
  const centerText = `
    <text x="${cx}" y="${cy + 3}" text-anchor="middle" class="donut-total">${escape(formatCompact(total))}</text>
    <text x="${cx}" y="${cy + 20}" text-anchor="middle" class="donut-unit">${escape(unit)}</text>
  `;

  return `<div class="pie-chart">
    <svg viewBox="0 0 220 220" width="220" height="220">${wedges.join("")}${centerText}</svg>
    <ul class="pie-legend">${legendItems.join("")}</ul>
  </div>`;
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

/**
 * Pull a 3-letter month name out of a "YYYY-MM-DD" day key. Used by the
 * year-view x-axis, where we want "Apr"/"May"/... instead of MM-DD.
 * Reading from the key string keeps us out of any TZ re-parsing — the
 * key was canonicalized when the bucket was built.
 */
function monthShortFromKey(key: string): string {
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const m = parseInt(key.slice(5, 7), 10);
  return MONTHS[m - 1] ?? "";
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

/**
 * Loading screen shown briefly on a cache miss while we read the data
 * files and rebuild the HTML. Each render picks a random tagline so
 * users who open the dashboard often see a little variety. Pure static
 * HTML — no JS — so it paints as soon as the webview receives it.
 */
function renderLoading(): string {
  // Short, on-brand quips. Keep them cheeky and self-aware about what
  // the tool is actually doing under the hood. Roughly 6-8 words each
  // so they fit on one line in a narrow webview.
  const quotes = [
    "Counting your tokens, one cache read at a time…",
    "Tallying turns and tokens…",
    "Reading transcripts so you don't have to…",
    "Drawing little orange squares…",
    "Bucketing days at local midnight…",
    "Following the prompt cache trail…",
    "Where did all those tokens go?",
    "Translating turns into numbers…",
    "Re-counting your conversations with Claude…",
    "Summing input, output, and cache reads…",
    "Looking up every cwd you've worked in…",
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)]!;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Token Count</title>
<style>
  /* Centered, full-viewport loader. The three orange dots pulse on a
     stagger so the animation reads as motion, not flicker. The accent
     hex is hard-coded here (rather than via the --tc-accent variable
     used elsewhere) because this loading screen is its own self-
     contained HTML doc — it doesn't share the main dashboard's :root
     custom properties. */
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 24px;
  }
  .loading-dots { display: flex; gap: 10px; }
  .loading-dots span {
    width: 12px;
    height: 12px;
    background: #D97757;
    border-radius: 50%;
    display: inline-block;
    animation: tc-pulse 1.4s infinite ease-in-out both;
  }
  /* Negative delays so the first dot is already mid-pulse when the
     animation starts, instead of all three sitting still at t=0. */
  .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
  .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
  .loading-dots span:nth-child(3) { animation-delay:  0s;   }
  @keyframes tc-pulse {
    0%, 80%, 100% { transform: scale(0.65); opacity: 0.35; }
    40%           { transform: scale(1);    opacity: 1;    }
  }
  .quote {
    font-size: 13px;
    font-style: italic;
    opacity: 0.7;
    max-width: 360px;
    text-align: center;
    padding: 0 16px;
  }
</style>
</head>
<body>
  <div class="loading-dots" aria-label="Loading">
    <span></span><span></span><span></span>
  </div>
  <div class="quote">${escape(quote)}</div>
</body>
</html>`;
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
