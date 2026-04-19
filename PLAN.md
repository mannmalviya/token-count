# Token Count — Plan

Local-first tracker for Claude Code token usage. Stores per-turn records in
`~/.token-count/usage.jsonl` and exposes them through a CLI and a VSCode
extension. Codex support is deferred; the storage schema leaves a seam for it.

## How it works

Claude Code writes every assistant turn into a transcript JSONL at
`~/.claude/projects/<slug>/<session-id>.jsonl`. Each assistant event carries a
`message.usage` object with `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, plus `model`.

The `Stop` hook fires after each response. We install it once (globally) via
`token-count init`. When it fires, `token-count hook` reads `session_id` +
`transcript_path` from stdin, tails the transcript for new assistant turns
(dedupe by the event `uuid`), and appends records to `~/.token-count/usage.jsonl`.

```
Claude Code ──Stop hook──▶ token-count hook
                               │
                               ▼
                   tail transcript, extract new
                   assistant turns (dedupe by uuid)
                               │
                               ▼
                   append to ~/.token-count/usage.jsonl
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
 token-count stats      VSCode status bar      VSCode webview
   (terminal table)     (today's total)        (time-series chart)
```

## Repo layout

```
token-count/                         (monorepo root, pnpm workspaces)
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── PLAN.md                          (this file)
├── CLAUDE.md                        (guidance for Claude Code sessions)
└── packages/
    ├── core/                        (@token-count/core — shared lib)
    ├── cli/                         (@token-count/cli — token-count bin)
    └── vscode/                      (@token-count/vscode — extension)
```

## Storage format

`~/.token-count/usage.jsonl` — one line per assistant turn:

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

`turn_uuid` is the dedupe key. A sibling `~/.token-count/state.json` stores the
per-session cursor `{ [session_id]: last_seen_uuid }` so the hook only scans
new lines in the transcript.

## Packages

### `@token-count/core`

Shared library consumed by both the CLI and the extension. No CLI deps, no
VSCode deps — just Node stdlib + `zod` for schema validation.

- `paths.ts` — resolves `~/.token-count/{usage.jsonl,state.json}`, honors
  `TOKEN_COUNT_DIR` env override (tests + the extension).
- `transcript.ts` — `parseAssistantTurns(transcriptPath, sinceUuid?)` streams
  JSONL and yields records for `type === "assistant"` events with a
  `message.usage`.
- `storage.ts` — `appendRecords`, `readAllRecords`, `readStateCursor`,
  `writeStateCursor`. Append is line-atomic.
- `aggregate.ts` — `summarize(records, { groupBy, since?, until? })`.
- `types.ts` — `UsageRecord`, `Source`, `Summary`.

### `@token-count/cli`

Single `token-count` binary with three subcommands (built on `commander`).

- `token-count init [--project]` — idempotently writes the Stop hook entry
  into `~/.claude/settings.json` (or `.claude/settings.json` with `--project`)
  and creates `~/.token-count/`.
- `token-count hook` — reads hook payload on stdin, appends new turn records
  to `usage.jsonl`, updates the cursor. Always exits 0 so Claude Code never
  blocks on us.
- `token-count stats [--since] [--by day|model|project]` — terminal table
  from `aggregate.summarize`.

### `@token-count/vscode`

- Status bar item (left): `◆ 12.4k today`. Watches `usage.jsonl` for changes
  and refreshes live. Click opens the dashboard.
- Webview dashboard (`tokenCount.showDashboard`): time-series line chart (last
  30 days), all-time/week/today totals, breakdowns by model and project.
- Imports `@token-count/core` directly; bundled via `esbuild` at package time.

## Implementation order

1. Monorepo scaffold — root `package.json`, `pnpm-workspace.yaml`,
   `tsconfig.base.json`, `.gitignore`.
2. `core` — types, paths, transcript parser, storage, aggregate. Unit tests
   against a fixture transcript.
3. CLI `hook` — pipe a synthetic payload, confirm `usage.jsonl` grows.
4. CLI `init` — writes hook config idempotently.
5. CLI `stats` — terminal table, eyeball against `/cost`.
6. VSCode extension — status bar + webview.
7. Packaging + README install instructions.

## Codex (deferred)

The schema's `source` field + adapter-style seam (`parseAssistantTurns`) leaves
room for a `core/adapters/codex.ts` later. No code for it yet.

## Verification

1. `pnpm install && pnpm -r build && pnpm --filter cli link --global`
2. `token-count init` → `~/.claude/settings.json` has the new Stop hook.
3. Open a Claude Code session, send a prompt → `~/.token-count/usage.jsonl`
   gains a record with non-zero `output_tokens`.
4. `token-count stats` totals match `/cost` within rounding.
5. Extension: `F5` → status bar shows today's total; webview renders.
6. Re-running `token-count init` is a no-op.
