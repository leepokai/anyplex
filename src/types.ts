// The vocabulary every provider is projected onto. Translators are pure functions from a raw
// upstream event to a Translation; the session runner turns Translations into SessionEvents.

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export type Outcome =
  | { kind: "completed" }
  /** The provider paused or the budget watchdog stopped the session because of a spend cap. */
  | { kind: "budget_exceeded" }
  /** The upstream session waits for a client tool result anyplex sessions do not supply. */
  | { kind: "requires_action" }
  /** The upstream session ended without a result (cancelled, deleted, or terminated). */
  | { kind: "terminated" }
  /** stop() was called; the upstream session was interrupted and cleaned up. */
  | { kind: "stopped" }
  /** The start/attach `signal` aborted: this process let go, the upstream session keeps running. Re-attach later. */
  | { kind: "detached" }
  | { kind: "failed"; error: string };

/**
 * How a provider reports spend. Anthropic prices the session itself (list cost, cumulative);
 * OpenAI and Gemini report token usage, priced locally with the rate table.
 */
export type Spend =
  | { kind: "list_cost_usd"; totalUsd: number }
  | { kind: "tokens_delta"; usage: TokenUsage }
  | { kind: "tokens_total"; usage: TokenUsage };

export interface RawEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type TranslationOutcome = { kind: "continue" } | Outcome;

export interface Translation {
  /** Upstream identifier for dedupe after a reconnect; null when the event carries none. */
  upstreamId: string | null;
  events: RawEvent[];
  spend?: Spend;
  /** The provider should fetch the authoritative spend figure after this event. */
  pollSpend?: boolean;
  outcome: TranslationOutcome;
}

export type SessionEvent =
  | { type: "message.delta"; payload: { text: string }; upstreamId: string | null }
  | {
      type: "tool.call";
      payload: { id: unknown; name: unknown; input: unknown; source?: string };
      upstreamId: string | null;
    }
  | {
      type: "tool.result";
      payload: { id: unknown; name?: unknown; is_error: boolean; content: unknown };
      upstreamId: string | null;
    }
  | { type: "harness.event"; payload: Record<string, unknown>; upstreamId: string | null }
  | {
      type: "spend.updated";
      payload: { spent_usd: number; delta_usd: number; uncertain: boolean };
      upstreamId: null;
    }
  | {
      type: "session.ended";
      payload: { outcome: Outcome; spent_usd: number; uncertain: boolean };
      upstreamId: null;
    };

/** Everything needed to find the hosted session again from another process. */
export interface SessionRef {
  provider: ProviderName;
  sessionId: string;
  agentId: string;
  environmentId: string | null;
}

/** Caches the provider-side agent object per definition so sessions do not create one each. */
export interface AgentStore {
  get(key: string): Promise<{ agentId: string; environmentId: string | null } | null>;
  set(key: string, ref: { agentId: string; environmentId: string | null }): Promise<void>;
}

export class MemoryStore implements AgentStore {
  private readonly refs = new Map<string, { agentId: string; environmentId: string | null }>();
  async get(key: string) {
    return this.refs.get(key) ?? null;
  }
  async set(key: string, ref: { agentId: string; environmentId: string | null }) {
    this.refs.set(key, ref);
  }
}

/**
 * JSON file store, so a process restart reuses the provider-side agents instead of creating
 * new ones (Anthropic creates an agent and an environment per definition; OpenAI an agent).
 * ponytail: whole-file rewrite on every set; fine for a handful of definitions.
 */
export class FileStore implements AgentStore {
  constructor(private readonly path: string) {}
  private async read(): Promise<Record<string, { agentId: string; environmentId: string | null }>> {
    const { readFile } = await import("node:fs/promises");
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch {
      return {};
    }
  }
  async get(key: string) {
    return (await this.read())[key] ?? null;
  }
  async set(key: string, ref: { agentId: string; environmentId: string | null }) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const all = await this.read();
    all[key] = ref;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }
}

export const CONTINUE: TranslationOutcome = { kind: "continue" };

export function skip(upstreamId: string | null = null): Translation {
  return { upstreamId, events: [], outcome: CONTINUE };
}

const PREVIEW_CHARS = 4_000;

/** Tool inputs and results can be huge; events keep a bounded preview. */
export function preview(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string")
    return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
  const json = JSON.stringify(value);
  return json.length > PREVIEW_CHARS ? `${json.slice(0, PREVIEW_CHARS)}…` : value;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
