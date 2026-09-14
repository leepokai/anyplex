// Two ways a session ends early: a USD cap the watchdog enforces, and stop() from another task.
//   GEMINI_API_KEY=... pnpm example examples/budget-and-stop.ts
import { anyplex } from "../src/index.ts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
const agent = anyplex({
  provider: "google",
  apiKey,
  model: "gemini-3.8-flash",
  instructions: "You are a terse assistant. Use code execution, then stop.",
});

// 1. Budget: Gemini spend is estimated at an expensive fallback rate, so a tiny cap trips fast.
const capped = await agent.start({
  prompt: "Print the numbers 1 to 5, one per line.",
  budgetUsd: 0.005,
});
for await (const event of capped.events())
  if (event.type === "session.ended")
    console.log("capped:", event.payload.outcome, `$${event.payload.spent_usd}`);

// 2. stop(): interrupt from outside the consumer loop.
const stopped = await agent.start({
  prompt: "Print the numbers 1 to 100, sleeping 1 second between each.",
  budgetUsd: 1,
});
setTimeout(() => void stopped.stop(), 4000);
for await (const event of stopped.events())
  if (event.type === "session.ended")
    console.log("stopped:", event.payload.outcome, `$${event.payload.spent_usd}`);
