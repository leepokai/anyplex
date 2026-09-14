<img src="assets/icon.svg" width="96" alt="anyplex: four strands converging into one hub and leaving as one line">

# anyplex

LiteLLM for managed agents: one session interface for hosted agent runtimes.

| Provider | API | Status on 2026-09-14 |
|---|---|---|
| `anthropic` | Claude Managed Agents (`managed-agents-2026-04-01`) | beta, verified live |
| `openai` | OpenAI Agents API (`client.beta.agents`) | public beta since 2026-09-10, verified live with `gpt-6-astra` |
| `google` | Gemini Managed Agents (Interactions API, `antigravity-preview-05-2026`) | preview, verified live with `gemini-3.8-flash` |
| `cursor` | Cursor Cloud Agents API v1 (`api.cursor.com`) | public beta, verified live with `claude-haiku-4-5` (Pro plan required) |

The four runtimes converged on the same shape: a persisted agent, a hosted session with its own
sandbox, and an event stream. anyplex drives all of them through one loop and gives an
application every layer it needs, in one vocabulary:

- **Definition.** Instructions, model, tools the application executes, MCP servers with
  credentials, the sandbox environment (files, repositories, network, packages, setup commands),
  and a permission policy. Each provider maps it onto its own objects; what a provider cannot do
  is refused at construction, never silently dropped.
- **One event stream.** `message.delta`, `tool.call`, `tool.result`, `tool.request`,
  `approval.request`, `harness.event`, `spend.updated`, `session.ended`, identical across
  providers.
- **Turns.** `start()` runs the first turn; `send()` runs the next on the same session;
  `respond()` and `approve()` answer what the agent is waiting on; `events()` drives one turn at
  a time.
- **Spend that is actually right.** Anthropic prices the session (read from the settled
  `session.usage` history); OpenAI reports usage seconds to a minute after the turn (waited
  for, with backoff); Gemini reports cumulative totals per interaction (diffed, reset per
  chained interaction); Cursor reports the charged cost in cents on its usage endpoint.
  Unpriced models use a deliberately expensive fallback rate and are flagged `uncertain`;
  pass `rates` to price them yourself.
- **A budget watchdog.** `budgetUsd` interrupts the session upstream as soon as settled spend
  reaches it; Anthropic additionally enforces it natively.
- **stop()** that reaches the hosted session; a `signal` only detaches.
- **Lossless re-attach.** Persist `session.state()`; `attach()` replays history and skips what
  you already saw, treats earlier turns as transcript only, and never reopens an answered
  request. Works where the provider has no replay (OpenAI) or no event ids (Gemini).
- **Artifacts.** List and read the files the agent left in its sandbox.
- **Fakes.** `anyplex/fakes` ships test doubles for all four APIs, shaped from live traffic
  (or, for Cursor, the published spec) including their timing quirks, so your own tests never
  spend money.
- **Errors you can route on.** Every rejection is an `AnyplexError` with the vendor's `status`,
  `code`, a `retryable` hint, and the original error as `cause`.
- **Your own runtime.** Implement `Provider` and pass the object instead of a name.
- **A relay on top.** `docs/gateway-readiness.md` is the compatibility promise for building a
  LiteLLM-style multi-tenant relay over this package without a breaking change.

## Install

```sh
pnpm add anyplex
```

Node 22.13 or newer. The official vendor SDKs are dependencies; you only need the key of the
provider you use. `anyplex/fakes` additionally needs `hono` and `@hono/node-server`.

## Use

```ts
import { anyplex } from "anyplex";

const agent = anyplex({
  provider: "openai",                 // "anthropic" | "openai" | "google" | "cursor" | your Provider
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-6-astra",               // or omit `provider` and route with model: "openai/gpt-6-astra"
  instructions: "You fix failing tests in the repository you are given.",
  tools: [
    {
      name: "lookup_ticket",
      description: "Fetch a ticket from our tracker.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ],
  environment: {
    repositories: [{ url: "https://github.com/acme/api", path: "/workspace/api", ref: "main" }],
    network: { allowedHosts: ["registry.npmjs.org"] },
  },
});

const session = await agent.start({ prompt: "Ticket 42 says the build is red. Fix it.", budgetUsd: 2 });

for (;;) {
  for await (const event of session.events()) {
    switch (event.type) {
      case "message.delta":   process.stdout.write(event.payload.text); break;
      case "tool.call":       console.log("agent ran", event.payload.name); break;
      case "tool.request":    console.log("agent asks for", event.payload.name); break;
      case "spend.updated":   console.log(`$${event.payload.spent_usd}`); break;
      case "session.ended":   console.log(event.payload.outcome.kind); break;
    }
  }
  if (session.outcome?.kind !== "requires_action") break;
  for (const request of session.pending) {
    if (request.kind === "tool") await session.respond(request.id, { output: await lookupTicket(request.input) });
    else await session.approve(request.id, true);
  }
}

await session.send("Now open a pull request description for the change.");
for await (const event of session.events()) { /* the next turn */ }

for (const artifact of await session.artifacts()) console.log(artifact.path, artifact.sizeBytes);
```

Stop from anywhere: `await session.stop()`. Survive a restart: persist `session.state()` and
call `agent.attach(state.ref, state)` from the new process.

## The definition

| Field | Meaning | anthropic | openai | google | cursor |
|---|---|---|---|---|---|
| `instructions` | System prompt | agent `system` | agent `instructions` | agent instructions | no REST field: prepended to the first prompt (emulated) |
| `tools` | Tools the application executes; arrive as `tool.request` | custom tools | function tools | function tools | unsupported (MCP only) |
| `mcpServers` | Remote MCP servers the agent may call | `mcp_servers` + toolset; bearer tokens in a vault | `mcp` tool with http transport, bearer and headers | `mcp_server` tool with headers | inline `mcpServers` (http) with headers; bearer becomes `Authorization` |
| `environment.files` | Text files placed in the sandbox | Files API upload + session resource, mounted under `/mnt/session/uploads/` | inline files (base64) at the given path | inline sources at the given path | unsupported |
| `environment.repositories` | Repositories cloned in | `github_repository` resource with token and branch | `git clone` setup command (emulated) | repository source, no token | `repos[]` with `startingRef`; access through Cursor's GitHub App, no token |
| `environment.network` | `"unrestricted"`, `"none"`, or `{ allowedHosts }` | environment networking | environment network | allowlist / disabled | unsupported |
| `environment.packages` | `npm`, `pip`, `apt` | environment packages | environment packages | unsupported | unsupported |
| `environment.setupCommands` | Shell commands before the agent starts | unsupported | setup commands | unsupported | unsupported |
| `permissions` | `"allow"`, `"ask"`, `"auto"` for built-in tools | toolset permission policy | unsupported | unsupported | unsupported |
| `rates` | Price overrides by model id | any | any | any | any (no built-in table) |
| `providerOptions` | Raw params merged into `agent`, `session`, `environment` creates | yes | yes | yes | `agent` and `session` merge into the create body; `environment` becomes `env` |
| `store` | Where the provider-side agent id is cached | `MemoryStore` (default), `FileStore`, your own | | | no provider-side object; the store is unused |

`capabilities(provider)` returns the same information as data (`native`, `emulated`,
`unsupported`). Using an unsupported field throws `UnsupportedError` from `anyplex()`.

## The session

| Member | What it does |
|---|---|
| `events()` | Drives the current turn and yields unified events; ends with `session.ended`. Call it again after `send()`, `respond()`, or `approve()`. |
| `send(prompt)` | Next user turn on the same session. Refused while requests are pending. |
| `pending` | `ToolRequest`s the agent is waiting on (`kind: "tool"` or `"approval"`). |
| `respond(id, { output })` / `respond(id, { error })` | Answer a `tool.request`. |
| `approve(id, allow, reason?)` | Answer an `approval.request` (Anthropic). |
| `artifacts()` / `readArtifact(a)` | Files produced in the sandbox (Gemini: list only; Cursor: `/opt/cursor/artifacts`). |
| `stop()` | Interrupt and delete (Anthropic, OpenAI), cancel (Gemini), cancel the run and delete the agent (Cursor). |
| `state()` / `ref` | Everything to `attach()` from another process. Gemini's `ref.sessionId` advances on every turn, so persist after each pass. |
| `spentUsd`, `uncertain`, `outcome` | Settled spend, whether any of it is an estimate, the last pass's outcome. |

Outcomes: `completed` (the turn is done; `send()` is allowed), `requires_action` (answer
`pending`), `budget_exceeded`, `terminated` (the provider ended it), `stopped`, `detached`
(your `signal` aborted; the session keeps running), `failed` (with the vendor's `code` and
`status` when known).

Every rejection from a session method is an `AnyplexError` (`provider`, `status`, `code`,
`retryable`, `cause`); `UnsupportedError` is one of them.

## Examples

Runnable scripts in [`examples/`](examples): `basic.ts` (stream one session on any provider),
`tools-and-turns.ts` (client tool, second turn, artifacts), `resume.ts` (save the state, attach
from a second run), `budget-and-stop.ts` (cap and `stop()`), `with-fakes.ts` (no key at all).
Run one with `pnpm example examples/basic.ts`.

## Scope

anyplex is an adapter layer and nothing more. It does not persist anything, queue anything,
retry beyond the vendor SDK defaults, or run a loop of its own. The agent loop, the sandbox,
the model, and the bill all belong to the provider; anyplex only speaks their four dialects
through one interface. All four APIs are beta or preview and may change under it.

## Things that will bite you

Every item below was hit while testing against the real vendors. Read this before you rely
on a number or a lifecycle.

**Spend**

- Spend is the provider's figure, not your invoice. Anthropic reports public list price; OpenAI
  and Gemini report tokens that anyplex prices with a small local rate table. A model missing
  from the table (`gpt-6-astra`, every Gemini model) is priced at a deliberately expensive
  fallback and the session is marked `uncertain`; pass `rates` or treat it as an upper bound.
- Anthropic rounds list cost to whole cents. A short warm-cache Haiku session reports $0.00,
  and the session object shows $0 until the turn ends. A budget below $0.01 cannot trigger.
- OpenAI reports usage asynchronously, anywhere from seconds to more than a minute after the
  turn ends. anyplex waits about a minute with backoff. If usage still has not arrived, the
  pass ends with a `harness.event` of type `spend.unsettled`; `attach()` later settles it.
- The budget watchdog acts between turns or after the turn, never inside one. For OpenAI it
  usually fires after the session already finished.

**Turns and requests**

- One `events()` pass is one turn. When it ends with `requires_action`, nothing happens
  upstream until you `respond()` or `approve()` every request in `pending` and call `events()`
  again. Anthropic rejects a new `send()` while requests are pending.
- An upstream item whose events you only partly consumed is redelivered in full on `attach()`;
  every event carries `upstreamId`, so dedupe on it if you need exactly-once.
- Gemini function-call arguments are taken from a single streamed chunk; multi-chunk argument
  streams are not buffered yet.

**Sessions and agents**

- A finished session is left in place. Only `stop()` deletes it (Anthropic, OpenAI) or cancels it
  (Gemini). Budget stops interrupt but do not delete, so the transcript stays attachable.
- `attach()` to a session you already stopped ends with `failed` (Anthropic and OpenAI answer
  404) or `terminated` (Gemini); it never hangs.
- With the default `MemoryStore`, every new process creates a fresh provider-side agent, and
  for Anthropic also an environment and, with MCP tokens, a vault. Pass `FileStore` or your own
  `AgentStore` in anything that restarts.
- `events()` never throws for upstream failures; it ends with `session.ended` carrying
  `{ kind: "failed", error }`. Wrong keys and unknown models are rejected by `start()` itself.

**Artifacts and files**

- Each provider collects artifacts from a different place: Anthropic from
  `/mnt/session/outputs`, OpenAI from `/workspace/outputs`, Gemini lists the whole environment
  (inputs included). `capabilities(provider).artifactsDirectory` says where; tell the agent to
  write there.
- Anthropic mounts uploaded files under `/mnt/session/uploads/<path>` and indexes outputs one to
  three seconds after the turn ends; `artifacts()` retries twice when the list is empty.
- Gemini can list but not download files through the public API.

**OpenAI specifics**

- The Agents API accepted only `gpt-6-astra`, `gpt-5.2-codex`, and `gpt-5.2` on 2026-09-13,
  and only `gpt-6-astra` completed a turn; the other two failed upstream with `internal_error`.
- The hosted environment boots in about fifteen seconds and bills container time with a
  five-minute minimum, so a tiny task still costs a few cents of compute.
- Deleting a session whose turn is still cancelling is refused; `stop()` waits for the session
  to leave `in_progress` before deleting.
- Repositories are emulated with a `git clone` setup command; a token is embedded in the clone
  URL and removed from the remote afterwards.
- The hosted environment occasionally fails to provision. The session then ends `failed`, the
  turn is no longer active, and a `respond()` to it is refused with 409 ("the hosted environment
  failed to provision" on inspection). Start a new session; nothing on your side caused it.
- Function-call requests surface on the session object (`required_actions`) and as in-progress
  items before the turn completes; anyplex reads both.

**Gemini specifics**

- Every reconnect replays the whole interaction from the first event and `last_event_id` is
  ignored; dedupe keeps your consumer clean but the bytes still flow.
- A cancelled interaction replays without a terminal event; anyplex asks for the final status
  once more and ends with `terminated`.
- Each turn is a new interaction chained with `previous_interaction_id` on the same
  environment; `ref.sessionId` moves forward, so persist `state()` after every pass. Chaining
  in the same instant the previous interaction settled can fail with "Precondition check
  failed"; anyplex waits for the previous interaction to be final and retries briefly.
- Artifacts can be listed but not downloaded through the public API; repository tokens and
  packages have no mapping.

**Cursor specifics**

- Cloud Agents need a Cursor Pro plan or above: a free account gets `403 plan_required` on
  every endpoint, including `/v1/me`, so `start()` fails immediately with that code.
- `POST /v1/agents` blocks until the VM is provisioned, about 60 s live, and the connection can
  be reset before it answers while the agent is created anyway. anyplex sends a client-chosen
  `agentId` and converges on it (retry answers `409 agent_id_conflict`, or the agent is fetched
  by id), so a reset never leaks a second agent. Follow-up runs return in about a second.
  Passing `envVars` through `providerOptions` disables this, because Cursor refuses `agentId`
  next to it.
- The usage endpoint carries `cost.chargedCents` (undocumented, observed live); anyplex uses
  it as the settled spend, so `rates` only matter if that field disappears. A one-command
  `claude-haiku-4-5` run cost $0.006 to $0.03 depending on prompt-cache writes.
- Model ids come from `GET /v1/models` (`claude-haiku-4-5`, `composer-2.5`, `gpt-5.4-nano`,
  `default`, ...); an unknown id fails at `start()` with `400 invalid_model`.
- There is no system-prompt field in the REST API (the SDK's `systemPrompt` is local-only).
  anyplex prepends `instructions` to the first prompt; later turns rely on the conversation.
- The final reply is streamed as `assistant` deltas and then repeated in the `result` event;
  anyplex emits it once. Every simplified event is mirrored by an `interaction_update` frame
  with the same id, and `result` and `done` share an id; anyplex ignores the mirrors.
- No client tools: the agent can only reach your code through an MCP server you host. Input
  files, network policy, packages, and setup commands have no mapping either; repositories are
  GitHub only and must already be connected through Cursor's GitHub App.
- One run per agent at a time. `send()` while a run is still winding down would get
  `409 agent_busy`; anyplex waits up to 30 s for the previous run to settle and retries.
- A run's stream is not open right after the run is created: it answers two `status` frames,
  then `error stream_unavailable` and `done`, about two seconds in. anyplex re-checks the run
  and reconnects with backoff; the first run's stream is ready by the time the create call
  returns, so this only shows on `send()`.
- The run stream is retained for 24 h (`X-Cursor-Stream-Retention-Seconds: 86400`). After
  that, `attach()` settles from the run object, whose transcript is only the final reply.
  Earlier runs always replay as their final reply only, fetched one by one because the run
  list omits `result`; attaching without state to a three-run agent took 12 s live and
  reported the cost of all runs.
- The agent works in `/agent` (a plain VM, home `/home/ubuntu`). Only files under
  `/opt/cursor/artifacts` (a symlink into Cursor's store) are listed by `artifacts()`, as
  `artifacts/<name>`; a file written to `./artifacts` in the workspace is not. Tell the agent
  the absolute path; `capabilities("cursor").artifactsDirectory` is it.
- `stop()` cancels the active run and deletes the agent (about 6 s live); a budget stop only
  cancels, and since spend is known only after the run ends, it fires after the run finished.
- No-repo agents (no `repositories`) must be enabled for the account; repository-scoped keys
  cannot create them.

**Anthropic specifics**

- `session.usage` is the settled figure for a turn; anyplex reads it from the event history
  because the SDK's stream parser may drop it. Polling the session object mid-turn returns zeros.
- Sessions require Managed Agents beta access on the key; without it every call fails at
  `start()`.
- MCP headers other than a bearer token have no mapping; bearer tokens are stored in a vault
  created with the agent.

## What has been verified, and how far

"Live" means against the real vendor with a real key; "fake" means against the test doubles in
`anyplex/fakes`, whose shapes and timing quirks were captured from live traffic on 2026-09-13.

| Behaviour | Anthropic | OpenAI | Gemini | Cursor |
|---|---|---|---|---|
| Create agent, start session, stream to completion | live | live | live | live |
| Tool call and result in the unified transcript | live | live | live | live |
| Spend settles with the provider's figure | live | live | live | live (`cost.chargedCents`) |
| `attach()` mid-run, after completion with state, after completion without state | live | live | live | live |
| Budget watchdog interrupts the session | live | live | live | live (fires after the run) |
| `stop()` reaches the hosted session | live | live | live | live |
| `attach()` to a stopped session ends cleanly | live | live | live | live |
| `signal` abort detaches and the session keeps running | live | live | live | live |
| Wrong key and unknown model rejected at `start()` | live | live | live | live |
| Second turn with `send()` | live | live | live | live |
| Client tool round trip (`tool.request` → `respond()`) | live | live | live | n/a |
| Approval round trip (`approval.request` → `approve()`) | fake | n/a | n/a | n/a |
| Environment files (mounted and read by the agent) | live | live | live | n/a |
| Repositories, network, packages, MCP mapping | fake | fake | fake | fake (repositories, MCP) |
| Artifacts list and read | live (`/mnt/session/outputs`) | live (`/workspace/outputs`) | live (list only, whole environment) | live (`/opt/cursor/artifacts`) |
| Earlier runs replay as transcript on attach without state | n/a | n/a | n/a | live (three-run agent) |
| Expired stream settles from the run object | n/a | n/a | n/a | fake |
| Two concurrent sessions on one cached agent | live | not run (cost) | live | live |
| Native provider budget (`budget_reached`) | fake | n/a | n/a | n/a |
| Self-hosted environments, subagents, long runs, load | not covered | not covered | not covered | not covered |

The live suite is `pnpm e2e:live`; `test/live-scenarios.test.ts` is the list above as code.
Cursor was verified on 2026-09-14 with `claude-haiku-4-5` on a Pro plan: eleven scenarios,
about $0.15 in total, one-command runs costing $0.006 to $0.03 each.

## Testing

```sh
pnpm test                       # translators + session runner against the fakes, no keys
pnpm e2e:live                   # real vendors (ANYPLEX_LIVE=anthropic,openai,google,cursor), needs keys, costs money
```

Use the same fakes in your own suite:

```ts
import { startFakeOpenAI } from "anyplex/fakes";

const fake = await startFakeOpenAI({ eventDelayMs: 10, functionTool: "lookup_ticket", usageDelayMs: 2000 });
const agent = anyplex({ provider: "openai", apiKey: "fake", baseUrl: `${fake.url}/v1`, model: "gpt-5", instructions: "..." });
// ... run your code against it; fake.state shows what the "vendor" saw ...
await fake.close();
```

`startFakeAnthropic()`, `startFakeGoogle()`, and `startFakeCursor()` take `baseUrl: fake.url`
(the SDKs add their own prefixes). Options script client tool calls, approvals, late usage,
refused deletes, expired streams, failing runs, budgets.

## License

MIT
