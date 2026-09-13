// Fake Claude Managed Agents upstream: environments, agents, sessions, session events (list,
// send, SSE stream with no replay). A session keeps running whether or not a client is attached.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, now, sleep, type Timeline } from "./timeline.ts";

export interface FakeAnthropicOptions {
  /** List cost of one session turn, in cents. Default 42. */
  turnCents?: number;
  /** bash tool calls per turn. Default 1. */
  toolCalls?: number;
  /** Pause between session events. Default 30. */
  eventDelayMs?: number;
}

export interface FakeManagedSession {
  id: string;
  agentId: string;
  environmentId: string;
  status: "running" | "idle";
  budgetCents: number | null;
  listCostCents: number;
  interrupted: boolean;
  deleted: boolean;
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeAnthropicState {
  sessions: Map<string, FakeManagedSession>;
  agents: Record<string, unknown>[];
}

export function createFakeAnthropic(options: FakeAnthropicOptions = {}) {
  const turnCents = options.turnCents ?? 42;
  const toolCalls = options.toolCalls ?? 1;
  const eventDelayMs = options.eventDelayMs ?? 30;
  const state: FakeAnthropicState = { sessions: new Map(), agents: [] };
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!c.req.header("x-api-key"))
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        401,
      );
    await next();
  });

  const usageJson = (session: FakeManagedSession) => ({
    input_tokens: 1000,
    output_tokens: 500,
    list_cost: { amount: String(session.listCostCents), currency: "USD" },
    active_seconds: 3,
  });
  const sessionJson = (session: FakeManagedSession) => ({
    id: session.id,
    type: "session",
    status: session.status,
    agent: { type: "agent", id: session.agentId, version: 1 },
    environment_id: session.environmentId,
    title: null,
    metadata: {},
    resources: [],
    vault_ids: [],
    archived_at: null,
    outcome_evaluations: [],
    stats: { active_seconds: 3 },
    budget:
      session.budgetCents === null
        ? null
        : {
            type: "limit",
            max_list_cost: { amount: String(session.budgetCents), currency: "USD" },
          },
    usage: usageJson(session),
    created_at: now(),
    updated_at: now(),
  });
  const findSession = (id: string) => {
    const session = state.sessions.get(id);
    return session && !session.deleted ? session : null;
  };
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) =>
    c.json(
      { type: "error", error: { type: "not_found_error", message: "session not found" } },
      404,
    );

  const runTurn = async (session: FakeManagedSession) => {
    const emit = async (type: string, data: Record<string, unknown> = {}) => {
      session.timeline.push({ type, id: fakeId("sevt"), processed_at: now(), ...data });
      await sleep(eventDelayMs);
    };
    const finish = async (reason: string) => {
      session.status = "idle";
      await emit("session.status_idle", { stop_reason: { type: reason } });
      session.timeline.finish();
    };
    session.status = "running";
    await emit("session.status_running");
    await emit("span.model_request_start");
    await emit("agent.message", {
      content: [{ type: "text", text: "(fake managed agent) starting" }],
    });
    for (let step = 1; step <= toolCalls; step += 1) {
      if (session.interrupted) return finish("end_turn");
      const id = `${session.id}_tool_${step}`;
      await emit("agent.tool_use", { id, name: "bash", input: { command: `echo step ${step}` } });
      await emit("agent.tool_result", {
        tool_use_id: id,
        content: [{ type: "text", text: `step ${step}\n` }],
        is_error: false,
      });
    }
    if (session.interrupted) return finish("end_turn");
    // The request that crosses the cap still finishes, so the cost overshoots a little.
    const overBudget = session.budgetCents !== null && session.budgetCents < turnCents;
    session.listCostCents = overBudget ? (session.budgetCents ?? 0) + 3 : turnCents;
    await emit("span.model_request_end", {
      is_error: false,
      model_usage: { input_tokens: 1000, output_tokens: 500 },
    });
    if (overBudget) {
      await emit("session.usage", { usage: usageJson(session) });
      return finish("budget_reached");
    }
    await emit("agent.message", { content: [{ type: "text", text: "(fake managed agent) done" }] });
    await emit("session.usage", { usage: usageJson(session) });
    return finish("end_turn");
  };

  app.post("/v1/environments", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({
      id: fakeId("env"),
      type: "environment",
      name: body.name ?? "fake",
      config: body.config ?? { type: "cloud" },
      created_at: now(),
    });
  });
  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agent = {
      id: fakeId("agent"),
      type: "agent",
      version: 1,
      name: body.name ?? "fake",
      model: body.model ?? "claude-fake",
      created_at: now(),
    };
    state.agents.push(agent);
    return c.json(agent);
  });
  app.post("/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agent = body.agent as { id?: string } | string | undefined;
    const amount = (body.budget as { max_list_cost?: { amount?: string } } | undefined)
      ?.max_list_cost?.amount;
    const session: FakeManagedSession = {
      id: fakeId("sesn"),
      agentId: typeof agent === "string" ? agent : (agent?.id ?? "agent_unknown"),
      environmentId: typeof body.environment_id === "string" ? body.environment_id : "env_unknown",
      status: "idle",
      budgetCents: typeof amount === "string" ? Number(amount) : null,
      listCostCents: 0,
      interrupted: false,
      deleted: false,
      timeline: createTimeline(),
    };
    state.sessions.set(session.id, session);
    const initial = Array.isArray(body.initial_events)
      ? (body.initial_events as { type?: string }[])
      : [];
    if (initial.some((event) => event.type === "user.message")) void runTurn(session);
    return c.json(sessionJson(session));
  });
  app.get("/v1/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json(sessionJson(session)) : notFound(c);
  });
  app.delete("/v1/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    session.deleted = true;
    session.interrupted = true;
    session.timeline.finish();
    return c.json({ id: session.id, type: "session_deleted" });
  });
  app.post("/v1/sessions/:id/events", async (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { events?: { type?: string }[] };
    for (const event of body.events ?? []) {
      if (event.type === "user.message" && session.status === "idle" && !session.timeline.done)
        void runTurn(session);
      if (event.type === "user.interrupt") session.interrupted = true;
    }
    return c.json({
      events: (body.events ?? []).map((event) => ({
        ...event,
        id: fakeId("sevt"),
        processed_at: now(),
      })),
    });
  });
  app.get("/v1/sessions/:id/events", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    const data = session.timeline.events;
    return c.json({
      data,
      has_more: false,
      first_id: (data[0]?.id as string | undefined) ?? null,
      last_id: (data.at(-1)?.id as string | undefined) ?? null,
    });
  });
  app.get("/v1/sessions/:id/events/stream", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    return streamSSE(c, async (s) => {
      const closed = new AbortController();
      s.onAbort(() => closed.abort());
      // No replay: only events that happen after the connection is open.
      for await (const { event } of session.timeline.from(
        session.timeline.events.length,
        closed.signal,
      ))
        await s.writeSSE({ event: event.type as string, data: JSON.stringify(event) });
    });
  });

  return { app, state };
}

export async function startFakeAnthropic(
  options: FakeAnthropicOptions = {},
): Promise<FakeServer<FakeAnthropicState>> {
  const { app, state } = createFakeAnthropic(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
