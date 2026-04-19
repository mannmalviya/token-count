// Tests for the Claude Code transcript parser.
//
// A "transcript" is the JSONL file Claude Code writes at
// `~/.claude/projects/<slug>/<session-id>.jsonl`. Each line is a JSON event.
// We only care about events of `type: "assistant"` that carry a
// `message.usage` object — those are the per-turn token counts.
//
// The parser should:
//   1. Skip non-assistant events (user, queue-operation, etc.).
//   2. Skip assistant events that have no usage (e.g. interrupted turns).
//   3. Skip malformed JSON lines without crashing.
//   4. Support `sinceUuid`: start yielding only AFTER that event uuid.
//   5. Return fully-formed UsageRecord values ready to append.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAssistantTurns } from "../../src/transcript.js";

// Helper: write `lines` as JSONL to a fresh temp file and return its path.
function writeTempTranscript(lines: unknown[]): string {
  // Each test gets its own tmpdir so parallel tests don't collide.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-transcript-"));
  const p = path.join(dir, "session.jsonl");
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// A canonical assistant event matching the shape Claude Code writes.
function assistantEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: "uuid-1",
    sessionId: "sess-1",
    timestamp: "2026-04-19T18:22:41.631Z",
    cwd: "/home/mann/token-count",
    requestId: "req-1",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 3,
        output_tokens: 412,
        cache_creation_input_tokens: 9847,
        cache_read_input_tokens: 11226,
      },
    },
    ...overrides,
  };
}

describe("parseAssistantTurns", () => {
  // Collect temp files to clean up after each test.
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpFiles.length = 0;
  });
  beforeEach(() => {
    tmpFiles.length = 0;
  });

  it("returns [] for an empty file", () => {
    const p = writeTempTranscript([]);
    tmpFiles.push(p);
    expect(parseAssistantTurns(p)).toEqual([]);
  });

  it("returns [] when the transcript path doesn't exist", () => {
    // The hook may race with file creation. Graceful return > throw.
    expect(parseAssistantTurns("/tmp/does-not-exist-xyz.jsonl")).toEqual([]);
  });

  it("yields one record per assistant event with usage", () => {
    const p = writeTempTranscript([assistantEvent()]);
    tmpFiles.push(p);
    const [rec] = parseAssistantTurns(p);
    expect(rec).toMatchObject({
      source: "claude-code",
      session_id: "sess-1",
      turn_uuid: "uuid-1",
      request_id: "req-1",
      cwd: "/home/mann/token-count",
      model: "claude-opus-4-7",
      input_tokens: 3,
      output_tokens: 412,
      cache_creation_input_tokens: 9847,
      cache_read_input_tokens: 11226,
    });
  });

  it("skips non-assistant event types", () => {
    const p = writeTempTranscript([
      { type: "user", content: "hi" },
      { type: "queue-operation", operation: "enqueue" },
      assistantEvent({ uuid: "a" }),
      { type: "file-history-snapshot" },
    ]);
    tmpFiles.push(p);
    const records = parseAssistantTurns(p);
    expect(records).toHaveLength(1);
    expect(records[0]!.turn_uuid).toBe("a");
  });

  it("skips assistant events that lack a usage object", () => {
    const noUsage = {
      type: "assistant",
      uuid: "no-usage",
      sessionId: "s",
      timestamp: "2026-04-19T00:00:00.000Z",
      message: { model: "claude-opus-4-7" },
    };
    const p = writeTempTranscript([noUsage, assistantEvent({ uuid: "has-usage" })]);
    tmpFiles.push(p);
    const records = parseAssistantTurns(p);
    expect(records).toHaveLength(1);
    expect(records[0]!.turn_uuid).toBe("has-usage");
  });

  it("skips malformed JSON lines without crashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-transcript-"));
    const p = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      p,
      [
        "{not json",
        JSON.stringify(assistantEvent({ uuid: "good" })),
        "",
        "another bad line",
      ].join("\n"),
    );
    tmpFiles.push(p);
    const records = parseAssistantTurns(p);
    expect(records).toHaveLength(1);
    expect(records[0]!.turn_uuid).toBe("good");
  });

  it("with sinceUuid, returns only events strictly AFTER that uuid", () => {
    const p = writeTempTranscript([
      assistantEvent({ uuid: "a" }),
      assistantEvent({ uuid: "b" }),
      assistantEvent({ uuid: "c" }),
    ]);
    tmpFiles.push(p);
    const records = parseAssistantTurns(p, "b");
    expect(records.map((r) => r.turn_uuid)).toEqual(["c"]);
  });

  it("with sinceUuid not present in the file, returns all events", () => {
    // This would happen if a transcript got truncated/rotated; we fall back
    // to re-emitting everything rather than silently dropping data.
    const p = writeTempTranscript([
      assistantEvent({ uuid: "a" }),
      assistantEvent({ uuid: "b" }),
    ]);
    tmpFiles.push(p);
    const records = parseAssistantTurns(p, "not-in-file");
    expect(records.map((r) => r.turn_uuid)).toEqual(["a", "b"]);
  });

  it("tolerates missing optional fields (cwd, requestId)", () => {
    const trimmed = {
      type: "assistant",
      uuid: "u",
      sessionId: "s",
      timestamp: "2026-04-19T00:00:00.000Z",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    };
    const p = writeTempTranscript([trimmed]);
    tmpFiles.push(p);
    const [rec] = parseAssistantTurns(p);
    expect(rec).toMatchObject({
      cwd: "",
      request_id: "",
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});
