# anyplex

One session interface for hosted agent runtimes: Anthropic Managed Agents, the OpenAI Agents
API, and Gemini Managed Agents behind one definition, one event stream, one turn model, one
spend model, and lossless re-attach. An adapter layer only: no persistence, no queue, no loop
of its own.

@docs/file-structure.md
@docs/architecture.md
@docs/conventions.md

## Required reading

- `docs/architecture.md` for the layers and the runner invariants (seen, stale, answered, spend).
- `docs/conventions.md` for how to add a provider or a capability, fake fidelity, and the live
  verification protocol.
- `README.md` sections "Things that will bite you" and "What has been verified" are the public
  record of vendor behaviour; update them in the same change that changes behaviour.

## Rules

- Write all code, comments, documentation, and commit messages in English. Conversation with
  Kevin may be in Traditional Chinese.
- Never commit keys. `.env` is ignored; live tests read keys from it or the environment.
- Live tests spend real money. Run `pnpm test` (fakes) by default; run `pnpm e2e:live` only when
  a behaviour cannot be verified against the fakes, and note the cost in the change.
- Any vendor quirk found live must land in three places: the provider mapping, the fake in
  `src/fakes/`, and the README pitfalls or verification table.
- Translators (`translate*` in `src/providers/`) are pure functions of one raw event; IO lives in
  the provider object. Keep it that way so behaviour stays unit-testable.
- Unsupported features are refused at `anyplex()` with `UnsupportedError`; never drop a field
  silently, and never claim a capability the provider does not enforce.
- Do not add AI attribution trailers to commits.
- Before committing: `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm build`. Run `/code-review`
  on substantial changes to the runner or a provider mapping.
