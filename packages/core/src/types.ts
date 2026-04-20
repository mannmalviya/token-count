// Shared types for the whole monorepo.
//
// We define them once here using `zod`. zod is a small library that lets us
// describe a data shape AND validate that a runtime value matches that shape.
// The TypeScript type is inferred from the schema with `z.infer<...>`, so
// the compile-time type and the runtime validator can never drift apart.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Source of a usage record.
//
// For now only Claude Code writes records. "codex" is reserved so that when
// we add a Codex adapter later, the storage format doesn't need to change.
// ---------------------------------------------------------------------------
export const SourceSchema = z.enum(["claude-code", "codex"]);
export type Source = z.infer<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// UsageRecord — one line of `~/.token-count/usage.jsonl`.
//
// Every field is required. Unknown / missing fields cause parse() to throw,
// which is what we want: a malformed line is a bug, not something to silently
// tolerate. Negative token counts are rejected since they're never valid.
// ---------------------------------------------------------------------------
export const UsageRecordSchema = z.object({
  // ISO-8601 UTC timestamp of when the assistant turn completed.
  // z.string().datetime() enforces a proper RFC-3339 string.
  ts: z.string().datetime(),

  source: SourceSchema,

  // Claude Code session id (UUID). Correlates back to the transcript file.
  session_id: z.string().min(1),

  // UUID of the specific assistant event in the transcript. Used as a dedupe
  // key so we never double-count if the hook re-reads the transcript.
  turn_uuid: z.string().min(1),

  // Claude's internal request id. Useful for debugging, not for dedup.
  // Allowed to be empty string since older / minimal transcripts may omit it.
  request_id: z.string(),

  // Working directory of the Claude Code session. Lets us break down usage
  // by project later. Empty string allowed when the transcript omits it.
  cwd: z.string(),

  // Model identifier, e.g. "claude-opus-4-7".
  model: z.string().min(1),

  // Token counts. Non-negative integers.
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

// ---------------------------------------------------------------------------
// PromptRecord — one line of `~/.token-count/prompts.jsonl`.
//
// One record per REAL user prompt (i.e. something the human actually typed).
// Claude Code transcripts contain two kinds of `type: "user"` events:
//   1. Genuine user input — has a `text` content block.
//   2. Synthetic tool_result messages the agent loop injects after a tool
//      call — has a `tool_result` content block. These share the same
//      `promptId` as the user prompt that kicked off the turn.
//
// By deduping on `promptId` we get exactly one record per user prompt — the
// number Claude Code's `/insights` calls "messages".
// ---------------------------------------------------------------------------
export const PromptRecordSchema = z.object({
  // ISO-8601 UTC timestamp of the user prompt.
  ts: z.string().datetime(),
  source: SourceSchema,
  session_id: z.string().min(1),
  // The transcript's `promptId`. Our dedupe key — a single user prompt has
  // one of these regardless of how many tool calls it spawns downstream.
  prompt_id: z.string().min(1),
  cwd: z.string(),
});
export type PromptRecord = z.infer<typeof PromptRecordSchema>;

// ---------------------------------------------------------------------------
// Shape of a user event in Claude Code's transcript JSONL.
//
// We only model the fields we read. `message.content` is an array that can
// mix text blocks and tool_result blocks; we inspect it to tell real prompts
// from synthetic ones.
// ---------------------------------------------------------------------------
export const TranscriptUserEventSchema = z.object({
  type: z.literal("user"),
  uuid: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  cwd: z.string().optional(),
  promptId: z.string().optional(),
  message: z.object({
    role: z.literal("user"),
    // Content can be a string (old shape) or an array of blocks (current).
    // zod's union handles either.
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string() }).passthrough()),
    ]),
  }),
});
export type TranscriptUserEvent = z.infer<typeof TranscriptUserEventSchema>;

// ---------------------------------------------------------------------------
// Shape of an assistant event in Claude Code's transcript JSONL.
//
// We only model the fields we actually read. Claude may add new fields —
// that's fine, zod's default is to strip unknown keys unless we use
// `.strict()`. We intentionally don't use .strict() here so that future
// schema changes don't break us.
// ---------------------------------------------------------------------------
export const TranscriptAssistantEventSchema = z.object({
  type: z.literal("assistant"),
  uuid: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  cwd: z.string().optional(),
  requestId: z.string().optional(),
  message: z.object({
    model: z.string(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      // Cache fields are newer additions — be tolerant if absent.
      cache_creation_input_tokens: z.number().optional().default(0),
      cache_read_input_tokens: z.number().optional().default(0),
    }),
  }),
});
export type TranscriptAssistantEvent = z.infer<typeof TranscriptAssistantEventSchema>;

// ---------------------------------------------------------------------------
// StateCursor — shape of `~/.token-count/state.json`.
//
// Maps session_id -> last-seen turn uuid. Lets the hook start scanning the
// transcript from where it left off instead of re-reading the whole file
// every turn.
// ---------------------------------------------------------------------------
export const StateCursorSchema = z.record(z.string(), z.string());
export type StateCursor = z.infer<typeof StateCursorSchema>;
