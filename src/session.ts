// The runner: one loop that drives any hosted agent session, projects it onto SessionEvents,
// meters provider-reported spend, enforces a client-side budget watchdog, stops the upstream
// session, and can re-attach after a process restart without duplicating events or spend.

import { createHash } from "node:crypto";
import { computeCost } from "./pricing.ts";
import type { Provider, ProviderContext, StopReason } from "./provider.ts";
import { anthropic } from "./providers/anthropic.ts";
import { google } from "./providers/google.ts";
import { openai } from "./providers/openai.ts";
import {
  type AgentStore,
  MemoryStore,
  type Outcome,
  type ProviderName,
  type RawEvent,
  type SessionEvent,
  type SessionRef,
  type Spend,
  type TokenUsage,
} from "./types.ts";

const PROVIDERS: Record<ProviderName, Provider> = { anthropic, openai, google };

export interface AnyplexOptions {
  provider: ProviderName;
  apiKey: string;
  /** Override the provider's base URL (fakes, proxies). OpenAI expects the `/v1` suffix. */
  baseUrl?: string;
  model: string;
  instructions: string;
  /** Caches the provider-side agent per definition; in-memory by default. */
  store?: AgentStore;
}

export interface StartOptions {
  prompt: string;
  /** Client-side hard cap: the session is stopped as soon as settled spend reaches it. */
  budgetUsd?: number;
  signal?: AbortSignal;
}

/** What a caller persists to re-attach from another process. */
export interface SessionState {
  spentUsd: number;
  uncertain: boolean;
  usageTotal: TokenUsage | null;
  seen: string[];
}

export interface AttachOptions extends Partial<SessionState> {
  budgetUsd?: number;
  signal?: AbortSignal;
}

export interface Session {
  readonly ref: SessionRef;
  /** Settled spend so far; `uncertain` when any part was priced with the fallback rate. */
  readonly spentUsd: number;
  readonly uncertain: boolean;
  readonly outcome: Outcome | null;
  /** Snapshot for persistence; feed it to `attach()` later. */
  state(): SessionState;
  /** Single pass: drives the upstream session and yields unified events until it ends. */
  events(): AsyncGenerator<SessionEvent>;
  /** Interrupt and clean up the upstream session; `events()` then ends with outcome `stopped`. */
  stop(): Promise<void>;
}

export interface Anyplex {
  start(options: StartOptions): Promise<Session>;
  attach(ref: SessionRef, options?: AttachOptions): Session;
}

export function anyplex(options: AnyplexOptions): Anyplex {
  const provider = PROVIDERS[options.provider];
  if (!provider) throw new Error(`unsupported provider ${options.provider}`);
  const store = options.store ?? new MemoryStore();
  const agentKey = createHash("sha256")
    .update(
      JSON.stringify({
        provider: options.provider,
        model: options.model,
        instructions: options.instructions,
        base_url: options.baseUrl ?? null,
      }),
    )
    .digest("hex");
  const context = (remainingBudgetUsd: number | null): ProviderContext => ({
    provider: options.provider,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? null,
    model: options.model,
    instructions: options.instructions,
    agentKey,
    remainingBudgetUsd,
  });

  return {
    async start(start) {
      const signal = start.signal ?? new AbortController().signal;
      const ctx = context(start.budgetUsd ?? null);
      let ids = await store.get(agentKey);
      if (!ids) {
        ids = await provider.createAgent(ctx, signal);
        await store.set(agentKey, ids);
      }
      const sessionId = await provider.createSession(ctx, ids, start.prompt, signal);
      const ref: SessionRef = {
        provider: options.provider,
        sessionId,
        agentId: ids.agentId,
        environmentId: ids.environmentId,
      };
      return createSession(provider, ctx, ref, {}, start.budgetUsd ?? null, start.signal);
    },
    attach(ref, attach = {}) {
      if (ref.provider !== options.provider)
        throw new Error(`session belongs to ${ref.provider}, not ${options.provider}`);
      const ctx = context(
        attach.budgetUsd === undefined ? null : attach.budgetUsd - (attach.spentUsd ?? 0),
      );
      return createSession(provider, ctx, ref, attach, attach.budgetUsd ?? null, attach.signal);
    },
  };
}

function subtractUsage(total: TokenUsage, previous: TokenUsage | null): TokenUsage {
  const p = previous ?? { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Math.max(0, total.inputTokens - p.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - p.outputTokens),
    cacheReadTokens: Math.max(0, (total.cacheReadTokens ?? 0) - (p.cacheReadTokens ?? 0)),
    cacheWriteTokens: Math.max(0, (total.cacheWriteTokens ?? 0) - (p.cacheWriteTokens ?? 0)),
  };
}

function createSession(
  provider: Provider,
  ctx: ProviderContext,
  ref: SessionRef,
  initial: Partial<SessionState>,
  budgetUsd: number | null,
  outerSignal: AbortSignal | undefined,
): Session {
  let spentUsd = initial.spentUsd ?? 0;
  let uncertain = initial.uncertain ?? false;
  let usageTotal = initial.usageTotal ?? null;
  const seen = new Set(initial.seen ?? []);
  let outcome: Outcome | null = null;
  let stopRequested = false;
  const abort = new AbortController();
  outerSignal?.addEventListener("abort", () => abort.abort(outerSignal.reason), { once: true });

  /** Normalize a provider spend report into a USD delta. */
  const spendDelta = (spend: Spend): { costUsd: number; estimated: boolean } => {
    switch (spend.kind) {
      case "list_cost_usd":
        return { costUsd: Math.max(0, spend.totalUsd - spentUsd), estimated: false };
      case "tokens_delta":
        return computeCost(ctx.provider, ctx.model, spend.usage);
      case "tokens_total": {
        const delta = subtractUsage(spend.usage, usageTotal);
        usageTotal = spend.usage;
        return computeCost(ctx.provider, ctx.model, delta);
      }
    }
  };
  const apply = (spend: Spend): SessionEvent | null => {
    const { costUsd, estimated } = spendDelta(spend);
    if (costUsd <= 0) return null;
    spentUsd = Math.round((spentUsd + costUsd) * 1e6) / 1e6;
    uncertain = uncertain || estimated;
    return {
      type: "spend.updated",
      payload: { spent_usd: spentUsd, delta_usd: costUsd, uncertain },
      upstreamId: null,
    };
  };
  const poll = async (): Promise<SessionEvent | null> => {
    if (!provider.pollSpend) return null;
    const reported = await provider.pollSpend(ctx, ref, abort.signal);
    return reported ? apply(reported) : null;
  };
  const capReached = () => budgetUsd !== null && spentUsd >= budgetUsd;
  const stopUpstream = async (reason: StopReason) => {
    await provider.stop(ctx, ref, reason).catch(() => undefined);
  };

  async function* events(): AsyncGenerator<SessionEvent> {
    let result: Outcome | null = null;
    try {
      for await (const raw of provider.follow(ctx, ref, abort.signal)) {
        const t = provider.translate(raw);
        const duplicate = t.upstreamId !== null && seen.has(t.upstreamId);
        if (!duplicate) {
          // Mark the upstream item seen only once every event it produced was delivered: a
          // consumer that abandons the generator mid-item gets the whole item again on attach
          // (at-least-once per item; dedupe by upstreamId for exactly-once).
          for (const event of t.events) yield stamp(event, t.upstreamId);
          if (t.upstreamId !== null) seen.add(t.upstreamId);
          if (t.spend) {
            const update = apply(t.spend);
            if (update) yield update;
          }
        }
        if (t.pollSpend) {
          const update = await poll();
          if (update) yield update;
        }
        if (capReached()) {
          result = { kind: "budget_exceeded" };
          break;
        }
        if (t.outcome.kind !== "continue") {
          result = t.outcome;
          break;
        }
      }
    } catch (err) {
      if (!stopRequested && !abort.signal.aborted) {
        await stopUpstream("failed");
        throw err;
      }
    }
    if (stopRequested || abort.signal.aborted) result = { kind: "stopped" };
    if (result === null)
      result = { kind: "failed", error: "upstream stream ended before the session settled" };

    // Providers report usage asynchronously (OpenAI: seconds after the turn ends); wait briefly
    // so the session ends with its real cost. ponytail: fixed 15 x 2 s, make adaptive if needed.
    if ((result.kind === "completed" || result.kind === "budget_exceeded") && provider.pollSpend) {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const reported = await provider.pollSpend(ctx, ref, abort.signal).catch(() => null);
        if (reported) {
          const update = apply(reported);
          if (update) yield update;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (result.kind === "completed" && capReached()) result = { kind: "budget_exceeded" };
    }
    switch (result.kind) {
      case "completed":
        await stopUpstream("finished");
        break;
      case "budget_exceeded":
        await stopUpstream("budget_exceeded");
        break;
      case "requires_action":
      case "failed":
        await stopUpstream("failed");
        break;
      case "stopped":
      case "terminated":
        break;
    }
    outcome = result;
    yield {
      type: "session.ended",
      payload: { outcome: result, spent_usd: spentUsd, uncertain },
      upstreamId: null,
    };
  }

  return {
    ref,
    get spentUsd() {
      return spentUsd;
    },
    get uncertain() {
      return uncertain;
    },
    get outcome() {
      return outcome;
    },
    state: () => ({ spentUsd, uncertain, usageTotal, seen: [...seen] }),
    events,
    async stop() {
      stopRequested = true;
      abort.abort("stopped");
      await stopUpstream("kill");
    },
  };
}

function stamp(event: RawEvent, upstreamId: string | null): SessionEvent {
  return { type: event.type, payload: event.payload, upstreamId } as SessionEvent;
}
