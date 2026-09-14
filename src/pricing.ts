// Rate table for providers that report token usage instead of a price. Unknown models fall back
// to a deliberately expensive rate and are flagged as estimates, so a budget watchdog errs early.

import type { ProviderName, TokenUsage } from "./types.ts";

export interface TokenRate {
  /** USD per million input tokens. */
  inputPerMtok: number;
  /** USD per million output tokens. */
  outputPerMtok: number;
  cacheWriteMultiplier?: number;
  cacheReadMultiplier?: number;
}

const ANTHROPIC_DEFAULTS = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 } as const;
const ANTHROPIC: Record<string, TokenRate> = {
  "claude-fable-5": { inputPerMtok: 10, outputPerMtok: 50, ...ANTHROPIC_DEFAULTS },
  "claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-sonnet-5": { inputPerMtok: 2, outputPerMtok: 10, ...ANTHROPIC_DEFAULTS },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5, ...ANTHROPIC_DEFAULTS },
};

/** First-party list prices recorded on 2026-08-31; update this date with price changes. */
export const RATES: Record<ProviderName, Record<string, TokenRate>> = {
  anthropic: ANTHROPIC,
  openai: {
    "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadMultiplier: 0.1 },
    "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2, cacheReadMultiplier: 0.1 },
  },
  // Gemini hosted-agent pricing is undisclosed as of 2026-09-13.
  google: {},
  // Cursor bills usage-based agent runs at the model's API list price (cursor.com/pricing);
  // its model ids for Claude match Anthropic's, so that table is reused. Composer, Grok, and
  // the rest have no public per-token price: pass `rates` or accept the fallback estimate.
  cursor: {
    ...ANTHROPIC,
    "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2, cacheReadMultiplier: 0.1 },
  },
};

/** Conservative estimate for unrecognized models. */
export const FALLBACK_RATE: TokenRate = { inputPerMtok: 15, outputPerMtok: 75 };

export function lookupRate(
  provider: string,
  model: string,
  overrides: Record<string, TokenRate> = {},
): TokenRate | null {
  const table = { ...(RATES[provider as ProviderName] ?? {}), ...overrides };
  const exact = table[model];
  if (exact) return exact;
  const normalized = model.replace(/\./g, "-").replace(/-\d{8}$/, "");
  return table[normalized] ?? null;
}

export function computeCost(
  provider: string,
  model: string,
  usage: TokenUsage,
  overrides: Record<string, TokenRate> = {},
): { costUsd: number; estimated: boolean } {
  const found = lookupRate(provider, model, overrides);
  const rate = found ?? FALLBACK_RATE;
  const perMtok = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  const costUsd =
    perMtok(usage.inputTokens, rate.inputPerMtok) +
    perMtok(usage.outputTokens, rate.outputPerMtok) +
    perMtok(usage.cacheWriteTokens ?? 0, rate.inputPerMtok * (rate.cacheWriteMultiplier ?? 1)) +
    perMtok(usage.cacheReadTokens ?? 0, rate.inputPerMtok * (rate.cacheReadMultiplier ?? 1));
  return { costUsd: Math.round(costUsd * 1e9) / 1e9, estimated: found === null };
}
