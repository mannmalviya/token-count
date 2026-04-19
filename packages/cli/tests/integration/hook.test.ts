// Tests for the `hook` subcommand logic.
//
// The hook is invoked by Claude Code after every assistant response. It reads
// a small JSON payload on stdin (`{ session_id, transcript_path, ... }`),
// tails the transcript for new assistant turns, and appends records to
// `~/.token-count/usage.jsonl`. It must be:
//   - idempotent (running twice should never double-count)
//   - exit-0 safe (errors go to stderr, never bubble)
//
// We test the pure function `runHook(payload)` here. The thin stdin wrapper
// is exercised by e2e tests later.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readAllRecords,
  readStateCursor,
  usageJsonlPath,
} from "@token-count/core";
import { runHook } from "../../src/hook.js";

// Build a Claude Code transcript at `tmp/session.jsonl` with `uuids` worth
// of assistant events. Returns the file path.
function makeTranscript(dir: string, uuids: string[]): string {
  const p = path.join(dir, "session.jsonl");
  const events = uuids.map((uuid, i) => ({
    type: "assistant",
    uuid,
    sessionId: "sess-1",
    timestamp: new Date(Date.UTC(2026, 3, 19, 10, i)).toISOString(),
    cwd: "/home/mann/proj",
    requestId: `req-${i}`,
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }));
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

describe("runHook", () => {
  let tmpDir: string;
  let claudeDir: string;
  const originalEnv = process.env.TOKEN_COUNT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-hook-"));
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-hook-claude-"));
    // Redirect all token-count storage to our tmp dir.
    process.env.TOKEN_COUNT_DIR = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TOKEN_COUNT_DIR;
    else process.env.TOKEN_COUNT_DIR = originalEnv;
  });

  it("appends one record per new assistant event", () => {
    const transcript = makeTranscript(claudeDir, ["a", "b"]);
    const { appended } = runHook({
      session_id: "sess-1",
      transcript_path: transcript,
    });
    expect(appended).toBe(2);
    expect(readAllRecords().map((r) => r.turn_uuid)).toEqual(["a", "b"]);
  });

  it("is idempotent — running twice over the same transcript only appends once", () => {
    const transcript = makeTranscript(claudeDir, ["a", "b"]);
    runHook({ session_id: "sess-1", transcript_path: transcript });
    const second = runHook({
      session_id: "sess-1",
      transcript_path: transcript,
    });
    expect(second.appended).toBe(0);
    expect(readAllRecords()).toHaveLength(2);
  });

  it("appends only newly-added events when the transcript grows", () => {
    const transcript = makeTranscript(claudeDir, ["a"]);
    runHook({ session_id: "sess-1", transcript_path: transcript });

    // Simulate Claude Code appending a new turn to the transcript.
    const newEvent = {
      type: "assistant",
      uuid: "b",
      sessionId: "sess-1",
      timestamp: "2026-04-19T11:00:00.000Z",
      cwd: "/home/mann/proj",
      requestId: "req-b",
      message: {
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 5,
          output_tokens: 6,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    fs.appendFileSync(transcript, JSON.stringify(newEvent) + "\n");

    const second = runHook({
      session_id: "sess-1",
      transcript_path: transcript,
    });
    expect(second.appended).toBe(1);
    expect(readAllRecords().map((r) => r.turn_uuid)).toEqual(["a", "b"]);
  });

  it("updates the per-session cursor to the most recent uuid", () => {
    const transcript = makeTranscript(claudeDir, ["a", "b", "c"]);
    runHook({ session_id: "sess-1", transcript_path: transcript });
    expect(readStateCursor()).toEqual({ "sess-1": "c" });
  });

  it("is a no-op when the transcript file is missing", () => {
    const result = runHook({
      session_id: "sess-1",
      transcript_path: "/nonexistent/path.jsonl",
    });
    expect(result.appended).toBe(0);
    expect(fs.existsSync(usageJsonlPath())).toBe(false);
  });

  it("never throws on a malformed transcript", () => {
    const p = path.join(claudeDir, "bad.jsonl");
    fs.writeFileSync(p, "{not json\n{also not json\n");
    expect(() =>
      runHook({ session_id: "sess-1", transcript_path: p }),
    ).not.toThrow();
  });

  it("tracks independent cursors for different sessions", () => {
    const t1 = makeTranscript(claudeDir, ["a"]);
    runHook({ session_id: "sess-1", transcript_path: t1 });
    // Second session, same base dir — different transcript, different cursor.
    const t2 = path.join(claudeDir, "s2.jsonl");
    fs.writeFileSync(
      t2,
      JSON.stringify({
        type: "assistant",
        uuid: "x",
        sessionId: "sess-2",
        timestamp: "2026-04-19T12:00:00.000Z",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) + "\n",
    );
    runHook({ session_id: "sess-2", transcript_path: t2 });
    expect(readStateCursor()).toEqual({ "sess-1": "a", "sess-2": "x" });
    expect(readAllRecords()).toHaveLength(2);
  });
});
