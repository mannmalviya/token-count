// Sidebar webview view.
//
// Registered as a WebviewView in the activity-bar view container
// "tokenCount". Renders a compact summary — three totals cards, a stats
// row, and a single "Open Full Dashboard" button that posts a message
// back to the extension host so it can run `tokenCount.showDashboard`.
//
// This view is intentionally lightweight: no chart, no tables. The full
// dashboard lives in dashboard.ts and is opened as an editor tab when the
// user clicks the button.

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

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /** Must match the id declared in package.json under contributes.views. */
  public static readonly viewType = "tokenCount.sidebar";

  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      // We run a tiny inline <script> to wire the button click → postMessage.
      enableScripts: true,
    };

    // Initial render.
    webviewView.webview.html = this.renderHtml();

    // Listen for button clicks from the webview.
    webviewView.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "open-dashboard") {
        void vscode.commands.executeCommand("tokenCount.showDashboard");
      }
    });

    // Re-render when the view becomes visible again (user collapsed and
    // reopened the sidebar) so numbers aren't stale.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
  }

  /** Called by extension.ts whenever usage.jsonl changes. */
  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.renderHtml();
    }
  }

  /**
   * Build the compact summary HTML. Pattern mirrors dashboard.ts but much
   * smaller — we only need totals + a couple of stats + one button.
   */
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

    const todaySum = summarize(records, { groupBy: "day", since: today });
    const weekSum = summarize(records, { groupBy: "day", since: sevenDaysAgo });
    const allSum = summarize(records, { groupBy: "day" });

    const userMessages = prompts.length;
    const sessions = new Set(records.map((r) => r.session_id)).size;
    const activeDays = allSum.groups.length;
    const msgsPerDay = activeDays > 0 ? userMessages / activeDays : 0;

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
    background: #22c55e;
    animation: tc-pulse 1.6s ease-in-out infinite;
  }
  @keyframes tc-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70%  { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
    100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
  }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 4px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .card .label {
    font-size: 11px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .card .value {
    font-size: 18px;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .card .sub { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .stat {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 4px;
    padding: 8px 10px;
  }
  .stat .label {
    font-size: 10px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .stat .value { font-size: 14px; margin-top: 2px; font-variant-numeric: tabular-nums; }
  button.open-dash {
    display: block;
    width: 100%;
    margin-top: 14px;
    padding: 8px 10px;
    font-size: 12px;
    font-family: inherit;
    font-weight: 500;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    cursor: pointer;
  }
  button.open-dash:hover { background: var(--vscode-button-hoverBackground); }
  .empty { opacity: 0.6; font-size: 12px; margin: 12px 0; }
</style>
</head>
<body>
  <h1>Token Count <span class="live-dot" title="Live"></span></h1>

  ${records.length === 0 ? `<p class="empty">No usage recorded yet. Start a Claude Code session — records show up here automatically.</p>` : ""}

  <div class="card">
    <div class="label">Today</div>
    <div class="value">${formatCount(todaySum.totals.total_tokens)}</div>
    <div class="sub">${formatNumber(todaySum.totals.total_tokens)} tokens</div>
  </div>

  <div class="card">
    <div class="label">Last 7 days</div>
    <div class="value">${formatCount(weekSum.totals.total_tokens)}</div>
    <div class="sub">${formatNumber(weekSum.totals.total_tokens)} tokens</div>
  </div>

  <div class="card">
    <div class="label">All time</div>
    <div class="value">${formatCount(allSum.totals.total_tokens)}</div>
    <div class="sub">${formatNumber(allSum.totals.total_tokens)} tokens</div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="label">Messages</div>
      <div class="value">${formatNumber(userMessages)}</div>
    </div>
    <div class="stat">
      <div class="label">Msgs/day</div>
      <div class="value">${msgsPerDay.toFixed(1)}</div>
    </div>
    <div class="stat">
      <div class="label">Sessions</div>
      <div class="value">${formatNumber(sessions)}</div>
    </div>
    <div class="stat">
      <div class="label">Active days</div>
      <div class="value">${formatNumber(activeDays)}</div>
    </div>
  </div>

  <button class="open-dash" id="open-dash">Open Full Dashboard &rarr;</button>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("open-dash").addEventListener("click", function () {
      vscode.postMessage({ type: "open-dashboard" });
    });
  </script>
</body>
</html>`;
  }
}

function renderError(msg: string): string {
  // Escape to be safe — we don't want error text (which could include a
  // file path) to inject HTML into the sidebar.
  const escaped = msg
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px;">
    <h3>Token Count</h3>
    <p>Failed to read usage.jsonl.</p>
    <pre style="white-space: pre-wrap; font-size: 11px; opacity: 0.8;">${escaped}</pre>
  </body></html>`;
}
