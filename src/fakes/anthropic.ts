// Fake Claude Managed Agents upstream: environments, agents, vaults, files, sessions, session
// events (list, send, SSE stream with no replay). A session is a timeline that keeps running
// whether or not a client is attached. Shapes and quirks follow live traffic of 2026-09-13:
// the session object's usage stays at zero until a turn ends, list cost is whole cents, and
// `session.usage` is the settled figure for the turn.

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
  /** Name of a custom (client) tool the agent calls once in its first turn. */
  customTool?: string;
  /** The first built-in tool call asks for confirmation (`evaluated_permission: "ask"`). */
  askPermission?: boolean;
}

export interface FakeManagedSession {
  id: string;
  agentId: string;
  environmentId: string;
  status: "running" | "idle";
  budgetCents: number | null;
  listCostCents: number;
  turns: number;
  interrupted: boolean;
  deleted: boolean;
  resources: unknown[];
  vaultIds: string[];
  /** Pending custom tool call, answered by user.custom_tool_result. */
  pendingTool: { id: string; result: string | null } | null;
  /** Pending confirmation, answered by user.tool_confirmation. */
  pendingConfirmation: { id: string; result: "allow" | "deny" | null } | null;
  artifacts: { id: string; filename: string; bytes: Uint8Array }[];
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeAnthropicState {
  sessions: Map<string, FakeManagedSession>;
  agents: Record<string, unknown>[];
  environments: Record<string, unknown>[];
  vaults: Record<string, unknown>[];
  credentials: Record<string, unknown>[];
  uploads: { id: string; filename: string; bytes: number }[];
}

export function createFakeAnthropic(options: FakeAnthropicOptions = {}) {
  const turnCents = options.turnCents ?? 42;
  const toolCalls = options.toolCalls ?? 1;
  const eventDelayMs = options.eventDelayMs ?? 30;
  const state: FakeAnthropicState = {
    sessions: new Map(),
    agents: [],
    environments: [],
    vaults: [],
    credentials: [],
    uploads: [],
  };
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
    input_tokens: 1000 * session.turns,
    output_tokens: 500 * session.turns,
    list_cost: { amount: String(session.listCostCents), currency: "USD" },
    active_seconds: 3 * session.turns,
  });
  const sessionJson = (session: FakeManagedSession) => ({
    id: session.id,
    type: "session",
    status: session.status,
    agent: { type: "agent", id: session.agentId, version: 1 },
    environment_id: session.environmentId,
    title: null,
    metadata: {},
    resources: session.resources,
    vault_ids: session.vaultIds,
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
  const waitFor = async (session: FakeManagedSession, ready: () => boolean) => {
    for (let i = 0; i < 6000 && !ready() && !session.interrupted; i += 1) await sleep(20);
  };

  const runTurn = async (session: FakeManagedSession) => {
    const turn = ++session.turns;
    const emit = async (type: string, data: Record<string, unknown> = {}) => {
      session.timeline.push({ type, id: fakeId("sevt"), processed_at: now(), ...data });
      await sleep(eventDelayMs);
    };
    const idle = async (reason: string) => {
      session.status = "idle";
      await emit("session.status_idle", { stop_reason: { type: reason } });
    };
    session.status = "running";
    await emit("session.status_running");
    await emit("span.model_request_start");
    await emit("agent.message", {
      content: [{ type: "text", text: `(fake managed agent) turn ${turn} starting` }],
    });
    if (options.customTool && turn === 1) {
      const id = `${session.id}_custom_1`;
      session.pendingTool = { id, result: null };
      await emit("agent.custom_tool_use", {
        id,
        name: options.customTool,
        input: { query: "fake" },
      });
      await idle("requires_action");
      await waitFor(session, () => session.pendingTool?.result !== null);
      if (session.interrupted) return idle("end_turn");
      session.status = "running";
      await emit("session.status_running");
      await emit("agent.message", {
        content: [
          { type: "text", text: `(fake managed agent) tool said: ${session.pendingTool?.result}` },
        ],
      });
      session.pendingTool = null;
    }
    for (let step = 1; step <= toolCalls; step += 1) {
      if (session.interrupted) return idle("end_turn");
      const id = `${session.id}_t${turn}_tool_${step}`;
      const ask = options.askPermission && turn === 1 && step === 1;
      await emit("agent.tool_use", {
        id,
        name: "bash",
        input: { command: `echo turn ${turn} step ${step}` },
        ...(ask ? { evaluated_permission: "ask" } : {}),
      });
      if (ask) {
        session.pendingConfirmation = { id, result: null };
        await idle("requires_action");
        await waitFor(session, () => session.pendingConfirmation?.result !== null);
        if (session.interrupted) return idle("end_turn");
        session.status = "running";
        await emit("session.status_running");
        if (session.pendingConfirmation?.result === "deny") {
          await emit("agent.tool_result", {
            tool_use_id: id,
            content: [{ type: "text", text: "denied by user" }],
            is_error: true,
          });
          session.pendingConfirmation = null;
          continue;
        }
        session.pendingConfirmation = null;
      }
      await emit("agent.tool_result", {
        tool_use_id: id,
        content: [{ type: "text", text: `turn ${turn} step ${step}\n` }],
        is_error: false,
      });
    }
    if (session.interrupted) return idle("end_turn");
    // Like the live API, the session object learns the cost only when the turn ends; the request
    // that crosses the cap still finishes, so the cost overshoots a little.
    const overBudget =
      session.budgetCents !== null && session.budgetCents < session.listCostCents + turnCents;
    session.listCostCents = overBudget
      ? (session.budgetCents ?? 0) + 3
      : session.listCostCents + turnCents;
    await emit("span.model_request_end", {
      is_error: false,
      model_usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const bytes = new TextEncoder().encode(`turn ${turn} output\n`);
    session.artifacts.push({ id: fakeId("file"), filename: `output-${turn}.txt`, bytes });
    if (overBudget) {
      await emit("session.usage", { usage: usageJson(session) });
      return idle("budget_reached");
    }
    await emit("agent.message", {
      content: [{ type: "text", text: `(fake managed agent) turn ${turn} done` }],
    });
    await emit("session.usage", { usage: usageJson(session) });
    return idle("end_turn");
  };

  app.post("/v1/environments", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const environment = { id: fakeId("env"), type: "environment", created_at: now(), ...body };
    state.environments.push(environment);
    return c.json(environment);
  });
  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agent = { id: fakeId("agent"), type: "agent", version: 1, created_at: now(), ...body };
    state.agents.push(agent);
    return c.json(agent);
  });
  app.post("/v1/vaults", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const vault = { id: fakeId("vault"), type: "vault", created_at: now(), ...body };
    state.vaults.push(vault);
    return c.json(vault);
  });
  app.post("/v1/vaults/:id/credentials", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const credential = {
      id: fakeId("cred"),
      type: "credential",
      vault_id: c.req.param("id"),
      created_at: now(),
      ...body,
    };
    state.credentials.push(credential);
    return c.json(credential);
  });
  app.post("/v1/files", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    const upload =
      file instanceof File
        ? { id: fakeId("file"), filename: file.name, bytes: file.size }
        : { id: fakeId("file"), filename: "upload", bytes: 0 };
    state.uploads.push(upload);
    return c.json({
      id: upload.id,
      type: "file",
      filename: upload.filename,
      size_bytes: upload.bytes,
      mime_type: "text/plain",
      created_at: now(),
      downloadable: false,
    });
  });
  app.get("/v1/files", (c) => {
    const scope = c.req.query("scope_id");
    const session = scope ? findSession(scope) : null;
    const data = (session?.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      type: "file",
      filename: artifact.filename,
      size_bytes: artifact.bytes.byteLength,
      mime_type: "text/plain",
      created_at: now(),
      downloadable: true,
    }));
    return c.json({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  });
  app.get("/v1/files/:id/content", (c) => {
    for (const session of state.sessions.values()) {
      const artifact = session.artifacts.find((a) => a.id === c.req.param("id"));
      if (artifact)
        return c.body(artifact.bytes as unknown as ArrayBuffer, 200, {
          "content-type": "text/plain",
        });
    }
    return notFound(c);
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
      turns: 0,
      interrupted: false,
      deleted: false,
      resources: Array.isArray(body.resources) ? body.resources : [],
      vaultIds: Array.isArray(body.vault_ids) ? (body.vault_ids as string[]) : [],
      pendingTool: null,
      pendingConfirmation: null,
      artifacts: [],
      timeline: createTimeline(),
    };
    state.sessions.set(session.id, session);
    const initial = Array.isArray(body.initial_events)
      ? (body.initial_events as Record<string, unknown>[])
      : [];
    for (const event of initial)
      session.timeline.push({ ...event, id: fakeId("sevt"), processed_at: now() });
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
    const body = (await c.req.json().catch(() => ({}))) as { events?: Record<string, unknown>[] };
    for (const event of body.events ?? []) {
      session.timeline.push({ ...event, id: fakeId("sevt"), processed_at: now() });
      if (event.type === "user.message") {
        if (session.pendingTool || session.pendingConfirmation)
          return c.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "session requires_action: settle pending events first",
              },
            },
            400,
          );
        if (session.status === "idle") void runTurn(session);
      }
      if (event.type === "user.interrupt") session.interrupted = true;
      const tool = session.pendingTool;
      if (
        tool &&
        event.type === "user.custom_tool_result" &&
        tool.id === event.custom_tool_use_id
      ) {
        const content = Array.isArray(event.content) ? (event.content as { text?: string }[]) : [];
        tool.result = content.map((block) => block.text ?? "").join("");
      }
      const confirmation = session.pendingConfirmation;
      if (
        confirmation &&
        event.type === "user.tool_confirmation" &&
        confirmation.id === event.tool_use_id
      )
        confirmation.result = event.result === "deny" ? "deny" : "allow";
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
    const types = c.req.queries("types[]") ?? c.req.queries("types") ?? [];
    const data = session.timeline.events.filter(
      (event) => !types.length || types.includes(event.type as string),
    );
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
