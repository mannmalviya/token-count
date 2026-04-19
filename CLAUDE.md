# CLAUDE.md

Guidance for Claude Code sessions working in this repo. Read [PLAN.md](PLAN.md)
first — it has the architecture, data flow, and storage schema.

## What this project is

A local-first tracker for Claude Code token usage. A `Stop` hook calls
`token-count hook`, which tails the session's transcript JSONL
(`~/.claude/projects/<slug>/<session-id>.jsonl`), extracts new assistant turns
with `message.usage`, and appends records to `~/.token-count/usage.jsonl`. A
CLI (`stats`) and a VSCode extension read that same file.

## Stack

- **TypeScript + Node** across the whole repo.
- **pnpm workspaces** (`packages/core`, `packages/cli`, `packages/vscode`).
- **`tsup`** to build the core + CLI. **`esbuild`** to bundle the extension.
- **`zod`** for schema validation of transcript + settings JSON (anything
  we don't own). `commander` for the CLI. `cli-table3` for `stats` output.
- Tests: **`vitest`**.

## Build + run

```bash
pnpm install
pnpm -r build             # builds all packages
pnpm --filter @token-count/cli dev    # run CLI from source
pnpm -r test
```

Linking the CLI locally so `token-count` is on PATH:

```bash
pnpm --filter @token-count/cli link --global
```

## General rules

- **File names use `kebab-case`** (e.g. `transcript-parser.ts`, not
  `transcriptParser.ts`).
- **The user is new to coding — write lots of explanatory comments.** Not just
  the "why is this non-obvious" kind, but also what each block does and why
  this pattern was chosen. Prefer clarity over cleverness. When introducing
  a new pattern (async iterators, zod schemas, workspace deps), explain it
  in a short comment.
- **Follow TDD.** Write tests first, then the implementation that makes them
  pass. Every function in `core` ships with a vitest test.
- **Clean, simple design.** Small files, small functions, minimal abstraction.
  If a wrapper has one caller, inline it.

## Coding rules

- **No cloud, no shared DB** — all data is local under `~/.token-count/`.
- **No native binary dependencies.** Keeps the VSCode extension portable
  across platforms and avoids build headaches. (No `better-sqlite3`, etc.)
- **Stats are always computed at read time** from `usage.jsonl`. Never cache
  aggregates on disk.
- **Dedupe by `turn_uuid`.** The cursor in `state.json` is an optimization;
  the append path still skips records whose uuid is already present for that
  session (cheap when the cursor is correct).
- **Append is the only write to `usage.jsonl`.** No rewrites, no rotation in
  v1. A single `fs.appendFile` with a trailing newline.
- **`core` exposes `TOKEN_COUNT_DIR` as an env override.** Tests and the
  extension use it. Never hard-code `~/.token-count` outside `paths.ts`.
- **The hook must never fail the user's turn.** `token-count hook` exits 0
  unconditionally. All errors go to stderr. Wrap top-level logic in try/catch.
- **One package, one responsibility.** `core` has no CLI or VSCode
  dependencies — plain Node + zod. Imported by both consumers.

## Tests

Tests live under `tests/` inside each package, organized by type:

```text
packages/core/tests/
├── unit/         # pure-function tests, no fs
├── integration/  # touches a temp dir via TOKEN_COUNT_DIR
├── e2e/          # spawns the CLI as a child process
└── stress/       # large transcript / high-volume append checks
```

Run `pnpm -r test` from the root.

## Command Guard

Before running any shell command, prefix the response with one of these:

- `[READ-ONLY]` — just looking, no harm done (e.g. `ls`, `cat`, `pnpm -v`)
- `[MUTATION]` — changes things but recoverable (e.g. `pnpm install`,
  writing a file)
- `[DESTRUCTIVE]` — irreversible, think twice (e.g. `rm -rf`, `git reset --hard`)
- `[SYSTEM]` — touches system-level stuff (packages installed globally,
  permissions, editing shell rc files)

## Style

- **No emojis** in code, commits, or docs unless explicitly asked.
- **Commit messages:** short, imperative, match the existing `git log` style.
  No trailing summaries.

## Key files

Once scaffolded:

- [packages/core/src/transcript.ts](packages/core/src/transcript.ts) —
  parses `~/.claude/projects/<slug>/<session>.jsonl`. This is the one piece
  that depends on Claude Code's on-disk format. If it changes, update the
  zod schema here.
- [packages/core/src/storage.ts](packages/core/src/storage.ts) — the only
  code that writes `usage.jsonl` and `state.json`.
- [packages/cli/src/hook.ts](packages/cli/src/hook.ts) — the Stop hook
  entrypoint. Keep it small and exit-0 safe.
- [packages/cli/src/init.ts](packages/cli/src/init.ts) — the only code
  that edits `~/.claude/settings.json`. Must be idempotent and preserve any
  hooks already configured.

## Transcript schema (for reference)

Assistant event, shape we rely on:

```json
{
  "type": "assistant",
  "uuid": "…",                 // dedupe key
  "sessionId": "…",
  "timestamp": "2026-04-19T…Z",
  "cwd": "/home/mann/…",
  "requestId": "…",
  "message": {
    "model": "claude-opus-4-7",
    "usage": {
      "input_tokens": 3,
      "output_tokens": 412,
      "cache_creation_input_tokens": 9847,
      "cache_read_input_tokens": 11226
    }
  }
}
```

Other event types (`user`, `queue-operation`, `file-history-snapshot`,
`system`, `ai-title`, `attachment`, `last-prompt`) are ignored.

## Hook payload (for reference)

Stdin to `token-count hook`:

```json
{
  "session_id": "…",
  "transcript_path": "/home/mann/.claude/projects/<slug>/<session-id>.jsonl",
  "cwd": "/home/mann/some-project",
  "hook_event_name": "Stop"
}
```

## Don'ts

- Don't rotate / compact `usage.jsonl` in v1. Append-only is the whole point.
- Don't read the transcript from the extension. The extension only reads
  `~/.token-count/usage.jsonl` (and watches it with `FileSystemWatcher`).
- Don't add a daemon or background process. Everything is on-demand: hook on
  write, CLI/extension on read.
- Don't make the hook network-aware. Purely local.
