// Pricing estimates.
//
// Anthropic's per-token rates (USD per million tokens) depend on the model.
// There are four rates per model:
//   - input        : fresh prompt tokens, never-cached
//   - output       : tokens the model generated
//   - cacheWrite   : tokens the request asked to store in the ephemeral
//                    (5-minute) prompt cache (~1.25x input)
//   - cacheRead    : tokens served from a prior cache write (~0.10x input)
//
// "Estimate" because:
//   1. Rates change. Treat the numbers below as a point-in-time snapshot.
//   2. We fall back to Sonnet rates for any model string we don't recognize
//      (e.g. future model releases, Bedrock/Vertex variants, typos). That
//      keeps `stats --cost` from silently returning 0 for new models.
//
// Source: https://www.anthropic.com/pricing (as of 2026-04-19).
// If you see these numbers drift far from `/cost` in a real session, update
// this table.

import type { UsageRecord } from "./types.js";

/** USD per million tokens for one model's four token kinds. */
export interface ModelRate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// Ordered list instead of a map so a longer prefix ("claude-opus-4") could
// later win over a shorter one. We match by `model.startsWith(prefix)`.
const RATES: ReadonlyArray<{ prefix: string; rate: ModelRate }> = [
  {
    prefix: "claude-opus",
    rate: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  },
  {
    prefix: "claude-sonnet",
    rate: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  },
  {
    prefix: "claude-haiku",
    rate: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  },
];

// Sonnet is a sensible middle-of-the-road fallback for unknown models.
const DEFAULT_RATE: ModelRate = RATES[1]!.rate;

/**
 * Look up per-token USD rates for a model string. Always returns a rate
 * (never null) so callers don't have to handle absence.
 */
export function rateFor(model: string): ModelRate {
  for (const r of RATES) {
    if (model.startsWith(r.prefix)) return r.rate;
  }
  return DEFAULT_RATE;
}

/**
 * Estimated USD cost of a single UsageRecord.
 *
 * Formula: each token kind's count multiplied by its per-token rate
 * (rate-per-million ÷ 1,000,000), then summed.
 */
export function estimateRecordCost(r: UsageRecord): number {
  const p = rateFor(r.model);
  return (
    (r.input_tokens * p.input +
      r.output_tokens * p.output +
      r.cache_creation_input_tokens * p.cacheWrite +
      r.cache_read_input_tokens * p.cacheRead) /
    1_000_000
  );
}
