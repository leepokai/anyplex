// Cursor Cloud Agents API v1 (public beta).
//
// Mapping: Cursor has no agent-configuration object, so `createAgent` creates nothing; each
// start() is `POST /v1/agents` (a durable conversation plus workspace on a Cursor-hosted VM) and
// the Cursor agent id is the anyplex session id. Every turn is a run: `send()` is
// `POST /v1/agents/{id}/runs`, followed with `GET .../runs/{runId}/stream` (SSE with opaque
// event ids). Instructions have no REST field (the SDK's `systemPrompt` is local-only), so they
// are prepended to the first prompt. Spend is polled from `GET /v1/agents/{id}/usage`, which
// live (2026-09-14) carries `cost.chargedCents` next to the token counts. Artifacts are the
// workspace `artifacts/` directory. Eight endpoints, so plain fetch.
//
// Observed live 2026-09-14 with claude-haiku-4-5: `POST /v1/agents` blocks until the VM is up
// (about 60 s) and a connection reset mid-way does not undo the creation, so the agent id is
// chosen client-side and the call converges on it; follow-up runs return in about a second.
// Every simplified SSE event is mirrored by an `interaction_update` frame with the same id, and
// `result` and `done` share an id, so only mapped events count for dedupe. The final reply is
// streamed as `assistant` deltas before `result` repeats it. A run's stream is not open right
// after the run is created: it answers `status` frames, then `error stream_unavailable` and
// `done` (~2 s), so `follow` re-checks the run and reconnects with backoff. The agent works in
// `/agent`; only files under `/opt/cursor/artifacts` are listed by the artifacts endpoint.

import { randomUUID } from "node:crypto";
import type { Provider, ProviderContext } from "../provider.ts";
import {
  type Capabilities,
  CONTINUE,
  num,
  preview,
  type RawEvent,
  record,
  skip,
  stale,
  str,
  type TokenUsage,
  type Translation,
  UnsupportedError,
} from "../types.ts";

export const cursorCapabilities: Capabilities = {
  multiTurn: "native",
  clientTools: "unsupported",
  approvals: "unsupported",
  permissions: "unsupported",
  mcp: "native",
  mcpAuth: "native",
  mcpHeaders: "native",
  files: "unsupported",
  repositories: "native",
  repositoryAuth: "unsupported",
  network: "unsupported",
  packages: "unsupported",
  setupCommands: "unsupported",
  artifactsList: "native",
  artifactsRead: "native",
  nativeBudget: "unsupported",
  artifactsDirectory: "/opt/cursor/artifacts",
};

export const CURSOR_BASE_URL = "https://api.cursor.com";
const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
const ACTIVE = new Set(["CREATING", "RUNNING"]);

export function cursorTokenUsage(raw: unknown): TokenUsage | null {
  const usage = record(raw);
  if (!usage) return null;
  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
  };
}

/** Raw event shape `follow` yields: one SSE frame or one run object, tagged with its run. */
export interface CursorRawEvent {
  runId: string;
  /** SSE event name, or "run" for a run object fetched from the REST API. */
  event: string;
  id: string | null;
  data: unknown;
  stale?: boolean;
}

function runOutcome(status: string, data: Record<string, unknown>): Translation["outcome"] {
  switch (status) {
    case "FINISHED":
      return { kind: "completed" };
    case "ERROR":
      return { kind: "failed", error: str(data.error) ?? str(data.text) ?? "cursor run failed" };
    case "CANCELLED":
    case "EXPIRED":
      return { kind: "terminated" };
    default:
      return CONTINUE;
  }
}

export function translateCursor(raw: unknown): Translation {
  const ev = record(raw) as (Record<string, unknown> & Partial<CursorRawEvent>) | null;
  if (!ev) return skip();
  if (ev.stale === true) return stale(translateCursor({ ...ev, stale: false }));
  const runId = str(ev.runId) ?? "run";
  const upstreamId = str(ev.id) ? `${runId}:${ev.id}` : null;
  const data = record(ev.data) ?? {};
  const done = (events: RawEvent[], extra: Partial<Translation> = {}): Translation => ({
    upstreamId,
    events,
    outcome: CONTINUE,
    ...extra,
  });

  switch (ev.event) {
    case "assistant": {
      const text = str(data.text);
      return text ? done([{ type: "message.delta", payload: { text } }]) : skip(upstreamId);
    }
    case "thinking":
      return done([{ type: "harness.event", payload: { type: "thinking", text: data.text } }]);
    case "tool_call": {
      const id = str(data.callId) ?? upstreamId ?? "call";
      const name = str(data.name) ?? "tool";
      if (data.status === "running")
        return done([{ type: "tool.call", payload: { id, name, input: preview(data.args) } }]);
      // Tool output arrives as `{ success: ... }` / `{ error: ... }` (observed live for
      // run_terminal_cmd); the mirror frames use `{ status, value }`. Unwrap either.
      const result = record(data.result);
      let is_error = false;
      let content: unknown = data.result;
      if (result) {
        if ("success" in result) content = result.success;
        else if ("error" in result) {
          is_error = true;
          content = result.error;
        } else if (typeof result.status === "string") {
          is_error = result.status !== "success";
          content = result.value ?? result;
        }
      }
      return done([
        { type: "tool.result", payload: { id, name, is_error, content: preview(content) } },
      ]);
    }
    case "result": {
      const status = str(data.status) ?? "FINISHED";
      return done(
        [
          {
            type: "harness.event",
            payload: {
              type: "run.result",
              run_id: runId,
              status,
              text: data.text ?? null,
              git: data.git ?? null,
            },
          },
        ],
        { pollSpend: true, outcome: runOutcome(status, data) },
      );
    }
    case "run": {
      // A run object from the REST API: the terminal state when the stream is gone or replayed.
      const status = str(data.status) ?? "";
      const text = str(data.result);
      return done(
        [
          ...(text ? [{ type: "message.delta", payload: { text } }] : []),
          {
            type: "harness.event",
            payload: { type: "run.result", run_id: runId, status, git: data.git ?? null },
          },
        ],
        TERMINAL.has(status) ? { pollSpend: true, outcome: runOutcome(status, data) } : {},
      );
    }
    case "error": {
      // `stream_unavailable` / `stream_expired` are handled by `follow` (re-check, reconnect).
      const code = str(data.code);
      if (code === "stream_unavailable" || code === "stream_expired") return skip();
      const message = str(data.message) ?? "cursor stream error";
      return done([{ type: "harness.event", payload: { type: "error", code, error: message } }]);
    }
    default:
      // `status` (sticky, no id, re-sent on every connect), heartbeat, done, and the
      // interaction_update mirror frames. None may mark an id seen: they share ids with the
      // simplified events above.
      return skip();
  }
}

// ---- HTTP ----

class CursorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`cursor ${status} ${code}: ${message}`);
    this.name = "CursorError";
  }
}

type Ctx = { apiKey: string; baseUrl: string | null };
const base = (ctx: Ctx) => (ctx.baseUrl ?? CURSOR_BASE_URL).replace(/\/+$/, "");

async function api<T = Record<string, unknown>>(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${base(ctx)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function toError(response: Response): Promise<CursorError> {
  const text = await response.text().catch(() => "");
  let code = "http_error";
  let message = text || response.statusText;
  try {
    const error = record(record(JSON.parse(text))?.error);
    code = str(error?.code) ?? code;
    message = str(error?.message) ?? message;
  } catch {}
  return new CursorError(response.status, code, message);
}

/** Minimal SSE reader: yields `{ id, event, data }` per frame. */
async function* sse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<{ id: string | null; event: string; data: unknown }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  const flush = () => {
    if (!data.length) return null;
    const text = data.join("\n");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const frame = { id, event, data: parsed };
    id = null;
    event = "message";
    data = [];
    return frame;
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        } else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    const frame = flush();
    if (frame) yield frame;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

interface Run {
  id: string;
  status: string;
  [key: string]: unknown;
}

const getRun = (ctx: Ctx, agentId: string, runId: string, signal?: AbortSignal) =>
  api<Run>(ctx, "GET", `/v1/agents/${agentId}/runs/${runId}`, undefined, signal);

async function listRuns(ctx: Ctx, agentId: string, signal?: AbortSignal): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await api<{ items: Run[]; nextCursor?: string }>(
      ctx,
      "GET",
      `/v1/agents/${agentId}/runs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      undefined,
      signal,
    );
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  // Newest first from the API; replay oldest first.
  return runs.reverse();
}

async function waitForIdle(ctx: Ctx, agentId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = await api(ctx, "GET", `/v1/agents/${agentId}`);
    const latest = str(agent.latestRunId);
    if (!latest) return;
    const run = await getRun(ctx, agentId, latest);
    if (!ACTIVE.has(run.status) || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function mcpServers(d: ProviderContext["definition"]) {
  return d.mcpServers.map((server) => {
    const headers = { ...(server.headers ?? {}) };
    if (server.authorization) headers.Authorization = `Bearer ${server.authorization}`;
    return {
      name: server.name,
      type: "http" as const,
      url: server.url,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  });
}

export const cursor: Provider = {
  name: "cursor",
  capabilities: cursorCapabilities,

  // Cursor keeps no agent configuration apart from the conversation itself.
  async createAgent(ctx) {
    return { agentId: `cursor:${ctx.agentKey.slice(0, 16)}`, environmentId: null };
  },

  async createSession(ctx, _agent, prompt, signal) {
    const d = ctx.definition;
    const repos = (d.environment.repositories ?? []).map((repo) => ({
      url: repo.url,
      ...(repo.ref ? { startingRef: repo.ref } : {}),
    }));
    const options = { ...(d.providerOptions.agent ?? {}), ...(d.providerOptions.session ?? {}) };
    // A client-chosen id makes the create idempotent; Cursor refuses it next to `envVars`.
    const agentId = "envVars" in options ? null : `bc-${randomUUID()}`;
    const body = {
      ...options,
      ...(agentId ? { agentId } : {}),
      // No system-prompt field in the REST API: the instructions lead the first prompt.
      prompt: { text: d.instructions ? `${d.instructions}\n\n${prompt}` : prompt },
      ...(d.model && d.model !== "default" ? { model: { id: d.model } } : {}),
      ...(repos.length ? { repos } : {}),
      ...(d.mcpServers.length ? { mcpServers: mcpServers(d) } : {}),
      ...(d.providerOptions.environment ? { env: d.providerOptions.environment } : {}),
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        const created = await api<{ agent: { id: string }; run: Run }>(
          ctx,
          "POST",
          "/v1/agents",
          body,
          signal,
        );
        return { sessionId: created.agent.id, environmentId: null };
      } catch (err) {
        if (err instanceof CursorError) {
          if (err.code === "agent_id_conflict" && agentId)
            return { sessionId: agentId, environmentId: null };
          throw err;
        }
        // The call blocks while the VM boots and may be reset mid-way; the agent exists anyway.
        if (signal.aborted || !agentId || attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const existing = await api(ctx, "GET", `/v1/agents/${agentId}`, undefined, signal).catch(
          () => null,
        );
        if (existing) return { sessionId: agentId, environmentId: null };
      }
    }
  },

  async *follow(ctx, ref, signal) {
    const agentId = ref.sessionId;
    const runs = await listRuns(ctx, agentId, signal);
    const current = runs.at(-1);
    if (!current) return;
    // Earlier runs are transcript only: their final reply, marked stale. The list endpoint
    // omits `result` (observed live), so each earlier run is fetched in full.
    for (const run of runs.slice(0, -1)) {
      const full = run.result === undefined ? await getRun(ctx, agentId, run.id, signal) : run;
      yield { runId: run.id, event: "run", id: "result", data: full, stale: true };
    }
    // The current run: stream from the start (the runner dedupes on event id). Reconnect with
    // Last-Event-ID while the run is active; when the stream is not open yet or is gone, the run
    // object is the truth.
    let lastId: string | null = null;
    // Reconnect quickly at first: the stream opens a second or two after a run is created.
    let delay = 500;
    const backoff = async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5000);
    };
    for (;;) {
      if (signal.aborted) return;
      let response: Response;
      try {
        response = await fetch(`${base(ctx)}/v1/agents/${agentId}/runs/${current.id}/stream`, {
          headers: {
            authorization: `Bearer ${ctx.apiKey}`,
            accept: "text/event-stream",
            ...(lastId ? { "last-event-id": lastId } : {}),
          },
          signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        throw err;
      }
      if (!response.ok) {
        const error = await toError(response);
        const gone =
          error.status === 410 ||
          error.code === "stream_unavailable" ||
          error.code === "invalid_last_event_id";
        if (!gone) throw error;
        if (error.code === "invalid_last_event_id") lastId = null;
        const run = await getRun(ctx, agentId, current.id, signal);
        if (TERMINAL.has(run.status)) {
          yield { runId: run.id, event: "run", id: "result", data: run };
          return;
        }
        await backoff();
        continue;
      }
      let settled = false;
      for await (const frame of sse(response, signal)) {
        if (frame.event === "error") {
          const code = str(record(frame.data)?.code);
          // Not open yet (right after the run was created) or retired: re-check and reconnect.
          if (code === "stream_unavailable" || code === "stream_expired") break;
        }
        if (frame.id) lastId = frame.id;
        yield { runId: current.id, event: frame.event, id: frame.id, data: frame.data };
        if (frame.event === "result") settled = true;
      }
      if (settled || signal.aborted) return;
      // The stream closed without a result: settle from the run object, else resume.
      const run = await getRun(ctx, agentId, current.id, signal);
      if (TERMINAL.has(run.status)) {
        yield { runId: run.id, event: "run", id: "result", data: run };
        return;
      }
      await backoff();
    }
  },

  translate: translateCursor,

  /**
   * Cumulative spend across every run on the agent. Live, the usage endpoint reports the charged
   * cost in cents (undocumented, observed 2026-09-14); that is the authoritative figure. Token
   * counts priced with the local rate table are the fallback.
   */
  async pollSpend(ctx, ref, signal) {
    const usage = await api(ctx, "GET", `/v1/agents/${ref.sessionId}/usage`, undefined, signal);
    const cents = record(usage.cost)?.chargedCents;
    if (typeof cents === "number" && Number.isFinite(cents))
      return cents > 0 ? { kind: "list_cost_usd", totalUsd: cents / 100 } : null;
    const total = cursorTokenUsage(usage.totalUsage);
    if (!total) return null;
    const sum =
      total.inputTokens +
      total.outputTokens +
      (total.cacheReadTokens ?? 0) +
      (total.cacheWriteTokens ?? 0);
    return sum > 0 ? { kind: "tokens_total", usage: total } : null;
  },

  async sendMessage(ctx, ref, text) {
    // Only one run may be active per agent; a run that is still winding down answers 409.
    await waitForIdle(ctx, ref.sessionId, 30_000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await api(ctx, "POST", `/v1/agents/${ref.sessionId}/runs`, { prompt: { text } });
        return undefined;
      } catch (err) {
        if (!(err instanceof CursorError) || err.code !== "agent_busy" || attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  },

  async sendToolResult() {
    throw new UnsupportedError("cursor", ["clientTools"]);
  },

  async listArtifacts(ctx, ref) {
    const page = await api<{ items: { path: string; sizeBytes?: number }[] }>(
      ctx,
      "GET",
      `/v1/agents/${ref.sessionId}/artifacts`,
    );
    return page.items.map((item) => ({
      id: item.path,
      path: item.path,
      sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : null,
    }));
  },

  async readArtifact(ctx, ref, artifact) {
    const { url } = await api<{ url: string }>(
      ctx,
      "GET",
      `/v1/agents/${ref.sessionId}/artifacts/download?path=${encodeURIComponent(artifact.id)}`,
    );
    const response = await fetch(url);
    if (!response.ok) throw new CursorError(response.status, "artifact_download", url);
    return new Uint8Array(await response.arrayBuffer());
  },

  async stop(ctx, ref, reason) {
    if (reason !== "kill" && reason !== "budget_exceeded") return;
    const agentId = ref.sessionId;
    const agent = await api(ctx, "GET", `/v1/agents/${agentId}`).catch(() => null);
    const latest = str(agent?.latestRunId);
    // Cancelling a run that already ended answers 409 run_not_cancellable; that is fine.
    if (latest)
      await api(ctx, "POST", `/v1/agents/${agentId}/runs/${latest}/cancel`).catch(() => undefined);
    if (reason === "kill") await api(ctx, "DELETE", `/v1/agents/${agentId}`).catch(() => undefined);
  },
};
