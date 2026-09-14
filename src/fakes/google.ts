// Fake Gemini Managed Agents upstream (Interactions API, preview 2026-05-19): agents,
// interactions (background create, `GET ?stream=true` replaying from the first event on every
// connect, cancel), and environment files. Point a base URL at `url`; the SDK adds `/v1beta`.
// Quirks follow live traffic of 2026-09-13: no event ids, tool code and results in step.delta,
// a cancelled interaction replays without a terminal event.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, now, sleep, type Timeline } from "./timeline.ts";

export interface FakeGoogleOptions {
  /** Pause between interaction events. Default 30. */
  eventDelayMs?: number;
  /** Token usage per model step; totals are cumulative across the two model steps. Defaults 1000 / 200. */
  inputTokens?: number;
  outputTokens?: number;
  /** Code executions per interaction. Default 1. */
  toolCalls?: number;
  /** End with `budget_exceeded` instead of completing. Default false. */
  budgetExceeded?: boolean;
  /** Name of a function (client) tool the agent calls in the first interaction of a chain. */
  functionTool?: string;
}

export interface FakeInteraction {
  id: string;
  agent: string;
  environmentId: string;
  previousId: string | null;
  status: string;
  usage: Record<string, unknown> | null;
  cancelled: boolean;
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeGoogleState {
  agents: Record<string, unknown>[];
  interactions: Map<string, FakeInteraction>;
  /** Files per environment id, as the agent leaves them. */
  files: Map<string, { path: string; bytes: number }[]>;
}

export function createFakeGoogle(options: FakeGoogleOptions = {}) {
  const eventDelayMs = options.eventDelayMs ?? 30;
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 200;
  const toolCalls = options.toolCalls ?? 1;
  const state: FakeGoogleState = { agents: [], interactions: new Map(), files: new Map() };
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!c.req.header("x-goog-api-key")) {
      return c.json(
        { error: { code: 401, message: "API key not valid", status: "UNAUTHENTICATED" } },
        401,
      );
    }
    await next();
  });

  const usageJson = (steps: number) => ({
    total_input_tokens: inputTokens * steps,
    total_output_tokens: outputTokens * steps,
    total_cached_tokens: 0,
    total_thought_tokens: 0,
    total_tokens: (inputTokens + outputTokens) * steps,
  });
  const interactionJson = (interaction: FakeInteraction) => ({
    id: interaction.id,
    object: "interaction",
    agent: interaction.agent,
    status: interaction.status,
    usage: interaction.usage,
    environment_id: interaction.environmentId,
    ...(interaction.previousId ? { previous_interaction_id: interaction.previousId } : {}),
    created: now(),
    updated: now(),
    steps: [],
  });
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) =>
    c.json({ error: { code: 404, message: "interaction not found", status: "NOT_FOUND" } }, 404);

  const runInteraction = async (
    interaction: FakeInteraction,
    input: unknown,
    chainDepth: number,
  ) => {
    let index = 0;
    // Like the real API: events carry no event_id.
    const emit = async (event_type: string, data: Record<string, unknown>) => {
      interaction.timeline.push({ event_type, ...data });
      await sleep(eventDelayMs);
    };
    const status = async (value: string) => {
      interaction.status = value;
      await emit("interaction.status_update", { interaction_id: interaction.id, status: value });
    };
    const modelStep = async (text: string, usage: Record<string, unknown>) => {
      const i = index++;
      await emit("step.start", { index: i, step: { type: "model_output" } });
      await emit("step.delta", { index: i, delta: { type: "text", text } });
      interaction.usage = usage;
      await emit("step.stop", { index: i, usage });
    };
    await emit("interaction.created", {
      interaction: { id: interaction.id, status: "in_progress", agent: interaction.agent },
    });
    await status("in_progress");
    const functionResults = Array.isArray(input)
      ? (input as Record<string, unknown>[]).filter((step) => step.type === "function_result")
      : [];
    if (functionResults.length)
      await modelStep(
        `(fake gemini agent) tool said: ${String(functionResults[0]?.result ?? "")}`,
        usageJson(1),
      );
    else await modelStep(`(fake gemini agent) chain ${chainDepth} starting`, usageJson(1));
    if (options.functionTool && chainDepth === 1 && !functionResults.length) {
      const i = index++;
      await emit("step.start", {
        index: i,
        step: {
          type: "function_call",
          id: `call_${interaction.id}`,
          name: options.functionTool,
          arguments: { query: "fake" },
        },
      });
      await emit("step.stop", { index: i, usage: usageJson(1) });
      interaction.usage = usageJson(1);
      await status("requires_action");
      interaction.timeline.finish();
      return;
    }
    for (let step = 1; step <= toolCalls; step += 1) {
      if (interaction.cancelled) break;
      // Real shape: step.start only names the call; the code and the result stream through deltas.
      const callId = `call_${interaction.id}_${step}`;
      const callIndex = index++;
      await emit("step.start", {
        index: callIndex,
        step: { type: "code_execution_call", id: callId, signature: "" },
      });
      await emit("step.delta", {
        index: callIndex,
        delta: {
          type: "code_execution_call",
          arguments: { code: `print(${step})`, language: "python" },
        },
      });
      await emit("step.stop", { index: callIndex, usage: usageJson(1) });
      const resultIndex = index++;
      await emit("step.start", {
        index: resultIndex,
        step: { type: "code_execution_result", call_id: callId },
      });
      await emit("step.delta", {
        index: resultIndex,
        delta: { type: "code_execution_result", result: `${step}\n`, is_error: false },
      });
      await emit("step.stop", { index: resultIndex, usage: usageJson(1) });
    }
    if (interaction.cancelled) {
      // Like the real API: no terminal event is replayed for a cancelled interaction.
      interaction.status = "cancelled";
      interaction.timeline.finish();
      return;
    }
    if (options.budgetExceeded) {
      await status("budget_exceeded");
      interaction.timeline.finish();
      return;
    }
    await modelStep("(fake gemini agent) done", usageJson(2));
    const files = state.files.get(interaction.environmentId) ?? [];
    files.push({ path: `/workspace/outputs/result-${chainDepth}.txt`, bytes: 16 });
    state.files.set(interaction.environmentId, files);
    interaction.status = "completed";
    await emit("interaction.completed", {
      interaction: {
        id: interaction.id,
        status: "completed",
        agent: interaction.agent,
        usage: usageJson(2),
      },
    });
    interaction.timeline.finish();
  };

  app.post("/:version/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.id === "string" && state.agents.some((agent) => agent.id === body.id))
      return c.json(
        { error: { message: "Requested entity already exists", code: "aborted" } },
        409,
      );
    const agent = { id: fakeId("agent"), ...body };
    state.agents.push(agent);
    return c.json(agent);
  });

  app.get("/:version/agents/:id", (c) => {
    const agent = state.agents.find((entry) => entry.id === c.req.param("id"));
    return agent ? c.json(agent) : notFound(c);
  });

  const stream = (c: Parameters<typeof streamSSE>[0], interaction: FakeInteraction) =>
    streamSSE(c, async (s) => {
      const closed = new AbortController();
      s.onAbort(() => closed.abort());
      // Every connect replays from the first event, exactly like the live API.
      for await (const { event } of interaction.timeline.from(0, closed.signal))
        await s.writeSSE({ data: JSON.stringify(event) });
      if (!closed.signal.aborted) await s.writeSSE({ data: "[DONE]" });
    });

  app.post("/:version/interactions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const previous =
      typeof body.previous_interaction_id === "string"
        ? state.interactions.get(body.previous_interaction_id)
        : null;
    const environmentId =
      typeof body.environment === "string" && body.environment !== "remote"
        ? body.environment
        : (previous?.environmentId ?? fakeId("env"));
    const interaction: FakeInteraction = {
      id: fakeId("interaction"),
      agent: typeof body.agent === "string" ? body.agent : "agent_unknown",
      environmentId,
      previousId: previous?.id ?? null,
      status: "in_progress",
      usage: null,
      cancelled: false,
      timeline: createTimeline(),
    };
    state.interactions.set(interaction.id, interaction);
    let depth = 1;
    for (
      let p = previous;
      p;
      p = p.previousId ? (state.interactions.get(p.previousId) ?? null) : null
    )
      depth += 1;
    void runInteraction(interaction, body.input, depth);
    if (body.stream === true) return stream(c, interaction);
    return c.json(interactionJson(interaction));
  });

  app.get("/:version/interactions/:id", (c) => {
    const interaction = state.interactions.get(c.req.param("id"));
    if (!interaction) return notFound(c);
    if (c.req.query("stream") !== "true") return c.json(interactionJson(interaction));
    return stream(c, interaction);
  });

  app.post("/:version/interactions/:id/cancel", (c) => {
    const interaction = state.interactions.get(c.req.param("id"));
    if (!interaction) return notFound(c);
    interaction.cancelled = true;
    return c.json({ ...interactionJson(interaction), status: "cancelled" });
  });

  // Like the live API: the root is "" and paths come back relative to it, sizes as strings.
  app.get("/:version/environments/:env/files/*", (c) => {
    const files = state.files.get(c.req.param("env")) ?? [];
    return c.json({
      files: [
        { name: "workspace", path: "workspace", type: "DIRECTORY" },
        ...files.map((file) => ({
          name: file.path.split("/").pop(),
          path: file.path.replace(/^\//, ""),
          type: "FILE",
          size_bytes: String(file.bytes),
          mime_type: "text/plain",
        })),
      ],
    });
  });

  return { app, state };
}

export async function startFakeGoogle(
  options: FakeGoogleOptions = {},
): Promise<FakeServer<FakeGoogleState>> {
  const { app, state } = createFakeGoogle(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
