// Claude Managed Agents (beta managed-agents-2026-04-01): agent + environment once per
// definition, one session per run. The SDK's SSE parser drops `session.usage`, so the
// authoritative spend is polled from the session object after every model request and at the end.

import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../provider.ts";
import {
  CONTINUE,
  num,
  preview,
  type RawEvent,
  record,
  skip,
  str,
  type Translation,
} from "../types.ts";

/** USD -> Managed Agents budget amount: integer cents as a string ("0.30" -> "30"); at least one cent. */
export function usdToCents(usd: number): string {
  return String(Math.max(1, Math.round(usd * 100)));
}

/** `{ amount, currency }` where amount is integer minor units as a string; tolerates a decimal dollar string. */
export function parseListCostUsd(listCost: unknown): number | null {
  const amount = record(listCost)?.amount;
  const raw = typeof amount === "number" ? String(amount) : amount;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return raw.includes(".") ? n : n / 100;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => record(block))
    .filter((block) => block?.type === "text")
    .map((block) => str(block?.text))
    .filter((text): text is string => text !== null);
}

export function translateAnthropic(raw: unknown): Translation {
  const ev = record(raw);
  if (!ev) return skip();
  const type = str(ev.type) ?? "";
  const id = str(ev.id);
  const done = (events: RawEvent[], extra: Partial<Translation> = {}): Translation => ({
    upstreamId: id,
    events,
    outcome: CONTINUE,
    ...extra,
  });

  switch (type) {
    case "agent.message":
      return done(
        textBlocks(ev.content).map((text) => ({ type: "message.delta", payload: { text } })),
      );
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use":
      return done([
        {
          type: "tool.call",
          payload: {
            id: ev.id,
            name: ev.name,
            input: preview(ev.input),
            source:
              type === "agent.tool_use"
                ? "builtin"
                : type === "agent.mcp_tool_use"
                  ? "mcp"
                  : "custom",
          },
        },
      ]);
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return done([
        {
          type: "tool.result",
          payload: {
            id: ev.tool_use_id,
            is_error: ev.is_error === true,
            content: preview(ev.content),
          },
        },
      ]);
    case "session.usage": {
      const usage = record(ev.usage) ?? ev;
      const totalUsd = parseListCostUsd(usage.list_cost);
      return done(
        [
          {
            type: "harness.event",
            payload: { type, list_cost_usd: totalUsd, active_seconds: num(usage.active_seconds) },
          },
        ],
        totalUsd === null ? {} : { spend: { kind: "list_cost_usd", totalUsd } },
      );
    }
    case "span.model_request_end":
      return done(
        [{ type: "harness.event", payload: { type, model_usage: ev.model_usage ?? null } }],
        { pollSpend: true },
      );
    case "session.status_running":
      return done([{ type: "harness.event", payload: { type } }]);
    case "session.status_idle": {
      const reason = str(record(ev.stop_reason)?.type) ?? "end_turn";
      const status: RawEvent = { type: "harness.event", payload: { type, stop_reason: reason } };
      if (reason === "requires_action")
        return done([status], { outcome: { kind: "requires_action" }, pollSpend: true });
      if (reason === "budget_reached")
        return done([status], { outcome: { kind: "budget_exceeded" }, pollSpend: true });
      if (reason === "retries_exhausted")
        return done([status], {
          outcome: { kind: "failed", error: "managed agent: retries_exhausted" },
          pollSpend: true,
        });
      return done([status], { outcome: { kind: "completed" }, pollSpend: true });
    }
    case "session.status_terminated":
    case "session.deleted":
      return done([{ type: "harness.event", payload: { type } }], {
        outcome: { kind: "terminated" },
      });
    case "session.error": {
      const error = record(ev.error);
      const message = str(error?.message) ?? str(ev.message) ?? "managed agent session error";
      return done([{ type: "harness.event", payload: { type, error: message } }], {
        outcome: { kind: "failed", error: message },
      });
    }
    default:
      // User event echoes, live-preview deltas, thread and span starts stay out of the transcript.
      return skip(id);
  }
}

const client = (ctx: { apiKey: string; baseUrl: string | null }) =>
  new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl ?? undefined, maxRetries: 2 });
const ignore = () => undefined;

export const anthropic: Provider = {
  async createAgent(ctx, signal) {
    const c = client(ctx);
    const label = `anyplex-${ctx.agentKey.slice(0, 12)}`;
    const environment = await c.beta.environments.create(
      { name: label, config: { type: "cloud" } },
      { signal },
    );
    const agent = await c.beta.agents.create(
      {
        name: label,
        model: ctx.model,
        system: ctx.instructions,
        tools: [{ type: "agent_toolset_20260401" }],
      },
      { signal },
    );
    return { agentId: agent.id, environmentId: environment.id };
  },

  async createSession(ctx, ids, prompt, signal) {
    if (!ids.environmentId) throw new Error("anthropic managed agent needs an environment");
    const session = await client(ctx).beta.sessions.create(
      {
        agent: { type: "agent", id: ids.agentId },
        environment_id: ids.environmentId,
        title: `anyplex ${new Date().toISOString()}`,
        ...(ctx.remainingBudgetUsd === null
          ? {}
          : {
              budget: {
                type: "limit",
                max_list_cost: { amount: usdToCents(ctx.remainingBudgetUsd), currency: "USD" },
              },
            }),
        initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      },
      { signal },
    );
    return session.id;
  },

  async *follow(ctx, ref, signal) {
    const c = client(ctx);
    // Stream first, then history: the overlap is what makes the dedupe lossless.
    const stream = await c.beta.sessions.events.stream(ref.sessionId, {}, { signal });
    try {
      for await (const event of c.beta.sessions.events.list(
        ref.sessionId,
        { order: "asc" },
        { signal },
      ))
        yield event;
      for await (const event of stream) yield event;
    } finally {
      stream.controller.abort();
    }
  },

  translate: translateAnthropic,

  async pollSpend(ctx, ref, signal) {
    const session = await client(ctx).beta.sessions.retrieve(ref.sessionId, {}, { signal });
    const totalUsd = parseListCostUsd(session.usage?.list_cost);
    return totalUsd === null ? null : { kind: "list_cost_usd", totalUsd };
  },

  async stop(ctx, ref, reason) {
    const c = client(ctx);
    if (reason === "kill" || reason === "budget_exceeded")
      await c.beta.sessions.events
        .send(ref.sessionId, { events: [{ type: "user.interrupt" }] })
        .catch(ignore);
    // Hygiene: a deleted session cannot accrue runtime or be resumed by mistake.
    await c.beta.sessions.delete(ref.sessionId).catch(ignore);
  },
};
