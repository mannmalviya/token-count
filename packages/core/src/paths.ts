// Where data lives on disk.
//
// By default every file is under `~/.token-count/`. The env var
// `TOKEN_COUNT_DIR` overrides the base dir — we use it in tests (so we don't
// write to the real home) and we could use it in the VSCode extension if it
// ever runs under a different HOME.
//
// IMPORTANT: these are the ONLY places in the codebase allowed to know about
// the directory layout. Everything else imports from here.

import os from "node:os";
import path from "node:path";

/** Base directory that holds all local token-count data. */
export function tokenCountDir(): string {
  // Env override takes precedence. Falsy check covers both "unset" and "".
  const override = process.env.TOKEN_COUNT_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".token-count");
}

/** Append-only log of one UsageRecord per line. */
export function usageJsonlPath(): string {
  return path.join(tokenCountDir(), "usage.jsonl");
}

/** Per-session cursor so the hook can resume scanning instead of re-reading. */
export function stateJsonPath(): string {
  return path.join(tokenCountDir(), "state.json");
}

/**
 * Append-only log of one PromptRecord per real user prompt.
 *
 * Kept separate from usage.jsonl because the schemas and dedupe keys differ
 * (prompts dedupe by prompt_id; usage dedupes by turn_uuid). Two thin files
 * are easier to reason about than one file with a `kind` discriminator.
 */
export function promptsJsonlPath(): string {
  return path.join(tokenCountDir(), "prompts.jsonl");
}
