# File structure

> Living document: update it when adding or moving a file at the top level of `src/`,
> `test/`, or `examples/`.

```text
anyplex/
├── src/
│   ├── index.ts                Public entry: anyplex(), capabilities(), stores, types, providers
│   ├── types.ts                Vocabulary: definition specs, Capabilities, Outcome, Spend, events, SessionRef, stores
│   ├── provider.ts             The Provider interface every runtime implements, ProviderContext, AgentDefinition
│   ├── pricing.ts              Rate table, fallback rate, computeCost with per-call overrides
│   ├── session.ts              anyplex() factory, capability check, agent cache, and the session runner
│   ├── providers/
│   │   ├── anthropic.ts        Claude Managed Agents: pure translateAnthropic + the provider object
│   │   ├── openai.ts           OpenAI Agents API: pure translateOpenAI + the provider object
│   │   ├── google.ts           Gemini Managed Agents (Interactions): pure translateGoogle + the provider object
│   │   └── cursor.ts           Cursor Cloud Agents v1 over fetch: pure translateCursor + SSE reader + the provider object
│   └── fakes/                  Published as `anyplex/fakes`: test doubles shaped from live traffic
│       ├── timeline.ts         A session as an append-only timeline that runs without a listener
│       ├── anthropic.ts        /v1/environments, agents, vaults, files, sessions, events (list, send, SSE)
│       ├── openai.ts           /v1/agents, sessions, events (POST input, GET SSE), items, turns, artifacts
│       ├── google.ts           /v1beta/agents, interactions (background, replayed SSE, cancel), environment files
│       ├── cursor.ts           /v1/agents, runs (SSE with ids, Last-Event-ID, 410 after retention), usage, artifacts
│       └── index.ts
├── test/
│   ├── translate.test.ts       Translator unit tests: shapes observed live
│   ├── session.test.ts         Runner against the fakes: every layer, every provider
│   ├── live.test.ts            Opt-in smoke against the real vendors (ANYPLEX_LIVE)
│   └── live-scenarios.test.ts  Opt-in lifecycle scenarios against the real vendors
├── examples/                   Runnable scripts (pnpm example examples/<name>.ts)
├── assets/                     Project mark: icon.svg (light), icon-dark.svg, rendered PNGs
├── scripts/
│   ├── vendor-docs.mjs         Mirrors the vendors' managed-agent docs into vendor-docs/ (pnpm docs:vendor)
│   └── docs-search.mjs         MiniSearch over docs/ and the mirror from the shell (pnpm docs:search)
├── docs/.vitepress/config.mts  VitePress site over docs/ and the mirror (pnpm docs:dev / docs:build)
├── docs/index.md               Site home page
├── vendor-docs/                Ignored by git: the mirror, one folder per provider with an INDEX.md
├── docs/                       This folder: structure, architecture, conventions, gateway-readiness (relay plan), vendor-docs (doc mirror), vendor-gaps (unmapped vendor features)
├── .github/workflows/ci.yml    install, check, lint, test, build on push and pull request
├── package.json                exports "." and "./fakes"; vendor SDKs are dependencies, hono is an optional peer
├── tsconfig.json / tsconfig.build.json   Type-check everything; emit `dist/` from `src/` only
├── biome.json                  Lint and format
├── CHANGELOG.md
└── README.md                   Public contract: use, definition, session, pitfalls, verification table
```

## Dependency direction

```text
index      → session, providers, types, pricing
session    → provider (interface), providers (built-ins), pricing, types
providers  → provider (interface), types, the vendor SDK of that provider only
fakes      → hono only (never the library code)
test       → src/index, src/fakes
```

`types.ts` and `provider.ts` import nothing from the rest of the package. A provider never
imports another provider. The fakes never import the library, so a fake can be trusted to
describe the vendor rather than the adapter.
