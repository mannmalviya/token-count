# Architecture

For install and usage, see [README.md](README.md).

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

## 🏗️ Monorepo layout

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
