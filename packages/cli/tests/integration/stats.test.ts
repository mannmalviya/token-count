// Tests for `token-count stats`.
//
// `runStats` reads records from `usage.jsonl` (under TOKEN_COUNT_DIR),
// summarizes them via `core.summarize`, and returns:
//   - the raw Summary (so programmatic callers like the extension can reuse)
//   - a terminal-ready string for the CLI to print.
//
// We don't try to assert exact ASCII-table layout — it's brittle. Instead we
// assert that the important numbers and keys appear in the output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRecords, type UsageRecord } from "@token-count/core";
import { runStats } from "../../src/stats.js";

function rec(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    ts: "2026-04-19T12:00:00.000Z",
    source: "claude-code",
    session_id: "s",
    turn_uuid: Math.random().toString(),
    request_id: "",
    cwd: "/proj",
    model: "claude-opus-4-7",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

describe("runStats", () => {
  let tmpDir: string;
  const originalEnv = process.env.TOKEN_COUNT_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-stats-"));
    process.env.TOKEN_COUNT_DIR = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TOKEN_COUNT_DIR;
    else process.env.TOKEN_COUNT_DIR = originalEnv;
  });

  it("with no usage.jsonl, summary is zero and output says so", () => {
    const { summary, output } = runStats({ by: "day" });
    expect(summary.totals.total_tokens).toBe(0);
    expect(output.toLowerCase()).toContain("no usage");
  });

  it("returns correct grand total across several records", () => {
    appendRecords([
      rec({ input_tokens: 10, output_tokens: 20 }),
      rec({ cache_read_input_tokens: 100 }),
    ]);
    const { summary } = runStats({ by: "day" });
    expect(summary.totals.total_tokens).toBe(10 + 20 + 100);
    expect(summary.totals.record_count).toBe(2);
  });

  it("groupBy day: output contains each day key", () => {
    appendRecords([
      rec({ ts: "2026-04-18T09:00:00.000Z", output_tokens: 1 }),
      rec({ ts: "2026-04-19T09:00:00.000Z", output_tokens: 2 }),
    ]);
    const { output } = runStats({ by: "day" });
    expect(output).toContain("2026-04-18");
    expect(output).toContain("2026-04-19");
  });

  it("groupBy model: output contains model ids", () => {
    appendRecords([
      rec({ model: "claude-opus-4-7", output_tokens: 10 }),
      rec({ model: "claude-sonnet-4-6", output_tokens: 5 }),
    ]);
    const { output } = runStats({ by: "model" });
    expect(output).toContain("claude-opus-4-7");
    expect(output).toContain("claude-sonnet-4-6");
  });

  it("groupBy project: output contains cwd paths", () => {
    appendRecords([
      rec({ cwd: "/home/mann/a", output_tokens: 1 }),
      rec({ cwd: "/home/mann/b", output_tokens: 2 }),
    ]);
    const { output } = runStats({ by: "project" });
    expect(output).toContain("/home/mann/a");
    expect(output).toContain("/home/mann/b");
  });

  it("--since filter drops older records from summary + output", () => {
    appendRecords([
      rec({ ts: "2026-01-01T00:00:00.000Z", output_tokens: 1000 }),
      rec({ ts: "2026-04-19T00:00:00.000Z", output_tokens: 7 }),
    ]);
    const { summary, output } = runStats({
      by: "day",
      since: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(summary.totals.record_count).toBe(1);
    expect(summary.totals.total_tokens).toBe(7);
    expect(output).not.toContain("2026-01-01");
  });
});
