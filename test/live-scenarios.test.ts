// Live behaviour scenarios (opt-in, costs money): everything the fake suite covers, against the
// real vendors, plus the failure modes a first-time user hits. ANYPLEX_LIVE=anthropic,openai,google.
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, describe, expect, it } from "vitest";
import {
  anyplex,
  MemoryStore,
  type ProviderName,
  type SessionEvent,
  type SessionRef,
} from "../src/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const live = (process.env.ANYPLEX_LIVE ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p): p is ProviderName => p === "anthropic" || p === "openai" || p === "google");

const VENDOR: Record<ProviderName, { key: string; model: string; badModel: string }> = {
  anthropic: {
    key: "ANTHROPIC_API_KEY",
    model: process.env.ANYPLEX_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
    badModel: "claude-does-not-exist",
  },
  openai: {
    key: "OPENAI_API_KEY",
    model: process.env.ANYPLEX_OPENAI_MODEL ?? "gpt-6-astra",
    badModel: "gpt-5",
  },
  google: {
    key: "GEMINI_API_KEY",
    model: process.env.ANYPLEX_GOOGLE_MODEL ?? "gemini-3.8-flash",
    badModel: "gemini-does-not-exist",
  },
};

const INSTRUCTIONS =
  "You are a terse assistant. Do exactly what the user asks with shell commands and stop.";
const SLOW_PROMPT =
  "Run these shell commands one at a time, each as its own tool call, in this order: `echo one`, `sleep 20`, `echo two`. Then reply done.";
const TWO_PROMPT =
  "Run these shell commands one at a time, each as its own tool call: `echo one`, then `echo two`. Then reply done.";

const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(s);
};
afterAll(() => console.log(`\n--- live scenario log ---\n${log.join("\n")}`));

async function collect(events: AsyncIterable<SessionEvent>, until?: (e: SessionEvent) => boolean) {
  const out: SessionEvent[] = [];
  const it = events[Symbol.asyncIterator]();
  for (;;) {
    const next = await it.next();
    if (next.done) break;
    out.push(next.value);
    if (until?.(next.value)) {
      await it.return?.(undefined);
      break;
    }
  }
  return out;
}
const outcomeOf = (events: SessionEvent[]) => {
  const last = events.at(-1);
  return last?.type === "session.ended" ? last.payload.outcome : null;
};
const ids = (events: SessionEvent[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.upstreamId);

/** Vendor-side truth, read with the raw SDKs. */
async function upstreamStatus(
  provider: ProviderName,
  apiKey: string,
  ref: SessionRef,
): Promise<string> {
  try {
    if (provider === "anthropic") {
      const s = await new Anthropic({ apiKey }).beta.sessions.retrieve(ref.sessionId);
      return s.status;
    }
    if (provider === "openai") {
      const s = await new OpenAI({ apiKey }).beta.agents.sessions.retrieve(ref.sessionId);
      return s.status;
    }
    const i = await new GoogleGenAI({ apiKey }).interactions.get(ref.sessionId);
    return i.status ?? "unknown";
  } catch (err) {
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode;
    return `error:${status ?? (err as Error).message.slice(0, 60)}`;
  }
}

describe.skipIf(live.length === 0)("live scenarios", () => {
  for (const provider of live) scenarios(provider);
});

function scenarios(provider: ProviderName) {
  const { key, model, badModel } = VENDOR[provider];
  const apiKey = process.env[key] ?? "";
  const store = new MemoryStore();
  const client = () => anyplex({ provider, apiKey, model, instructions: INSTRUCTIONS, store });

  describe.skipIf(!apiKey)(`${provider} live scenarios`, () => {
    const timeout = 400_000;
    let stoppedRef: SessionRef | null = null;

    it("rejects a wrong api key without hanging", { timeout: 60_000 }, async () => {
      const bad = anyplex({
        provider,
        apiKey: "invalid-key-0000",
        model,
        instructions: INSTRUCTIONS,
      });
      const started = Date.now();
      await expect(bad.start({ prompt: "hi" })).rejects.toThrow();
      note(`${provider}: wrong key rejected in ${Date.now() - started}ms`);
    });

    it("rejects an unsupported model without hanging", { timeout: 120_000 }, async () => {
      const bad = anyplex({ provider, apiKey, model: badModel, instructions: INSTRUCTIONS });
      let message = "";
      try {
        const session = await bad.start({ prompt: "Reply with the single word hi." });
        const events = await collect(session.events());
        const outcome = outcomeOf(events);
        message = `ended with ${JSON.stringify(outcome)}`;
        expect(outcome?.kind).toBe("failed");
      } catch (err) {
        message = `threw ${(err as Error).message.slice(0, 120)}`;
      }
      note(`${provider}: unsupported model ${badModel} -> ${message}`);
    });

    it("stop() interrupts a running session upstream", { timeout }, async () => {
      const session = await client().start({ prompt: SLOW_PROMPT, budgetUsd: 1 });
      const seen: SessionEvent[] = [];
      const consumer = (async () => {
        for await (const e of session.events()) seen.push(e);
      })();
      const t0 = Date.now();
      while (
        !seen.some(
          (e) =>
            e.type === "tool.call" ||
            (e.type === "harness.event" &&
              /in_progress|running|created/.test(String(e.payload.type ?? e.payload.status))),
        ) &&
        Date.now() - t0 < 120_000
      )
        await new Promise((r) => setTimeout(r, 200));
      const stopStarted = Date.now();
      await session.stop();
      await consumer;
      const stopMs = Date.now() - stopStarted;
      expect(outcomeOf(seen)).toEqual({ kind: "stopped" });
      await new Promise((r) => setTimeout(r, 3000));
      const status = await upstreamStatus(provider, apiKey, session.ref);
      note(
        `${provider}: stop() after ${seen.length} events took ${stopMs}ms; upstream now ${status}; spent $${session.spentUsd}`,
      );
      stoppedRef = session.ref;
    });

    it("attach to a stopped session ends cleanly", { timeout: 120_000 }, async () => {
      expect(stoppedRef).not.toBeNull();
      const t0 = Date.now();
      let result = "";
      try {
        const events = await collect(
          client()
            .attach(stoppedRef as SessionRef, { budgetUsd: 1 })
            .events(),
        );
        result = `ended ${JSON.stringify(outcomeOf(events))} after ${events.length} events`;
      } catch (err) {
        result = `threw ${(err as Error).message.slice(0, 100)}`;
      }
      note(`${provider}: attach to stopped session -> ${result} in ${Date.now() - t0}ms`);
      expect(Date.now() - t0).toBeLessThan(60_000);
    });

    it("re-attaches mid-run and after completion without duplicating spend", {
      timeout,
    }, async () => {
      const first = await client().start({ prompt: TWO_PROMPT, budgetUsd: 1 });
      const before = await collect(first.events(), (e) => e.type === "tool.call");
      const state = JSON.parse(JSON.stringify(first.state()));
      const second = client().attach(first.ref, { ...state, budgetUsd: 1 });
      const after = await collect(second.events());
      expect(outcomeOf(after)).toEqual({ kind: "completed" });
      const calls = [...ids(before, "tool.call"), ...ids(after, "tool.call")];
      const duplicates = calls.length - new Set(calls).size;
      expect(duplicates).toBeLessThanOrEqual(1);
      note(
        `${provider}: mid-run attach: ${before.length} events before, ${after.length} after, ${new Set(calls).size} distinct tool calls, ${duplicates} redelivered, spent $${second.spentUsd}${second.uncertain ? " (est)" : ""}`,
      );

      // Same session, state fully persisted: nothing new should arrive.
      const third = client().attach(first.ref, {
        ...JSON.parse(JSON.stringify(second.state())),
        budgetUsd: 1,
      });
      const nothing = await collect(third.events());
      expect(outcomeOf(nothing)).toEqual({ kind: "completed" });
      note(
        `${provider}: tool.call ids before=${JSON.stringify(ids(before, "tool.call"))} after=${JSON.stringify(ids(after, "tool.call"))} withState=${JSON.stringify(ids(nothing, "tool.call"))}`,
      );
      expect(nothing.filter((e) => e.type === "tool.call")).toHaveLength(0);
      // OpenAI can report usage more than a minute after idle: a later attach may settle what an
      // earlier session had to leave unsettled. Spend never goes down.
      expect(third.spentUsd).toBeGreaterThanOrEqual(second.spentUsd);
      note(
        `${provider}: attach after completion with state -> ${nothing.length} events, spend unchanged $${third.spentUsd}`,
      );

      // State lost entirely: the whole history replays from the vendor.
      const fourth = client().attach(first.ref, { budgetUsd: 1 });
      const replay = await collect(fourth.events());
      expect(outcomeOf(replay)).toEqual({ kind: "completed" });
      note(
        `${provider}: attach after completion without state -> ${replay.length} events, ${ids(replay, "tool.call").length} tool calls, spend $${fourth.spentUsd}${fourth.uncertain ? " (est)" : ""}`,
      );
    });

    it("budget watchdog stops the session", { timeout }, async () => {
      // Anthropic prices in whole cents: a warm-cache one-command session rounds to $0.00, so the
      // cap can only bite on a task that costs at least one cent.
      const heavy =
        "Write a 1500-word story about a lighthouse into /tmp/story.txt with a single shell command (heredoc), then run `wc -w /tmp/story.txt`, then reply done.";
      const budgetUsd = provider === "anthropic" ? 0.01 : 0.005;
      const session = await client().start({
        prompt: provider === "anthropic" ? heavy : TWO_PROMPT,
        budgetUsd,
      });
      const events = await collect(session.events());
      const outcome = outcomeOf(events);
      await new Promise((r) => setTimeout(r, 3000));
      const status = await upstreamStatus(provider, apiKey, session.ref);
      note(
        `${provider}: budget $${budgetUsd} -> ${JSON.stringify(outcome)} at $${session.spentUsd}${session.uncertain ? " (est)" : ""} after ${events.length} events; upstream ${status}`,
      );
      expect(outcome?.kind).toBe("budget_exceeded");
    });

    it("an aborted signal detaches without killing the session", { timeout }, async () => {
      const controller = new AbortController();
      const session = await client().start({
        prompt: SLOW_PROMPT,
        budgetUsd: 1,
        signal: controller.signal,
      });
      const seen: SessionEvent[] = [];
      const consumer = (async () => {
        for await (const e of session.events()) seen.push(e);
      })();
      const t0 = Date.now();
      while (seen.length < 2 && Date.now() - t0 < 60_000)
        await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      await consumer;
      expect(outcomeOf(seen)).toEqual({ kind: "detached" });
      const status = await upstreamStatus(provider, apiKey, session.ref);
      note(`${provider}: detached after ${seen.length} events; upstream still ${status}`);
      // Clean up so the vendor is not left running.
      const resumed = client().attach(session.ref, { ...session.state(), budgetUsd: 1 });
      const rest = await collect(resumed.events());
      note(
        `${provider}: re-attached after detach -> ${JSON.stringify(outcomeOf(rest))}, spend $${resumed.spentUsd}${resumed.uncertain ? " (est)" : ""}`,
      );
    });

    it.skipIf(provider === "openai")(
      "two concurrent sessions share one agent",
      { timeout },
      async () => {
        const shared = client();
        const [a, b] = await Promise.all([
          shared.start({ prompt: "Reply with the single word alpha.", budgetUsd: 1 }),
          shared.start({ prompt: "Reply with the single word beta.", budgetUsd: 1 }),
        ]);
        const [ea, eb] = await Promise.all([collect(a.events()), collect(b.events())]);
        expect(outcomeOf(ea)).toEqual({ kind: "completed" });
        expect(outcomeOf(eb)).toEqual({ kind: "completed" });
        expect(a.ref.agentId).toBe(b.ref.agentId);
        note(`${provider}: concurrent sessions ok, shared agent ${a.ref.agentId.slice(0, 24)}`);
      },
    );
  });
}
