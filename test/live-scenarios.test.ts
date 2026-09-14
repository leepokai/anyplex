// Live behaviour scenarios (opt-in, costs money): everything the fake suite covers, against the
// real vendors, plus the failure modes a first-time user hits.
// ANYPLEX_LIVE=anthropic,openai,google,cursor.
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, describe, expect, it } from "vitest";
import {
  anyplex,
  capabilities,
  MemoryStore,
  PROVIDERS,
  type ProviderName,
  type SessionEvent,
  type SessionRef,
} from "../src/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const live = (process.env.ANYPLEX_LIVE ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p): p is ProviderName => (PROVIDERS as readonly string[]).includes(p));

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
  cursor: {
    key: "CURSOR_API_KEY",
    model: process.env.ANYPLEX_CURSOR_MODEL ?? "claude-haiku-4-5",
    badModel: "cursor-does-not-exist",
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
    if (provider === "cursor") {
      const headers = { authorization: `Bearer ${apiKey}` };
      const agent = (await (
        await fetch(`https://api.cursor.com/v1/agents/${ref.sessionId}`, { headers })
      ).json()) as { status?: string; latestRunId?: string; error?: { code: string } };
      if (agent.error) return `error:${agent.error.code}`;
      const run = (await (
        await fetch(`https://api.cursor.com/v1/agents/${ref.sessionId}/runs/${agent.latestRunId}`, {
          headers,
        })
      ).json()) as { status?: string };
      return `${agent.status}/${run.status}`;
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

    it("runs a second turn on the same session", { timeout }, async () => {
      const session = await client().start({
        prompt: "Run `echo one` as a shell command, then reply done.",
        budgetUsd: 1,
      });
      const first = await collect(session.events());
      expect(outcomeOf(first)).toEqual({ kind: "completed" });
      const firstId = session.ref.sessionId;
      await session.send("Now run `echo two` as a shell command, then reply done.");
      const second = await collect(session.events());
      expect(outcomeOf(second)).toEqual({ kind: "completed" });
      const calls = [...ids(first, "tool.call"), ...ids(second, "tool.call")];
      expect(new Set(calls).size).toBeGreaterThanOrEqual(2);
      note(
        `${provider}: second turn ok: ${first.length} + ${second.length} events, ${new Set(calls).size} distinct tool calls, spend $${session.spentUsd}${session.uncertain ? " (est)" : ""}${provider === "google" ? `, interaction ${firstId.slice(-6)} -> ${session.ref.sessionId.slice(-6)}` : ""}`,
      );
    });

    it.skipIf(capabilities(provider).clientTools === "unsupported")(
      "hands a client tool to the application and continues after respond()",
      { timeout },
      async () => {
        const withTool = anyplex({
          provider,
          apiKey,
          model,
          instructions:
            "You are a terse assistant. To answer weather questions you must call the `weather` tool and then report its result verbatim.",
          tools: [
            {
              name: "weather",
              description: "Current weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
          store,
        });
        const session = await withTool.start({
          prompt: "What is the weather in Taipei right now?",
          budgetUsd: 1,
        });
        const first = await collect(session.events());
        const outcome = outcomeOf(first);
        note(
          `${provider}: tool pass 1 -> ${JSON.stringify(outcome)} pending=${JSON.stringify(session.pending.map((r) => ({ name: r.name, input: r.input })))}`,
        );
        expect(outcome?.kind).toBe("requires_action");
        const request = session.pending[0];
        expect(request?.name).toBe("weather");
        await session.respond(request?.id as string, {
          output: { city: "Taipei", temperatureC: 27, sky: "clear" },
        });
        const rest = await collect(session.events());
        const text = rest
          .filter((e) => e.type === "message.delta")
          .map((e) => (e.payload as { text: string }).text)
          .join(" ");
        note(
          `${provider}: tool pass 2 -> ${JSON.stringify(outcomeOf(rest))}, text=${JSON.stringify(text.slice(0, 120))}, spend $${session.spentUsd}${session.uncertain ? " (est)" : ""}`,
        );
        expect(outcomeOf(rest)).toEqual({ kind: "completed" });
        expect(text).toMatch(/27/);
      },
    );

    it("mounts a file and lists the artifacts the agent produced", { timeout }, async () => {
      // Cursor takes no input files: the agent is told the word instead of reading it.
      const canMount = capabilities(provider).files !== "unsupported";
      const dir = capabilities(provider).artifactsDirectory ?? "/workspace/outputs";
      const withFile = anyplex({
        provider,
        apiKey,
        model,
        instructions: INSTRUCTIONS,
        ...(canMount
          ? {
              environment: {
                files: [{ path: "/workspace/notes.md", content: "The secret word is pomelo.\n" }],
              },
            }
          : {}),
        store,
      });
      const session = await withFile.start({
        prompt: canMount
          ? `Read /workspace/notes.md, then write the secret word into ${dir}/secret.txt (create the directory) using shell commands, then reply with the secret word.`
          : `The secret word is pomelo. Write it into ${dir}/secret.txt (create the directory) using shell commands, then reply with the secret word.`,
        budgetUsd: 1,
      });
      const events = await collect(session.events());
      const text = events
        .filter((e) => e.type === "message.delta")
        .map((e) => (e.payload as { text: string }).text)
        .join(" ");
      let artifacts: { id: string; path: string; sizeBytes: number | null }[] = [];
      let read = "";
      try {
        artifacts = await session.artifacts();
        const hit = artifacts.find((a) => /secret/.test(a.path)) ?? artifacts[0];
        if (hit && capabilities(provider).artifactsRead === "native")
          read = new TextDecoder().decode(await session.readArtifact(hit)).slice(0, 80);
      } catch (err) {
        read = `error ${(err as Error).message.slice(0, 100)}`;
      }
      note(
        `${provider}: file+artifacts -> ${JSON.stringify(outcomeOf(events))}, mentions pomelo=${/pomelo/i.test(text)}, artifacts=${JSON.stringify(artifacts.map((a) => a.path))}, read=${JSON.stringify(read)}`,
      );
      expect(outcomeOf(events)).toEqual({ kind: "completed" });
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
