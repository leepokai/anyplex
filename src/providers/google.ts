// Gemini Managed Agents (Interactions API, preview 2026-05-19).
//
// Mapping: the definition becomes one saved agent (caller-chosen id from the definition hash,
// function tools, MCP servers with headers, a `remote` base environment with inline files,
// repositories, and a network allowlist). A session is a chain of interactions: start() creates
// one in the background with `environment: "remote"`, send() and respond() create the next one
// with `previous_interaction_id` on the same environment, so `ref.sessionId` moves forward.
// Verified live 2026-09-13 with gemini-3.8-flash: events carry no event_id, tool code and
// results arrive in step.delta rather than step.start, and every reconnect replays from the
// first event while last_event_id is ignored. The provider therefore stamps ordinal ids and
// attaches the step.start metadata to later deltas so dedupe and tool ids work. Pricing is
// undisclosed: usage is priced at the fallback rate and flagged as an estimate.

import { GoogleGenAI } from "@google/genai";
import type { Provider, ProviderContext } from "../provider.ts";
import {
  type Capabilities,
  CONTINUE,
  num,
  type Outcome,
  preview,
  type RawEvent,
  record,
  resultText,
  skip,
  str,
  type TokenUsage,
  type ToolRequest,
  type Translation,
  type TranslationOutcome,
} from "../types.ts";

const BASE_AGENT = "antigravity-preview-05-2026";

export const googleCapabilities: Capabilities = {
  multiTurn: "native",
  clientTools: "native",
  approvals: "unsupported",
  permissions: "unsupported",
  mcp: "native",
  mcpAuth: "native",
  mcpHeaders: "native",
  files: "native",
  repositories: "native",
  repositoryAuth: "unsupported",
  network: "native",
  packages: "unsupported",
  setupCommands: "unsupported",
  artifactsList: "native",
  artifactsRead: "unsupported",
  nativeBudget: "unsupported",
  artifactsDirectory: null,
};

/** Interaction usage totals are cumulative for the interaction. */
export function googleTokenUsage(raw: unknown): TokenUsage | null {
  const usage = record(raw);
  if (!usage) return null;
  const cached = num(usage.total_cached_tokens);
  return {
    inputTokens: Math.max(0, num(usage.total_input_tokens) - cached),
    outputTokens: num(usage.total_output_tokens) + num(usage.total_thought_tokens),
    cacheReadTokens: cached,
  };
}

function statusOutcome(status: string): TranslationOutcome {
  const map: Record<string, Outcome> = {
    completed: { kind: "completed" },
    failed: { kind: "failed", error: "interaction failed" },
    incomplete: { kind: "failed", error: "interaction incomplete" },
    cancelled: { kind: "terminated" },
    budget_exceeded: { kind: "budget_exceeded" },
    requires_action: { kind: "requires_action", requests: [] },
  };
  return map[status] ?? CONTINUE;
}

const toolName = (type: string) => type.replace(/_(call|result)$/, "");
const hasKeys = (value: unknown) => {
  const r = record(value);
  return r !== null && Object.keys(r).length > 0;
};

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function functionRequest(step: Record<string, unknown>, input: unknown, index: number) {
  const id = str(step.id) ?? `step_${index}`;
  const name = str(step.name) ?? "function";
  const request: ToolRequest = { id, kind: "tool", name, input };
  return {
    events: [{ type: "tool.request", payload: { id, name, input: preview(input) } }] as RawEvent[],
    requests: [request],
  };
}

/** Steps that already carry their content at step.start; streamed content is handled by deltas. */
function stepStart(
  step: Record<string, unknown>,
  index: number,
): { events: RawEvent[]; requests?: ToolRequest[] } {
  const type = str(step.type) ?? "";
  const id = str(step.id) ?? str(step.call_id) ?? `step_${index}`;
  if (type === "model_output" || type === "thought" || type === "user_input") return { events: [] };
  if (type === "function_call")
    return hasKeys(step.arguments) ? functionRequest(step, step.arguments, index) : { events: [] };
  if (type.endsWith("_call")) {
    if (!hasKeys(step.arguments)) return { events: [] };
    return {
      events: [
        {
          type: "tool.call",
          payload: { id, name: str(step.name) ?? toolName(type), input: preview(step.arguments) },
        },
      ],
    };
  }
  if (type.endsWith("_result")) {
    if (step.result === undefined) return { events: [] };
    return {
      events: [
        {
          type: "tool.result",
          payload: {
            id,
            name: str(step.name) ?? toolName(type),
            is_error: step.is_error === true,
            content: preview(step.result),
          },
        },
      ],
    };
  }
  return {
    events: [{ type: "harness.event", payload: { type: `step.${type}`, step: preview(step) } }],
  };
}

function stepDelta(
  delta: Record<string, unknown>,
  step: Record<string, unknown> | null,
  index: number,
): { events: RawEvent[]; requests?: ToolRequest[] } {
  const type = str(delta.type) ?? "";
  const id = str(step?.id) ?? str(step?.call_id) ?? `step_${index}`;
  switch (type) {
    case "text": {
      const text = str(delta.text);
      return { events: text ? [{ type: "message.delta", payload: { text } }] : [] };
    }
    case "code_execution_call":
      return {
        events: [
          {
            type: "tool.call",
            payload: { id, name: "code_execution", input: preview(delta.arguments) },
          },
        ],
      };
    case "code_execution_result":
      return {
        events: [
          {
            type: "tool.result",
            payload: {
              id,
              name: "code_execution",
              is_error: delta.is_error === true,
              content: preview(delta.result),
            },
          },
        ],
      };
    case "arguments_delta":
      // ponytail: one chunk per call assumed (as observed); multi-chunk arguments would need buffering.
      return functionRequest(
        step ?? { id, name: "function" },
        parseArguments(delta.arguments),
        index,
      );
    case "function_result":
      return {
        events: [
          {
            type: "tool.result",
            payload: {
              id,
              name: str(delta.name) ?? str(step?.name) ?? "function",
              is_error: delta.is_error === true,
              content: preview(delta.result),
            },
          },
        ],
      };
    default:
      // Thought summaries, signatures, media, and search deltas stay out of the transcript.
      return { events: [] };
  }
}

export function translateGoogle(raw: unknown): Translation {
  const ev = record(raw);
  if (!ev) return skip();
  const type = str(ev.event_type) ?? "";
  const eventId = str(ev.event_id);
  const done = (events: RawEvent[], extra: Partial<Translation> = {}): Translation => ({
    upstreamId: eventId,
    events,
    outcome: CONTINUE,
    ...extra,
  });

  switch (type) {
    case "interaction.created":
      return done([
        {
          type: "harness.event",
          payload: { type, interaction_id: record(ev.interaction)?.id ?? null },
        },
      ]);
    case "interaction.status_update": {
      const status = str(ev.status) ?? "in_progress";
      return done([{ type: "harness.event", payload: { type, status } }], {
        outcome: statusOutcome(status),
      });
    }
    case "step.start": {
      const step = record(ev.step);
      if (!step) return skip(eventId);
      const { events, requests } = stepStart(step, num(ev.index));
      return done(events, requests ? { requests } : {});
    }
    case "step.delta": {
      const delta = record(ev.delta);
      if (!delta) return skip(eventId);
      const { events, requests } = stepDelta(delta, record(ev.step), num(ev.index));
      return done(events, requests ? { requests } : {});
    }
    case "step.stop": {
      const usage = googleTokenUsage(ev.usage);
      return done([], usage ? { spend: { kind: "tokens_total", usage } } : {});
    }
    case "interaction.completed": {
      const interaction = record(ev.interaction);
      const usage = googleTokenUsage(interaction?.usage);
      const status = str(interaction?.status) ?? "completed";
      return done([{ type: "harness.event", payload: { type, status } }], {
        ...(usage ? { spend: { kind: "tokens_total", usage } } : {}),
        outcome: status === "completed" ? { kind: "completed" } : statusOutcome(status),
      });
    }
    case "error": {
      const error = record(ev.error);
      const message = str(error?.message) ?? str(error?.code) ?? "interaction error";
      return done([{ type: "harness.event", payload: { type, error: message } }], {
        outcome: { kind: "failed", error: message },
      });
    }
    default:
      return skip(eventId);
  }
}

const client = (ctx: { apiKey: string; baseUrl: string | null }) =>
  new GoogleGenAI({
    apiKey: ctx.apiKey,
    ...(ctx.baseUrl ? { httpOptions: { baseUrl: ctx.baseUrl } } : {}),
  });
const ignore = () => undefined;

function baseEnvironment(env: ProviderContext["definition"]["environment"]) {
  const sources = [
    ...(env.files ?? []).map((file) => ({
      type: "inline",
      target: file.path,
      content: file.content,
    })),
    ...(env.repositories ?? []).map((repo) => ({
      type: "repository",
      source: repo.url,
      ...(repo.path ? { target: repo.path } : {}),
    })),
  ];
  const network =
    env.network === undefined
      ? undefined
      : env.network === "none"
        ? ("disabled" as const)
        : env.network === "unrestricted"
          ? { allowlist: [{ domain: "*" }] }
          : { allowlist: env.network.allowedHosts.map((domain) => ({ domain })) };
  if (!sources.length && network === undefined) return undefined;
  return {
    type: "remote" as const,
    ...(sources.length ? { sources } : {}),
    ...(network !== undefined ? { network } : {}),
  };
}

/**
 * A continuation interaction on the same environment, chained to the previous one. Chaining
 * right after the previous interaction settled can fail with "Precondition check failed"
 * (observed live 2026-09-14), so wait for the previous one to be final and retry briefly.
 */
async function continueInteraction(
  ctx: ProviderContext,
  ref: { sessionId: string; agentId: string; environmentId: string | null },
  input: unknown,
) {
  const c = client(ctx);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const previous = await c.interactions.get(ref.sessionId).catch(() => null);
    const status = previous?.status ?? "";
    if (status && status !== "in_progress" && status !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  let lastError: unknown;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const interaction = await c.interactions.create({
        agent: ref.agentId,
        // biome-ignore lint/suspicious/noExplicitAny: input accepts a string or an array of steps
        input: input as any,
        previous_interaction_id: ref.sessionId,
        environment: ref.environmentId ?? "remote",
        background: true,
        stream: false,
        ...(ctx.definition.providerOptions.session ?? {}),
      });
      return { sessionId: interaction.id };
    } catch (err) {
      lastError = err;
      if (!/precondition/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  throw lastError;
}

export const google: Provider = {
  name: "google",
  capabilities: googleCapabilities,

  async createAgent(ctx) {
    const c = client(ctx);
    const d = ctx.definition;
    const id = `anyplex-${ctx.agentKey.slice(0, 24)}`;
    const environment = baseEnvironment(d.environment);
    const definition = {
      id,
      base_agent: BASE_AGENT,
      system_instruction: d.instructions,
      agent_config: { type: "antigravity" as const, model: d.model },
      ...(d.tools.length || d.mcpServers.length
        ? {
            tools: [
              ...d.tools.map((tool) => ({
                type: "function" as const,
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
              ...d.mcpServers.map((server) => ({
                type: "mcp_server" as const,
                name: server.name,
                url: server.url,
                headers: {
                  ...(server.headers ?? {}),
                  ...(server.authorization
                    ? { Authorization: `Bearer ${server.authorization}` }
                    : {}),
                },
              })),
            ],
          }
        : {}),
      ...(environment ? { base_environment: environment } : {}),
      ...(d.providerOptions.agent ?? {}),
    };
    const agent = await c.agents.create(definition).catch(async (err: unknown) => {
      const existing = await c.agents.get(id).catch(() => null);
      if (existing?.id) return existing;
      throw err;
    });
    if (!agent.id) throw new Error("gemini agent create returned no id");
    return { agentId: agent.id, environmentId: null };
  },

  async createSession(ctx, agent, prompt) {
    // "remote" gives the interaction a hosted sandbox; background so the id is known before streaming.
    const interaction = await client(ctx).interactions.create({
      agent: agent.agentId,
      input: prompt,
      environment: "remote",
      background: true,
      stream: false,
      ...(ctx.definition.providerOptions.session ?? {}),
    });
    return { sessionId: interaction.id, environmentId: interaction.environment_id ?? null };
  },

  async *follow(ctx, ref, signal) {
    // The server replays the whole interaction on every (re)connect and ignores last_event_id
    // (verified 2026-09-13), and events carry no ids of their own. Ordinal ids are therefore
    // stable across reconnects, which is all the executor's dedupe needs.
    const stream = await client(ctx).interactions.get(ref.sessionId, { stream: true });
    const cancel = () => void stream.cancel().catch(ignore);
    signal.addEventListener("abort", cancel, { once: true });
    const starts = new Map<number, Record<string, unknown>>();
    let ordinal = 0;
    let terminal = false;
    try {
      for await (const raw of stream) {
        const event = raw as unknown as Record<string, unknown>;
        ordinal += 1;
        if (
          event.event_type === "interaction.completed" ||
          event.event_type === "error" ||
          (event.event_type === "interaction.status_update" &&
            statusOutcome(str(event.status) ?? "").kind !== "continue")
        )
          terminal = true;
        const index = typeof event.index === "number" ? event.index : null;
        const step = record(event.step);
        if (event.event_type === "step.start" && index !== null && step) starts.set(index, step);
        const known = step ?? (index === null ? null : (starts.get(index) ?? null));
        yield {
          ...event,
          event_id:
            typeof event.event_id === "string" && event.event_id
              ? event.event_id
              : `${ref.sessionId}:${ordinal}`,
          ...(known ? { step: known } : {}),
        };
      }
      // A cancelled interaction replays without a terminal event (observed live); ask once.
      if (!terminal && !signal.aborted) {
        const final = await client(ctx).interactions.get(ref.sessionId);
        yield {
          event_type: "interaction.status_update",
          event_id: `${ref.sessionId}:final`,
          interaction_id: ref.sessionId,
          status: final.status ?? "failed",
        };
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  },

  translate: translateGoogle,

  sendMessage: (ctx, ref, text) => continueInteraction(ctx, ref, text),

  sendToolResult: (ctx, ref, request, result) =>
    continueInteraction(ctx, ref, [
      {
        type: "function_result",
        call_id: request.id,
        name: request.name,
        result: resultText(result.error ?? result.output),
        is_error: result.error !== undefined,
      },
    ]),

  async listArtifacts(ctx, ref) {
    if (!ref.environmentId) return [];
    // Verified live 2026-09-14: the root is "" (not "/"), paths come back relative, sizes as strings.
    const response = await client(ctx).environments.files.list({
      environment: ref.environmentId,
      path: "",
      recursive: true,
    });
    return (response.files ?? [])
      .filter((file) => String(file.type ?? "").toLowerCase() !== "directory")
      .map((file) => ({
        id: file.path ?? file.name ?? "",
        path: `/${file.path ?? file.name ?? ""}`,
        sizeBytes: file.size_bytes === undefined ? null : Number(file.size_bytes),
      }));
  },

  async stop(ctx, ref, reason) {
    if (reason === "kill" || reason === "budget_exceeded")
      await client(ctx).interactions.cancel(ref.sessionId).catch(ignore);
  },
};
