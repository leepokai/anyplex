// Fake Cursor Cloud Agents API v1 upstream: /v1/agents (create = agent + first run), runs
// (create, list, get, SSE stream with ids and Last-Event-ID, cancel), usage, artifacts (list +
// presigned download), archive, delete, models, me. Point a base URL at `url`. Shapes follow
// the published OpenAPI spec (2026-09); options model the timing the live API is expected to
// show: usage that lands after the run ends, a stream that expires after retention.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, now, sleep, type Timeline } from "./timeline.ts";

export interface FakeCursorOptions {
  /** Pause between run events. Default 30. */
  eventDelayMs?: number;
  /** Token usage reported per run. Defaults 1000 / 200 / 0 / 0. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Tool calls per run. Default 1. */
  toolCalls?: number;
  /** How long after a run ends before its usage appears. Default 0. */
  usageDelayMs?: number;
  /** How long after a run ends before its stream answers 410 stream_expired. Default never. */
  streamRetentionMs?: number;
  /** Model ids accepted by `model.id`; anything else answers 400 invalid_model. */
  models?: string[];
  /** End every run with ERROR instead of FINISHED. Default false. */
  failRuns?: boolean;
  /**
   * For this long after a run is created, its stream answers `status`, `error stream_unavailable`,
   * `done` and closes, like the live API right after a follow-up run. Default 300.
   */
  streamWarmupMs?: number;
  /** Report `cost.chargedCents` on the usage endpoint like the live API. Default true. */
  reportCost?: boolean;
  /** Charged cents per run when `reportCost` is on. Default 3 (a haiku run observed live). */
  centsPerRun?: number;
}

export interface FakeCursorRun {
  id: string;
  agentId: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  createdAt: string;
  updatedAt: string;
  result: string | null;
  durationMs: number | null;
  cancelled: boolean;
  endedAt: number;
  usageAvailableAt: number;
  timeline: Timeline<{ id: string | null; event: string; data: Record<string, unknown> }>;
}

export interface FakeCursorAgent {
  id: string;
  name: string;
  status: "ACTIVE" | "IDLE" | "ARCHIVED";
  /** The create request body, for assertions. */
  request: Record<string, unknown>;
  runs: FakeCursorRun[];
  artifacts: { path: string; bytes: Uint8Array; updatedAt: string }[];
  cancelAttempts: number;
  deleted: boolean;
}

export interface FakeCursorState {
  agents: Map<string, FakeCursorAgent>;
}

// From GET /v1/models on 2026-09-14 (a subset).
const DEFAULT_MODELS = [
  "default",
  "composer-2.5",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "gpt-5.4-nano",
];

export function createFakeCursor(options: FakeCursorOptions = {}) {
  const eventDelayMs = options.eventDelayMs ?? 30;
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 200;
  const cacheReadTokens = options.cacheReadTokens ?? 0;
  const cacheWriteTokens = options.cacheWriteTokens ?? 0;
  const toolCalls = options.toolCalls ?? 1;
  const usageDelayMs = options.usageDelayMs ?? 0;
  const retentionMs = options.streamRetentionMs ?? Number.POSITIVE_INFINITY;
  const models = options.models ?? DEFAULT_MODELS;
  const reportCost = options.reportCost ?? true;
  const streamWarmupMs = options.streamWarmupMs ?? 300;
  const centsPerRun = options.centsPerRun ?? 3;
  const state: FakeCursorState = { agents: new Map() };
  const app = new Hono();
  let eventClock = 0;

  const error = (
    c: { json: (body: unknown, status: 400 | 401 | 404 | 409 | 410) => Response },
    status: 400 | 401 | 404 | 409 | 410,
    code: string,
    message: string,
  ) => c.json({ error: { code, message } }, status);

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/_download/")) return next();
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ") && !auth.startsWith("Basic "))
      return error(c, 401, "unauthorized", "Invalid or missing API key");
    await next();
  });

  const nextEventId = () => `${Date.now()}-${++eventClock}`;
  const usageJson = (runs: number) => ({
    inputTokens: inputTokens * runs,
    outputTokens: outputTokens * runs,
    cacheWriteTokens: cacheWriteTokens * runs,
    cacheReadTokens: cacheReadTokens * runs,
    totalTokens: (inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens) * runs,
  });
  const runUsage = (run: FakeCursorRun) =>
    run.status === "FINISHED" && Date.now() >= run.usageAvailableAt ? usageJson(1) : usageJson(0);
  const gitJson = (agent: FakeCursorAgent) => {
    const repos = Array.isArray(agent.request.repos) ? agent.request.repos : [];
    const first = repos[0] as { url?: string } | undefined;
    return first?.url
      ? {
          branches: [
            { repoUrl: first.url.replace(/^https?:\/\//, ""), branch: `cursor/${agent.id}` },
          ],
        }
      : undefined;
  };
  const runJson = (agent: FakeCursorAgent, run: FakeCursorRun) => ({
    id: run.id,
    agentId: agent.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.durationMs !== null ? { durationMs: run.durationMs } : {}),
    ...(run.result !== null ? { result: run.result } : {}),
    ...(gitJson(agent) ? { git: gitJson(agent) } : {}),
  });
  const agentJson = (agent: FakeCursorAgent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    env: { type: "cloud" },
    repos: agent.request.repos ?? [],
    workOnCurrentBranch: false,
    autoCreatePR: agent.request.autoCreatePR ?? false,
    url: `https://cursor.com/agents/${agent.id}`,
    createdAt: agent.runs[0]?.createdAt ?? now(),
    updatedAt: now(),
    ...(agent.runs.at(-1) ? { latestRunId: agent.runs.at(-1)?.id } : {}),
  });
  const findAgent = (id: string) => {
    const agent = state.agents.get(id);
    return agent && !agent.deleted ? agent : null;
  };
  const activeRun = (agent: FakeCursorAgent) =>
    agent.runs.find((run) => run.status === "CREATING" || run.status === "RUNNING") ?? null;

  const runTurn = async (agent: FakeCursorAgent, run: FakeCursorRun) => {
    const started = Date.now();
    const emit = async (event: string, data: Record<string, unknown>, withId = true) => {
      run.timeline.push({ id: withId ? nextEventId() : null, event, data });
      run.updatedAt = now();
      await sleep(eventDelayMs);
    };
    const runNo = agent.runs.indexOf(run) + 1;
    agent.status = "ACTIVE";
    await emit("status", { runId: run.id, status: "CREATING" }, false);
    run.status = "RUNNING";
    await emit("status", { runId: run.id, status: "RUNNING" }, false);
    await emit("assistant", { text: `(fake cursor agent) run ${runNo} starting` });
    for (let step = 1; step <= toolCalls && !run.cancelled; step += 1) {
      const callId = fakeId("call");
      const args = { command: `echo run ${runNo} step ${step}`, isBackground: false };
      await emit("tool_call", { callId, name: "run_terminal_cmd", status: "running", args });
      await emit("tool_call", {
        callId,
        name: "run_terminal_cmd",
        status: "completed",
        args,
        // Shape observed live 2026-09-14 for run_terminal_cmd.
        result: {
          success: { command: args.command, stdout: `run ${runNo} step ${step}\n` },
          isBackground: false,
        },
      });
    }
    const finish = async (status: FakeCursorRun["status"], text: string | null) => {
      run.status = status;
      run.result = text;
      run.durationMs = Date.now() - started;
      run.endedAt = Date.now();
      run.usageAvailableAt = Date.now() + usageDelayMs;
      agent.status = "IDLE";
      await emit("result", {
        runId: run.id,
        status,
        ...(text ? { text } : {}),
        durationMs: run.durationMs,
        ...(gitJson(agent) ? { git: gitJson(agent) } : {}),
      });
      await emit("done", {});
      run.timeline.finish();
    };
    if (run.cancelled) return finish("CANCELLED", null);
    if (options.failRuns) return finish("ERROR", null);
    await emit("assistant", { text: `(fake cursor agent) run ${runNo} done` });
    agent.artifacts.push({
      path: `artifacts/result-${runNo}.txt`,
      bytes: new TextEncoder().encode(`run ${runNo} output\n`),
      updatedAt: now(),
    });
    if (run.cancelled) return finish("CANCELLED", null);
    await finish("FINISHED", `Run ${runNo} finished.`);
  };

  const newRun = (agent: FakeCursorAgent): FakeCursorRun => {
    const run: FakeCursorRun = {
      id: `run-${fakeId("cursor")}`,
      agentId: agent.id,
      status: "CREATING",
      createdAt: now(),
      updatedAt: now(),
      result: null,
      durationMs: null,
      cancelled: false,
      endedAt: Number.POSITIVE_INFINITY,
      usageAvailableAt: Number.POSITIVE_INFINITY,
      timeline: createTimeline(),
    };
    agent.runs.push(run);
    void runTurn(agent, run);
    return run;
  };

  app.get("/v1/me", (c) => c.json({ apiKeyName: "fake", createdAt: now(), userId: 1 }));

  app.get("/v1/models", (c) =>
    c.json({
      items: models.map((id) => ({
        id,
        displayName: id,
        variants: [{ params: [], displayName: id, isDefault: true }],
      })),
    }),
  );

  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return error(c, 400, "missing_body", "Request body is required");
    const prompt = body.prompt as { text?: string } | undefined;
    if (!prompt?.text) return error(c, 400, "validation_error", "prompt.text is required");
    const model = body.model as { id?: string } | undefined;
    if (model?.id && !models.includes(model.id))
      return error(c, 400, "invalid_model", `Unknown model ${model.id}`);
    const requestedId = typeof body.agentId === "string" ? body.agentId : null;
    if (requestedId && body.envVars)
      return error(c, 400, "validation_error", "agentId cannot be combined with envVars");
    if (requestedId && state.agents.has(requestedId))
      return error(c, 409, "agent_id_conflict", "Agent id already exists");
    const agent: FakeCursorAgent = {
      id: requestedId ?? `bc-${fakeId("cursor")}`,
      name: typeof body.name === "string" ? body.name : prompt.text.slice(0, 40),
      status: "ACTIVE",
      request: body,
      runs: [],
      artifacts: [],
      cancelAttempts: 0,
      deleted: false,
    };
    state.agents.set(agent.id, agent);
    const run = newRun(agent);
    return c.json({ agent: agentJson(agent), run: runJson(agent, run) });
  });

  app.get("/v1/agents", (c) =>
    c.json({
      items: [...state.agents.values()]
        .filter((agent) => !agent.deleted)
        .map((agent) => agentJson(agent)),
    }),
  );

  app.get("/v1/agents/:id", (c) => {
    const agent = findAgent(c.req.param("id"));
    return agent ? c.json(agentJson(agent)) : error(c, 404, "agent_not_found", "No such agent");
  });

  app.delete("/v1/agents/:id", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    agent.deleted = true;
    for (const run of agent.runs) run.cancelled = true;
    return c.json({ id: agent.id });
  });

  app.post("/v1/agents/:id/archive", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    agent.status = "ARCHIVED";
    return c.json({ id: agent.id });
  });

  app.post("/v1/agents/:id/runs", async (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    if (agent.status === "ARCHIVED") return error(c, 409, "agent_archived", "Agent is archived");
    if (activeRun(agent)) return error(c, 409, "agent_busy", "Another run is active");
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: { text?: string } };
    if (!body.prompt?.text) return error(c, 400, "validation_error", "prompt.text is required");
    const run = newRun(agent);
    return c.json({ run: runJson(agent, run) });
  });

  app.get("/v1/agents/:id/runs", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    // Like the live API, list items carry no `result` or `durationMs`; fetch a run for those.
    return c.json({
      items: [...agent.runs].reverse().map((run) => {
        const { result: _result, durationMs: _duration, ...summary } = runJson(agent, run);
        return summary;
      }),
    });
  });

  app.get("/v1/agents/:id/runs/:runId", (c) => {
    const agent = findAgent(c.req.param("id"));
    const run = agent?.runs.find((r) => r.id === c.req.param("runId"));
    if (!agent || !run) return error(c, 404, "run_not_found", "No such run");
    return c.json(runJson(agent, run));
  });

  app.get("/v1/agents/:id/runs/:runId/stream", (c) => {
    const agent = findAgent(c.req.param("id"));
    const run = agent?.runs.find((r) => r.id === c.req.param("runId"));
    if (!agent || !run) return error(c, 404, "run_not_found", "No such run");
    if (Date.now() - run.endedAt > retentionMs)
      return error(c, 410, "stream_expired", "Stream retention window elapsed");
    if (Date.now() - Date.parse(run.createdAt) < streamWarmupMs)
      return streamSSE(c, async (s) => {
        await s.writeSSE({
          event: "status",
          data: JSON.stringify({ runId: run.id, status: "CREATING" }),
        });
        await s.writeSSE({
          event: "status",
          data: JSON.stringify({ runId: run.id, status: run.status }),
        });
        await s.writeSSE({
          event: "error",
          data: JSON.stringify({
            code: "stream_unavailable",
            message: "Run stream is no longer available",
          }),
        });
        await s.writeSSE({ event: "done", data: "{}" });
      });
    const lastEventId = c.req.header("last-event-id");
    let from = 0;
    if (lastEventId) {
      const index = run.timeline.events.findIndex((e) => e.id === lastEventId);
      if (index < 0) return error(c, 400, "invalid_last_event_id", "Unknown event id");
      from = index + 1;
    }
    c.header("X-Cursor-Stream-Retention-Seconds", "3600");
    return streamSSE(c, async (s) => {
      const closed = new AbortController();
      s.onAbort(() => closed.abort());
      // The sticky framing event: no id, re-sent at the top of every connect.
      await s.writeSSE({
        event: "status",
        data: JSON.stringify({ runId: run.id, status: run.status }),
      });
      for await (const { event } of run.timeline.from(from, closed.signal)) {
        if (event.event === "status") continue;
        await s.writeSSE({
          ...(event.id ? { id: event.id } : {}),
          event: event.event,
          data: JSON.stringify(event.data),
        });
      }
    });
  });

  app.post("/v1/agents/:id/runs/:runId/cancel", (c) => {
    const agent = findAgent(c.req.param("id"));
    const run = agent?.runs.find((r) => r.id === c.req.param("runId"));
    if (!agent || !run) return error(c, 404, "run_not_found", "No such run");
    agent.cancelAttempts += 1;
    if (run.status !== "CREATING" && run.status !== "RUNNING")
      return error(c, 409, "run_not_cancellable", "Run is not active");
    run.cancelled = true;
    return c.json({ id: run.id });
  });

  app.get("/v1/agents/:id/usage", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    const runId = c.req.query("runId");
    const runs = runId ? agent.runs.filter((run) => run.id === runId) : agent.runs;
    if (runId && !runs.length) return error(c, 404, "run_not_found", "No such run");
    const charged = (run: FakeCursorRun) => (runUsage(run).totalTokens > 0 ? centsPerRun : 0);
    const perRun = runs.map((run) => ({
      id: run.id,
      usage: runUsage(run),
      ...(reportCost ? { cost: { rawCostCents: charged(run), chargedCents: charged(run) } } : {}),
    }));
    const totalUsage = usageJson(0);
    for (const entry of perRun)
      for (const key of Object.keys(totalUsage) as (keyof typeof totalUsage)[])
        totalUsage[key] += entry.usage[key];
    const totalCents = runs.reduce((sum, run) => sum + charged(run), 0);
    return c.json({
      totalUsage,
      ...(reportCost ? { cost: { rawCostCents: totalCents, chargedCents: totalCents } } : {}),
      runs: perRun,
    });
  });

  app.get("/v1/agents/:id/artifacts", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    return c.json({
      items: agent.artifacts.map((artifact) => ({
        path: artifact.path,
        sizeBytes: artifact.bytes.byteLength,
        updatedAt: artifact.updatedAt,
      })),
    });
  });

  app.get("/v1/agents/:id/artifacts/download", (c) => {
    const agent = findAgent(c.req.param("id"));
    if (!agent) return error(c, 404, "agent_not_found", "No such agent");
    const path = c.req.query("path") ?? "";
    const artifact = agent.artifacts.find((a) => a.path === path);
    if (!artifact) return error(c, 404, "artifact_not_found", `No artifact at ${path}`);
    const url = new URL(c.req.url);
    return c.json({
      url: `${url.origin}/_download/${agent.id}/${encodeURIComponent(path)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  });

  // The "presigned S3 URL": unauthenticated, like the real one.
  app.get("/_download/:id/:path", (c) => {
    const agent = state.agents.get(c.req.param("id"));
    const artifact = agent?.artifacts.find(
      (a) => a.path === decodeURIComponent(c.req.param("path")),
    );
    if (!artifact) return c.text("not found", 404);
    return c.body(artifact.bytes as unknown as ArrayBuffer, 200, {
      "content-type": "application/octet-stream",
    });
  });

  return { app, state };
}

export async function startFakeCursor(
  options: FakeCursorOptions = {},
): Promise<FakeServer<FakeCursorState>> {
  const { app, state } = createFakeCursor(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
