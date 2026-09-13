// Opt-in smoke against the real vendors (costs money). ANYPLEX_LIVE=anthropic,openai,google
// with ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY in the environment or a root .env.
import { appendFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anyplex, type ProviderName, type SessionEvent } from "../src/index.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const live = (process.env.ANYPLEX_LIVE ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p): p is ProviderName => p === "anthropic" || p === "openai" || p === "google");

const MODELS: Record<ProviderName, { key: string; model: string }> = {
  anthropic: {
    key: "ANTHROPIC_API_KEY",
    model: process.env.ANYPLEX_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  },
  // Agents API accepted gpt-6-astra, gpt-5.2-codex, gpt-5.2 on 2026-09-13; only gpt-6-astra completed a turn.
  openai: { key: "OPENAI_API_KEY", model: process.env.ANYPLEX_OPENAI_MODEL ?? "gpt-6-astra" },
  google: { key: "GEMINI_API_KEY", model: process.env.ANYPLEX_GOOGLE_MODEL ?? "gemini-3.8-flash" },
};

describe.skipIf(live.length === 0)("live", () => {
  for (const provider of live) {
    it(`${provider} runs one shell command`, { timeout: 300_000 }, async () => {
      const { key, model } = MODELS[provider];
      const apiKey = process.env[key];
      expect(apiKey, `${key} is required`).toBeTruthy();
      const client = anyplex({
        provider,
        apiKey: apiKey as string,
        model,
        instructions:
          "You are a terse assistant. Run exactly one shell command that prints hello, then stop.",
      });
      const session = await client.start({
        prompt: "Print hello with a shell command, then finish.",
        budgetUsd: 0.5,
      });
      const events: SessionEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (process.env.ANYPLEX_DEBUG)
          appendFileSync(
            process.env.ANYPLEX_DEBUG,
            `${provider} ${event.type} ${JSON.stringify(event.payload).slice(0, 160)}\n`,
          );
      }
      const last = events.at(-1);
      expect(last?.type).toBe("session.ended");
      expect(session.outcome).toEqual({ kind: "completed" });
      // Anthropic rounds list cost to whole cents, so a sub-cent session legitimately reports $0.
      if (provider === "anthropic") expect(session.spentUsd).toBeGreaterThanOrEqual(0);
      else expect(session.spentUsd).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "tool.call")).toBe(true);
      console.log(
        `${provider}: $${session.spentUsd}${session.uncertain ? " (estimated)" : ""}, ${events.length} events`,
      );
    });
  }
});
