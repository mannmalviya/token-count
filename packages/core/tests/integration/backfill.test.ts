// Integration tests for backfill.
//
// Backfill walks `~/.claude/projects/<slug>/<session>.jsonl` (the transcripts
// Claude Code writes for every session), pulls every assistant turn with
// token usage, and appends any records we don't already have to usage.jsonl.
// It also writes a cursor per session so future Stop-hook runs only pick up
// NEW turns.
//
// Why it's its own module (and not part of hook.ts): a first-run feature
// that scans many files at once is a different contract from the per-turn
// hook. It's safe to call repeatedly (idempotent via turn_uuid dedupe).
//
// These tests write to temp dirs via TOKEN_COUNT_DIR — never the real home.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillFromClaudeProjects } from "../../src/backfill.js";
import { readAllRecords, readStateCursor } from "../../src/storage.js";

/**
 * Build one JSON-line string for an assistant event that matches the shape
 * parseAssistantTurns expects. We only bother with the fields we consume.
 */
function assistantLine(opts: {
  uuid: string;
  sessionId: string;
  ts?: string;
  cwd?: string;
  outputTokens?: number;
}): string {
  const ev = {
    type: "assistant",
    uuid: opts.uuid,
    sessionId: opts.sessionId,
    timestamp: opts.ts ?? "2026-04-19T18:22:41.631Z",
    cwd: opts.cwd ?? "/tmp/proj",
    requestId: `req-${opts.uuid}`,
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 10,
        output_tokens: opts.outputTokens ?? 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  return JSON.stringify(ev);
}

/** Noise lines the real transcripts contain — we want them ignored. */
function userLine(sessionId: string): string {
  return JSON.stringify({ type: "user", sessionId, content: "hi" });
}

describe("backfillFromClaudeProjects", () => {
  // Two tmp dirs per test:
  //   - tokenCountDir: where usage.jsonl + state.json land (our output)
  //   - projectsDir:   fake ~/.claude/projects/ tree we read from (our input)
  let tokenCountDir: string;
  let projectsDir: string;
  const originalEnv = process.env.TOKEN_COUNT_DIR;

  beforeEach(() => {
    tokenCountDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-bf-out-"));
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-bf-in-"));
    process.env.TOKEN_COUNT_DIR = tokenCountDir;
  });
  afterEach(() => {
    fs.rmSync(tokenCountDir, { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TOKEN_COUNT_DIR;
    else process.env.TOKEN_COUNT_DIR = originalEnv;
  });

  // Small helper to drop a transcript file under a project slug.
  function writeTranscript(
    slug: string,
    sessionId: string,
    lines: string[],
  ): void {
    const dir = path.join(projectsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      lines.join("\n") + "\n",
    );
  }

  it("returns zeros when the projects dir does not exist", () => {
    const result = backfillFromClaudeProjects({
      projectsDir: path.join(projectsDir, "nope"),
    });
    expect(result).toEqual({
      sessionsScanned: 0,
      appended: 0,
      skipped: 0,
      promptsAppended: 0,
      promptsSkipped: 0,
    });
    expect(readAllRecords()).toEqual([]);
  });

  it("ingests every assistant turn across multiple sessions", () => {
    writeTranscript("-home-mann-a", "sess-a", [
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      userLine("sess-a"),
      assistantLine({ uuid: "a2", sessionId: "sess-a" }),
    ]);
    writeTranscript("-home-mann-b", "sess-b", [
      assistantLine({ uuid: "b1", sessionId: "sess-b" }),
    ]);

    const result = backfillFromClaudeProjects({ projectsDir });
    expect(result.sessionsScanned).toBe(2);
    expect(result.appended).toBe(3);
    expect(result.skipped).toBe(0);

    const uuids = readAllRecords()
      .map((r) => r.turn_uuid)
      .sort();
    expect(uuids).toEqual(["a1", "a2", "b1"]);
  });

  it("writes a state.json cursor pointing at each session's last turn", () => {
    writeTranscript("-home-mann-a", "sess-a", [
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      assistantLine({ uuid: "a2", sessionId: "sess-a" }),
    ]);
    writeTranscript("-home-mann-b", "sess-b", [
      assistantLine({ uuid: "b1", sessionId: "sess-b" }),
    ]);

    backfillFromClaudeProjects({ projectsDir });
    const cursor = readStateCursor();
    expect(cursor["sess-a"]).toBe("a2");
    expect(cursor["sess-b"]).toBe("b1");
  });

  it("is idempotent — second run appends nothing and counts skips", () => {
    writeTranscript("-home-mann-a", "sess-a", [
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      assistantLine({ uuid: "a2", sessionId: "sess-a" }),
    ]);

    const first = backfillFromClaudeProjects({ projectsDir });
    expect(first.appended).toBe(2);

    const second = backfillFromClaudeProjects({ projectsDir });
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(2);

    // The file still has only the original two records.
    expect(readAllRecords()).toHaveLength(2);
  });

  it("dedupes against existing usage.jsonl records by turn_uuid", () => {
    // Simulate: the Stop hook has already recorded a1 during an active
    // session. Backfill should see that and only append a2.
    writeTranscript("-home-mann-a", "sess-a", [
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      assistantLine({ uuid: "a2", sessionId: "sess-a" }),
    ]);

    // Run backfill twice with a "manual hook" in between simulated by calling
    // the same function — first run plants a1+a2, second run is the "already
    // ingested" state.
    const first = backfillFromClaudeProjects({ projectsDir });
    expect(first.appended).toBe(2);

    // Now pretend a new turn a3 shows up in the same transcript.
    writeTranscript("-home-mann-a", "sess-a", [
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      assistantLine({ uuid: "a2", sessionId: "sess-a" }),
      assistantLine({ uuid: "a3", sessionId: "sess-a" }),
    ]);

    const second = backfillFromClaudeProjects({ projectsDir });
    expect(second.appended).toBe(1);
    expect(second.skipped).toBe(2);
    const uuids = readAllRecords()
      .map((r) => r.turn_uuid)
      .sort();
    expect(uuids).toEqual(["a1", "a2", "a3"]);
  });

  it("skips non-jsonl files inside a slug directory", () => {
    const dir = path.join(projectsDir, "-home-mann-a");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a transcript");
    fs.writeFileSync(
      path.join(dir, "sess-a.jsonl"),
      assistantLine({ uuid: "a1", sessionId: "sess-a" }) + "\n",
    );

    const result = backfillFromClaudeProjects({ projectsDir });
    expect(result.sessionsScanned).toBe(1);
    expect(result.appended).toBe(1);
  });

  it("tolerates malformed transcript lines without throwing", () => {
    writeTranscript("-home-mann-a", "sess-a", [
      "not json at all",
      assistantLine({ uuid: "a1", sessionId: "sess-a" }),
      '{"type":"assistant","malformed":true}', // missing required fields
    ]);

    const result = backfillFromClaudeProjects({ projectsDir });
    expect(result.appended).toBe(1);
    expect(readAllRecords().map((r) => r.turn_uuid)).toEqual(["a1"]);
  });
});
