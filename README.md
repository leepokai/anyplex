# anyplex

One session interface for hosted agent runtimes.

| Provider | API | Status on 2026-09-13 |
|---|---|---|
| `anthropic` | Claude Managed Agents (`managed-agents-2026-04-01`) | beta, verified live |
| `openai` | OpenAI Agents API (`client.beta.agents`) | public beta since 2026-09-10, verified live with `gpt-6-astra` |
| `google` | Gemini Managed Agents (Interactions API, `antigravity-preview-05-2026`) | preview, verified live with `gemini-3.8-flash` |

The three runtimes converged on the same shape: a persisted agent, a hosted session with its own
sandbox, and an event stream. anyplex drives all three through one loop and gives you what the
raw SDKs do not:

- **One event stream.** `message.delta`, `tool.call`, `tool.result`, `harness.event`,
  `spend.updated`, `session.ended`, identical across providers.
- **Spend that is actually right.** Anthropic prices the session (polled, because the SDK drops
  `session.usage`); OpenAI reports usage seconds after the turn ends (waited for); Gemini
  reports cumulative totals (diffed). Unpriced models are estimated at a deliberately expensive
  fallback rate and flagged `uncertain`.
- **A budget watchdog.** Pass `budgetUsd`; the session is stopped upstream as soon as settled
  spend reaches it. Anthropic additionally gets a native session budget. Enforcement is between
  turns, so one long turn can overshoot.
- **stop()** that reaches the hosted session: interrupt and delete, cancel and delete, or cancel.
- **Lossless re-attach.** Persist `session.ref` and `session.state()`; `attach()` replays history
  and skips what you already saw, so a process restart duplicates neither spend nor finished
  upstream items. Works even where the provider has no replay (OpenAI) or no event ids (Gemini).
  An upstream item whose events you only partly consumed is redelivered in full; every event
  carries `upstreamId`, so dedupe on it if you need exactly-once.
- **Fakes.** Test doubles for all three APIs, shaped from live traffic, so your own tests never
  spend money.

## Install

```sh
pnpm add anyplex
```

Node 22.13 or newer. The official vendor SDKs are dependencies; you only need the key of the
provider you use.

## Use

```ts
import { anyplex } from "anyplex";

const agent = anyplex({
  provider: "openai",                 // "anthropic" | "openai" | "google"
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6-astra",
  instructions: "You fix failing tests in the repository you are given.",
});

const session = await agent.start({
  prompt: "Run the test suite and fix the first failure.",
  budgetUsd: 0.5,
});

for await (const event of session.events()) {
  switch (event.type) {
    case "message.delta":  process.stdout.write(event.payload.text); break;
    case "tool.call":      console.log("tool", event.payload.name, event.payload.input); break;
    case "spend.updated":  console.log(`$${event.payload.spent_usd}`); break;
    case "session.ended":  console.log(event.payload.outcome, `$${event.payload.spent_usd}`); break;
  }
}
```

Stop from anywhere:

```ts
await session.stop(); // events() ends with { kind: "stopped" }
```

Survive a restart:

```ts
// process A
save({ ref: session.ref, state: session.state() });

// process B
const resumed = agent.attach(saved.ref, { ...saved.state, budgetUsd: 0.5 });
for await (const event of resumed.events()) { /* only what A never saw */ }
```

Swap the provider by changing two strings. The agent object is created once per definition and
cached in `store` (in-memory by default; implement `AgentStore` to persist it).

## Outcomes

`session.ended` carries one of `completed`, `budget_exceeded`, `requires_action` (the hosted
session wants a client tool result that anyplex does not provide), `terminated` (the provider
ended it), `stopped`, or `failed`.

## What it does not do

- Move a session between providers. The model and the sandbox belong to the provider.
- Read files out of the hosted sandbox. Use the provider's own artifact APIs.
- Continue a session with a second prompt. One `start()` is one prompt; multi-turn is next.

## Testing

```sh
pnpm test                       # translators + session runner against the fakes, no keys
pnpm e2e:live                   # real vendors (ANYPLEX_LIVE=anthropic,openai,google), needs keys, costs money
```

## Scope

anyplex is an adapter layer and nothing more. It does not persist anything, queue anything,
retry beyond the vendor SDK defaults, or run a loop of its own. The agent loop, the sandbox,
the model, and the bill all belong to the provider; anyplex only speaks their three dialects
through one interface. All three APIs are beta or preview and may change under it.

## What has been verified, and how far

Everything below was checked on 2026-09-13. "Live" means against the real vendor with a real
key; "fake" means against the test doubles in `test/fakes`, whose shapes were captured from
live traffic that day.

| Behaviour | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Create agent, start session, stream to completion | live (`claude-haiku-4-5`) | live (`gpt-6-astra`) | live (`gemini-3.8-flash`) |
| Tool call and result in the unified transcript | live | live (`command_execution`) | live (`code_execution_call` / `_result` via deltas) |
| Spend settles with the provider's figure | live (list cost, rounded to whole cents) | live (usage arrives late, waited for) | live (cumulative totals, priced at the fallback rate) |
| History replay on attach | fake only (stream + list overlap) | fake only (items and turns backfill) | live: replay from the first event observed; dedupe fake only |
| Budget watchdog stops the session | fake only | fake only | fake only |
| Native provider budget (`budget_reached`) | fake only | n/a | n/a |
| `stop()` reaches the hosted session | fake only | fake only | fake only |
| `requires_action`, `terminated`, `failed` paths | fake / unit only | fake / unit only (`internal_error` seen live on other models) | fake / unit only |
| Self-hosted environments, MCP and function tools, subagents, multi-turn | not covered | not covered | not covered |

Known gaps you should expect to hit first: OpenAI models other than `gpt-6-astra` failed
upstream that day; Gemini hosted-agent pricing is unpublished, so its spend is an estimate;
the watchdog can only act between turns; nothing here has been run for longer than a few
minutes or under load.

## Provider notes

- **OpenAI.** The Agents API accepted `gpt-6-astra`, `gpt-5.2-codex`, and `gpt-5.2` on
  2026-09-13; only `gpt-6-astra` completed a turn, the other two failed upstream with
  `internal_error`. Turn events carry `usage: null`; the session object fills in about seven
  seconds after idle, and anyplex waits up to thirty seconds for it.
- **Gemini.** Agents need a caller-chosen id (derived from the definition hash). Interactions
  run with `environment: "remote"` and `background: true`. Events carry no ids and every reconnect
  replays from the start; anyplex stamps ordinal ids for dedupe. Hosted-agent pricing is
  undisclosed, so spend is an estimate.
- **Anthropic.** Sessions are deleted at the end for hygiene. List cost is public list price,
  not your contracted price.

## License

MIT
