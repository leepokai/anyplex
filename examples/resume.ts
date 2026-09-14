// Survive a restart: run this script twice. The first run starts a session, saves the ref and
// state to a JSON file, and stops consuming after the first tool call. The second run attaches
// and prints only what the first run never saw.
//   ANTHROPIC_API_KEY=... pnpm example examples/resume.ts && pnpm example examples/resume.ts
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { anyplex, FileStore, type SessionRef, type SessionState } from "../src/index.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
const saved = "examples/.resume.json";

const agent = anyplex({
  provider: "anthropic",
  apiKey,
  model: "claude-haiku-4-5",
  instructions: "You are a terse assistant. Use shell commands, then stop.",
  // The provider-side agent survives restarts too; MemoryStore would create a new one per process.
  store: new FileStore("examples/.agents.json"),
});

if (!existsSync(saved)) {
  const session = await agent.start({
    prompt:
      "Run `echo one`, then `sleep 5`, then `echo two`, each as its own command. Then reply done.",
    budgetUsd: 0.5,
  });
  for await (const event of session.events()) {
    console.log(event.type, JSON.stringify(event.payload).slice(0, 80));
    if (event.type === "tool.call") break; // simulate the process dying here
  }
  writeFileSync(saved, JSON.stringify({ ref: session.ref, state: session.state() }, null, 2));
  console.log(`saved ${saved}; run again to attach`);
} else {
  const { ref, state } = JSON.parse(readFileSync(saved, "utf8")) as {
    ref: SessionRef;
    state: SessionState;
  };
  const session = agent.attach(ref, { ...state, budgetUsd: 0.5 });
  for await (const event of session.events())
    console.log(event.type, JSON.stringify(event.payload).slice(0, 80));
  unlinkSync(saved);
}
