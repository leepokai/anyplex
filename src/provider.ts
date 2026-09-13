// What each hosted runtime must implement. Translators are pure; everything else does IO with
// the provider's official SDK.

import type { ProviderName, SessionRef, Spend, Translation } from "./types.ts";

export interface ProviderContext {
  provider: ProviderName;
  apiKey: string;
  baseUrl: string | null;
  model: string;
  instructions: string;
  /** Stable key for the agent definition; providers that need a caller-chosen id derive it from this. */
  agentKey: string;
  /** Remaining budget the provider may enforce natively (Anthropic session budget); null when uncapped. */
  remainingBudgetUsd: number | null;
}

export type StopReason = "kill" | "budget_exceeded" | "finished" | "failed";

export interface Provider {
  createAgent(
    ctx: ProviderContext,
    signal: AbortSignal,
  ): Promise<{ agentId: string; environmentId: string | null }>;
  createSession(
    ctx: ProviderContext,
    ids: { agentId: string; environmentId: string | null },
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
  /**
   * Yield raw upstream events: history first so a reconnect never loses anything, then the live
   * stream. Ends when the upstream session settles or `signal` aborts.
   */
  follow(ctx: ProviderContext, ref: SessionRef, signal: AbortSignal): AsyncIterable<unknown>;
  translate(raw: unknown): Translation;
  /** Authoritative cumulative spend when the provider exposes one; null while unreported. */
  pollSpend?(ctx: ProviderContext, ref: SessionRef, signal: AbortSignal): Promise<Spend | null>;
  /** Interrupt and clean up the upstream session. Safe to call twice. */
  stop(ctx: ProviderContext, ref: SessionRef, reason: StopReason): Promise<void>;
}
