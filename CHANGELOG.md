# Changelog

## 0.3.0 (2026-09-14)

- New provider `cursor`: Cursor Cloud Agents API v1 (agents + runs, SSE with `Last-Event-ID`,
  cancel, usage, artifacts). No SDK dependency: eight endpoints over `fetch`. Instructions are
  prepended to the first prompt (no system-prompt field); client tools, input files, network,
  packages, setup commands, permissions are refused as unsupported; MCP servers and GitHub
  repositories map natively. `anyplex/fakes` gains `startFakeCursor()` (expired streams, late
  usage, failing runs, idempotent `agentId`, charged cost). Verified live with
  `claude-haiku-4-5` on a Pro plan; the create call blocks about 60 s and may be reset, so the
  agent id is client-chosen and the call converges on it; spend is the usage endpoint's
  `cost.chargedCents`.
- `model: "provider/model"` routes (`"cursor/claude-haiku-4-5"`) make `provider` optional;
  `parseModel()` is exported. The README tagline is now "LiteLLM for managed agents".
- Spend deltas are rounded to a millionth of a dollar before they are applied, so a provider
  figure with more digits no longer produces a phantom follow-up update.
- `AnyplexError`: every rejection from a session method now carries the vendor's `status`,
  `code`, a `retryable` hint, and the original error as `cause`. `UnsupportedError` extends it.
  A `failed` outcome carries `code` and `status` when known. Callers that matched on vendor
  SDK error classes must switch to `AnyplexError` (0.x breaking change, made now so it is the
  last one on this surface).
- `spend.updated` carries the token `usage` delta behind the update when the provider reports
  tokens.
- `docs/gateway-readiness.md`: the compatibility promise and the additive plan for building a
  LiteLLM-style relay on top of the package.

## 0.2.0 (2026-09-14)

The adapter grew from "one prompt, one session" into a full application interface:

- Definition: `tools` the application executes, `mcpServers` (bearer or headers), `environment`
  (files, repositories, network, packages, setup commands), `permissions`, `rates` overrides,
  `providerOptions` escape hatch, and a `capabilities()` table; unsupported combinations are
  refused at construction with `UnsupportedError`.
- Session: `send()` for the next turn, `tool.request` / `approval.request` events with
  `respond()` and `approve()`, `pending`, `artifacts()` / `readArtifact()`, and a `SessionState`
  that now carries the ref and the answered requests.
- Runner: history replayed from earlier turns is transcript-only (never ends the current pass or
  reopens answered requests); chained Gemini interactions reset the usage snapshot.
- Custom providers: pass a `Provider` implementation instead of a name.
- Fakes model the live timing quirks (late OpenAI usage, delete refused while cancelling,
  Anthropic zeros until turn end, Gemini cancelled replay without a terminal event).
- Verified live on 2026-09-14 across all three vendors: second turn, client tool round trip,
  mounted files, artifact listing (and download where the vendor allows it). Findings folded in:
  OpenAI inline files must be base64 and function calls surface on `required_actions`; Gemini
  chaining needs the previous interaction to be final and lists the environment root as "";
  Anthropic outputs index a few seconds after idle and uploads land under
  `/mnt/session/uploads`.

## 0.1.0 (2026-09-14)

First release. One session interface over Anthropic Managed Agents, the OpenAI Agents API,
and Gemini Managed Agents: unified events, provider-reported spend, a client-side budget
watchdog, `stop()`, `detached` on signal abort, and lossless `attach()` after a restart.
`anyplex/fakes` ships test doubles for all three APIs. Verified live against each vendor on
2026-09-13; the README lists what was checked and what will bite.
