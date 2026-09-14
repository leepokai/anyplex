# Architecture

anyplex projects four hosted agent runtimes onto one contract. The contract has four layers;
each maps onto the vendors differently, and the differences are the whole point of the package.

## 1. Definition

`AnyplexOptions` is what an application declares once: model, instructions, `tools` it will
execute itself, `mcpServers`, `environment` (files, repositories, network, packages, setup
commands), `permissions`, `rates`, `providerOptions`, `store`. `anyplex()` turns it into an
`AgentDefinition`, hashes everything that shapes the provider-side agent (never the secrets)
into `agentKey`, checks the provider's `Capabilities` and throws `UnsupportedError` for any
field the provider cannot honour.

Per provider the definition becomes:

| | anthropic | openai | google | cursor |
|---|---|---|---|---|
| Agent object | `environments.create` + `agents.create` (+ a vault when MCP tokens exist) | `beta.agents.create` | `agents.create` with a caller-chosen id (`anyplex-<hash>`; 409 falls back to `get`) | none: Cursor keeps no configuration apart from the conversation |
| Session object | `sessions.create` with resources, budget, vault ids, initial user message | `sessions.create` with the `openai_hosted` environment and the first input | `interactions.create` in the background on a `remote` environment | `POST /v1/agents` (a Cursor agent = conversation + workspace); instructions lead the first prompt |

The agent object is cached in an `AgentStore` keyed by `agentKey`, so a definition creates one
provider-side agent, not one per session. `MemoryStore` forgets on restart; `FileStore` does not.

## 2. Session and turns

A `Session` is a pointer (`SessionRef`) plus state. `events()` drives one turn: it follows the
upstream stream, translates each raw event, dedupes, meters spend, collects requests, and ends
with `session.ended`. The application then either reads the result, answers `pending` with
`respond()` / `approve()`, or continues with `send()`, and calls `events()` again.

Gemini has no long-lived session: every turn is a new interaction chained with
`previous_interaction_id` on the same environment. `sendMessage` and `sendToolResult` therefore
return a new session id and the runner advances `ref.sessionId`. This is why `state()` includes
`ref` and why callers persist state after every pass.

Cursor turns are runs on one agent (`POST /v1/agents/{id}/runs`); only one run may be active,
so `sendMessage` waits for the previous run to settle before creating the next.

## 3. Events and dedupe

Translators are pure: `translate(raw) -> Translation { upstreamId, events, spend?, pollSpend?,
requests?, outcome }`. The runner owns the invariants:

- **seen**: upstream ids already delivered. Marked only after every event of an item was
  yielded, so an abandoned generator redelivers the item on attach (at-least-once per item).
- **stale**: history replayed from an earlier turn is transcript only. Anthropic's `follow`
  marks everything before the last `user.*` event; OpenAI's marks items and turns that are not
  the latest turn. A stale translation keeps events and spend but loses outcome, requests, and
  polling. Without this, replaying turn one's idle would end turn two before it started.
- **answered**: request ids the application already answered. A replay of the
  `custom_tool_use` / `function_call` item must not reopen them.
- **ordinal ids**: Gemini events carry no id and replay from the start on every connect, so the
  provider stamps `${interactionId}:${n}`; the same position always gets the same id.
- **run-scoped ids**: Cursor's SSE ids are opaque per run, so the provider stamps
  `${runId}:${id}`. Earlier runs replay as their final reply (stale); when the current run's
  stream has expired (410), the run object stands in for it.

## 4. Spend

Each provider reports spend its own way, normalised into one `Spend`:

| Kind | Source | Runner rule |
|---|---|---|
| `list_cost_usd` | Anthropic `session.usage` event from the history (the session object stays at zero until a turn ends; list cost is whole cents) | delta = total − spent |
| `tokens_total` | Gemini `step.stop` / `interaction.completed` usage; OpenAI session or turn usage (late, polled); Cursor `GET /usage` totals across runs (polled) | delta = snapshot − previous snapshot; the snapshot resets when the session id advances |
| `tokens_delta` | reserved for providers that report per-turn deltas | priced as-is |

Token spend is priced by `computeCost` from the built-in table plus `rates` overrides; unknown
models use `FALLBACK_RATE` and mark the session `uncertain`. After a turn completes the runner
polls with backoff for about a minute; if the provider still has not reported, it emits
`harness.event { type: "spend.unsettled" }` so `$0` is never silent. The budget watchdog compares
settled spend to `budgetUsd` after every event and stops the upstream session when reached;
Anthropic additionally receives the remaining budget as a native session budget.

## Lifecycle end states

`Outcome` is one of `completed`, `requires_action`, `budget_exceeded`, `terminated`, `stopped`,
`detached`, `failed`. `stop()` interrupts and deletes (Anthropic, OpenAI), cancels (Gemini), or
cancels the run and deletes the agent (Cursor); a budget stop interrupts only; a finished
session is left in place so it stays attachable; a `signal` abort detaches without touching the
vendor. `events()` never throws for upstream errors; the message, vendor code, and HTTP status
travel in `failed`.

## Errors

Session methods reject with `AnyplexError` (`provider`, `status`, `code`, `retryable`, `cause`),
built by `toAnyplexError` from whatever the vendor SDK threw. `UnsupportedError` is a subclass
with `code: "unsupported"`. Nothing above the runner needs to know a vendor's error classes;
that is the basis of the relay plan in `gateway-readiness.md`.
