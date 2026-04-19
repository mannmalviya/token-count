// Tests for the pricing helper.
//
// Anthropic charges different per-token rates for:
//   - input (fresh prompt tokens)
//   - output (model's reply)
//   - cache write (tokens the request asked the service to cache)
//   - cache read (tokens served from a prior cache write)
// Rates vary by model (Opus >> Sonnet > Haiku). `estimateRecordCost` returns
// a USD estimate for one UsageRecord. "Estimate" because rates change and
// because we use a conservative fallback for unknown models.

import { describe, expect, it } from "vitest";
import { estimateRecordCost, rateFor } from "../../src/pricing.js";
import type { UsageRecord } from "../../src/types.js";

function rec(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    ts: "2026-04-19T10:00:00.000Z",
    source: "claude-code",
    session_id: "s",
    turn_uuid: "u",
    request_id: "",
    cwd: "/p",
    model: "claude-sonnet-4-6",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

describe("rateFor", () => {
  it("returns opus rates for opus models", () => {
    expect(rateFor("claude-opus-4-7").input).toBe(15);
    expect(rateFor("claude-opus-4-7").output).toBe(75);
  });

  it("returns sonnet rates for sonnet models", () => {
    expect(rateFor("claude-sonnet-4-6").input).toBe(3);
    expect(rateFor("claude-sonnet-4-6").output).toBe(15);
  });

  it("returns haiku rates for haiku models", () => {
    expect(rateFor("claude-haiku-4-5").input).toBe(1);
    expect(rateFor("claude-haiku-4-5").output).toBe(5);
  });

  it("falls back to sonnet rates for unknown models", () => {
    // Sonnet = middle-of-the-road. Better to be slightly off than to bail.
    expect(rateFor("gpt-9000")).toEqual(rateFor("claude-sonnet-4-6"));
  });

  it("cache write is priced 1.25x input, cache read 0.1x input (discount)", () => {
    const r = rateFor("claude-sonnet-4-6");
    expect(r.cacheWrite).toBeCloseTo(r.input * 1.25, 5);
    expect(r.cacheRead).toBeCloseTo(r.input * 0.1, 5);
  });
});

describe("estimateRecordCost", () => {
  it("is 0 for a record with all zeros", () => {
    expect(estimateRecordCost(rec({}))).toBe(0);
  });

  it("prices input at the model's input rate per million tokens", () => {
    // 1,000,000 sonnet input tokens = $3.00 exactly.
    const cost = estimateRecordCost(
      rec({ model: "claude-sonnet-4-6", input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(3, 5);
  });

  it("prices output more heavily than input", () => {
    const inputOnly = estimateRecordCost(
      rec({ model: "claude-opus-4-7", input_tokens: 10_000 }),
    );
    const outputOnly = estimateRecordCost(
      rec({ model: "claude-opus-4-7", output_tokens: 10_000 }),
    );
    // Output = 5x input for Opus ($75 vs $15).
    expect(outputOnly).toBeCloseTo(inputOnly * 5, 5);
  });

  it("prices cache read at roughly 1/10th of input", () => {
    const inp = estimateRecordCost(
      rec({ model: "claude-sonnet-4-6", input_tokens: 1_000_000 }),
    );
    const cached = estimateRecordCost(
      rec({
        model: "claude-sonnet-4-6",
        cache_read_input_tokens: 1_000_000,
      }),
    );
    expect(cached).toBeCloseTo(inp * 0.1, 5);
  });

  it("sums all four components", () => {
    const cost = estimateRecordCost(
      rec({
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000, // $3.00
        output_tokens: 1_000_000, // $15.00
        cache_creation_input_tokens: 1_000_000, // $3.75
        cache_read_input_tokens: 1_000_000, // $0.30
      }),
    );
    expect(cost).toBeCloseTo(3 + 15 + 3.75 + 0.3, 5);
  });
});
