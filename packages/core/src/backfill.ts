// Backfill: import all historical Claude Code token usage from every
// transcript under `~/.claude/projects/<slug>/*.jsonl`.
//
// The Stop hook only sees transcripts for sessions that are live AFTER
// `token-count init` runs. Backfill fills the gap so stats cover usage
// from before install too.
//
// Contract:
//   - Idempotent. Re-running is safe: records are deduped by `turn_uuid`
//     against whatever is already in usage.jsonl.
//   - After run, state.json has a cursor per session pointing at the last
//     turn we ingested. That way a later Stop-hook fire on the same session
//     picks up only NEW turns (without double-counting the backfill).
//   - Never throws on a bad transcript file. Silently skips garbage lines
//     (parseAssistantTurns already does this) and ignores non-.jsonl files.
//
// Design note: this lives in `core` (not `cli`) because both the CLI and
// the VSCode extension might eventually want to trigger it.

import fs from "node:fs";
import path from "node:path";
import { parseAssistantTurns } from "./transcript.js";
import {
  appendRecords,
  readAllRecords,
  readStateCursor,
  writeStateCursor,
} from "./storage.js";
import type { UsageRecord } from "./types.js";

export interface BackfillOptions {
  /**
   * Absolute path to Claude Code's projects directory, typically
   * `~/.claude/projects`. Injectable for tests.
   */
  projectsDir: string;
}

export interface BackfillResult {
  /** Number of .jsonl transcript files we opened. */
  sessionsScanned: number;
  /** Number of records appended to usage.jsonl. */
  appended: number;
  /** Records seen in transcripts but skipped because turn_uuid was a duplicate. */
  skipped: number;
}

/**
 * Walk `projectsDir` and ingest every assistant turn we haven't already
 * recorded. Updates state.json cursors so the per-turn hook resumes cleanly.
 */
export function backfillFromClaudeProjects(
  opts: BackfillOptions,
): BackfillResult {
  // Missing projects dir → fresh Claude install, nothing to do.
  if (!fs.existsSync(opts.projectsDir)) {
    return { sessionsScanned: 0, appended: 0, skipped: 0 };
  }

  // Build a Set of turn_uuids we already have. O(records) memory but cheap
  // — even thousands of records is <1MB of strings.
  const existingUuids = new Set<string>(
    readAllRecords().map((r) => r.turn_uuid),
  );

  const cursor = readStateCursor();
  const toAppend: UsageRecord[] = [];
  let sessionsScanned = 0;
  let skipped = 0;

  // Each subdirectory of projectsDir is one project slug. Inside are
  // per-session .jsonl transcripts.
  for (const slug of safeReaddir(opts.projectsDir)) {
    const slugPath = path.join(opts.projectsDir, slug);
    if (!fs.statSync(slugPath).isDirectory()) continue;

    for (const name of safeReaddir(slugPath)) {
      if (!name.endsWith(".jsonl")) continue;
      const transcriptPath = path.join(slugPath, name);
      sessionsScanned += 1;

      // parseAssistantTurns returns every record in the file (no cursor
      // passed). We dedupe against existingUuids below.
      const records = parseAssistantTurns(transcriptPath);
      if (records.length === 0) continue;

      for (const r of records) {
        if (existingUuids.has(r.turn_uuid)) {
          skipped += 1;
          continue;
        }
        existingUuids.add(r.turn_uuid);
        toAppend.push(r);
      }

      // Advance the cursor to the last turn in this file so the live hook
      // resumes from here. Use session_id off the records (the filename is
      // usually the session id but we don't rely on that).
      const last = records[records.length - 1]!;
      cursor[last.session_id] = last.turn_uuid;
    }
  }

  // Single append so we don't thrash the file on large backfills.
  if (toAppend.length > 0) {
    appendRecords(toAppend);
  }
  writeStateCursor(cursor);

  return {
    sessionsScanned,
    appended: toAppend.length,
    skipped,
  };
}

/**
 * fs.readdirSync but returns [] for any error (permission denied, missing
 * dir, etc.) instead of throwing. Backfill should never fail-hard because
 * of one weird subdirectory.
 */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
