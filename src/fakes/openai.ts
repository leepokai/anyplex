// Fake OpenAI Agents API upstream (public beta 2026-09-10): /agents, /agents/sessions, session
// events (POST input, GET SSE stream), items, turns, artifacts. Point a BYOK base URL at
// `${url}/v1`. Quirks follow live traffic of 2026-09-13: turn events carry `usage: null` and
// usage lands on the turn and session objects later; deleting a session whose turn is still
// cancelling is refused.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, sleep, type Timeline } from "./timeline.ts";

export interface FakeOpenAIOptions {
  /** Pause between session events. Default 30. */
  eventDelayMs?: number;
  /** Token usage reported per turn. Defaults 1000 / 200 / 0 cached. */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Command executions per turn. Default 1. */
  toolCalls?: number;
  /** Name of a function (client) tool the agent calls once per turn. */
  functionTool?: string;
  /** How long after a turn completes before usage appears on the turn (half) and session (full). Default 0. */
  usageDelayMs?: number;
  /** Refuse DELETE while a turn is in progress, like the live API. Default true. */
  refuseDeleteWhileInProgress?: boolean;
}

export interface FakeOpenAISession {
  id: string;
  agentId: string;
  environment: Record<string, unknown>;
  status: "in_progress" | "idle" | "failed" | "requires_action";
  items: Record<string, unknown>[];
  turns: Record<string, unknown>[];
  turnUsage: Map<string, Record<string, unknown>>;
  usageAvailableAt: number;
  turnCount: number;
  requiredActions: Record<string, unknown>[];
  pendingTool: { callId: string; turnId: string; output: string | null } | null;
  artifacts: { id: string; path: string; bytes: Uint8Array; turnId: string }[];
  cancelled: boolean;
  deleted: boolean;
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeOpenAIState {
  agents: Record<string, unknown>[];
  sessions: Map<string, FakeOpenAISession>;
}

const epoch = () => Math.floor(Date.now() / 1000);

export function createFakeOpenAI(options: FakeOpenAIOptions = {}) {
  const eventDelayMs = options.eventDelayMs ?? 30;
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 200;
  const cachedTokens = options.cachedTokens ?? 0;
  const toolCalls = options.toolCalls ?? 1;
  const usageDelayMs = options.usageDelayMs ?? 0;
  const refuseDelete = options.refuseDeleteWhileInProgress ?? true;
  const state: FakeOpenAIState = { agents: [], sessions: new Map() };
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

  const usageJson = (turns: number) => ({
    input_tokens: inputTokens * turns,
    input_tokens_details: { cached_tokens: cachedTokens * turns },
    output_tokens: outputTokens * turns,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: (inputTokens + outputTokens) * turns,
  });
  const sessionUsage = (session: FakeOpenAISession) =>
    session.turnCount > 0 && Date.now() >= session.usageAvailableAt
      ? usageJson(session.turnCount)
      : null;
  const turnJson = (session: FakeOpenAISession, turn: Record<string, unknown>) => ({
    ...turn,
    usage:
      turn.status === "completed" && Date.now() >= session.usageAvailableAt - usageDelayMs / 2
        ? usageJson(1)
        : null,
  });
  const sessionJson = (session: FakeOpenAISession) => ({
    id: session.id,
    object: "agent.session",
    agent: { id: session.agentId, version: 1 },
    created_at: epoch(),
    last_active_at: epoch(),
    environment: { id: `ccarenv_${session.id}`, ...session.environment },
    error: null,
    metadata: {},
    required_actions: session.requiredActions,
    status: session.status,
    usage: sessionUsage(session),
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
  const waitFor = async (session: FakeOpenAISession, ready: () => boolean) => {
    for (let i = 0; i < 6000 && !ready() && !session.cancelled; i += 1) await sleep(20);
  };

  const runTurn = async (session: FakeOpenAISession) => {
    const emit = async (type: string, data: Record<string, unknown>) => {
      session.timeline.push({ type, event_id: fakeId("evt"), ...data });
      await sleep(eventDelayMs);
    };
    const turnNo = ++session.turnCount;
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
    await item(message(`(fake openai agent) turn ${turnNo} starting`, "commentary"));
    if (options.functionTool) {
      const callId = fakeId("call");
      session.pendingTool = { callId, turnId: turn.id as string, output: null };
      await item({
        id: fakeId("fc"),
        type: "function_call",
        status: "in_progress",
        turn_id: turn.id,
        call_id: callId,
        name: options.functionTool,
        arguments: JSON.stringify({ query: "fake" }),
      });
      session.status = "requires_action";
      session.requiredActions = [
        {
          type: "function_call",
          call_id: callId,
          name: options.functionTool,
          arguments: { query: "fake" },
          turn_id: turn.id,
        },
      ];
      await emit("agent.session.requires_action", { session: sessionJson(session) });
      await waitFor(session, () => session.pendingTool?.output !== null);
      if (session.cancelled) return finishCancelled();
      session.status = "in_progress";
      session.requiredActions = [];
      await emit("agent.session.in_progress", { session: sessionJson(session) });
      await item(
        message(`(fake openai agent) tool said: ${session.pendingTool?.output}`, "commentary"),
      );
      session.pendingTool = null;
    }
    for (let step = 1; step <= toolCalls; step += 1) {
      if (session.cancelled) break;
      await item({
        id: `exec-${fakeId("cmd")}`,
        type: "command_execution",
        status: "completed",
        turn_id: turn.id,
        command: `/bin/bash -lc 'echo turn ${turnNo} step ${step}'`,
        cwd: "/workspace",
        exit_code: 0,
        duration_ms: 5,
        output: `turn ${turnNo} step ${step}\n`,
      });
    }
    async function finishCancelled() {
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
    }
    if (session.cancelled) return finishCancelled();
    await item(message(`(fake openai agent) turn ${turnNo} done`, "final_answer"));
    session.artifacts.push({
      id: fakeId("artifact"),
      path: `/workspace/outputs/result-${turnNo}.txt`,
      bytes: new TextEncoder().encode(`turn ${turnNo} output\n`),
      turnId: turn.id as string,
    });
    turn.status = "completed";
    turn.completed_at = epoch();
    // Like the live API: the turn event says usage: null; the objects fill in later.
    session.usageAvailableAt = Date.now() + usageDelayMs;
    await emit("agent.session.turn.completed", {
      session_id: session.id,
      turn,
      turn_id: turn.id,
      usage: null,
    });
    session.status = "idle";
    await emit("agent.session.idle", { session: sessionJson(session) });
  };

  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agent = {
      id: fakeId("agent"),
      object: "agent",
      created_at: epoch(),
      metadata: {},
      tools: [],
      ...body,
    };
    state.agents.push(agent);
    return c.json(agent);
  });

  app.post("/v1/agents/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const session: FakeOpenAISession = {
      id: fakeId("sess"),
      agentId: typeof body.agent_id === "string" ? body.agent_id : "agent_unknown",
      environment: (body.environment as Record<string, unknown>) ?? { type: "none" },
      status: "idle",
      items: [],
      turns: [],
      turnUsage: new Map(),
      usageAvailableAt: Number.POSITIVE_INFINITY,
      turnCount: 0,
      requiredActions: [],
      pendingTool: null,
      artifacts: [],
      cancelled: false,
      deleted: false,
      timeline: createTimeline(),
    };
    state.sessions.set(session.id, session);
    if (body.input) {
      const input = Array.isArray(body.input)
        ? body.input
        : [{ role: "user", content: [{ type: "input_text", text: String(body.input) }] }];
      for (const message of input as Record<string, unknown>[])
        session.items.push({
          id: fakeId("msg"),
          type: "message",
          role: "user",
          status: "completed",
          phase: null,
          turn_id: null,
          content: message.content,
        });
      void runTurn(session);
    }
    return c.json(sessionJson(session));
  });

  app.get("/v1/agents/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json(sessionJson(session)) : notFound(c);
  });

  app.delete("/v1/agents/sessions/:id", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    if (refuseDelete && session.status === "in_progress")
      return c.json(
        {
          error: {
            message: "Cannot delete a session with an active turn",
            type: "invalid_request_error",
            code: "session_active",
            param: null,
          },
        },
        400,
      );
    session.deleted = true;
    session.cancelled = true;
    session.timeline.finish();
    return c.json({ id: session.id, object: "agent.session.deleted", deleted: true });
  });

  app.post("/v1/agents/sessions/:id/events", async (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { events?: Record<string, unknown>[] };
    for (const event of body.events ?? []) {
      if (event.type === "agent.session.input.message" && session.status === "idle") {
        for (const message of (event.input as Record<string, unknown>[]) ?? [])
          session.items.push({
            id: fakeId("msg"),
            type: "message",
            role: "user",
            status: "completed",
            phase: null,
            turn_id: null,
            content: message.content,
          });
        void runTurn(session);
      }
      if (event.type === "agent.session.input.cancel") session.cancelled = true;
      const tool = session.pendingTool;
      if (tool && event.type === "agent.session.input.tool_result" && tool.callId === event.call_id)
        tool.output = String(event.error ?? event.output ?? "");
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
    return session
      ? c.json({
          object: "list",
          data: session.turns.map((turn) => turnJson(session, turn)),
          has_more: false,
        })
      : notFound(c);
  });

  app.get("/v1/agents/sessions/:id/items", (c) => {
    const session = findSession(c.req.param("id"));
    return session ? c.json({ object: "list", data: session.items, has_more: false }) : notFound(c);
  });

  app.get("/v1/agents/sessions/:id/artifacts", (c) => {
    const session = findSession(c.req.param("id"));
    if (!session) return notFound(c);
    return c.json({
      object: "list",
      data: session.artifacts.map((artifact) => ({
        id: artifact.id,
        object: "agent.session.artifact",
        created_at: epoch(),
        environment_id: `ccarenv_${session.id}`,
        path: artifact.path,
        session_id: session.id,
        size_bytes: artifact.bytes.byteLength,
        turn_id: artifact.turnId,
      })),
      has_more: false,
    });
  });

  app.get("/v1/agents/sessions/:id/artifacts/:artifactId/content", (c) => {
    const session = findSession(c.req.param("id"));
    const artifact = session?.artifacts.find((a) => a.id === c.req.param("artifactId"));
    if (!artifact) return notFound(c);
    return c.body(artifact.bytes as unknown as ArrayBuffer, 200, {
      "content-type": "application/octet-stream",
    });
  });

  return { app, state };
}

export async function startFakeOpenAI(
  options: FakeOpenAIOptions = {},
): Promise<FakeServer<FakeOpenAIState>> {
  const { app, state } = createFakeOpenAI(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
