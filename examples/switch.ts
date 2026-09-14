// Same code, any vendor: the only thing that changes is the "provider/model" route.
//   ANTHROPIC_API_KEY=... pnpm example examples/switch.ts anthropic/claude-haiku-4-5
//   GEMINI_API_KEY=...    pnpm example examples/switch.ts google/gemini-3.8-flash
//   OPENAI_API_KEY=...    pnpm example examples/switch.ts openai/gpt-6-astra
//   CURSOR_API_KEY=...    pnpm example examples/switch.ts cursor/claude-haiku-4-5
import { existsSync } from "node:fs";
import { anyplex, parseModel } from "../src/index.ts";

// Keys come from the environment or a local .env (ignored by git).
if (existsSync(".env")) process.loadEnvFile(".env");

const route = process.argv[2] ?? "anthropic/claude-haiku-4-5";
const { provider } = parseModel(route);
const keys = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  cursor: "CURSOR_API_KEY",
} as const;
const keyName = provider ? keys[provider] : null;
const apiKey = keyName ? process.env[keyName] : undefined;
if (!apiKey) throw new Error(`${keyName ?? "a provider key"} is not set`);

const agent = anyplex({
  apiKey,
  model: route,
  instructions:
    "You are a terse assistant. Use shell commands to do what the user asks, then stop.",
});

const session = await agent.start({
  prompt: "Print the date and the kernel name with one shell command, then reply done.",
  budgetUsd: 0.5,
});
console.log(`${route}  session ${session.ref.sessionId.slice(0, 20)}…`);

for await (const event of session.events()) {
  switch (event.type) {
    case "tool.call": {
      const input = event.payload.input as { command?: string; code?: string } | null;
      console.log(
        `  > ${String(event.payload.name)}  ${input?.command ?? input?.code ?? ""}`.trimEnd(),
      );
      break;
    }
    case "tool.result":
      console.log(`  < ${event.payload.is_error ? "error" : "ok"}`);
      break;
    case "message.delta":
      process.stdout.write(event.payload.text);
      break;
    case "session.ended":
      // Anthropic prices in whole cents, so a tiny run can settle at $0.00.
      console.log(
        `\n  ${event.payload.outcome.kind}  $${event.payload.spent_usd.toFixed(4)}${event.payload.uncertain ? " (estimate)" : ""}\n`,
      );
      break;
  }
}
