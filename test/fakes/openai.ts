// Fake OpenAI Agents API upstream (public beta 2026-09-10) so sessions can be exercised
// without a key. Shapes follow the `openai` SDK: /agents, /agents/sessions, session
// events (POST input, GET SSE stream), items and turns lists. Point a BYOK key's base_url at
// `${url}/v1`.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, sleep, type Timeline } from "./timeline.ts";

export interface FakeOpenAIAgentsOptions {
  /** Pause between session events. Default 30. */
  eventDelayMs?: number;
  /** Token usage reported on the turn. Defaults 1000 / 200 / 0 cached. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Command executions per turn. Default 1. */
  toolCalls?: number;
}

export interface FakeOpenAISession {
  id: string;
  agentId: string;
  status: "in_progress" | "idle" | "failed" | "requires_action";
  items: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  usage: Record<string, unknown> | null;
  cancelled: boolean;
  deleted: boolean;
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeOpenAIAgentsState {
  agents: Record<string, unknown>[];
  sessions: Map<string, FakeOpenAISession>;
}

const epoch = () => Math.floor(Date.now() / 1000);

export function createFakeOpenAIAgents(options: FakeOpenAIAgentsOptions = {}) {
  const eventDelayMs = options.eventDelayMs ?? 30;
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 200;
  const cachedTokens = options.cachedTokens ?? 0;
  const toolCalls = options.toolCalls ?? 1;
  const state: FakeOpenAIAgentsState = { agents: [], sessions: new Map() };
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!c.req.header("authorization")?.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            message: "Missing bearer token",
            type: "invalid_request_error",
            code: null,
            param: null,
          },
        },
        401,
      );
    }
    await next();
  });

  const usageJson = () => ({
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  });
  const sessionJson = (session: FakeOpenAISession) => ({
    id: session.id,
    object: "agent.session",
    agent: { id: session.agentId, version: 1 },
    created_at: epoch(),
    last_active_at: epoch(),
    environment: { type: "openai_hosted" },
    error: null,
    metadata: {},
    required_actions: [],
    status: session.status,
    usage: session.usage,
    vault_ids: [],
  });
  const findSession = (id: string) => {
    const session = state.sessions.get(id);
    return session && !session.deleted ? session : null;
  };
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) =>
    c.json(
      {
        error: {
          message: "No such session",
          type: "invalid_request_error",
          code: "not_found",
          param: null,
        },
      },
      404,
    );

  const runTurn = async (session: FakeOpenAISession) => {
    const emit = async (type: string, data: Record<string, unknown>) => {
      session.timeline.push({ type, event_id: fakeId("evt"), ...data });
      await sleep(eventDelayMs);
    };
    const turn: Record<string, unknown> = {
      id: fakeId("turn"),
      object: "agent.session.turn",
      agent_id: session.agentId,
      session_id: session.id,
      status: "in_progress",
      usage: null,
      error: null,
      subagent_id: null,
      created_at: epoch(),
      started_at: epoch(),
      completed_at: null,
    };
    session.turns.push(turn);
    session.status = "in_progress";
    await emit("agent.session.turn.created", { session_id: session.id, turn, turn_id: turn.id });
    await emit("agent.session.in_progress", { session: sessionJson(session) });
    const item = async (value: Record<string, unknown>) => {
      session.items.push(value);
      await emit("agent.session.turn.item.done", {
        item: value,
        output_index: session.items.length - 1,
        session_id: session.id,
        turn_id: turn.id,
      });
    };
    const message = (text: string, phase: "commentary" | "final_answer") => ({
      id: fakeId("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      phase,
      turn_id: turn.id,
      content: [{ type: "output_text", text }],
    });
    await item(message("(fake openai agent) starting the task", "commentary"));
    for (let step = 1; step <= toolCalls; step += 1) {
      if (session.cancelled) break;
      await item({
        id: fakeId("cmd"),
        type: "command_execution",
        status: "completed",
        turn_id: turn.id,
        command: `echo step ${step}`,
        cwd: "/workspace",
        exit_code: 0,
        duration_ms: 5,
        output: `step ${step}\n`,
      });
    }
    if (session.cancelled) {
      turn.status = "cancelled";
      turn.completed_at = epoch();
      await emit("agent.session.turn.cancelled", {
        session_id: session.id,
        turn,
        turn_id: turn.id,
        usage: null,
      });
      session.status = "idle";
      await emit("agent.session.idle", { session: sessionJson(session) });
      session.timeline.finish();
      return;
    }
    await item(message("(fake openai agent) done", "final_answer"));
    turn.status = "completed";
    turn.usage = usageJson();
    turn.completed_at = epoch();
    session.usage = usageJson();
    await emit("agent.session.turn.completed", {
      session_id: session.id,
      turn,
      turn_id: turn.id,
      usage: usageJson(),
    });
    session.status = "idle";
    await emit("agent.session.idle", { session: sessionJson(session) });
    session.timeline.finish();
  };

  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agent = {
      id: fakeId("agent"),
      object: "agent",
      created_at: epoch(),
      model: body.model ?? "gpt-fake",
      instructions: body.instructions ?? null,
      name: body.name ?? null,
      metadata: {},
      tools: [],
    };
    state.agents.push(agent);
    return c.json(agent);
  });

  app.post("/v1/agents/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const session: FakeOpenAISession = {
      id: fakeId("sess"),
      agentId: typeof body.agent_id === "string" ? body.agent_id : "agent_unknown",
      status: "idle",
      items: [],
      turns: [],
      usage: null,
      cancelled: false,
      deleted: false,
      timeline: createTimeline(),
    };
    state.sessions.set(session.id, session);
    if (body.input) void runTurn(session);
    return c.json(sessionJson(session));
  });

  app.get("/v1/agents/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json(sessionJson(session)) : notFound(c);
  });

  app.delete("/v1/agents/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    session.deleted = true;
    session.cancelled = true;
    session.timeline.finish();
    return c.json({ id: session.id, object: "agent.session.deleted", deleted: true });
  });

  app.post("/v1/agents/sessions/:id/events", async (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { events?: { type?: string }[] };
    for (const event of body.events ?? []) {
      if (
        event.type === "agent.session.input.message" &&
        session.status === "idle" &&
        !session.timeline.done
      )
        void runTurn(session);
      if (event.type === "agent.session.input.cancel") session.cancelled = true;
    }
    return c.json({});
  });

  app.get("/v1/agents/sessions/:id/events", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    return streamSSE(c, async (s) => {
      const closed = new AbortController();
      s.onAbort(() => closed.abort());
      for await (const { event } of session.timeline.from(
        session.timeline.events.length,
        closed.signal,
      ))
        await s.writeSSE({ data: JSON.stringify(event) });
      if (!closed.signal.aborted) await s.writeSSE({ data: "[DONE]" });
    });
  });

  app.get("/v1/agents/sessions/:id/turns", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json({ object: "list", data: session.turns, has_more: false }) : notFound(c);
  });

  app.get("/v1/agents/sessions/:id/items", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json({ object: "list", data: session.items, has_more: false }) : notFound(c);
  });

  return { app, state };
}

export async function startFakeOpenAI(
  options: FakeOpenAIAgentsOptions = {},
): Promise<FakeServer<FakeOpenAIAgentsState>> {
  const { app, state } = createFakeOpenAIAgents(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
