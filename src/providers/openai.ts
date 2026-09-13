// OpenAI Agents API (public beta 2026-09-10): persistent Agent per definition, one Session per
// run on the `openai_hosted` environment. Verified live 2026-09-13 with gpt-6-astra: turn events
// carry `usage: null`; the turn object fills in ~2 s after idle and the session object ~7 s, so
// spend is polled from the session (falling back to the sum of turns) and the runner waits for it.

import OpenAI from "openai";
import type { Provider } from "../provider.ts";
import {
  CONTINUE,
  num,
  preview,
  type RawEvent,
  record,
  skip,
  str,
  type TokenUsage,
  type Translation,
} from "../types.ts";

export function openaiTokenUsage(raw: unknown): TokenUsage | null {
  const usage = record(raw);
  if (!usage) return null;
  const cached = num(record(usage.input_tokens_details)?.cached_tokens);
  return {
    inputTokens: Math.max(0, num(usage.input_tokens) - cached),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: cached,
  };
}

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => record(part))
    .filter((part) => part?.type === "output_text")
    .map((part) => str(part?.text) ?? "")
    .join("");
}

function itemEvents(item: Record<string, unknown>): RawEvent[] {
  switch (item.type) {
    case "message": {
      if (item.role !== "assistant") return [];
      const text = outputText(item.content);
      return text ? [{ type: "message.delta", payload: { text } }] : [];
    }
    case "function_call":
      return [
        {
          type: "tool.call",
          payload: { id: item.call_id ?? item.id, name: item.name, input: preview(item.arguments) },
        },
      ];
    case "command_execution": {
      const exit = item.exit_code;
      return [
        {
          type: "tool.call",
          payload: {
            id: item.id,
            name: "bash",
            input: { command: item.command, cwd: item.cwd ?? null },
          },
        },
        {
          type: "tool.result",
          payload: {
            id: item.id,
            name: "bash",
            is_error: typeof exit === "number" && exit !== 0,
            content: preview(item.output ?? ""),
          },
        },
      ];
    }
    case "web_search_call":
      return [
        {
          type: "tool.call",
          payload: { id: item.id, name: "web_search", input: preview(item.action) },
        },
      ];
    case "mcp_call":
      return [
        {
          type: "tool.call",
          payload: { id: item.id, name: str(item.name) ?? "mcp", input: preview(item.arguments) },
        },
        ...(item.output === undefined
          ? []
          : [
              {
                type: "tool.result",
                payload: {
                  id: item.id,
                  name: str(item.name) ?? "mcp",
                  is_error: item.error != null,
                  content: preview(item.output),
                },
              },
            ]),
      ];
    case "reasoning":
      return [];
    default:
      return [
        {
          type: "harness.event",
          payload: { type: `item.${String(item.type)}`, item: preview(item) },
        },
      ];
  }
}

export function translateOpenAI(raw: unknown): Translation {
  const ev = record(raw);
  if (!ev) return skip();
  const type = str(ev.type) ?? "";
  const eventId = str(ev.event_id);
  const done = (
    upstreamId: string | null,
    events: RawEvent[],
    extra: Partial<Translation> = {},
  ): Translation => ({ upstreamId, events, outcome: CONTINUE, ...extra });

  switch (type) {
    case "agent.session.turn.item.done": {
      const item = record(ev.item);
      if (!item) return skip(eventId);
      return done(str(item.id) ?? eventId, itemEvents(item));
    }
    case "agent.session.turn.completed": {
      const turnId = str(ev.turn_id) ?? eventId;
      return done(
        turnId,
        [{ type: "harness.event", payload: { type, turn_id: turnId, usage: ev.usage ?? null } }],
        { pollSpend: true },
      );
    }
    case "agent.session.turn.failed": {
      const turnId = str(ev.turn_id) ?? eventId;
      const error = record(record(ev.turn)?.error);
      const code = str(error?.code);
      const message = str(error?.message) ?? "managed agent turn failed";
      return done(
        turnId,
        [{ type: "harness.event", payload: { type, turn_id: turnId, error: message, code } }],
        {
          pollSpend: true,
          outcome:
            code === "session_budget_exceeded" || code === "usage_limit_exceeded"
              ? { kind: "budget_exceeded" }
              : { kind: "failed", error: message },
        },
      );
    }
    case "agent.session.turn.cancelled": {
      const turnId = str(ev.turn_id) ?? eventId;
      return done(turnId, [{ type: "harness.event", payload: { type, turn_id: turnId } }], {
        pollSpend: true,
        outcome: { kind: "terminated" },
      });
    }
    case "agent.session.idle":
    case "agent.session.requires_action":
    case "agent.session.failed": {
      const session = record(ev.session);
      const sessionId = str(session?.id) ?? str(ev.session_id) ?? "session";
      const status = type.slice("agent.session.".length);
      const events: RawEvent[] = [{ type: "harness.event", payload: { type, status } }];
      const key = `${sessionId}:${status}`;
      if (type === "agent.session.idle")
        return done(key, events, { pollSpend: true, outcome: { kind: "completed" } });
      if (type === "agent.session.requires_action")
        return done(key, events, { pollSpend: true, outcome: { kind: "requires_action" } });
      const error = str(session?.error) ?? "managed agent session failed";
      return done(key, events, { pollSpend: true, outcome: { kind: "failed", error } });
    }
    case "error": {
      const message = str(record(ev.error)?.message) ?? "managed agent error";
      return done(eventId, [{ type: "harness.event", payload: { type, error: message } }], {
        outcome: { kind: "failed", error: message },
      });
    }
    case "agent.session.created":
    case "agent.session.in_progress":
    case "agent.session.turn.created":
      return done(eventId, [{ type: "harness.event", payload: { type } }]);
    default:
      if (
        type.startsWith("agent.session.environment.") ||
        type.startsWith("agent.session.subagent.")
      )
        return done(eventId, [{ type: "harness.event", payload: { type } }]);
      // Text, reasoning, and command-output deltas duplicate the finished items above.
      return skip(eventId);
  }
}

const client = (ctx: { apiKey: string; baseUrl: string | null }) =>
  new OpenAI({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl ?? undefined, maxRetries: 2 });
const ignore = () => undefined;
const TERMINAL_TURN = new Set(["completed", "failed", "cancelled"]);
const nonZero = (usage: TokenUsage | null) =>
  usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) > 0 ? usage : null;

export const openai: Provider = {
  async createAgent(ctx, signal) {
    const agent = await client(ctx).beta.agents.create(
      {
        model: ctx.model,
        name: `anyplex-${ctx.agentKey.slice(0, 12)}`,
        instructions: ctx.instructions,
      },
      { signal },
    );
    return { agentId: agent.id, environmentId: null };
  },

  async createSession(ctx, ids, prompt, signal) {
    const session = await client(ctx).beta.agents.sessions.create(
      {
        agent_id: ids.agentId,
        environment: { type: "openai_hosted" },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
      },
      { signal },
    );
    return session.id;
  },

  async *follow(ctx, ref, signal) {
    const c = client(ctx);
    const id = ref.sessionId;
    const stream = await c.beta.agents.sessions.events.stream(id, { signal });
    try {
      // History is reconstructed from items and turns (the event stream itself has no replay).
      for await (const item of c.beta.agents.sessions.items.list(id, { order: "asc" }, { signal }))
        yield {
          type: "agent.session.turn.item.done",
          event_id: item.id ?? "",
          item,
          output_index: 0,
          session_id: id,
          turn_id: item.turn_id ?? null,
        };
      const turns = [];
      for await (const turn of c.beta.agents.sessions.turns.list(
        id,
        { order: "asc" },
        { signal },
      )) {
        turns.push(turn);
        if (TERMINAL_TURN.has(turn.status))
          yield {
            type: `agent.session.turn.${turn.status}`,
            event_id: turn.id,
            session_id: id,
            turn,
            turn_id: turn.id,
            usage: turn.usage,
          };
      }
      const session = await c.beta.agents.sessions.retrieve(id, { signal });
      const settled = turns.length > 0 && turns.every((turn) => TERMINAL_TURN.has(turn.status));
      if (settled && session.status !== "in_progress") {
        yield {
          type: `agent.session.${session.status}`,
          event_id: `${id}:${session.status}`,
          session,
        };
        return;
      }
      for await (const event of stream) yield event;
    } finally {
      stream.controller.abort();
    }
  },

  translate: translateOpenAI,

  async pollSpend(ctx, ref, signal) {
    const c = client(ctx);
    const session = await c.beta.agents.sessions.retrieve(ref.sessionId, { signal });
    const fromSession = nonZero(openaiTokenUsage(session.usage));
    if (fromSession) return { kind: "tokens_total", usage: fromSession };
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    for await (const turn of c.beta.agents.sessions.turns.list(ref.sessionId, {}, { signal })) {
      const usage = nonZero(openaiTokenUsage(turn.usage));
      if (!usage) continue;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    }
    return nonZero(total) ? { kind: "tokens_total", usage: total } : null;
  },

  async stop(ctx, ref, reason) {
    const c = client(ctx);
    if (reason === "kill" || reason === "budget_exceeded")
      await c.beta.agents.sessions.events
        .create(ref.sessionId, { events: [{ type: "agent.session.input.cancel" }] })
        .catch(ignore);
    await c.beta.agents.sessions.delete(ref.sessionId).catch(ignore);
  },
};
