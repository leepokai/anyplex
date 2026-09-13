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
- **A budget watchdog.** Pass `budgetUsd`; the session is interrupted upstream as soon as
  settled spend reaches it. Anthropic additionally gets a native session budget. Enforcement is
  between turns, so one long turn can overshoot.
- **stop()** that reaches the hosted session: interrupt and delete (Anthropic), cancel and delete
  (OpenAI), or cancel (Gemini). A `signal` only detaches; the session keeps running.
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
cached in `store`: `MemoryStore` by default, `FileStore("path.json")` for anything that restarts,
or your own `AgentStore`.

## Outcomes

`session.ended` carries one of `completed`, `budget_exceeded`, `requires_action` (the hosted
session wants a client tool result that anyplex does not provide), `terminated` (the provider
ended it), `stopped` (you called `stop()`), `detached` (your `signal` aborted; the session is
still running upstream), or `failed`.

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

## Things that will bite you

Every item below was hit while testing against the real vendors on 2026-09-13. Read this
before you rely on a number or a lifecycle.

**Spend**

- Spend is the provider's figure, not your invoice. Anthropic reports public list price; OpenAI
  and Gemini report tokens that anyplex prices with a small local rate table. A model missing
  from the table (`gpt-6-astra`, every Gemini model) is priced at a deliberately expensive
  fallback and the session is marked `uncertain`; treat those numbers as an upper bound.
- Anthropic rounds list cost to whole cents. A short warm-cache Haiku session reports $0.00,
  and the session object shows $0 until the turn ends. A budget below $0.01 cannot trigger,
  and a $0.01 budget only triggers once a turn actually costs a cent.
- OpenAI reports usage asynchronously, anywhere from seconds to more than a minute after the
  turn ends. anyplex waits about a minute with backoff. If usage still has not arrived, the
  session ends with `spent_usd: 0` and a `harness.event` of type `spend.unsettled`; call
  `attach()` on the same ref later and the spend settles. Do not treat `session.ended` as the
  final bill for OpenAI unless no `spend.unsettled` event was seen.
- The budget watchdog only sees spend when the provider reports it, so it acts between turns
  or after the turn, never inside one. For OpenAI it usually fires after the session already
  finished. If you need a hard ceiling inside a turn, put it on the provider side (Anthropic
  session budget, which anyplex sets from `budgetUsd`) or accept the overshoot.

**Sessions and agents**

- A finished session is left in place. Only `stop()` deletes it (Anthropic, OpenAI) or cancels it
  (Gemini). Budget stops interrupt but do not delete, so the transcript stays attachable.
- `attach()` to a session you already stopped ends with `failed` (Anthropic and OpenAI answer
  404) or `terminated` (Gemini); it never hangs.
- With the default `MemoryStore`, every new process creates a fresh provider-side agent:
  Anthropic makes an agent plus an environment, OpenAI an agent, Gemini reuses by id. Pass
  `FileStore` or your own `AgentStore` in anything that restarts.
- One `start()` is one prompt. There is no second turn on the same session yet.
- `events()` never throws for upstream failures; it ends with `session.ended` carrying
  `{ kind: "failed", error }`. Wrong keys and unknown models are rejected by `start()` itself
  within a second or two.

**OpenAI specifics**

- The Agents API accepted only `gpt-6-astra`, `gpt-5.2-codex`, and `gpt-5.2` on 2026-09-13,
  and only `gpt-6-astra` completed a turn; the other two failed upstream with `internal_error`
  before producing anything. Any other model is refused at `start()`.
- The hosted environment boots in about fifteen seconds and bills container time with a
  five-minute minimum, so a tiny task still costs a few cents of compute.
- Deleting a session whose turn is still cancelling is refused; `stop()` waits for the session
  to leave `in_progress` before deleting, which takes a few seconds.

**Gemini specifics**

- Every reconnect replays the whole interaction from the first event and `last_event_id` is
  ignored, so `attach()` on a long interaction re-reads it in full; dedupe keeps your consumer
  clean but the bytes still flow.
- A cancelled interaction replays without a terminal event; anyplex asks for the final status
  once more and ends with `terminated`.
- Hosted-agent pricing is unpublished; all Gemini spend is an estimate.

**Anthropic specifics**

- `session.usage` is the settled figure for a turn; anyplex reads it from the event history
  because the SDK's stream parser may drop it. Polling the session object mid-turn returns zeros.
- Sessions require Managed Agents beta access on the key; without it every call fails at
  `start()`.

## What has been verified, and how far

Everything below was checked on 2026-09-13. "Live" means against the real vendor with a real
key; "fake" means against the test doubles in `test/fakes`, whose shapes were captured from
live traffic that day.

| Behaviour | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| Create agent, start session, stream to completion | live (`claude-haiku-4-5`) | live (`gpt-6-astra`) | live (`gemini-3.8-flash`) |
| Tool call and result in the unified transcript | live | live (`command_execution`) | live (`code_execution_call` / `_result` via deltas) |
| Spend settles with the provider's figure | live (list cost, whole cents) | live (late usage, waited for; `spend.unsettled` when it never comes) | live (cumulative totals at the fallback rate) |
| `attach()` mid-run, after completion with state, after completion without state | live | live | live |
| Budget watchdog interrupts the session | live ($0.01 cap on a one-cent task) | live (fires after the turn, once usage lands) | live (fires mid-interaction) |
| Native provider budget (`budget_reached`) | fake only | n/a | n/a |
| `stop()` reaches the hosted session | live (interrupt + delete, ~1 s) | live (cancel + delete, ~4 s) | live (cancel, ~3 s) |
| `attach()` to a stopped session ends cleanly | live (`failed`, 404) | live (`terminated`) | live (`terminated`) |
| `signal` abort detaches and the session keeps running | live | live | live |
| Wrong key and unknown model rejected at `start()` | live | live | live |
| Two concurrent sessions on one cached agent | live | not run (cost) | live |
| `requires_action` and provider-side `failed` paths | unit only | unit only (`internal_error` seen live on other models) | unit only |
| Self-hosted environments, MCP and function tools, subagents, multi-turn | not covered | not covered | not covered |

Nothing here has been run for longer than a few minutes or under load. The live suite is
`pnpm e2e:live`; `test/live-scenarios.test.ts` is the list above as code.

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
