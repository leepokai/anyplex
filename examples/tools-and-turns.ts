// Every layer at once: an application-side tool the agent can call, a second turn on the same
// session, and the files it left behind. Works on any provider; the flow is identical. Layers a
// provider lacks (Cursor: client tools, input files) are left out via `capabilities()`.
//   OPENAI_API_KEY=... pnpm example examples/tools-and-turns.ts
//   ANYPLEX_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm example examples/tools-and-turns.ts
//   ANYPLEX_PROVIDER=cursor CURSOR_API_KEY=... pnpm example examples/tools-and-turns.ts
import { anyplex, capabilities, type ProviderName, type SessionEvent } from "../src/index.ts";

const provider = (process.env.ANYPLEX_PROVIDER ?? "openai") as ProviderName;
const config = {
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-6-astra" },
  google: { key: "GEMINI_API_KEY", model: "gemini-3.8-flash" },
  cursor: { key: "CURSOR_API_KEY", model: "composer-2" },
}[provider];
const apiKey = process.env[config.key];
if (!apiKey) throw new Error(`${config.key} is not set`);

const caps = capabilities(provider);
const clientTools = caps.clientTools !== "unsupported";
const inputFiles = caps.files !== "unsupported";
const outputs = caps.artifactsDirectory ?? "/workspace/outputs";

const agent = anyplex({
  provider,
  apiKey,
  model: process.env.ANYPLEX_MODEL ?? config.model,
  instructions: clientTools
    ? "You are a terse assistant. When the user asks for the weather, call the `weather` tool; never guess."
    : "You are a terse assistant. Use shell commands to do what the user asks, then stop.",
  // The application executes this tool; the agent only asks.
  ...(clientTools
    ? {
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
      }
    : {}),
  ...(inputFiles
    ? {
        environment: {
          files: [{ path: "/workspace/notes.md", content: "The user lives in Taipei.\n" }],
        },
      }
    : {}),
});

function show(event: SessionEvent) {
  if (event.type === "message.delta") process.stdout.write(event.payload.text);
  else if (event.type === "tool.request")
    console.log(`\n? agent asks ${event.payload.name} ${JSON.stringify(event.payload.input)}`);
  else if (event.type === "tool.call") console.log(`\n> ${String(event.payload.name)}`);
  else if (event.type === "session.ended")
    console.log(`\n[${event.payload.outcome.kind}] $${event.payload.spent_usd}`);
}

// Drive one turn to completion, answering tool requests as they come.
async function drive(session: Awaited<ReturnType<typeof agent.start>>) {
  for (;;) {
    for await (const event of session.events()) show(event);
    if (session.outcome?.kind !== "requires_action") return;
    for (const request of session.pending) {
      if (request.kind === "tool") {
        const city = (request.input as { city?: string }).city ?? "somewhere";
        await session.respond(request.id, { output: { city, temperatureC: 27, sky: "clear" } });
      } else await session.approve(request.id, true);
    }
  }
}

const session = await agent.start({
  prompt: !clientTools
    ? "Print the current date with a shell command and tell me what it is."
    : inputFiles
      ? "Read /workspace/notes.md, then tell me the weather where the user lives."
      : "Tell me the weather in Taipei.",
  budgetUsd: 0.5,
});
await drive(session);

await session.send(
  `Now write what you found to ${outputs}/report.txt (create the directory) and tell me its size.`,
);
await drive(session);

console.log("artifacts:", await session.artifacts());
if (capabilities(provider).artifactsRead === "native") {
  const [first] = await session.artifacts();
  if (first)
    console.log(
      `${first.path}: ${new TextDecoder().decode(await session.readArtifact(first)).slice(0, 200)}`,
    );
}
console.log("persist this to attach later:", JSON.stringify(session.state()).slice(0, 120), "...");
