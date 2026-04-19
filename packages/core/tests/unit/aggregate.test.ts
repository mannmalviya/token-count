// Tests for the aggregation helper.
//
// `summarize` takes an array of records and returns:
//   - totals: grand-total counters across the whole window
//   - groups: per-bucket counters (by day | by model | by project)
//
// "Total tokens" for a record = input + output + cache_creation + cache_read.
// This matches how Claude Code's /cost command bills usage.

import { describe, expect, it } from "vitest";
import { summarize } from "../../src/aggregate.js";
import type { UsageRecord } from "../../src/types.js";

// Factory so each test can spell out only the fields it cares about.
function rec(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    ts: "2026-04-19T10:00:00.000Z",
    source: "claude-code",
    session_id: "s",
    turn_uuid: Math.random().toString(),
    request_id: "",
    cwd: "/p",
    model: "claude-opus-4-7",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

describe("summarize", () => {
  it("returns zero totals for an empty input", () => {
    const s = summarize([], { groupBy: "day" });
    expect(s.totals.total_tokens).toBe(0);
    expect(s.totals.record_count).toBe(0);
    expect(s.groups).toEqual([]);
  });

  it("computes grand totals across all token kinds", () => {
    const s = summarize(
      [
        rec({ input_tokens: 1, output_tokens: 2 }),
        rec({
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
        }),
      ],
      { groupBy: "day" },
    );
    expect(s.totals).toMatchObject({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      total_tokens: 1 + 2 + 10 + 20 + 100 + 1000,
      record_count: 2,
    });
  });

  it("groupBy day buckets by UTC calendar day (YYYY-MM-DD)", () => {
    const s = summarize(
      [
        rec({ ts: "2026-04-18T23:30:00.000Z", output_tokens: 5 }),
        rec({ ts: "2026-04-19T00:30:00.000Z", output_tokens: 7 }),
        rec({ ts: "2026-04-19T10:00:00.000Z", output_tokens: 3 }),
      ],
      { groupBy: "day" },
    );
    // Groups come back sorted ascending by key so UIs can render chronologically.
    expect(s.groups.map((g) => g.key)).toEqual(["2026-04-18", "2026-04-19"]);
    expect(s.groups[0]!.totals.total_tokens).toBe(5);
    expect(s.groups[1]!.totals.total_tokens).toBe(7 + 3);
  });

  it("groupBy model buckets by model id", () => {
    const s = summarize(
      [
        rec({ model: "claude-opus-4-7", output_tokens: 10 }),
        rec({ model: "claude-sonnet-4-6", output_tokens: 3 }),
        rec({ model: "claude-opus-4-7", output_tokens: 2 }),
      ],
      { groupBy: "model" },
    );
    // Groups sorted by total_tokens descending so the heaviest model shows first.
    expect(s.groups.map((g) => g.key)).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
    expect(s.groups[0]!.totals.total_tokens).toBe(12);
    expect(s.groups[1]!.totals.total_tokens).toBe(3);
  });

  it("groupBy project buckets by cwd", () => {
    const s = summarize(
      [
        rec({ cwd: "/proj/a", output_tokens: 5 }),
        rec({ cwd: "/proj/b", output_tokens: 10 }),
      ],
      { groupBy: "project" },
    );
    expect(s.groups.map((g) => g.key).sort()).toEqual(["/proj/a", "/proj/b"]);
  });

  it("filters records by since/until (inclusive since, exclusive until)", () => {
    const s = summarize(
      [
        rec({ ts: "2026-04-17T12:00:00.000Z", output_tokens: 1 }),
        rec({ ts: "2026-04-18T12:00:00.000Z", output_tokens: 2 }),
        rec({ ts: "2026-04-19T12:00:00.000Z", output_tokens: 4 }),
        rec({ ts: "2026-04-20T12:00:00.000Z", output_tokens: 8 }),
      ],
      {
        groupBy: "day",
        since: new Date("2026-04-18T00:00:00.000Z"),
        until: new Date("2026-04-20T00:00:00.000Z"),
      },
    );
    expect(s.totals.total_tokens).toBe(2 + 4);
    expect(s.totals.record_count).toBe(2);
  });
});
