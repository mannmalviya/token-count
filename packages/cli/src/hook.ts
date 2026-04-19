// `token-count hook` — the Stop hook handler invoked by Claude Code.
//
// Claude Code pipes a small JSON payload on stdin (session_id,
// transcript_path, cwd, hook_event_name). We:
//   1. Load the cursor for this session from state.json.
//   2. Parse only the new assistant turns in the transcript.
//   3. Append them to usage.jsonl.
//   4. Update the cursor to the last uuid we saw.
//
// CRITICAL: This function must never throw. Any uncaught error would crash
// the hook process, which Claude Code surfaces to the user. The CLI
// entrypoint wraps this in a try/catch so exit code is always 0.

import {
  appendRecords,
  parseAssistantTurns,
  readStateCursor,
  writeStateCursor,
} from "@token-count/core";

/** Shape of the JSON payload Claude Code pipes on stdin for the Stop hook. */
export interface HookPayload {
  session_id: string;
  transcript_path: string;
  // These fields are in the payload but we don't currently need them.
  cwd?: string;
  hook_event_name?: string;
}

export interface HookResult {
  /** How many new records were appended to usage.jsonl this invocation. */
  appended: number;
}

/**
 * Run the hook given an already-parsed payload. Pure-ish: reads/writes files
 * under TOKEN_COUNT_DIR via the core storage helpers, so tests can redirect
 * it to a tmp dir.
 */
export function runHook(payload: HookPayload): HookResult {
  // Pull the last uuid we processed for this session, if any. First run of
  // a session will have no cursor → parseAssistantTurns returns all records.
  const cursor = readStateCursor();
  const sinceUuid = cursor[payload.session_id];

  const newRecords = parseAssistantTurns(payload.transcript_path, sinceUuid);

  if (newRecords.length === 0) {
    return { appended: 0 };
  }

  // Append first, then update the cursor. If a crash happens in between the
  // worst case is that next run re-parses from the old cursor and dedupes
  // via `parseAssistantTurns(…, sinceUuid)` — we'd only double-count if the
  // crash happens AFTER the append finishes, which is a tiny window. For v1
  // this is acceptable; we can add a dedupe-by-uuid scan to appendRecords
  // later if we see real duplicates in the wild.
  appendRecords(newRecords);

  const last = newRecords[newRecords.length - 1]!;
  cursor[payload.session_id] = last.turn_uuid;
  writeStateCursor(cursor);

  return { appended: newRecords.length };
}
