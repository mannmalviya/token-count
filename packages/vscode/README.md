# Token Count

**Live [Claude Code](https://claude.com/claude-code) token usage in the status bar + a dashboard.** All data stays on your machine.

## Prerequisite — install the `token-count` CLI first

This extension is a viewer. It reads `~/.token-count/usage.jsonl`, which is populated by a Stop hook installed via the `token-count` CLI. **Without the CLI, the extension shows zeros.**

One-time setup:

```bash
git clone https://github.com/mannmalviya/token-count.git
cd token-count
pnpm install && pnpm -r build
pnpm --filter @token-count/cli link --global
token-count init      # installs the Stop hook + backfills your history
```

The hook records every assistant turn going forward. Re-run `token-count backfill` at any time to re-import history (deduped by turn UUID, so it's safe).

Full CLI docs: <https://github.com/mannmalviya/token-count>.

## What you get

- **Left status bar** — `◆ 12.4k today`, always visible. Click to open the dashboard.
- **Right status bar** — same number with a rich hover tooltip: today / last-7-days / all-time totals, message counts, and top model. Toggle off via `tokenCount.rightStatusBar.enabled`.
- **Activity-bar sidebar** — pinned stat cards (today tokens, today messages, current project totals) with a `+ Add stat` tile to pin 7-day / all-time / sessions / msgs-per-day / top-model.
- **Dashboard** — open via the command palette (**Token Count: Show Dashboard**) or by clicking any status-bar item:
  - Summary cards: today, last 7 days, all-time.
  - Time-series chart with a timeframe dropdown (week / month / year / all-time), independent model and project filters, and three chart styles: **heatmap** (GitHub-style calendar), **bars**, **line**.
  - Tokens vs. Messages metric toggle.
  - Sortable, clickable "By model" and "By project" tables — clicking a row filters the chart above.
  - Project breakdown donut with hover-pop wedges.

## Settings

- **`tokenCount.rightStatusBar.enabled`** *(default `true`)* — show/hide the right status bar item with the rich tooltip.
- **`tokenCount.useLocalTimezone`** *(default `true`)* — bucket per-day stats at your machine's local midnight. Turn off to use UTC midnight (matches `token-count stats --utc`). Affects the dashboard, sidebar cards, and tooltips. Applies immediately — no reload.

## Privacy

Everything is local. The extension reads `~/.token-count/usage.jsonl` and never makes a network call. Cost figures (when shown) are computed from a hard-coded snapshot of published Anthropic rates.

## Issues / source

<https://github.com/mannmalviya/token-count>
