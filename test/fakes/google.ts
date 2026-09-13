// Fake Gemini Managed Agents upstream (Interactions API, preview 2026-05-19) so sessions can be
// exercised without a key. Shapes follow @google/genai `client.agents` and
// `client.interactions` as observed live on 2026-09-13: background create, `GET ?stream=true`
// replaying from the first event on every connect, no event ids, tool code and results in
// step.delta, cancel. Point a BYOK key's base_url at `url`; the SDK adds `/v1beta` itself.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createTimeline, type FakeServer, fakeId, now, sleep, type Timeline } from "./timeline.ts";

export interface FakeGoogleAgentsOptions {
  /** Pause between interaction events. Default 30. */
  eventDelayMs?: number;
  /** Token usage per model step; totals are cumulative across the two model steps. Defaults 1000 / 200. */
  inputTokens?: number;
  outputTokens?: number;
  /** Code executions per interaction. Default 1. */
  toolCalls?: number;
  /** End with `budget_exceeded` instead of completing. Default false. */
  budgetExceeded?: boolean;
}

export interface FakeInteraction {
  id: string;
  agent: string;
  status: string;
  usage: Record<string, unknown> | null;
  cancelled: boolean;
  timeline: Timeline<Record<string, unknown>>;
}

export interface FakeGoogleAgentsState {
  agents: Record<string, unknown>[];
  interactions: Map<string, FakeInteraction>;
}

export function createFakeGoogleAgents(options: FakeGoogleAgentsOptions = {}) {
  const eventDelayMs = options.eventDelayMs ?? 30;
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 200;
  const toolCalls = options.toolCalls ?? 1;
  const state: FakeGoogleAgentsState = { agents: [], interactions: new Map() };
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
    environment_id: "env_fake",
    created: now(),
    updated: now(),
    steps: [],
  });
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) =>
    c.json({ error: { code: 404, message: "interaction not found", status: "NOT_FOUND" } }, 404);

  const runInteraction = async (interaction: FakeInteraction) => {
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
    await modelStep("(fake gemini agent) starting the task", usageJson(1));
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
      await status("cancelled");
      interaction.timeline.finish();
      return;
    }
    if (options.budgetExceeded) {
      await status("budget_exceeded");
      interaction.timeline.finish();
      return;
    }
    await modelStep("(fake gemini agent) done", usageJson(2));
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
    const interaction: FakeInteraction = {
      id: fakeId("interaction"),
      agent: typeof body.agent === "string" ? body.agent : "agent_unknown",
      status: "in_progress",
      usage: null,
      cancelled: false,
      timeline: createTimeline(),
    };
    state.interactions.set(interaction.id, interaction);
    void runInteraction(interaction);
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

  return { app, state };
}

export async function startFakeGoogle(
  options: FakeGoogleAgentsOptions = {},
): Promise<FakeServer<FakeGoogleAgentsState>> {
  const { app, state } = createFakeGoogleAgents(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
