# Building a relay on top of anyplex

> The plan for a LiteLLM-style relay (one HTTP endpoint, many tenants, many vendor keys) that
> uses anyplex as its adapter layer. Written 2026-09-14 so the relay can be built later without
> breaking this package's contract. This document is the compatibility promise; change it in the
> same commit as any contract change.

## Division of labour

anyplex stays the per-provider adapter: one definition, one provider, one key, one session at a
time. Everything a relay adds lives above it and talks to it only through the public surface:

| Relay concern | Where it lives | What anyplex already gives it |
|---|---|---|
| Tenants, keys, quotas | relay | `apiKey` and `baseUrl` per `anyplex()` call; nothing global |
| Model routing (`"cursor/composer-2"`), fallbacks, retries | relay | `provider` + `model` per call; `AnyplexError.retryable` |
| Durable session registry | relay database | `SessionRef` and `SessionState` are plain JSON |
| Replicas, hand-off, crash recovery | relay | `attach(ref, state)` from any process; `attach(ref).stop()` works cross-process |
| Spend ledger, per-tenant caps | relay | `spend.updated` carries `delta_usd` and the token `usage` behind it; `budgetUsd` per session |
| Streaming to clients, resume cursors | relay | every event carries `upstreamId`; the relay adds its own `seq` |
| Vendor agent cache shared by replicas | relay store | `AgentStore` is an async interface; wrap it to namespace by tenant |
| Custom or private runtimes | relay | pass a `Provider` object instead of a name |

Nothing in anyplex holds state outside a `Session` object except the fakes' id counters. A
relay replica can be killed at any time; the next replica attaches with the persisted state.

## Compatibility rules (SemVer, 0.x treated as 1.x for these)

1. **Additive only.** `AnyplexOptions`, `StartOptions`, `AttachOptions`, `SessionState`,
   `SessionRef`, `Capabilities`, event payloads, and `Outcome` variants gain fields; they never
   lose or rename one. New event types and outcome kinds may appear; consumers must ignore
   event types they do not know.
2. **Stable identifiers.** Provider names (`anthropic`, `openai`, `google`, `cursor`), event
   type strings, outcome kinds, and `Support` values do not change meaning.
3. **JSON everywhere.** Anything a relay must persist or forward (`SessionRef`, `SessionState`,
   `SessionEvent`, `ToolRequest` including `handle`, `Artifact`) stays JSON-serializable with
   no class instances.
4. **Errors are `AnyplexError`.** Every rejection from `start()`, `send()`, `respond()`,
   `approve()`, `artifacts()`, `readArtifact()` is an `AnyplexError` (`provider`, `status`,
   `code`, `retryable`, `cause`). `UnsupportedError` extends it. A `failed` outcome carries the
   same `code` and `status`. A relay maps these to HTTP without inspecting vendor SDK classes.
5. **`Provider` is the extension point.** New optional methods may be added to the interface;
   required methods are not added in a minor version.
6. **Money semantics.** `spentUsd` never decreases within a session; `uncertain` only flips to
   `true`; `spend.updated.delta_usd` sums to `spent_usd`.

## Planned additive changes (in order of need)

| Change | Why a relay needs it | Shape |
|---|---|---|
| `credentials` on `AnyplexOptions` and `ProviderContext` | AWS AgentCore and Azure Foundry sign requests instead of sending an API key | `credentials?: Record<string, string>`; `apiKey` stays as the common case |
| `headers` / `fetch` override | relay-to-relay chaining, tracing headers, proxies | `transport?: { headers?, fetch? }` on `AnyplexOptions`, passed in `ProviderContext` |
| `idempotencyKey` on `StartOptions` | retried `start()` must not create a second vendor session | providers that support it (Cursor `agentId`) use it; others ignore it |
| `metadata` on `StartOptions` | tenant and trace ids on the vendor object | forwarded where the vendor has a metadata field |
| `parseModel("provider/model")` helper | route strings in the LiteLLM style | pure function in `index.ts`; no change to `provider` + `model` |
| `Session.usage` | token totals without summing events | `TokenUsage | null` mirror of the runner's snapshot |

None of these change an existing field.

## Relay sketch

```text
client ── POST /v1/sessions {provider, model, definition, prompt, budgetUsd}
       ── GET  /v1/sessions/:id/events   (SSE; Last-Event-ID = relay seq)
       ── POST /v1/sessions/:id/messages | /respond | /approve | /stop
       ── GET  /v1/sessions/:id/artifacts[/:path]

relay  ── resolves tenant → vendor key → anyplex({ provider, apiKey, store: tenantStore })
       ── start() or attach(ref, state) → events() → append (seq, event) to the log
       ── on spend.updated: ledger.add(tenant, delta_usd, usage)
       ── persist session.state() after every events() pass
```

The relay owns the event log and its sequence numbers; `upstreamId` is kept on each row so a
replay from the vendor after a crash dedupes against what was already forwarded.

## What not to move into anyplex

Routing tables, tenant keys, quotas, HTTP surfaces, and the event log. Each is a policy the
relay's operator owns, and each would make the adapter opinionated about deployments it cannot
see. anyplex answers one question per call: how does this definition run on this provider.
