// Sidebar webview view — customizable stat cards.
//
// The sidebar renders a short list of "stat cards" the user has chosen to
// pin. The default set covers the common asks (today's tokens + messages,
// and the same pair scoped to the currently-open VSCode workspace folder).
//
// A "+ Add stat" tile posts an `add-stat` message to the extension host,
// which opens a VSCode QuickPick so the user can pick any other stat from
// the registry below. Removing a stat is a `remove-stat` message. The
// enabled list is persisted in globalState so it survives reloads and
// follows the user across workspaces.

import * as vscode from "vscode";
import {
  readAllPrompts,
  readAllRecords,
  summarize,
} from "@token-count/core";
import {
  formatCount,
  formatNumber,
  startOfTodayUTC,
} from "./format.js";

/** Key under which we persist the ordered list of enabled stat ids. */
const STATE_KEY = "tokenCount.sidebar.enabledStats";

/** Shipped defaults: two global stats + two current-project stats. */
const DEFAULT_STATS: string[] = [
  "today-tokens",
  "today-messages",
  "project-alltime-tokens",
  "project-alltime-messages",
];

// Context passed to every stat's compute function. Built once per render so
// each stat doesn't have to re-read the files or recompute common values.
interface StatCtx {
  records: ReturnType<typeof readAllRecords>;
  prompts: ReturnType<typeof readAllPrompts>;
  currentProject: string | undefined;
  today: Date;
  sevenDaysAgo: Date;
}

interface StatDef {
  label: string;
  /** Hide the stat if it's not meaningful in the current context (e.g.
   *  project stats with no workspace folder open). */
  available?: (ctx: StatCtx) => boolean;
  /** Produces the rendered card content. `main` is the big value, `sub` is
   *  an optional secondary line under it. */
  compute: (ctx: StatCtx) => { main: string; sub?: string };
}

/** Membership test for "this record belongs to the current project". We
 *  allow sub-folders of the workspace so Claude Code sessions run from a
 *  deeper directory still count as part of the project. */
function inProject(cwd: string, project: string): boolean {
  return cwd === project || cwd.startsWith(project + "/");
}

/**
 * Stat registry. Ids are stable — they're persisted in user state, so don't
 * rename an id without a migration. Labels can change freely since they're
 * only used for display.
 */
const STATS: Record<string, StatDef> = {
  "today-tokens": {
    label: "Today · Tokens",
    compute: (c) => {
      const s = summarize(c.records, { groupBy: "day", since: c.today });
      return {
        main: formatCount(s.totals.total_tokens),
        sub: `${formatNumber(s.totals.total_tokens)} tokens`,
      };
    },
  },
  "today-messages": {
    label: "Today · Messages",
    compute: (c) => {
      const cutoff = c.today.getTime();
      const n = c.prompts.filter((p) => Date.parse(p.ts) >= cutoff).length;
      return { main: formatNumber(n), sub: "messages today" };
    },
  },
  "week-tokens": {
    label: "Last 7 days · Tokens",
    compute: (c) => {
      const s = summarize(c.records, { groupBy: "day", since: c.sevenDaysAgo });
      return {
        main: formatCount(s.totals.total_tokens),
        sub: `${formatNumber(s.totals.total_tokens)} tokens`,
      };
    },
  },
  "week-messages": {
    label: "Last 7 days · Messages",
    compute: (c) => {
      const cutoff = c.sevenDaysAgo.getTime();
      const n = c.prompts.filter((p) => Date.parse(p.ts) >= cutoff).length;
      return { main: formatNumber(n), sub: "messages" };
    },
  },
  "alltime-tokens": {
    label: "All time · Tokens",
    compute: (c) => {
      const s = summarize(c.records, { groupBy: "day" });
      return {
        main: formatCount(s.totals.total_tokens),
        sub: `${formatNumber(s.totals.total_tokens)} tokens`,
      };
    },
  },
  "alltime-messages": {
    label: "All time · Messages",
    compute: (c) => ({
      main: formatNumber(c.prompts.length),
      sub: "messages",
    }),
  },
  "project-today-tokens": {
    label: "This project · Today tokens",
    available: (c) => !!c.currentProject,
    compute: (c) => {
      const proj = c.currentProject!;
      const filtered = c.records.filter((r) => inProject(r.cwd, proj));
      const s = summarize(filtered, { groupBy: "day", since: c.today });
      return {
        main: formatCount(s.totals.total_tokens),
        sub: `${formatNumber(s.totals.total_tokens)} tokens · this project`,
      };
    },
  },
  "project-today-messages": {
    label: "This project · Today messages",
    available: (c) => !!c.currentProject,
    compute: (c) => {
      const proj = c.currentProject!;
      const cutoff = c.today.getTime();
      const n = c.prompts.filter(
        (p) => Date.parse(p.ts) >= cutoff && inProject(p.cwd, proj),
      ).length;
      return { main: formatNumber(n), sub: "messages · this project" };
    },
  },
  "project-alltime-tokens": {
    label: "This project · All time tokens",
    available: (c) => !!c.currentProject,
    compute: (c) => {
      const proj = c.currentProject!;
      const filtered = c.records.filter((r) => inProject(r.cwd, proj));
      const s = summarize(filtered, { groupBy: "day" });
      return {
        main: formatCount(s.totals.total_tokens),
        sub: `${formatNumber(s.totals.total_tokens)} tokens · this project`,
      };
    },
  },
  "project-alltime-messages": {
    label: "This project · All time messages",
    available: (c) => !!c.currentProject,
    compute: (c) => {
      const proj = c.currentProject!;
      const n = c.prompts.filter((p) => inProject(p.cwd, proj)).length;
      return { main: formatNumber(n), sub: "messages · this project" };
    },
  },
  sessions: {
    label: "Sessions (all time)",
    compute: (c) => ({
      main: formatNumber(new Set(c.records.map((r) => r.session_id)).size),
      sub: "distinct sessions",
    }),
  },
  "active-days": {
    label: "Active days",
    compute: (c) => {
      const s = summarize(c.records, { groupBy: "day" });
      return { main: formatNumber(s.groups.length), sub: "days with usage" };
    },
  },
  "msgs-per-day": {
    label: "Messages per active day",
    compute: (c) => {
      const s = summarize(c.records, { groupBy: "day" });
      const avg = s.groups.length > 0 ? c.prompts.length / s.groups.length : 0;
      return { main: avg.toFixed(1), sub: "avg messages per day" };
    },
  },
  "top-model-today": {
    label: "Top model today",
    compute: (c) => {
      const cutoff = c.today.getTime();
      const todayRecs = c.records.filter((r) => Date.parse(r.ts) >= cutoff);
      const s = summarize(todayRecs, { groupBy: "model" });
      if (s.groups.length === 0) return { main: "—" };
      return {
        main: s.groups[0]!.key,
        sub: `${formatNumber(s.groups[0]!.totals.total_tokens)} tokens`,
      };
    },
  },
};

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tokenCount.sidebar";

  private view: vscode.WebviewView | undefined;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();

    webviewView.webview.onDidReceiveMessage(
      (msg: { type?: string; id?: string }) => {
        if (msg?.type === "open-dashboard") {
          void vscode.commands.executeCommand("tokenCount.showDashboard");
        } else if (msg?.type === "add-stat") {
          void this.pickAndAddStat();
        } else if (msg?.type === "remove-stat" && typeof msg.id === "string") {
          void this.removeStat(msg.id);
        }
      },
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
  }

  /** Called by extension.ts whenever usage.jsonl or prompts.jsonl changes. */
  refresh(): void {
    if (this.view) this.view.webview.html = this.renderHtml();
  }

  // -------------------------------------------------------------------------
  // State helpers: read / write the enabled stat list in globalState. We use
  // globalState (not workspaceState) so the user's picks follow them between
  // workspaces — which matches the behavior of most VSCode UI preferences.
  // -------------------------------------------------------------------------

  private getEnabled(): string[] {
    const saved = this.context.globalState.get<string[]>(STATE_KEY);
    if (Array.isArray(saved)) return saved;
    return [...DEFAULT_STATS];
  }

  private async setEnabled(ids: string[]): Promise<void> {
    await this.context.globalState.update(STATE_KEY, ids);
  }

  private async pickAndAddStat(): Promise<void> {
    const enabled = this.getEnabled();
    // Offer only stats that aren't already on the sidebar. If every stat is
    // already shown, tell the user and bail — opening an empty QuickPick
    // would be confusing.
    type Pick = vscode.QuickPickItem & { id: string };
    const items: Pick[] = Object.entries(STATS)
      .filter(([id]) => !enabled.includes(id))
      .map(([id, def]) => ({ label: def.label, id }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        "All available stats are already on the sidebar.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick<Pick>(items, {
      placeHolder: "Add a stat to the Token Count sidebar",
    });
    if (!picked) return;
    await this.setEnabled([...enabled, picked.id]);
    this.refresh();
  }

  private async removeStat(id: string): Promise<void> {
    const enabled = this.getEnabled();
    await this.setEnabled(enabled.filter((x) => x !== id));
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // HTML rendering.
  // -------------------------------------------------------------------------

  private renderHtml(): string {
    let records: ReturnType<typeof readAllRecords>;
    let prompts: ReturnType<typeof readAllPrompts>;
    try {
      records = readAllRecords().filter((r) => r.model !== "<synthetic>");
      prompts = readAllPrompts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return renderError(msg);
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const today = startOfTodayUTC();
    const sevenDaysAgo = new Date(today.getTime() - 6 * DAY_MS);
    // First open workspace folder is our "current project". If none is open
    // (bare window), project-scoped stats will hide themselves via the
    // `available` predicate.
    const currentProject =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const ctx: StatCtx = {
      records,
      prompts,
      currentProject,
      today,
      sevenDaysAgo,
    };

    const enabled = this.getEnabled();
    const cards = enabled
      .map((id) => {
        const def = STATS[id];
        if (!def) return ""; // Unknown id in state (older version) — skip.
        if (def.available && !def.available(ctx)) return ""; // Not applicable now.
        let main = "—";
        let sub: string | undefined;
        try {
          const out = def.compute(ctx);
          main = out.main;
          sub = out.sub;
        } catch {
          main = "—";
        }
        const subHtml = sub ? `<div class="sub">${escapeHtml(sub)}</div>` : "";
        return `<div class="stat-card" data-id="${escapeHtml(id)}">
          <button class="remove" data-id="${escapeHtml(id)}" title="Remove from sidebar" aria-label="Remove">&times;</button>
          <div class="label">${escapeHtml(def.label)}</div>
          <div class="value">${escapeHtml(main)}</div>
          ${subHtml}
        </div>`;
      })
      .join("");

    const emptyNote =
      enabled.length === 0
        ? `<p class="empty">No stats pinned. Click <b>+ Add stat</b> to choose what to show.</p>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Token Count</title>
<style>
  /* Claude-Code orange accent. Kept in sync with dashboard.ts so both
     surfaces feel like one app — any future tweaks should change both. */
  :root {
    --tc-accent: #D97757;
    --tc-accent-strong: #C26240;
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    padding: 12px;
    margin: 0;
    line-height: 1.4;
  }
  h1 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.85;
  }
  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tc-accent);
    animation: tc-pulse 1.6s ease-in-out infinite;
  }
  @keyframes tc-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(217, 119, 87, 0.7); }
    70%  { box-shadow: 0 0 0 6px rgba(217, 119, 87, 0); }
    100% { box-shadow: 0 0 0 0 rgba(217, 119, 87, 0); }
  }
  /* Stat card: subtle accent strip on the left so the cards read as
     "Token Count" items at a glance, plus a warmer hover state. The
     left border gets thicker on hover rather than changing color to
     avoid a visible shift of the card's content. */
  .stat-card {
    position: relative;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-left: 3px solid var(--tc-accent);
    border-radius: 4px;
    padding: 10px 12px 10px 10px;
    margin-bottom: 8px;
    transition: border-color 0.1s, background 0.1s;
  }
  .stat-card:hover {
    border-left-color: var(--tc-accent-strong);
  }
  .stat-card .label {
    font-size: 11px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  /* Big value: tinted with the Claude orange so it stands out and ties
     visually to the dashboard charts. */
  .stat-card .value {
    font-size: 18px;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
    word-break: break-word;
    color: var(--tc-accent);
    font-weight: 600;
  }
  .stat-card .sub { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  /* Small X in the corner — hidden until the user hovers the card so the
     resting state stays clean. */
  .stat-card .remove {
    position: absolute;
    top: 4px;
    right: 4px;
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 3px;
    transition: opacity 0.1s, background 0.1s;
  }
  .stat-card:hover .remove { opacity: 0.7; }
  .stat-card .remove:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
  }
  /* Dashed-border tile that opens the QuickPick. Styled like a card so it
     reads as "another slot" rather than a pushy button. */
  button.add-stat {
    display: block;
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 12px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px dashed var(--vscode-editorWidget-border);
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    opacity: 0.75;
    transition: opacity 0.1s, border-color 0.1s;
  }
  button.add-stat:hover {
    opacity: 1;
    border-color: var(--tc-accent);
    color: var(--tc-accent);
  }
  /* Primary CTA: Claude-orange fill with white text, matching the dashboard
     toggle-active state. Darkens on hover to the -strong variant. */
  button.open-dash {
    display: block;
    width: 100%;
    padding: 8px 10px;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    color: #ffffff;
    background: var(--tc-accent);
    border: 1px solid var(--tc-accent);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
  }
  button.open-dash:hover {
    background: var(--tc-accent-strong);
    border-color: var(--tc-accent-strong);
  }
  .empty { opacity: 0.6; font-size: 12px; margin: 12px 0; }
</style>
</head>
<body>
  <h1>Token Count <span class="live-dot" title="Live"></span></h1>

  ${emptyNote}
  ${cards}

  <button class="add-stat" id="add-stat" type="button">+ Add stat</button>

  <button class="open-dash" id="open-dash" type="button">Open Full Dashboard &rarr;</button>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("open-dash").addEventListener("click", function () {
      vscode.postMessage({ type: "open-dashboard" });
    });
    document.getElementById("add-stat").addEventListener("click", function () {
      vscode.postMessage({ type: "add-stat" });
    });
    // Per-card remove buttons. Each posts the stat id to the extension so it
    // can update globalState and push a fresh HTML render back.
    document.querySelectorAll(".stat-card .remove").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        const id = btn.getAttribute("data-id");
        if (id) vscode.postMessage({ type: "remove-stat", id: id });
      });
    });
  </script>
</body>
</html>`;
  }
}

function renderError(msg: string): string {
  const escaped = escapeHtml(msg);
  return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px;">
    <h3>Token Count</h3>
    <p>Failed to read usage.jsonl.</p>
    <pre style="white-space: pre-wrap; font-size: 11px; opacity: 0.8;">${escaped}</pre>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
