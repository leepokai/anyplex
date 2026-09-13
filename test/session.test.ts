// Session runner against the fake upstreams: completion with spend, the budget watchdog, stop(),
// and re-attaching after abandoning a stream without duplicating events or spend.
import { afterAll, describe, expect, it } from "vitest";
import { anyplex, type ProviderName, type SessionEvent } from "../src/index.ts";
import { startFakeAnthropic } from "./fakes/anthropic.ts";
import { startFakeGoogle } from "./fakes/google.ts";
import { startFakeOpenAI } from "./fakes/openai.ts";
import type { FakeServer } from "./fakes/timeline.ts";

interface Vendor {
  provider: ProviderName;
  model: string;
  start: (eventDelayMs: number) => Promise<FakeServer<unknown>>;
  base: (url: string) => string;
  /** Spend of one scripted turn: list price (Anthropic) or the rate table / fallback (OpenAI, Gemini). */
  turnUsd: number;
  lowBudgetUsd: number;
  /** stop(): interrupted and deleted upstream. */
  stopped: (state: unknown, sessionId: string) => boolean;
  /** Budget: interrupted upstream, transcript kept. */
  interrupted: (state: unknown, sessionId: string) => boolean;
}

const VENDORS: Vendor[] = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    start: (eventDelayMs) => startFakeAnthropic({ eventDelayMs, turnCents: 42 }),
    base: (url) => url,
    turnUsd: 0.42,
    lowBudgetUsd: 0.3,
    stopped: (state, id) => {
      const s = (state as Awaited<ReturnType<typeof startFakeAnthropic>>["state"]).sessions.get(id);
      return s?.interrupted === true && s.deleted;
    },
    interrupted: (state, id) =>
      (state as Awaited<ReturnType<typeof startFakeAnthropic>>["state"]).sessions.get(id)
        ?.interrupted === true,
  },
  {
    provider: "openai",
    model: "gpt-5",
    start: (eventDelayMs) => startFakeOpenAI({ eventDelayMs }),
    base: (url) => `${url}/v1`,
    turnUsd: 0.00325,
    lowBudgetUsd: 0.003,
    stopped: (state, id) => {
      const s = (state as Awaited<ReturnType<typeof startFakeOpenAI>>["state"]).sessions.get(id);
      return s?.cancelled === true && s.deleted;
    },
    interrupted: (state, id) =>
      (state as Awaited<ReturnType<typeof startFakeOpenAI>>["state"]).sessions.get(id)
        ?.cancelled === true,
  },
  {
    provider: "google",
    model: "gemini-3.8-flash",
    start: (eventDelayMs) => startFakeGoogle({ eventDelayMs }),
    base: (url) => url,
    turnUsd: 0.06,
    lowBudgetUsd: 0.02,
    stopped: (state, id) =>
      (state as Awaited<ReturnType<typeof startFakeGoogle>>["state"]).interactions.get(id)
        ?.cancelled === true,
    interrupted: (state, id) =>
      (state as Awaited<ReturnType<typeof startFakeGoogle>>["state"]).interactions.get(id)
        ?.cancelled === true,
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
    const agent = async (eventDelayMs: number) => {
      const fake = await vendor.start(eventDelayMs);
      servers.push(fake);
      const client = anyplex({
        provider: vendor.provider,
        apiKey: "fake-local-only",
        baseUrl: vendor.base(fake.url),
        model: vendor.model,
        instructions: "Run the scripted task",
      });
      return { fake, client };
    };

    it("completes with a unified transcript and settled spend", async () => {
      const { fake, client } = await agent(20);
      const session = await client.start({ prompt: "go", budgetUsd: 1 });
      const events = await collect(session.events());
      expect(ended(events).outcome).toEqual({ kind: "completed" });
      expect(session.spentUsd).toBe(vendor.turnUsd);
      const t = types(events);
      expect(t.filter((x) => x === "message.delta").length).toBeGreaterThanOrEqual(2);
      expect(t.filter((x) => x === "tool.call")).toHaveLength(1);
      expect(t.filter((x) => x === "tool.result")).toHaveLength(1);
      expect(t).toContain("spend.updated");
      // A finished session is left in place (attachable), never deleted.
      expect(vendor.stopped(fake.state, session.ref.sessionId)).toBe(false);
    });

    it("stops the upstream session when spend reaches the budget", async () => {
      const { fake, client } = await agent(20);
      const session = await client.start({ prompt: "go", budgetUsd: vendor.lowBudgetUsd });
      const events = await collect(session.events());
      expect(ended(events).outcome).toEqual({ kind: "budget_exceeded" });
      expect(session.spentUsd).toBeGreaterThanOrEqual(vendor.lowBudgetUsd);
      expect(session.spentUsd).toBeLessThanOrEqual(vendor.turnUsd);
      await until(() => vendor.interrupted(fake.state, session.ref.sessionId));
    });

    it("stop() interrupts the hosted session", async () => {
      const { fake, client } = await agent(150);
      const session = await client.start({ prompt: "go", budgetUsd: 1 });
      const seen: SessionEvent[] = [];
      const consumer = (async () => {
        for await (const event of session.events()) seen.push(event);
      })();
      await until(() => seen.some((e) => e.type === "tool.call"));
      await session.stop();
      await consumer;
      expect(ended(seen).outcome).toEqual({ kind: "stopped" });
      await until(() => vendor.stopped(fake.state, session.ref.sessionId));
    });

    it("re-attaches after an abandoned stream without duplicates", async () => {
      const { client } = await agent(150);
      const first = await client.start({ prompt: "go", budgetUsd: 1 });
      const before: SessionEvent[] = [];
      const iterator = first.events();
      for await (const event of iterator) {
        before.push(event);
        if (event.type === "tool.call") break;
      }
      await iterator.return(undefined);
      // Simulate a new process: only the ref and the persisted state survive.
      const state = JSON.parse(JSON.stringify(first.state()));
      const ref = JSON.parse(JSON.stringify(first.ref));
      const second = client.attach(ref, { ...state, budgetUsd: 1 });
      const after = await collect(second.events());
      expect(ended(after).outcome).toEqual({ kind: "completed" });
      // The item interrupted mid-delivery may be redelivered in full; dedupe by upstream id.
      const all = [...before, ...after];
      const distinct = (type: string) =>
        new Set(all.filter((e) => e.type === type).map((e) => e.upstreamId)).size;
      expect(distinct("tool.call")).toBe(1);
      expect(distinct("tool.result")).toBe(1);
      expect(after.filter((e) => e.type === "message.delta").length).toBeGreaterThanOrEqual(1);
      expect(second.spentUsd).toBe(vendor.turnUsd);
    });
  });
}
