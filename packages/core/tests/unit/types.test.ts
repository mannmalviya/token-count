// Tests for the zod schema that validates a UsageRecord.
//
// UsageRecord is the shape written to `~/.token-count/usage.jsonl`. We
// validate on read (to catch corruption or old records) and use the inferred
// TS type on write.
import { describe, expect, it } from "vitest";
import { UsageRecordSchema } from "../../src/types.js";

// A minimal valid record we can spread over + tweak in individual tests.
const validRecord = {
  ts: "2026-04-19T18:22:41.631Z",
  source: "claude-code",
  session_id: "8c975a4d-3f2d-48ef-b3f9-8459a934e799",
  turn_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  request_id: "req_abc",
  cwd: "/home/mann/token-count",
  model: "claude-opus-4-7",
  input_tokens: 3,
  output_tokens: 412,
  cache_creation_input_tokens: 9847,
  cache_read_input_tokens: 11226,
};

describe("UsageRecordSchema", () => {
  it("accepts a well-formed record", () => {
    const parsed = UsageRecordSchema.parse(validRecord);
    // zod returns the parsed object unchanged for valid input.
    expect(parsed).toEqual(validRecord);
  });

  it("accepts codex as a source (we'll implement that adapter later)", () => {
    expect(() =>
      UsageRecordSchema.parse({ ...validRecord, source: "codex" }),
    ).not.toThrow();
  });

  it("rejects unknown sources", () => {
    expect(() =>
      UsageRecordSchema.parse({ ...validRecord, source: "chatgpt" }),
    ).toThrow();
  });

  it("rejects negative token counts", () => {
    expect(() =>
      UsageRecordSchema.parse({ ...validRecord, output_tokens: -1 }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    const { session_id: _omit, ...withoutSession } = validRecord;
    expect(() => UsageRecordSchema.parse(withoutSession)).toThrow();
  });

  it("rejects non-ISO timestamps", () => {
    expect(() =>
      UsageRecordSchema.parse({ ...validRecord, ts: "not-a-date" }),
    ).toThrow();
  });
});
