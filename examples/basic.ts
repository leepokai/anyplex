// Start one hosted session and print its unified event stream.
//   OPENAI_API_KEY=... pnpm example examples/basic.ts
//   ANYPLEX_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm example examples/basic.ts
//   ANYPLEX_PROVIDER=cursor CURSOR_API_KEY=... pnpm example examples/basic.ts
import { anyplex, type ProviderName } from "../src/index.ts";

const provider = (process.env.ANYPLEX_PROVIDER ?? "openai") as ProviderName;
const config = {
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-6-astra" },
  google: { key: "GEMINI_API_KEY", model: "gemini-3.8-flash" },
  cursor: { key: "CURSOR_API_KEY", model: "composer-2" },
}[provider];
const apiKey = process.env[config.key];
if (!apiKey) throw new Error(`${config.key} is not set`);

const agent = anyplex({
  provider,
  apiKey,
  model: process.env.ANYPLEX_MODEL ?? config.model,
  instructions:
    "You are a terse assistant. Use shell commands to do what the user asks, then stop.",
});

const session = await agent.start({
  prompt: "Create a file named hello.txt containing 'hello', then print its contents.",
  budgetUsd: 0.5,
});
console.log(`session ${session.ref.sessionId} on ${provider}`);

for await (const event of session.events()) {
  switch (event.type) {
    case "message.delta":
      process.stdout.write(event.payload.text);
      break;
    case "tool.call":
      console.log(`\n> ${String(event.payload.name)} ${JSON.stringify(event.payload.input)}`);
      break;
    case "tool.result":
      console.log(`< ${event.payload.is_error ? "error" : "ok"}`);
      break;
    case "spend.updated":
      console.log(`$ ${event.payload.spent_usd}${event.payload.uncertain ? " (estimated)" : ""}`);
      break;
    case "session.ended":
      console.log(`\n${event.payload.outcome.kind}, $${event.payload.spent_usd}`);
      break;
  }
}
