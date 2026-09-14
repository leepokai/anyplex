// The vocabulary every provider is projected onto. Translators are pure functions from a raw
// upstream event to a Translation; the session runner turns Translations into SessionEvents.

export const PROVIDERS = ["anthropic", "openai", "google", "cursor"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

// ---- what an application declares once ----

/** A tool the application executes itself; the hosted agent asks for it through `tool.request`. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  parameters: Record<string, unknown>;
}

export interface McpServerSpec {
  name: string;
  url: string;
  /** Bearer token; stored provider-side (Anthropic vault) or sent as a header (OpenAI, Gemini). */
  authorization?: string;
  headers?: Record<string, string>;
}

export interface EnvironmentSpec {
  /** Text files placed in the sandbox before the agent starts. */
  files?: { path: string; content: string }[];
  /** Repositories cloned into the sandbox. */
  repositories?: { url: string; path?: string; ref?: string; token?: string }[];
  /** Outbound network from the sandbox. Default: the provider's default. */
  network?: "unrestricted" | "none" | { allowedHosts: string[] };
  packages?: { npm?: string[]; pip?: string[]; apt?: string[] };
  /** Shell commands run once the sandbox exists, before the agent starts. */
  setupCommands?: string[];
}

/** Who may run the agent's built-in tools: always, never without asking, or the provider decides. */
export type PermissionPolicy = "allow" | "ask" | "auto";

/** Raw parameters merged into the provider's own create calls; the escape hatch when the abstraction is not enough. */
export interface ProviderOptions {
  agent?: Record<string, unknown>;
  session?: Record<string, unknown>;
  environment?: Record<string, unknown>;
}

export type Support = "native" | "emulated" | "unsupported";

export interface Capabilities {
  multiTurn: Support;
  clientTools: Support;
  approvals: Support;
  permissions: Support;
  mcp: Support;
  mcpAuth: Support;
  mcpHeaders: Support;
  files: Support;
  repositories: Support;
  repositoryAuth: Support;
  network: Support;
  packages: Support;
  setupCommands: Support;
  artifactsList: Support;
  artifactsRead: Support;
  nativeBudget: Support;
  /** Directory the agent must write to for files to show up in `artifacts()`; null when the whole sandbox is listed. */
  artifactsDirectory: string | null;
}

// ---- what a session produces ----

export type Outcome =
  | { kind: "completed" }
  /** The provider paused or the budget watchdog stopped the session because of a spend cap. */
  | { kind: "budget_exceeded" }
  /** The agent is waiting on the application: answer `session.pending` with respond() or approve(), then call events() again. */
  | { kind: "requires_action"; requests: ToolRequest[] }
  /** The upstream session ended without a result (cancelled, deleted, or terminated). */
  | { kind: "terminated" }
  /** stop() was called; the upstream session was interrupted and cleaned up. */
  | { kind: "stopped" }
  /** The start/attach `signal` aborted: this process let go, the upstream session keeps running. Re-attach later. */
  | { kind: "detached" }
  /** `code` and `status` carry the vendor's error code and HTTP status when known. */
  | { kind: "failed"; error: string; code?: string; status?: number };

/**
 * How a provider reports spend. Anthropic prices the session itself (list cost, cumulative);
 * OpenAI and Gemini report token usage, priced locally with the rate table.
 */
export type Spend =
  | { kind: "list_cost_usd"; totalUsd: number }
  | { kind: "tokens_delta"; usage: TokenUsage }
  | { kind: "tokens_total"; usage: TokenUsage };

/** Something the hosted agent needs from the application before it can continue. */
export interface ToolRequest {
  id: string;
  /** "tool": run it and respond(); "approval": approve() or deny it. */
  kind: "tool" | "approval";
  name: string;
  input: unknown;
  /** Provider-specific correlation the provider needs to route the answer (OpenAI turn id, ...). */
  handle?: unknown;
}

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
  /** Requests the application must answer; the session keeps them in `pending`. */
  requests?: ToolRequest[];
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
  /** The agent wants the application to run one of its `tools`; answer with `session.respond()`. */
  | {
      type: "tool.request";
      payload: { id: string; name: string; input: unknown };
      upstreamId: string | null;
    }
  /** The provider wants a human decision on a built-in tool call; answer with `session.approve()`. */
  | {
      type: "approval.request";
      payload: { id: string; name: string; input: unknown };
      upstreamId: string | null;
    }
  | { type: "harness.event"; payload: Record<string, unknown>; upstreamId: string | null }
  /** `usage` is the token delta behind this update when the provider reports tokens. */
  | {
      type: "spend.updated";
      payload: { spent_usd: number; delta_usd: number; uncertain: boolean; usage?: TokenUsage };
      upstreamId: null;
    }
  /** The last event of every events() pass. `completed` means the turn is done and send() is allowed. */
  | {
      type: "session.ended";
      payload: { outcome: Outcome; spent_usd: number; uncertain: boolean };
      upstreamId: null;
    };

/**
 * Everything needed to find the hosted session again from another process. Gemini sessions are
 * chains of interactions, so `sessionId` moves forward on every send() or respond(); persist the
 * ref after each pass.
 */
export interface SessionRef {
  provider: string;
  sessionId: string;
  agentId: string;
  environmentId: string | null;
}

export interface Artifact {
  id: string;
  path: string;
  sizeBytes: number | null;
}

export interface AgentRefRecord {
  agentId: string;
  environmentId: string | null;
  /** Provider-specific extras created alongside the agent (Anthropic vault id, ...). */
  extra?: Record<string, string>;
}

/** Caches the provider-side agent object per definition so sessions do not create one each. */
export interface AgentStore {
  get(key: string): Promise<AgentRefRecord | null>;
  set(key: string, ref: AgentRefRecord): Promise<void>;
}

export class MemoryStore implements AgentStore {
  private readonly refs = new Map<string, AgentRefRecord>();
  async get(key: string) {
    return this.refs.get(key) ?? null;
  }
  async set(key: string, ref: AgentRefRecord) {
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
  private async read(): Promise<Record<string, AgentRefRecord>> {
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
  async set(key: string, ref: AgentRefRecord) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const all = await this.read();
    all[key] = ref;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * Every error a session method throws: the vendor's HTTP status and error code, normalized, with
 * the original error as `cause`. `retryable` is a hint (408, 429, 5xx) for callers that retry.
 */
export class AnyplexError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  constructor(
    provider: string,
    message: string,
    options: {
      status?: number | null;
      code?: string | null;
      cause?: unknown;
      retryable?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AnyplexError";
    this.provider = provider;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryable =
      options.retryable ??
      (this.status !== null && (this.status === 408 || this.status === 429 || this.status >= 500));
  }
}

export class UnsupportedError extends AnyplexError {
  constructor(
    provider: string,
    readonly features: string[],
  ) {
    super(provider, `${provider} does not support: ${features.join(", ")}`, {
      code: "unsupported",
      retryable: false,
    });
    this.name = "UnsupportedError";
  }
}

/** Normalize a vendor SDK error (Anthropic, OpenAI, Google, fetch) into an AnyplexError. */
export function toAnyplexError(provider: string, err: unknown): AnyplexError {
  if (err instanceof AnyplexError) return err;
  const e = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const status =
    [e.status, e.statusCode, record(e.response)?.status]
      .map((value) => (typeof value === "number" ? value : Number.NaN))
      .find((value) => Number.isFinite(value) && value > 0) ?? null;
  const body = record(e.error);
  const inner = record(body?.error);
  const code =
    str(e.code) ?? str(body?.code) ?? str(inner?.code) ?? str(body?.type) ?? str(inner?.type);
  const message = err instanceof Error ? err.message : String(err);
  return new AnyplexError(provider, message, { status, code, cause: err });
}

export const CONTINUE: TranslationOutcome = { kind: "continue" };

export function skip(upstreamId: string | null = null): Translation {
  return { upstreamId, events: [], outcome: CONTINUE };
}

/** A replayed event from an earlier turn: transcript only, no outcome, no requests, no polling. */
export function stale(translation: Translation): Translation {
  return {
    upstreamId: translation.upstreamId,
    events: translation.events,
    spend: translation.spend,
    outcome: CONTINUE,
  };
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

/** Tool results travel as text; objects are serialized, strings pass through. */
export function resultText(output: unknown): string {
  if (output === undefined || output === null) return "";
  return typeof output === "string" ? output : JSON.stringify(output);
}
