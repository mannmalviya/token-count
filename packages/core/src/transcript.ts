// Parses a Claude Code transcript JSONL file into UsageRecord values.
//
// The transcript file is append-only, one JSON object per line. Many event
// types live there (user, assistant, queue-operation, file-history-snapshot,
// ...); we only care about `assistant` events that include token `usage`.
//
// Design notes:
//   - We read the whole file synchronously. Transcripts for a single session
//     are typically small (KB to a few MB). If that ever becomes a problem
//     we can switch to a streaming read without changing the signature.
//   - We validate each line with zod. Malformed lines are skipped silently
//     rather than throwing, because:
//       * The transcript is external data we don't own.
//       * The Stop hook must never crash — that would block Claude Code.
//   - `sinceUuid` lets the hook resume where it left off. Events are emitted
//     in the order they appear in the file, so a simple "toggle on after
//     seeing uuid" works.

import fs from "node:fs";
import {
  TranscriptAssistantEventSchema,
  TranscriptUserEventSchema,
  type PromptRecord,
  type UsageRecord,
} from "./types.js";

/**
 * Parse a Claude Code transcript and return one UsageRecord per assistant
 * turn that has usage data.
 *
 * @param transcriptPath absolute path to the session JSONL
 * @param sinceUuid if set, return only records whose event appears AFTER
 *                  the event with this uuid. If the uuid is not present in
 *                  the file (e.g. the transcript was truncated), we fall
 *                  back to returning all records.
 */
export function parseAssistantTurns(
  transcriptPath: string,
  sinceUuid?: string,
): UsageRecord[] {
  // If the file doesn't exist yet, return an empty list. This can happen
  // briefly when a new Claude Code session starts — the hook might fire
  // before the transcript is flushed to disk.
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  // Split on newlines. An empty last element (trailing newline) is filtered
  // out below by the JSON.parse guard.
  const lines = raw.split("\n");

  // First pass: parse every line that looks like a valid assistant-with-usage
  // event. We keep both the parsed record and the raw uuid so we can apply
  // `sinceUuid` filtering as a second step.
  const parsed: UsageRecord[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;

    // Step 1: JSON.parse — bail silently on garbage.
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Step 2: zod-validate the assistant event shape. `safeParse` returns
    // `{ success: false }` for non-matching input instead of throwing.
    const result = TranscriptAssistantEventSchema.safeParse(obj);
    if (!result.success) continue;

    // Step 3: convert the transcript event into our storage-level UsageRecord.
    // We tag `source: "claude-code"` here since this parser is specific to
    // Claude Code's on-disk format.
    const ev = result.data;
    parsed.push({
      ts: ev.timestamp,
      source: "claude-code",
      session_id: ev.sessionId,
      turn_uuid: ev.uuid,
      request_id: ev.requestId ?? "",
      cwd: ev.cwd ?? "",
      model: ev.message.model,
      input_tokens: ev.message.usage.input_tokens,
      output_tokens: ev.message.usage.output_tokens,
      cache_creation_input_tokens: ev.message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: ev.message.usage.cache_read_input_tokens,
    });
  }

  // If no sinceUuid was requested, return everything we parsed.
  if (sinceUuid === undefined) return parsed;

  // Otherwise, find the index of the sinceUuid in our parsed list and return
  // everything strictly after it. If we can't find it (transcript rotated /
  // truncated) we return all records — safer to let the dedupe in the
  // storage layer handle duplicates than to silently drop data.
  const cutoff = parsed.findIndex((r) => r.turn_uuid === sinceUuid);
  if (cutoff === -1) return parsed;
  return parsed.slice(cutoff + 1);
}

// ---------------------------------------------------------------------------
// parseUserPrompts
//
// Walks the same transcript file but yields one PromptRecord per REAL user
// prompt. "Real" means the event's content carries at least one `text` block
// (or is a plain string in older transcripts) — we drop synthetic tool_result
// events, which are the agent loop's way of feeding tool output back to the
// model. We also dedupe by `promptId` because a single prompt sometimes
// produces multiple transcript events.
//
// Same graceful-failure contract as parseAssistantTurns: missing file → [];
// malformed lines are skipped silently.
// ---------------------------------------------------------------------------

export function parseUserPrompts(transcriptPath: string): PromptRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: PromptRecord[] = [];
  // Track promptIds we've already emitted for this file so dedup is O(1).
  const seenPromptIds = new Set<string>();

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const result = TranscriptUserEventSchema.safeParse(obj);
    if (!result.success) continue;
    const ev = result.data;

    // Drop events with no promptId — we can't dedupe them.
    if (!ev.promptId) continue;
    if (seenPromptIds.has(ev.promptId)) continue;

    // Must contain at least one `text` block to count as a real prompt.
    // A string-form content (old transcripts) is always a real prompt.
    const isRealPrompt =
      typeof ev.message.content === "string"
        ? true
        : ev.message.content.some((b) => b.type === "text");
    if (!isRealPrompt) continue;

    seenPromptIds.add(ev.promptId);
    out.push({
      ts: ev.timestamp,
      source: "claude-code",
      session_id: ev.sessionId,
      prompt_id: ev.promptId,
      cwd: ev.cwd ?? "",
    });
  }

  return out;
}
