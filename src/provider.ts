// What each hosted runtime must implement. Translators are pure; everything else does IO with
// the provider's official SDK. Implement this interface to add a runtime anyplex does not ship.

import type { TokenRate } from "./pricing.ts";
import type {
  AgentRefRecord,
  Artifact,
  Capabilities,
  EnvironmentSpec,
  McpServerSpec,
  PermissionPolicy,
  ProviderOptions,
  SessionRef,
  Spend,
  ToolRequest,
  ToolSpec,
  Translation,
} from "./types.ts";

/** The application's agent definition, as the provider sees it. */
export interface AgentDefinition {
  model: string;
  instructions: string;
  tools: ToolSpec[];
  mcpServers: McpServerSpec[];
  environment: EnvironmentSpec;
  permissions: PermissionPolicy | null;
  providerOptions: ProviderOptions;
}

export interface ProviderContext {
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  definition: AgentDefinition;
  /** Stable key for the definition; providers that need a caller-chosen id derive it from this. */
  agentKey: string;
  /** Remaining budget the provider may enforce natively (Anthropic session budget); null when uncapped. */
  remainingBudgetUsd: number | null;
  /** Price overrides by model id, on top of the built-in table. */
  rates: Record<string, TokenRate>;
}

export type StopReason = "kill" | "budget_exceeded" | "finished" | "failed";

export interface ToolResult {
  output?: unknown;
  error?: string;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: Capabilities;
  createAgent(ctx: ProviderContext, signal: AbortSignal): Promise<AgentRefRecord>;
  createSession(
    ctx: ProviderContext,
    agent: AgentRefRecord,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ sessionId: string; environmentId?: string | null }>;
  /**
   * Yield raw upstream events: history first so a reconnect never loses anything, then the live
   * stream. Ends when the upstream session settles or `signal` aborts.
   */
  follow(ctx: ProviderContext, ref: SessionRef, signal: AbortSignal): AsyncIterable<unknown>;
  translate(raw: unknown): Translation;
  /** Authoritative cumulative spend when the provider exposes one; null while unreported. */
  pollSpend?(ctx: ProviderContext, ref: SessionRef, signal: AbortSignal): Promise<Spend | null>;
  /** Next user turn on the same session. Returns a new session id when the provider chains sessions (Gemini). */
  sendMessage(
    ctx: ProviderContext,
    ref: SessionRef,
    text: string,
  ): Promise<{ sessionId?: string } | undefined>;
  /** Answer a `tool.request`. */
  sendToolResult(
    ctx: ProviderContext,
    ref: SessionRef,
    request: ToolRequest,
    result: ToolResult,
  ): Promise<{ sessionId?: string } | undefined>;
  /** Answer an `approval.request`. */
  confirmTool?(
    ctx: ProviderContext,
    ref: SessionRef,
    request: ToolRequest,
    allow: boolean,
    reason?: string,
  ): Promise<void>;
  listArtifacts?(ctx: ProviderContext, ref: SessionRef): Promise<Artifact[]>;
  readArtifact?(ctx: ProviderContext, ref: SessionRef, artifact: Artifact): Promise<Uint8Array>;
  /** Interrupt and clean up the upstream session. Safe to call twice. */
  stop(ctx: ProviderContext, ref: SessionRef, reason: StopReason): Promise<void>;
}
