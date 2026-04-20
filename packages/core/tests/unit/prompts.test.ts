// Tests for parseUserPrompts.
//
// Unlike parseAssistantTurns, this parser reads `type: "user"` events and
// emits exactly one record per REAL user prompt. The tricky bit is that the
// transcript contains TWO kinds of user events:
//
//   1. Real prompts — the thing the human typed. Content is an array with a
//      `{ type: "text", text: "..." }` block (or a plain string).
//
//   2. Synthetic tool_result — injected by Claude Code's agent loop after a
//      tool call. Content is an array with `{ type: "tool_result", ... }`
//      blocks. These share the same `promptId` as the real prompt that kicked
//      off the turn, so deduping by `promptId` makes them drop out cleanly.
//
// Counting unique `promptId` values in real prompts = the "messages" metric
// Claude Code's /insights reports.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUserPrompts } from "../../src/transcript.js";

function writeTempTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-prompts-"));
  const p = path.join(dir, "session.jsonl");
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// A canonical real-user-prompt event matching what Claude Code writes.
function userPromptEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: "u-1",
    sessionId: "sess-1",
    timestamp: "2026-04-19T18:22:00.000Z",
    cwd: "/home/mann/token-count",
    promptId: "prompt-1",
    message: {
      role: "user",
      content: [{ type: "text", text: "do the thing" }],
    },
    ...overrides,
  };
}

// A tool_result "user" event — the parser should IGNORE these.
function toolResultEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: "tr-1",
    sessionId: "sess-1",
    timestamp: "2026-04-19T18:22:05.000Z",
    cwd: "/home/mann/token-count",
    promptId: "prompt-1", // same promptId as the real prompt that triggered it
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "..." }],
    },
    ...overrides,
  };
}

describe("parseUserPrompts", () => {
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
    expect(parseUserPrompts(p)).toEqual([]);
  });

  it("returns [] when the transcript path doesn't exist", () => {
    expect(parseUserPrompts("/tmp/does-not-exist-xyz.jsonl")).toEqual([]);
  });

  it("yields one record per real user prompt", () => {
    const p = writeTempTranscript([userPromptEvent()]);
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "claude-code",
      session_id: "sess-1",
      prompt_id: "prompt-1",
      cwd: "/home/mann/token-count",
      ts: "2026-04-19T18:22:00.000Z",
    });
  });

  it("ignores tool_result user events", () => {
    const p = writeTempTranscript([userPromptEvent(), toolResultEvent()]);
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records).toHaveLength(1);
    expect(records[0]!.prompt_id).toBe("prompt-1");
  });

  it("dedupes multiple events sharing the same promptId", () => {
    // A single user prompt can produce multiple `type: user` events with
    // identical promptId (rare, but the transcript has been seen doing this).
    // We keep only one.
    const p = writeTempTranscript([
      userPromptEvent({ uuid: "u-a", promptId: "P1" }),
      userPromptEvent({ uuid: "u-b", promptId: "P1" }),
      userPromptEvent({ uuid: "u-c", promptId: "P2" }),
    ]);
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records.map((r) => r.prompt_id)).toEqual(["P1", "P2"]);
  });

  it("skips user events without a promptId", () => {
    // Very early Claude Code transcripts omit promptId. Without it we can't
    // dedupe reliably, so we drop them.
    const p = writeTempTranscript([
      userPromptEvent({ promptId: undefined }),
      userPromptEvent({ promptId: "has-one" }),
    ]);
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records.map((r) => r.prompt_id)).toEqual(["has-one"]);
  });

  it("skips assistant events and other event types", () => {
    const p = writeTempTranscript([
      { type: "assistant", uuid: "a", message: { model: "x", usage: {} } },
      { type: "queue-operation" },
      userPromptEvent(),
    ]);
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records).toHaveLength(1);
  });

  it("skips malformed JSON lines without crashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-prompts-"));
    const p = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      p,
      ["{not json", JSON.stringify(userPromptEvent()), "another bad"].join("\n"),
    );
    tmpFiles.push(p);
    const records = parseUserPrompts(p);
    expect(records).toHaveLength(1);
  });

  it("accepts string-form content (older transcripts)", () => {
    // Very old transcripts had `message.content` as a plain string rather
    // than an array of blocks. Still a real prompt — accept it.
    const p = writeTempTranscript([
      userPromptEvent({
        message: { role: "user", content: "plain text prompt" },
      }),
    ]);
    tmpFiles.push(p);
    expect(parseUserPrompts(p)).toHaveLength(1);
  });

  it("tolerates a missing cwd", () => {
    const p = writeTempTranscript([userPromptEvent({ cwd: undefined })]);
    tmpFiles.push(p);
    const [r] = parseUserPrompts(p);
    expect(r!.cwd).toBe("");
  });
});
