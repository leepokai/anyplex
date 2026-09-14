// Exercise your integration without a key or a bill: the fakes speak each vendor's dialect as
// observed live, and expose what the "vendor" saw.
//   pnpm example examples/with-fakes.ts
import { startFakeAnthropic, startFakeGoogle, startFakeOpenAI } from "../src/fakes/index.ts";
import { anyplex } from "../src/index.ts";

const anthropic = await startFakeAnthropic({ eventDelayMs: 5 });
const openai = await startFakeOpenAI({ eventDelayMs: 5 });
const google = await startFakeGoogle({ eventDelayMs: 5 });

const clients = [
  anyplex({
    provider: "anthropic",
    apiKey: "fake",
    baseUrl: anthropic.url,
    model: "claude-haiku-4-5",
    instructions: "x",
  }),
  anyplex({
    provider: "openai",
    apiKey: "fake",
    baseUrl: `${openai.url}/v1`,
    model: "gpt-5",
    instructions: "x",
  }),
  anyplex({
    provider: "google",
    apiKey: "fake",
    baseUrl: google.url,
    model: "gemini-3.8-flash",
    instructions: "x",
  }),
];

for (const client of clients) {
  const session = await client.start({ prompt: "go", budgetUsd: 1 });
  const types: string[] = [];
  for await (const event of session.events()) types.push(event.type);
  console.log(session.ref.provider, session.outcome?.kind, `$${session.spentUsd}`, types.join(" "));
}

// What the fake vendor saw, for assertions in your own tests.
console.log(
  "anthropic sessions:",
  [...anthropic.state.sessions.values()].map((s) => s.status),
);
await Promise.all([anthropic.close(), openai.close(), google.close()]);
