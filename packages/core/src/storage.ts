// Read/write helpers for `~/.token-count/usage.jsonl` and
// `~/.token-count/state.json`.
//
// RULES (see CLAUDE.md):
//   - usage.jsonl is APPEND-ONLY. No rewrites, no rotation in v1.
//   - Writes go through a single fs.appendFileSync with a trailing newline.
//   - Reads are tolerant: malformed lines are skipped, not thrown.
//   - state.json is a small JSON object; overwrite-in-place is fine because
//     it's tiny (one key per active session).

import fs from "node:fs";
import path from "node:path";
import {
  StateCursorSchema,
  UsageRecordSchema,
  type StateCursor,
  type UsageRecord,
} from "./types.js";
import { stateJsonPath, tokenCountDir, usageJsonlPath } from "./paths.js";

// ---------------------------------------------------------------------------
// usage.jsonl
// ---------------------------------------------------------------------------

/**
 * Append one or more UsageRecords to usage.jsonl. Creates the parent dir and
 * file if they don't exist yet.
 *
 * An empty array is a no-op — we don't want to create the file just to
 * touch it.
 */
export function appendRecords(records: UsageRecord[]): void {
  if (records.length === 0) return;

  // Make sure `~/.token-count/` exists. `recursive: true` is idempotent.
  fs.mkdirSync(tokenCountDir(), { recursive: true });

  // Build the full chunk as a single string and write it in one call. Doing
  // all the serialization up front means we only issue one system call per
  // append, which is both faster and less likely to interleave with other
  // writers.
  const chunk = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(usageJsonlPath(), chunk, "utf8");
}

/**
 * Read every record from usage.jsonl. Returns [] if the file doesn't exist
 * yet (fresh install). Lines that fail JSON or schema validation are skipped
 * rather than throwing — we never want the dashboard to crash because of a
 * single corrupt record.
 */
export function readAllRecords(): UsageRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(usageJsonlPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed JSON
    }
    const result = UsageRecordSchema.safeParse(obj);
    if (result.success) records.push(result.data);
    // silently drop records that don't match the current schema
  }
  return records;
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

/** Returns the saved per-session cursor map, or {} if unset/corrupt. */
export function readStateCursor(): StateCursor {
  let raw: string;
  try {
    raw = fs.readFileSync(stateJsonPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    const result = StateCursorSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/** Overwrites state.json with the given cursor map. */
export function writeStateCursor(cursor: StateCursor): void {
  fs.mkdirSync(path.dirname(stateJsonPath()), { recursive: true });
  // `null, 2` pretty-prints the file so a human can eyeball it if curious.
  fs.writeFileSync(stateJsonPath(), JSON.stringify(cursor, null, 2), "utf8");
}
