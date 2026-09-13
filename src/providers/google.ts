// Gemini Managed Agents (Interactions API, preview 2026-05-19). Verified live 2026-09-13 with
// gemini-3.8-flash: agents need a caller-chosen id (409 on repeat), interactions need
// `environment: "remote"` for a sandbox, events carry no event_id, tool code and results arrive in
// step.delta rather than step.start, and every reconnect replays from the first event while
// last_event_id is ignored. The provider therefore stamps ordinal ids and attaches the step.start
// metadata to later deltas so dedupe and tool ids work. Pricing is undisclosed: usage is priced
// at the fallback rate and flagged as an estimate.

import { GoogleGenAI } from "@google/genai";
import type { Provider } from "../provider.ts";
import {
  CONTINUE,
  num,
  type Outcome,
  preview,
  type RawEvent,
  record,
  skip,
  str,
  type TokenUsage,
  type Translation,
  type TranslationOutcome,
} from "../types.ts";

const BASE_AGENT = "antigravity-preview-05-2026";

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
    requires_action: { kind: "requires_action" },
  };
  return map[status] ?? CONTINUE;
}

const toolName = (type: string) => type.replace(/_(call|result)$/, "");
const hasKeys = (value: unknown) => {
  const r = record(value);
  return r !== null && Object.keys(r).length > 0;
};

/** Steps that already carry their content at step.start; streamed content is handled by deltas. */
function stepStartEvents(step: Record<string, unknown>, index: number): RawEvent[] {
  const type = str(step.type) ?? "";
  const id = str(step.id) ?? str(step.call_id) ?? `step_${index}`;
  if (type === "model_output" || type === "thought" || type === "user_input") return [];
  if (type.endsWith("_call")) {
    if (!hasKeys(step.arguments)) return [];
    return [
      {
        type: "tool.call",
        payload: { id, name: str(step.name) ?? toolName(type), input: preview(step.arguments) },
      },
    ];
  }
  if (type.endsWith("_result")) {
    if (step.result === undefined) return [];
    return [
      {
        type: "tool.result",
        payload: {
          id,
          name: str(step.name) ?? toolName(type),
          is_error: step.is_error === true,
          content: preview(step.result),
        },
      },
    ];
  }
  return [{ type: "harness.event", payload: { type: `step.${type}`, step: preview(step) } }];
}

function stepDeltaEvents(
  delta: Record<string, unknown>,
  step: Record<string, unknown> | null,
  index: number,
): RawEvent[] {
  const type = str(delta.type) ?? "";
  const id = str(step?.id) ?? str(step?.call_id) ?? `step_${index}`;
  switch (type) {
    case "text": {
      const text = str(delta.text);
      return text ? [{ type: "message.delta", payload: { text } }] : [];
    }
    case "code_execution_call":
      return [
        {
          type: "tool.call",
          payload: { id, name: "code_execution", input: preview(delta.arguments) },
        },
      ];
    case "code_execution_result":
      return [
        {
          type: "tool.result",
          payload: {
            id,
            name: "code_execution",
            is_error: delta.is_error === true,
            content: preview(delta.result),
          },
        },
      ];
    case "arguments_delta":
      return [
        {
          type: "tool.call",
          payload: { id, name: str(step?.name) ?? "function", input: preview(delta.arguments) },
        },
      ];
    case "function_result":
      return [
        {
          type: "tool.result",
          payload: {
            id,
            name: str(delta.name) ?? str(step?.name) ?? "function",
            is_error: delta.is_error === true,
            content: preview(delta.result),
          },
        },
      ];
    default:
      // Thought summaries, signatures, media, and search deltas stay out of the transcript.
      return [];
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
      return step ? done(stepStartEvents(step, num(ev.index))) : skip(eventId);
    }
    case "step.delta": {
      const delta = record(ev.delta);
      return delta ? done(stepDeltaEvents(delta, record(ev.step), num(ev.index))) : skip(eventId);
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

export const google: Provider = {
  async createAgent(ctx) {
    const c = client(ctx);
    const id = `anyplex-${ctx.agentKey.slice(0, 24)}`;
    const agent = await c.agents
      .create({
        id,
        base_agent: BASE_AGENT,
        system_instruction: ctx.instructions,
        agent_config: { type: "antigravity", model: ctx.model },
      })
      .catch(async (err: unknown) => {
        const existing = await c.agents.get(id).catch(() => null);
        if (existing?.id) return existing;
        throw err;
      });
    if (!agent.id) throw new Error("gemini agent create returned no id");
    return { agentId: agent.id, environmentId: null };
  },

  async createSession(ctx, ids, prompt) {
    const interaction = await client(ctx).interactions.create({
      agent: ids.agentId,
      input: prompt,
      environment: "remote",
      background: true,
      stream: false,
    });
    return interaction.id;
  },

  async *follow(ctx, ref, signal) {
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

  async stop(ctx, ref, reason) {
    if (reason === "kill" || reason === "budget_exceeded")
      await client(ctx).interactions.cancel(ref.sessionId).catch(ignore);
  },
};
