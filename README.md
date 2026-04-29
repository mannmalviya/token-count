<div align="center">
    <h1>token-count</h1>
    <p><strong>Local-first token usage tracker for <a href="https://claude.com/claude-code">Claude Code</a>.</strong></p>
    <p>A <code>Stop</code> hook records every assistant turn's token counts to a JSONL file on your disk. A CLI and a VSCode extension read that file to show totals, breakdowns, and cost estimates.</p>
    <p><em>No cloud. No account. No telemetry.</em> All data lives under <code>~/.token-count/</code>.</p>
</div>

<p align="center">
    <img src="https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/node-%3E%3D18.17-success?logo=node.js&logoColor=white" alt="Node >=18.17" />
    <img src="https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white" alt="pnpm workspaces" />
    <img src="https://img.shields.io/badge/local--first-no%20cloud-D97757" alt="Local-first" />
    <img src="https://img.shields.io/badge/VSCode-extension-007ACC?logo=visualstudiocode&logoColor=white" alt="VSCode extension" />
    <img src="https://img.shields.io/github/repo-size/mannmalviya/token-count?label=install%20size&color=D97757" alt="Install size" />
    <a href="https://deepwiki.com/mannmalviya/token-count"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
</p>

---

## ⚡ Quick Start

> **Prereq:** Node ≥18.17 and `pnpm` on your `PATH`. If you don't have pnpm:
> `corepack enable && pnpm setup` (then open a new shell so pnpm's global
> bin dir is on `$PATH`, otherwise step 3's `link --global` won't expose
> the `token-count` binary).

```bash
# 1. Clone and build
git clone https://github.com/mannmalviya/token-count.git && cd token-count
pnpm install && pnpm -r build

# 2. Put the `token-count` binary on your PATH
pnpm --filter @token-count/cli link --global

# 3. Install the Stop hook (also backfills your entire Claude Code history)
token-count init

# 4. See your usage
token-count stats
```

That's it — every Claude Code session from now on will record automatically,
and `token-count stats` will roll up totals by day, model, or project.

---

## ✨ Features

- 📝 **Per-turn recording** — every assistant response is captured with its
  `input`, `output`, `cache_creation`, and `cache_read` token counts, plus
  the model and working directory.
- 📚 **Backfill from history** — `token-count init` and `token-count backfill`
  import every assistant turn already sitting in
  `~/.claude/projects/*/*.jsonl`, so you get your full history on day one.
- 📊 **`token-count stats`** — colorful terminal table grouped by day, model,
  or project, with `--since`/`--until` windows and an optional `--cost`
  column (USD estimate using published Anthropic rates).
- 🎨 **VSCode — three surfaces**:
  - 🔢 **Left status bar** — live "today's total" tokens, always visible.
  - 💬 **Right status bar** — rich hover tooltip with today / 7-day /
    all-time totals and the top model. Can be disabled via
    `tokenCount.rightStatusBar.enabled`.
  - 📌 **Activity-bar sidebar** — a customizable quick-peek panel. Ships
    with four default stats (today tokens, today messages, current
    project's all-time tokens and messages) and a `+` button to pin any of
    10 more (7-day totals, sessions, active days, msgs/day, top model, …).
- 📈 **Full dashboard** (webview) — summary cards, a time-series chart
  (bars *or* line) across week / month / year / all-time windows, a
  tokens-vs-messages metric toggle, filters by model and project, sortable
  "By model" / "By project" tables, and a clickable donut breakdown of
  projects. Clicking a row or a pie slice filters the chart above.
- 🔒 **Deduped and append-only** — records are keyed by the transcript
  event's `uuid`, so re-running backfill or restarting the hook can never
  double-count.
- 🛡️ **Safe by construction** — the hook always exits 0, so a bug in
  `token-count` can't ever block your Claude Code session.
- 💾 **Zero dependencies on the cloud** — everything lives under
  `~/.token-count/`. No network calls, no telemetry, no account.

---

## 🛠️ Setup

### 1. Install dependencies and build

```bash
pnpm install
pnpm -r build
```

### 2. Link the CLI globally

This puts `token-count` on your `PATH`:

```bash
pnpm --filter @token-count/cli link --global
```

### 3. Install the Stop hook

This writes an entry into `~/.claude/settings.json` and, by default,
backfills every existing transcript under `~/.claude/projects/`:

```bash
token-count init
```

Options:

- `--project` — install the hook in the current repo's
  `.claude/settings.json` instead of the global settings.
- `--no-backfill` — skip the initial import; only record turns going forward.

Re-running `token-count init` is idempotent; it prints a note and exits if
the hook is already installed.

### 4. (Optional) Install the VSCode extension

From the repo root:

```bash
pnpm --filter token-count-vscode build
```

Then in VSCode, run **Developer: Install Extension from Location...** and
point it at `packages/vscode`. Alternatively, open `packages/vscode` in VSCode
and press `F5` to launch an Extension Development Host.

---

## 💻 Usage

### CLI

```bash
# Totals + daily breakdown (default grouping)
token-count stats

# Group by model instead of day
token-count stats --by model

# Group by project (cwd at the time of each turn)
token-count stats --by project

# Restrict to a date range
token-count stats --since 2026-04-01 --until 2026-04-19

# Include an estimated USD cost column
token-count stats --cost

# Per-day rows are bucketed at your machine's local midnight by default
# (so a session at 11pm shows up on the day you actually ran it). Pass
# --utc to anchor to UTC midnight instead.
token-count stats --utc

# Re-import history from ~/.claude/projects/ at any time (safe, dedupes)
token-count backfill
```

Run `token-count --help` (or `token-count <subcommand> --help`) for the
full list of flags and concrete examples.

Example output:

```text
Totals    Input     Output  Cache create   Cache read        Total  Turns
------  -------  ---------  ------------  -----------  -----------  -----
all     152,248  2,703,219    13,958,482  301,311,047  318,124,996   5843
```

Columns:

- **Input** — fresh, uncached prompt tokens.
- **Output** — tokens the model generated.
- **Cache create** — tokens written into the 5-minute prompt cache
  (~1.25× input price).
- **Cache read** — tokens served from a prior cache write (~0.10× input
  price). This is usually the biggest number because Claude Code re-sends
  the whole conversation each turn.
- **Total** — sum of all four.
- **Turns** — number of assistant responses (one per `message.usage` record).

### VSCode extension

All four surfaces read the same `~/.token-count/usage.jsonl` and auto-refresh
whenever the hook appends a record.

- **Left status bar** — shows `◆ 12.4k today`. Click to open the dashboard.
- **Right status bar** — shows the same "today" number with a different
  icon. Hovering reveals a markdown tooltip with today / last-7-days /
  all-time totals, message counts, and the top model. Click to open the
  dashboard. Toggle off via the `tokenCount.rightStatusBar.enabled` setting.
- **Activity-bar sidebar** — click the Token Count icon in the left
  activity bar to open a "Usage Summary" panel. Four default stat cards
  (today tokens, today messages, current project tokens, current project
  messages) plus a `+ Add stat` tile that opens a picker with the rest
  (7-day / all-time totals and messages, sessions, active days, msgs/day,
  top model today). Each pinned stat has a remove button (`×`) that
  appears on hover.
- **Dashboard** — command palette → **Token Count: Show Dashboard** (or
  click any status-bar item). Contents:
  - Summary cards for today / last 7 days / all-time tokens, plus a compact
    stats row (user messages, msgs/day, sessions, projects, models, active
    days, first-recorded date).
  - A time-series chart with a timeframe dropdown (past week / month /
    year / all-time), a model filter, a project filter, a chart-type
    toggle (**Heatmap** GitHub-style calendar grid in Claude orange —
    the default — plus **Bars** and **Line**), and a
    **Tokens/Messages** toggle. The model and project filters are
    independent and combine; an empty (model × project) intersection
    shows a friendly placeholder. All filter combinations with data are
    pre-rendered, so switching is instant.
  - A "By model" table that's sortable on any column (click a header to
    toggle descending/ascending) and whose rows are clickable — clicking
    a model filters the chart above.
  - A "Project breakdown" donut with its own Tokens/Messages toggle and a
    center-label total. Hovering a wedge pops it outward; clicking a wedge
    filters the chart to that project (and highlights the matching wedge).
  - A "By project" table, also sortable and clickable.

Settings (open with **Preferences: Open User Settings** → search
"token count"):

- `tokenCount.rightStatusBar.enabled` (default `true`) — show/hide the
  right-side status bar item.
- `tokenCount.useLocalTimezone` (default `true`) — bucket per-day stats
  at your machine's local midnight. Turn off to bucket at UTC midnight
  instead (matches `token-count stats --utc`). Affects the dashboard
  charts, the sidebar cards, and the status bar tooltips. Toggling
  applies immediately — no window reload required.

---

## 🏗️ How it works & architecture

For the internal design — data flow from transcript to dashboard, the
monorepo layout, package responsibilities, and the storage format — see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 🧪 Development

```bash
pnpm install
pnpm -r build              # build all packages
pnpm -r test               # run the full test suite (vitest)
pnpm --filter @token-count/cli dev    # run the CLI from source
```

Tests live under `tests/` inside each package, split into `unit/`,
`integration/`, `e2e/`, and `stress/`. Integration and e2e tests point
`TOKEN_COUNT_DIR` at a temp directory so they never touch real user data.

---

## 🚧 Limitations & non-goals

- **Claude Code only (for now).** The schema has a `source` field and the
  parser is adapter-shaped, so Codex or other tools could be added later,
  but there's no code for them yet.
- **No rotation or compaction.** `usage.jsonl` grows forever. At ~150 bytes
  per turn this is fine for years of heavy use; revisit if that changes.
- **No network.** The hook never talks to anything off-machine. Rates in
  `pricing.ts` are a hard-coded snapshot, not a live feed.
- **Cost is an estimate.** Treat `--cost` as directional. Compare against
  Claude Code's `/cost` command for an authoritative figure.
