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
    year / all-time), a model filter, a project filter, a **Bars/Line**
    toggle, and a **Tokens/Messages** toggle. All combinations are
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

---

## ⚙️ How it works

Claude Code writes every conversation to a transcript JSONL at
`~/.claude/projects/<slug>/<session-id>.jsonl`. Each assistant event in that
file carries a `message.usage` object with the token counts and the model
name.

When an assistant response finishes, Claude Code fires a `Stop` hook. Our
hook entry runs `token-count hook`, which:

1. Reads `session_id` and `transcript_path` from its stdin payload.
2. Looks up the last-seen `uuid` for that session in `state.json`.
3. Streams the transcript from that point forward, picking out new
   `type: "assistant"` events that have `message.usage`.
4. Appends one line per event to `~/.token-count/usage.jsonl`.
5. Updates the per-session cursor in `state.json`.

The hook always exits `0`. Errors go to stderr so they never fail the user's
turn.

```text
Claude Code --Stop hook--> token-count hook
                               |
                               v
                   tail transcript, extract new
                   assistant turns (dedupe by uuid)
                               |
                               v
                   append to ~/.token-count/usage.jsonl
                               |
       +-----------------------+-----------------------+
       v                       v                       v
 token-count stats      VSCode status bar      VSCode dashboard
   (terminal table)     (today's total)        (charts + tables)
```

Stats are always computed at read time from `usage.jsonl`. There's no cached
aggregate on disk — delete rows from the file and the next `stats` call
reflects it immediately.

---

## 🏗️ Architecture

### Monorepo layout

```text
token-count/                  pnpm workspace root
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── PLAN.md
├── CLAUDE.md
└── packages/
    ├── core/                 @token-count/core — shared library
    ├── cli/                  @token-count/cli — the `token-count` binary
    └── vscode/               token-count-vscode — the VSCode extension
```

The key invariant: `core` has no CLI or VSCode dependencies. It's plain Node
+ `zod` so both consumers import from the same source of truth.

### `@token-count/core`

Pure library. No side effects except the two functions in `storage.ts`.

- [packages/core/src/paths.ts](packages/core/src/paths.ts) — resolves
  `~/.token-count/{usage.jsonl,state.json}`. Honors the `TOKEN_COUNT_DIR` env
  override (used by tests and the VSCode extension).
- [packages/core/src/transcript.ts](packages/core/src/transcript.ts) —
  `parseAssistantTurns(path, sinceUuid?)` streams the transcript JSONL line
  by line and yields validated records for `type: "assistant"` events with a
  `message.usage`. Validation is done via `zod` so a schema change upstream
  produces a clear error instead of corrupted data.
- [packages/core/src/storage.ts](packages/core/src/storage.ts) — the only
  code that writes to `usage.jsonl` or `state.json`. `appendRecords` is
  line-atomic via a single `fs.appendFile`.
- [packages/core/src/aggregate.ts](packages/core/src/aggregate.ts) —
  `summarize(records, { groupBy, since?, until? })`. Pure function. No
  filesystem access.
- [packages/core/src/pricing.ts](packages/core/src/pricing.ts) — per-token
  USD rates for Opus / Sonnet / Haiku plus a fallback, and
  `estimateRecordCost(record)`.
- [packages/core/src/backfill.ts](packages/core/src/backfill.ts) — walks
  `~/.claude/projects/*/*.jsonl` and feeds every assistant turn through the
  same append path, dedupe-keyed by `turn_uuid`.
- [packages/core/src/types.ts](packages/core/src/types.ts) — `UsageRecord`,
  `Source`, `Summary` type definitions.

### `@token-count/cli`

A single `token-count` binary with four subcommands, wired up with
`commander`. Each subcommand lives in its own file so `index.ts` stays a
thin argument-parsing shim.

- [packages/cli/src/init.ts](packages/cli/src/init.ts) — the only code that
  edits `~/.claude/settings.json`. Idempotent; preserves any hooks the user
  already has.
- [packages/cli/src/hook.ts](packages/cli/src/hook.ts) — the Stop-hook
  entrypoint. Small and wrapped in a top-level try/catch so it never fails
  the user's turn.
- [packages/cli/src/stats.ts](packages/cli/src/stats.ts) — reads all
  records, rolls them up via `core.summarize`, and renders a table. Table
  formatting is done by hand with `padStart`/`padEnd` so long project paths
  don't get truncated by a library.

### `token-count-vscode`

- [packages/vscode/src/extension.ts](packages/vscode/src/extension.ts) —
  activation entrypoint. Creates all four surfaces, registers the
  dashboard command, and sets up a `FileSystemWatcher` on `usage.jsonl`
  (and `prompts.jsonl`) so everything refreshes whenever the hook appends
  a record.
- [packages/vscode/src/status-bar.ts](packages/vscode/src/status-bar.ts) —
  left status bar. Shows "today's total".
- [packages/vscode/src/right-status-bar.ts](packages/vscode/src/right-status-bar.ts)
  — right status bar. Same label, but its tooltip is a
  `vscode.MarkdownString` with the rich quick-peek breakdown.
- [packages/vscode/src/sidebar-view.ts](packages/vscode/src/sidebar-view.ts) —
  activity-bar webview. Renders the pinned stat cards, handles the
  `+ Add stat` picker, and persists the list via `context.globalState`.
- [packages/vscode/src/dashboard.ts](packages/vscode/src/dashboard.ts) —
  full dashboard webview. All charts are hand-rolled inline SVG; every
  filter combination is pre-rendered and toggled via CSS classes, so
  switching is a no-op on the extension host.

The extension never reads the transcript itself. It only reads
`~/.token-count/usage.jsonl` and `~/.token-count/prompts.jsonl` (via
`core`), which keeps its permissions surface small.

### Storage format

`~/.token-count/usage.jsonl` — one JSON object per line, one line per
assistant turn:

```json
{
  "ts": "2026-04-19T18:22:41.631Z",
  "source": "claude-code",
  "session_id": "8c975a4d-…",
  "turn_uuid": "…",
  "request_id": "…",
  "cwd": "/home/mann/token-count",
  "model": "claude-opus-4-7",
  "input_tokens": 3,
  "output_tokens": 412,
  "cache_creation_input_tokens": 9847,
  "cache_read_input_tokens": 11226
}
```

`turn_uuid` is the dedupe key. Append-only; we never rewrite or rotate the
file.

`~/.token-count/state.json` — `{ [session_id]: last_seen_uuid }`. A cursor
so the hook can skip already-processed transcript lines on subsequent runs.
Purely an optimization; the dedupe-by-uuid check on append is still the
source of truth.

### Data flow summary

- **Write path:** Claude Code → Stop hook → `token-count hook` →
  `transcript.parseAssistantTurns` → `storage.appendRecords` →
  `usage.jsonl`.
- **Read path (CLI):** `token-count stats` → `storage.readAllRecords` →
  `aggregate.summarize` → formatted table.
- **Read path (extension):** `FileSystemWatcher` fires →
  `storage.readAllRecords` → `aggregate.summarize` → status bar / webview.

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
