// Session runner against the fake upstreams: every layer of the abstraction, for every provider.
import { afterAll, describe, expect, it } from "vitest";
import { startFakeAnthropic } from "../src/fakes/anthropic.ts";
import { startFakeGoogle } from "../src/fakes/google.ts";
import { startFakeOpenAI } from "../src/fakes/openai.ts";
import type { FakeServer } from "../src/fakes/timeline.ts";
import {
  type AnyplexOptions,
  anyplex,
  capabilities,
  computeCost,
  type Provider,
  type ProviderName,
  type SessionEvent,
  UnsupportedError,
} from "../src/index.ts";

interface Vendor {
  provider: ProviderName;
  model: string;
  start: (opts: Record<string, unknown>) => Promise<FakeServer<unknown>>;
  base: (url: string) => string;
  /** Spend of one scripted turn: list price (Anthropic) or the rate table / fallback (OpenAI, Gemini). */
  turnUsd: number;
  lowBudgetUsd: number;
  /** stop(): interrupted and deleted upstream. */
  stopped: (state: unknown, sessionId: string) => boolean;
  /** Budget: interrupted upstream, transcript kept. */
  interrupted: (state: unknown, sessionId: string) => boolean;
  toolOption: string;
}

type AnthropicState = Awaited<ReturnType<typeof startFakeAnthropic>>["state"];
type OpenAIState = Awaited<ReturnType<typeof startFakeOpenAI>>["state"];
type GoogleState = Awaited<ReturnType<typeof startFakeGoogle>>["state"];

const VENDORS: Vendor[] = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    start: (opts) => startFakeAnthropic({ eventDelayMs: 15, turnCents: 42, ...opts }),
    base: (url) => url,
    turnUsd: 0.42,
    lowBudgetUsd: 0.3,
    stopped: (state, id) => {
      const s = (state as AnthropicState).sessions.get(id);
      return s?.interrupted === true && s.deleted;
    },
    interrupted: (state, id) => (state as AnthropicState).sessions.get(id)?.interrupted === true,
    toolOption: "customTool",
  },
  {
    provider: "openai",
    model: "gpt-5",
    start: (opts) => startFakeOpenAI({ eventDelayMs: 15, ...opts }),
    base: (url) => `${url}/v1`,
    turnUsd: 0.00325,
    lowBudgetUsd: 0.003,
    stopped: (state, id) => {
      const s = (state as OpenAIState).sessions.get(id);
      return s?.cancelled === true && s.deleted;
    },
    interrupted: (state, id) => (state as OpenAIState).sessions.get(id)?.cancelled === true,
    toolOption: "functionTool",
  },
  {
    provider: "google",
    model: "gemini-3.8-flash",
    start: (opts) => startFakeGoogle({ eventDelayMs: 15, ...opts }),
    base: (url) => url,
    turnUsd: 0.06,
    lowBudgetUsd: 0.02,
    stopped: (state, id) => (state as GoogleState).interactions.get(id)?.cancelled === true,
    interrupted: (state, id) => (state as GoogleState).interactions.get(id)?.cancelled === true,
    toolOption: "functionTool",
  },
];

const servers: FakeServer<unknown>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function collect(events: AsyncIterable<SessionEvent>) {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const types = (events: SessionEvent[]) => events.map((e) => e.type);
const ended = (events: SessionEvent[]) => {
  const last = events.at(-1);
  if (last?.type !== "session.ended")
    throw new Error(`no session.ended: ${types(events).join(",")}`);
  return last.payload;
};
async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

for (const vendor of VENDORS) {
  describe(vendor.provider, () => {
    const agent = async (
      fakeOptions: Record<string, unknown> = {},
      extra: Partial<AnyplexOptions> = {},
    ) => {
      const fake = await vendor.start(fakeOptions);
      servers.push(fake);
      const client = anyplex({
        provider: vendor.provider,
        apiKey: "fake-local-only",
        baseUrl: vendor.base(fake.url),
        model: vendor.model,
        instructions: "Run the scripted task",
        ...extra,
      });
      return { fake, client };
    };

    it("completes with a unified transcript and settled spend, leaving the session in place", async () => {
      const { fake, client } = await agent();
      const session = await client.start({ prompt: "go", budgetUsd: 1 });
      const events = await collect(session.events());
      expect(ended(events).outcome).toEqual({ kind: "completed" });
      expect(session.spentUsd).toBe(vendor.turnUsd);
      const t = types(events);
      expect(t.filter((x) => x === "message.delta").length).toBeGreaterThanOrEqual(2);
      expect(t.filter((x) => x === "tool.call")).toHaveLength(1);
      expect(t.filter((x) => x === "tool.result")).toHaveLength(1);
      expect(t).toContain("spend.updated");
      expect(vendor.stopped(fake.state, session.ref.sessionId)).toBe(false);
    });

    it("interrupts the upstream session when spend reaches the budget", async () => {
      const { fake, client } = await agent();
      const session = await client.start({ prompt: "go", budgetUsd: vendor.lowBudgetUsd });
      const events = await collect(session.events());
      expect(ended(events).outcome).toEqual({ kind: "budget_exceeded" });
      expect(session.spentUsd).toBeGreaterThanOrEqual(vendor.lowBudgetUsd);
      await until(() => vendor.interrupted(fake.state, session.ref.sessionId));
    });

    it("stop() interrupts and deletes the hosted session", async () => {
      const { fake, client } = await agent({ eventDelayMs: 150 });
      const session = await client.start({ prompt: "go", budgetUsd: 1 });
      const seen: SessionEvent[] = [];
      const consumer = (async () => {
        for await (const event of session.events()) seen.push(event);
      })();
      await until(() => seen.some((e) => e.type === "tool.call"));
      await session.stop();
      await consumer;
      expect(ended(seen).outcome).toEqual({ kind: "stopped" });
      await until(() => vendor.stopped(fake.state, session.ref.sessionId), 15_000);
    });

    it("re-attaches after an abandoned stream without duplicates", async () => {
      const { client } = await agent({ eventDelayMs: 150 });
      const first = await client.start({ prompt: "go", budgetUsd: 1 });
      const before: SessionEvent[] = [];
      const iterator = first.events();
      for await (const event of iterator) {
        before.push(event);
        if (event.type === "tool.call") break;
      }
      await iterator.return(undefined);
      const state = JSON.parse(JSON.stringify(first.state()));
      const second = client.attach(state.ref, { ...state, budgetUsd: 1 });
      const after = await collect(second.events());
      expect(ended(after).outcome).toEqual({ kind: "completed" });
      const all = [...before, ...after];
      const distinct = (type: string) =>
        new Set(all.filter((e) => e.type === type).map((e) => e.upstreamId)).size;
      expect(distinct("tool.call")).toBe(1);
      expect(distinct("tool.result")).toBe(1);
      expect(second.spentUsd).toBe(vendor.turnUsd);
    });

    it("runs a second turn on the same session", async () => {
      const { client } = await agent();
      const session = await client.start({ prompt: "first", budgetUsd: 5 });
      const first = await collect(session.events());
      expect(ended(first).outcome).toEqual({ kind: "completed" });
      const firstId = session.ref.sessionId;
      await session.send("second");
      const second = await collect(session.events());
      expect(ended(second).outcome).toEqual({ kind: "completed" });
      const calls = [...first, ...second]
        .filter((e) => e.type === "tool.call")
        .map((e) => e.upstreamId);
      expect(new Set(calls).size).toBe(2);
      expect(session.spentUsd).toBeCloseTo(vendor.turnUsd * 2, 6);
      if (vendor.provider === "google") expect(session.ref.sessionId).not.toBe(firstId);
    });

    it("hands a client tool call to the application and continues after respond()", async () => {
      const { client } = await agent(
        { [vendor.toolOption]: "lookup" },
        {
          tools: [
            {
              name: "lookup",
              description: "look something up",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        },
      );
      const session = await client.start({ prompt: "use the tool", budgetUsd: 5 });
      const first = await collect(session.events());
      const outcome = ended(first).outcome;
      expect(outcome.kind).toBe("requires_action");
      expect(types(first)).toContain("tool.request");
      expect(session.pending).toHaveLength(1);
      const request = session.pending[0];
      expect(request?.name).toBe("lookup");
      expect(request?.input).toEqual({ query: "fake" });
      await expect(session.send("nope")).rejects.toThrow(/pending/);
      await session.respond(request?.id as string, { output: { answer: 42 } });
      expect(session.pending).toHaveLength(0);
      const rest = await collect(session.events());
      expect(ended(rest).outcome).toEqual({ kind: "completed" });
      const text = rest
        .filter((e) => e.type === "message.delta")
        .map((e) => (e.payload as { text: string }).text)
        .join(" ");
      expect(text).toContain("42");
    });

    it("passes environment, MCP servers, and tools through to the vendor", async () => {
      const { fake, client } = await agent(
        {},
        {
          tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }],
          mcpServers: [{ name: "docs", url: "https://mcp.example.com/mcp", authorization: "tok" }],
          environment: {
            files: [{ path: "/workspace/notes.md", content: "hello" }],
            repositories: [
              { url: "https://github.com/example/repo", path: "/workspace/repo", ref: "main" },
            ],
            network: { allowedHosts: ["example.com"] },
            ...(capabilities(vendor.provider).packages === "native"
              ? { packages: { npm: ["left-pad"] } }
              : {}),
            ...(capabilities(vendor.provider).setupCommands === "native"
              ? { setupCommands: ["echo setup"] }
              : {}),
          },
          ...(vendor.provider === "anthropic" ? { permissions: "ask" as const } : {}),
        },
      );
      const session = await client.start({ prompt: "go", budgetUsd: 5 });
      await collect(session.events());
      const json = JSON.stringify(
        vendor.provider === "anthropic"
          ? {
              agents: (fake.state as AnthropicState).agents,
              environments: (fake.state as AnthropicState).environments,
              credentials: (fake.state as AnthropicState).credentials,
              session: (fake.state as AnthropicState).sessions.get(session.ref.sessionId)
                ?.resources,
            }
          : vendor.provider === "openai"
            ? {
                agents: (fake.state as OpenAIState).agents,
                environment: (fake.state as OpenAIState).sessions.get(session.ref.sessionId)
                  ?.environment,
              }
            : { agents: (fake.state as GoogleState).agents },
      );
      expect(json).toContain("lookup");
      expect(json).toContain("mcp.example.com");
      expect(json).toContain("example.com");
      expect(json).toContain("notes.md");
      expect(json).toContain("github.com/example/repo");
      if (vendor.provider === "anthropic") {
        expect(json).toContain("static_bearer");
        expect(json).toContain("always_ask");
        expect(json).toContain("left-pad");
      }
      if (vendor.provider === "openai") {
        expect(json).toContain("git clone");
        expect(json).toContain("echo setup");
        expect(json).toContain("left-pad");
        expect(json).toContain("restricted");
      }
      if (vendor.provider === "google") expect(json).toContain("Bearer tok");
    });

    it("lists the artifacts the agent produced", async () => {
      const { client } = await agent();
      const session = await client.start({ prompt: "go", budgetUsd: 5 });
      await collect(session.events());
      const artifacts = await session.artifacts();
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]?.path).toMatch(/output|result/);
      if (capabilities(vendor.provider).artifactsRead === "native") {
        const bytes = await session.readArtifact(
          artifacts[0] as NonNullable<(typeof artifacts)[0]>,
        );
        expect(new TextDecoder().decode(bytes)).toContain("output");
      } else {
        await expect(
          session.readArtifact(artifacts[0] as NonNullable<(typeof artifacts)[0]>),
        ).rejects.toBeInstanceOf(UnsupportedError);
      }
    });

    it.skipIf(vendor.provider !== "anthropic")(
      "asks for approval and continues after approve()",
      async () => {
        const { client } = await agent({ askPermission: true }, { permissions: "ask" });
        const session = await client.start({ prompt: "go", budgetUsd: 5 });
        const first = await collect(session.events());
        expect(ended(first).outcome.kind).toBe("requires_action");
        expect(types(first)).toContain("approval.request");
        const request = session.pending[0];
        expect(request?.kind).toBe("approval");
        await session.approve(request?.id as string, true);
        const rest = await collect(session.events());
        expect(ended(rest).outcome).toEqual({ kind: "completed" });
        expect(
          rest
            .filter((e) => e.type === "tool.result")
            .some((e) => (e.payload as { is_error: boolean }).is_error),
        ).toBe(false);
      },
    );

    it.skipIf(vendor.provider !== "openai")(
      "waits for late usage and refuses no deletes",
      async () => {
        const { fake, client } = await agent({ usageDelayMs: 2500, eventDelayMs: 100 });
        const session = await client.start({ prompt: "go", budgetUsd: 5 });
        const events = await collect(session.events());
        expect(ended(events).outcome).toEqual({ kind: "completed" });
        expect(session.spentUsd).toBe(vendor.turnUsd);
        expect(types(events)).not.toContain("spend.unsettled");
        // Deleting while the turn is still cancelling is refused upstream; stop() waits it out.
        const slow = await client.start({ prompt: "go", budgetUsd: 5 });
        const consumer = collect(slow.events());
        await until(
          () =>
            (fake.state as OpenAIState).sessions.get(slow.ref.sessionId)?.status === "in_progress",
        );
        await slow.stop();
        await consumer;
        expect((fake.state as OpenAIState).sessions.get(slow.ref.sessionId)?.deleted).toBe(true);
      },
    );

    it.skipIf(vendor.provider !== "google")(
      "ends a cancelled interaction replay with terminated",
      async () => {
        const { client } = await agent({ eventDelayMs: 150 });
        const session = await client.start({ prompt: "go", budgetUsd: 5 });
        const consumer = collect(session.events());
        await until(() => session.ref.sessionId.length > 0);
        await new Promise((r) => setTimeout(r, 300));
        await session.stop();
        await consumer;
        const again = client.attach(session.ref, { budgetUsd: 5 });
        const replay = await collect(again.events());
        expect(ended(replay).outcome).toEqual({ kind: "terminated" });
      },
    );
  });
}

describe("capabilities", () => {
  it("refuses unsupported features at construction", () => {
    expect(capabilities("google").artifactsRead).toBe("unsupported");
    expect(() =>
      anyplex({
        provider: "openai",
        apiKey: "x",
        model: "gpt-5",
        instructions: "x",
        permissions: "ask",
      }),
    ).toThrow(UnsupportedError);
    expect(() =>
      anyplex({
        provider: "google",
        apiKey: "x",
        model: "m",
        instructions: "x",
        environment: { repositories: [{ url: "https://github.com/a/b", token: "secret" }] },
      }),
    ).toThrow(/repositories.token/);
    expect(() =>
      anyplex({
        provider: "anthropic",
        apiKey: "x",
        model: "m",
        instructions: "x",
        environment: { setupCommands: ["x"] },
      }),
    ).toThrow(/setupCommands/);
  });

  it("prices unknown models with an override instead of the fallback", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(computeCost("openai", "gpt-6-astra", usage)).toEqual({ costUsd: 15, estimated: true });
    expect(
      computeCost("openai", "gpt-6-astra", usage, {
        "gpt-6-astra": { inputPerMtok: 2, outputPerMtok: 8 },
      }),
    ).toEqual({ costUsd: 2, estimated: false });
  });
});

describe("custom provider", () => {
  it("drives a provider the package does not ship", async () => {
    const custom: Provider = {
      name: "custom",
      capabilities: capabilities("openai"),
      async createAgent() {
        return { agentId: "agent_custom", environmentId: null };
      },
      async createSession() {
        return { sessionId: "sess_custom" };
      },
      async *follow() {
        yield { id: "1", text: "hello" };
        yield { id: "2", done: true };
      },
      translate(raw) {
        const ev = raw as { id: string; text?: string; done?: boolean };
        return ev.done
          ? { upstreamId: ev.id, events: [], outcome: { kind: "completed" } }
          : {
              upstreamId: ev.id,
              events: [{ type: "message.delta", payload: { text: ev.text ?? "" } }],
              outcome: { kind: "continue" },
            };
      },
      async sendMessage() {
        return undefined;
      },
      async sendToolResult() {
        return undefined;
      },
      async stop() {},
    };
    const session = await anyplex({
      provider: custom,
      apiKey: "x",
      model: "m",
      instructions: "x",
    }).start({ prompt: "hi" });
    const events = await collect(session.events());
    expect(types(events)).toEqual(["message.delta", "session.ended"]);
    expect(ended(events).outcome).toEqual({ kind: "completed" });
  });
});
