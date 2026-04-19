// Integration tests for storage: they actually write to disk, but under a
// temp directory via the TOKEN_COUNT_DIR env override. No real ~/.token-count
// is ever touched.
//
// Contract:
//   - appendRecords(): adds one JSON line per record to usage.jsonl. Creates
//     the directory + file if missing. Never rewrites existing lines.
//   - readAllRecords(): streams usage.jsonl and returns parsed UsageRecords.
//     Returns [] if the file doesn't exist yet.
//   - read/writeStateCursor(): simple JSON object persisted to state.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/types.js";
import {
  appendRecords,
  readAllRecords,
  readStateCursor,
  writeStateCursor,
} from "../../src/storage.js";
import { usageJsonlPath, stateJsonPath } from "../../src/paths.js";

// Build a record quickly. Only fields we care about per test need overriding.
function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: "2026-04-19T18:22:41.631Z",
    source: "claude-code",
    session_id: "sess-1",
    turn_uuid: "uuid-1",
    request_id: "req-1",
    cwd: "/tmp/proj",
    model: "claude-opus-4-7",
    input_tokens: 1,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

describe("storage", () => {
  let tmpDir: string;
  const originalEnv = process.env.TOKEN_COUNT_DIR;

  beforeEach(() => {
    // Each test gets a fresh tmp dir so state never leaks between tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-storage-"));
    process.env.TOKEN_COUNT_DIR = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TOKEN_COUNT_DIR;
    else process.env.TOKEN_COUNT_DIR = originalEnv;
  });

  describe("appendRecords + readAllRecords", () => {
    it("reading before any writes returns []", () => {
      expect(readAllRecords()).toEqual([]);
    });

    it("creates the dir + file on first append", () => {
      const rec = makeRecord();
      appendRecords([rec]);
      expect(fs.existsSync(tmpDir)).toBe(true);
      expect(fs.existsSync(usageJsonlPath())).toBe(true);
      expect(readAllRecords()).toEqual([rec]);
    });

    it("appends across multiple calls without overwriting", () => {
      appendRecords([makeRecord({ turn_uuid: "a" })]);
      appendRecords([makeRecord({ turn_uuid: "b" })]);
      appendRecords([
        makeRecord({ turn_uuid: "c" }),
        makeRecord({ turn_uuid: "d" }),
      ]);
      expect(readAllRecords().map((r) => r.turn_uuid)).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    });

    it("writes each record as its own line (valid JSONL)", () => {
      appendRecords([
        makeRecord({ turn_uuid: "a" }),
        makeRecord({ turn_uuid: "b" }),
      ]);
      const text = fs.readFileSync(usageJsonlPath(), "utf8");
      // 2 records => 2 non-empty lines, trailing newline.
      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(text.endsWith("\n")).toBe(true);
    });

    it("appending [] is a no-op (no file created)", () => {
      appendRecords([]);
      expect(fs.existsSync(usageJsonlPath())).toBe(false);
    });

    it("skips malformed lines on read (tolerant to corruption)", () => {
      appendRecords([makeRecord({ turn_uuid: "good" })]);
      // Simulate a corrupted tail line.
      fs.appendFileSync(usageJsonlPath(), "{not json\n");
      appendRecords([makeRecord({ turn_uuid: "also-good" })]);
      expect(readAllRecords().map((r) => r.turn_uuid)).toEqual([
        "good",
        "also-good",
      ]);
    });
  });

  describe("state cursor", () => {
    it("returns {} when state.json does not exist", () => {
      expect(readStateCursor()).toEqual({});
    });

    it("round-trips a cursor map", () => {
      writeStateCursor({ "sess-a": "uuid-1", "sess-b": "uuid-2" });
      expect(fs.existsSync(stateJsonPath())).toBe(true);
      expect(readStateCursor()).toEqual({
        "sess-a": "uuid-1",
        "sess-b": "uuid-2",
      });
    });

    it("overwrites the previous cursor on write", () => {
      writeStateCursor({ "sess-a": "uuid-1" });
      writeStateCursor({ "sess-a": "uuid-2", "sess-b": "uuid-x" });
      expect(readStateCursor()).toEqual({
        "sess-a": "uuid-2",
        "sess-b": "uuid-x",
      });
    });

    it("returns {} if state.json is malformed", () => {
      // Write junk, then expect a graceful fallback.
      fs.mkdirSync(path.dirname(stateJsonPath()), { recursive: true });
      fs.writeFileSync(stateJsonPath(), "not json");
      expect(readStateCursor()).toEqual({});
    });
  });
});
