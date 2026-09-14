# Conventions

## Adding a provider

1. Implement `Provider` in `src/providers/<name>.ts`: a pure `translate<Name>` function and the
   provider object with `createAgent`, `createSession`, `follow`, `sendMessage`,
   `sendToolResult`, `stop`, and the optional `pollSpend`, `confirmTool`, `listArtifacts`,
   `readArtifact`. Declare `capabilities` honestly: `native`, `emulated`, or `unsupported`.
2. `follow` must yield history first (so a reconnect loses nothing), then the live stream, and
   must mark earlier-turn history as `stale` if the vendor replays it.
3. Every event the translator emits needs an `upstreamId`; if the vendor has none, stamp a
   deterministic one in `follow`.
4. Write the fake in `src/fakes/<name>.ts` from live traffic, not from the docs: shapes, ids,
   replay semantics, timing. Add the vendor to `test/session.test.ts` and
   `test/live-scenarios.test.ts`.
5. Add a row to every table in `README.md` and a section to its pitfalls.

## Adding a capability

Add the field to `Capabilities`, set it in all three `*Capabilities` objects, teach
`checkSupport` in `src/session.ts` which definition field uses it, map it in each provider,
cover it in the fakes and `test/session.test.ts`, and document it in the README definition
table.

## Fake fidelity

A fake exists to let users test without a key, so it must lie as little as possible. When a
live run shows behaviour the fake does not model, add it as an option with the live default
(for example `usageDelayMs`, `refuseDeleteWhileInProgress`, no `event_id` on Gemini events).
Never make the fake more helpful than the vendor.

## Live verification protocol

- Run against the fakes first; go live only for behaviour the fakes cannot prove.
- Prefer the cheapest vendor for a first live check (Gemini, then Anthropic Haiku); OpenAI's
  hosted environment bills a five-minute minimum per session.
- Never delete the vendor session in a probe until the data is captured; a deleted session
  cannot be inspected.
- Record what was observed, with the date and model, in the README verification table and the
  provider file's header comment.
- Keys stay in `.env` (ignored) or the environment; probe scripts must scrub keys from output.

## Code style

- TypeScript strict, `verbatimModuleSyntax`, `.ts` import extensions (rewritten on build).
- Biome formats and lints; run `pnpm format` before committing.
- Comments explain a vendor behaviour or an invariant, not what the code does.
- No AI attribution trailers in commits. Commit messages describe the behaviour change.

## Versioning

Semantic versions. Additive session or definition fields are minor; renaming an event type,
an outcome kind, or a `SessionState` field is major. `CHANGELOG.md` gets an entry per release.
