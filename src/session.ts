// The runner: one loop that drives any hosted agent session, projects it onto SessionEvents,
// meters provider-reported spend, enforces a client-side budget watchdog, hands the agent's
// requests (client tools, approvals) to the application, stops the upstream session, and can
// re-attach after a process restart without duplicating events or spend.

import { createHash } from "node:crypto";
import { computeCost, type TokenRate } from "./pricing.ts";
import type {
  AgentDefinition,
  Provider,
  ProviderContext,
  StopReason,
  ToolResult,
} from "./provider.ts";
import { anthropic } from "./providers/anthropic.ts";
import { google } from "./providers/google.ts";
import { openai } from "./providers/openai.ts";
import {
  type AgentStore,
  type Artifact,
  type Capabilities,
  type EnvironmentSpec,
  type McpServerSpec,
  MemoryStore,
  type Outcome,
  type PermissionPolicy,
  type ProviderName,
  type ProviderOptions,
  type RawEvent,
  type SessionEvent,
  type SessionRef,
  type Spend,
  type TokenUsage,
  type ToolRequest,
  type ToolSpec,
  UnsupportedError,
} from "./types.ts";

const BUILTIN: Record<ProviderName, Provider> = { anthropic, openai, google };

export interface AnyplexOptions {
  /** A built-in provider name, or your own `Provider` implementation. */
  provider: ProviderName | Provider;
  apiKey: string;
  /** Override the provider's base URL (fakes, proxies). OpenAI expects the `/v1` suffix. */
  baseUrl?: string;
  model: string;
  instructions: string;
  /** Tools the application executes; the agent asks through `tool.request`. */
  tools?: ToolSpec[];
  mcpServers?: McpServerSpec[];
  environment?: EnvironmentSpec;
  /** Approval policy for the agent's built-in tools (Anthropic). */
  permissions?: PermissionPolicy;
  /** Caches the provider-side agent per definition; in-memory by default. */
  store?: AgentStore;
  /** Price overrides by model id, for models the built-in table does not know. */
  rates?: Record<string, TokenRate>;
  /** Raw parameters merged into the provider's create calls. */
  providerOptions?: ProviderOptions;
}

export interface StartOptions {
  prompt: string;
  /** Client-side hard cap: the session is interrupted upstream as soon as settled spend reaches it. */
  budgetUsd?: number;
  signal?: AbortSignal;
}

/** Everything a caller persists to re-attach from another process. */
export interface SessionState {
  ref: SessionRef;
  spentUsd: number;
  uncertain: boolean;
  usageTotal: TokenUsage | null;
  seen: string[];
  pending: ToolRequest[];
  /** Requests already answered; a replay must not reopen them. */
  answered: string[];
}

export interface AttachOptions extends Partial<Omit<SessionState, "ref">> {
  budgetUsd?: number;
  signal?: AbortSignal;
}

export interface Session {
  /** Current upstream pointer. Gemini advances `sessionId` on every send() or respond(). */
  readonly ref: SessionRef;
  /** Settled spend so far; `uncertain` when any part was priced with the fallback rate. */
  readonly spentUsd: number;
  readonly uncertain: boolean;
  /** Outcome of the last events() pass, null while one is running. */
  readonly outcome: Outcome | null;
  /** Requests the agent is waiting on. Answer with respond() or approve(), then call events() again. */
  readonly pending: readonly ToolRequest[];
  /** Snapshot for persistence; feed it to `attach()` later. */
  state(): SessionState;
  /** Drive the session until the current turn settles; yields unified events and ends with `session.ended`. */
  events(): AsyncGenerator<SessionEvent>;
  /** Next user turn. Not allowed while requests are pending. Follow with events(). */
  send(prompt: string): Promise<void>;
  /** Answer a `tool.request`. Follow with events(). */
  respond(requestId: string, result: ToolResult): Promise<void>;
  /** Answer an `approval.request`. Follow with events(). */
  approve(requestId: string, allow: boolean, reason?: string): Promise<void>;
  /** Files the agent produced in its sandbox. */
  artifacts(): Promise<Artifact[]>;
  readArtifact(artifact: Artifact): Promise<Uint8Array>;
  /** Interrupt and clean up the upstream session; events() then ends with outcome `stopped`. */
  stop(): Promise<void>;
}

export interface Anyplex {
  readonly capabilities: Capabilities;
  start(options: StartOptions): Promise<Session>;
  attach(ref: SessionRef, options?: AttachOptions): Session;
}

export function capabilities(provider: ProviderName | Provider): Capabilities {
  return resolveProvider(provider).capabilities;
}

function resolveProvider(provider: ProviderName | Provider): Provider {
  if (typeof provider !== "string") return provider;
  const found = BUILTIN[provider];
  if (!found) throw new Error(`unsupported provider ${provider}`);
  return found;
}

/** Refuse at construction what the provider cannot do, instead of silently dropping it. */
function checkSupport(provider: Provider, definition: AgentDefinition): void {
  const c = provider.capabilities;
  const env = definition.environment;
  const used: [string, keyof Capabilities][] = [];
  if (definition.tools.length) used.push(["tools", "clientTools"]);
  if (definition.mcpServers.length) used.push(["mcpServers", "mcp"]);
  if (definition.mcpServers.some((m) => m.authorization))
    used.push(["mcpServers.authorization", "mcpAuth"]);
  if (definition.mcpServers.some((m) => m.headers && Object.keys(m.headers).length))
    used.push(["mcpServers.headers", "mcpHeaders"]);
  if (env.files?.length) used.push(["environment.files", "files"]);
  if (env.repositories?.length) used.push(["environment.repositories", "repositories"]);
  if (env.repositories?.some((r) => r.token))
    used.push(["environment.repositories.token", "repositoryAuth"]);
  if (env.network !== undefined) used.push(["environment.network", "network"]);
  if (env.packages) used.push(["environment.packages", "packages"]);
  if (env.setupCommands?.length) used.push(["environment.setupCommands", "setupCommands"]);
  if (definition.permissions) used.push(["permissions", "permissions"]);
  const unsupported = used.filter(([, key]) => c[key] === "unsupported").map(([label]) => label);
  if (unsupported.length) throw new UnsupportedError(provider.name, unsupported);
}

export function anyplex(options: AnyplexOptions): Anyplex {
  const provider = resolveProvider(options.provider);
  const definition: AgentDefinition = {
    model: options.model,
    instructions: options.instructions,
    tools: options.tools ?? [],
    mcpServers: options.mcpServers ?? [],
    environment: options.environment ?? {},
    permissions: options.permissions ?? null,
    providerOptions: options.providerOptions ?? {},
  };
  checkSupport(provider, definition);
  const store = options.store ?? new MemoryStore();
  const rates = options.rates ?? {};
  // Secrets stay out of the cache key; everything that shapes the provider-side agent goes in.
  const agentKey = createHash("sha256")
    .update(
      JSON.stringify({
        provider: provider.name,
        base_url: options.baseUrl ?? null,
        model: definition.model,
        instructions: definition.instructions,
        tools: definition.tools,
        mcp: definition.mcpServers.map((m) => ({
          name: m.name,
          url: m.url,
          headers: Object.keys(m.headers ?? {}),
        })),
        environment: {
          ...definition.environment,
          repositories: definition.environment.repositories?.map((r) => ({
            url: r.url,
            path: r.path,
            ref: r.ref,
          })),
        },
        permissions: definition.permissions,
        providerOptions: definition.providerOptions,
      }),
    )
    .digest("hex");
  const context = (remainingBudgetUsd: number | null): ProviderContext => ({
    provider: provider.name,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? null,
    definition,
    agentKey,
    remainingBudgetUsd,
    rates,
  });

  return {
    capabilities: provider.capabilities,
    async start(start) {
      const signal = start.signal ?? new AbortController().signal;
      const ctx = context(start.budgetUsd ?? null);
      let agent = await store.get(agentKey);
      if (!agent) {
        agent = await provider.createAgent(ctx, signal);
        await store.set(agentKey, agent);
      }
      const created = await provider.createSession(ctx, agent, start.prompt, signal);
      const ref: SessionRef = {
        provider: provider.name,
        sessionId: created.sessionId,
        agentId: agent.agentId,
        environmentId: created.environmentId ?? agent.environmentId,
      };
      return createSession(provider, context, ref, {}, start.budgetUsd ?? null, start.signal);
    },
    attach(ref, attach = {}) {
      if (ref.provider !== provider.name)
        throw new Error(`session belongs to ${ref.provider}, not ${provider.name}`);
      return createSession(provider, context, ref, attach, attach.budgetUsd ?? null, attach.signal);
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
  context: (remainingBudgetUsd: number | null) => ProviderContext,
  initialRef: SessionRef,
  initial: Partial<Omit<SessionState, "ref">>,
  budgetUsd: number | null,
  outerSignal: AbortSignal | undefined,
): Session {
  let ref: SessionRef = { ...initialRef };
  let spentUsd = initial.spentUsd ?? 0;
  let uncertain = initial.uncertain ?? false;
  let usageTotal = initial.usageTotal ?? null;
  const seen = new Set(initial.seen ?? []);
  const pending = new Map<string, ToolRequest>((initial.pending ?? []).map((r) => [r.id, r]));
  const answered = new Set<string>(initial.answered ?? []);
  let outcome: Outcome | null = null;
  let stopRequested = false;
  const abort = new AbortController();
  outerSignal?.addEventListener("abort", () => abort.abort(outerSignal.reason), { once: true });
  const ctx = () => context(budgetUsd === null ? null : Math.max(0, budgetUsd - spentUsd));

  /** Normalize a provider spend report into a USD delta. */
  const spendDelta = (spend: Spend): { costUsd: number; estimated: boolean } => {
    const c = ctx();
    switch (spend.kind) {
      case "list_cost_usd":
        return { costUsd: Math.max(0, spend.totalUsd - spentUsd), estimated: false };
      case "tokens_delta":
        return computeCost(c.provider, c.definition.model, spend.usage, c.rates);
      case "tokens_total": {
        const delta = subtractUsage(spend.usage, usageTotal);
        usageTotal = spend.usage;
        return computeCost(c.provider, c.definition.model, delta, c.rates);
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
    const reported = await provider.pollSpend(ctx(), ref, abort.signal);
    return reported ? apply(reported) : null;
  };
  const capReached = () => budgetUsd !== null && spentUsd >= budgetUsd;
  const stopUpstream = async (reason: StopReason) => {
    await provider.stop(ctx(), ref, reason).catch(() => undefined);
  };
  const advance = (moved: { sessionId?: string } | undefined) => {
    if (!moved?.sessionId || moved.sessionId === ref.sessionId) return;
    // A chained interaction (Gemini) reports its own cumulative usage from zero.
    ref = { ...ref, sessionId: moved.sessionId };
    usageTotal = null;
  };

  async function* events(): AsyncGenerator<SessionEvent> {
    outcome = null;
    let result: Outcome | null = null;
    try {
      for await (const raw of provider.follow(ctx(), ref, abort.signal)) {
        const t = provider.translate(raw);
        const duplicate = t.upstreamId !== null && seen.has(t.upstreamId);
        if (!duplicate) {
          // Mark the upstream item seen only once every event it produced was delivered: a
          // consumer that abandons the generator mid-item gets the whole item again on attach
          // (at-least-once per item; dedupe by upstreamId for exactly-once).
          for (const event of t.events) yield stamp(event, t.upstreamId);
          for (const request of t.requests ?? [])
            if (!answered.has(request.id)) pending.set(request.id, request);
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
        // A requires_action whose requests were all answered already is the provider catching up
        // (observed with OpenAI right after respond()): keep following.
        if (t.outcome.kind === "requires_action" && pending.size === 0) continue;
        if (t.outcome.kind !== "continue") {
          result = t.outcome;
          break;
        }
      }
    } catch (err) {
      // Upstream errors end the pass instead of throwing: every pass ends with `session.ended`,
      // and the error text travels in the outcome.
      if (!stopRequested && !abort.signal.aborted)
        result = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    if (stopRequested) result = { kind: "stopped" };
    else if (abort.signal.aborted) result = { kind: "detached" };
    if (result === null)
      result = { kind: "failed", error: "upstream stream ended before the session settled" };
    if (result.kind === "requires_action" || (result.kind === "completed" && pending.size > 0))
      result = { kind: "requires_action", requests: [...pending.values()] };

    // Providers report usage asynchronously (OpenAI: seconds to a minute after the turn ends).
    // Poll with backoff for up to ~60 s so the pass ends with its real cost; if it never
    // arrives, say so in the stream instead of silently ending at $0.
    if ((result.kind === "completed" || result.kind === "budget_exceeded") && provider.pollSpend) {
      let settled = false;
      let lastError: string | null = null;
      for (const delay of [1000, 2000, 4000, 8000, 15000, 30000]) {
        try {
          const reported = await provider.pollSpend(ctx(), ref, abort.signal);
          if (reported) {
            const update = apply(reported);
            if (update) yield update;
            settled = true;
            break;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (!settled)
        yield {
          type: "harness.event",
          payload: {
            type: "spend.unsettled",
            message: "the provider had not reported usage yet; attach() later to settle spend",
            error: lastError,
          },
          upstreamId: null,
        };
      if (result.kind === "completed" && capReached()) result = { kind: "budget_exceeded" };
    }
    switch (result.kind) {
      case "completed":
        await stopUpstream("finished");
        break;
      case "budget_exceeded":
        await stopUpstream("budget_exceeded");
        break;
      case "failed":
        await stopUpstream("failed");
        break;
      case "requires_action":
      case "stopped":
      case "detached":
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

  const takePending = (id: string, kind: ToolRequest["kind"]): ToolRequest => {
    const request = pending.get(id);
    if (!request || request.kind !== kind) throw new Error(`no pending ${kind} request ${id}`);
    return request;
  };

  return {
    get ref() {
      return ref;
    },
    get spentUsd() {
      return spentUsd;
    },
    get uncertain() {
      return uncertain;
    },
    get outcome() {
      return outcome;
    },
    get pending() {
      return [...pending.values()];
    },
    state: () => ({
      ref,
      spentUsd,
      uncertain,
      usageTotal,
      seen: [...seen],
      pending: [...pending.values()],
      answered: [...answered],
    }),
    events,
    async send(prompt) {
      if (pending.size) throw new Error("answer the pending requests before sending a new message");
      advance((await provider.sendMessage(ctx(), ref, prompt)) ?? undefined);
    },
    async respond(id, result) {
      const request = takePending(id, "tool");
      advance((await provider.sendToolResult(ctx(), ref, request, result)) ?? undefined);
      pending.delete(id);
      answered.add(id);
    },
    async approve(id, allow, reason) {
      const request = takePending(id, "approval");
      if (!provider.confirmTool) throw new UnsupportedError(provider.name, ["approvals"]);
      await provider.confirmTool(ctx(), ref, request, allow, reason);
      pending.delete(id);
      answered.add(id);
    },
    async artifacts() {
      if (!provider.listArtifacts) throw new UnsupportedError(provider.name, ["artifactsList"]);
      return provider.listArtifacts(ctx(), ref);
    },
    async readArtifact(artifact) {
      if (!provider.readArtifact) throw new UnsupportedError(provider.name, ["artifactsRead"]);
      return provider.readArtifact(ctx(), ref, artifact);
    },
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
