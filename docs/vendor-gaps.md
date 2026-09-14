# What the vendors offer that anyplex does not map

> Result of reading the four vendors' managed-agent documentation end to end (the mirror under
> `vendor-docs/`, fetched 2026-09-14) against the provider mappings. Contradictions found in
> that read were fixed in 0.3.0 (see CHANGELOG). This page is the remaining list: what fits
> the current abstraction and could be added as fields, what would need a new concept, and
> what is deliberately out of scope. Dates and page names refer to the mirror; refresh with
> `pnpm docs:vendor` and re-check before acting on an item.

## Fits the existing definition or session layers

Additive fields or methods; no new concept. Ordered by how many vendors would use them.

| Feature | anthropic | openai | google | cursor | Where it would land |
|---|---|---|---|---|---|
| Session-scoped environment variables | – | `environment.env` (reserved names rejected) | – | `envVars` (beta; excludes `agentId`) | `EnvironmentSpec.env` |
| Per-turn or per-session metadata and title | `title`, `metadata` on sessions | – | – | `name` on the agent | `StartOptions.metadata` (planned in gateway-readiness) |
| Model parameters beyond the id | `model.effort`, `speed`, `inference_geo` | – | – | `model.params` (reasoning, fast, context) | today `providerOptions`; a `modelOptions` map would be uniform |
| Repository checkout by commit SHA, PR URL | `checkout` branch or SHA | – | – | `startingRef` SHA, `prUrl` | `repositories[].ref` already carries SHA on Cursor; `prUrl` needs a field |
| More package managers | `cargo`, `gem`, `go` | – | – | – | `EnvironmentSpec.packages` keys |
| Setup command working directory | – | `{ command, cwd }` | – | – | `setupCommands` entries as objects |
| Binary or Files-API file inputs | Files API (any type) | `file_id` from the Files API | – | images in the prompt | `files[]` with `bytes` or `fileId` |
| MCP options: required, allowed tools, OAuth, stdio | `mcp_oauth` credentials | `required`, `allowed_tools` | Streamable HTTP only, lowercase names | `auth` (OAuth client), stdio `command`/`args`/`env` | `McpServerSpec` fields |
| Web tool restrictions | domain filters, `max_content_tokens`, `user_location` | – | – | – | a `builtinTools` map |
| Raise, lower, or remove the budget mid-session | `sessions.update` (the only way to resume a `budget_reached` pause) | – | `max_total_tokens` (ends `incomplete`) | – | `Session.setBudget()` |
| System message mid-conversation | `system.message` event | – | `system_instruction` per interaction | – | `Session.system()` |
| Artifact deletion | – | delete artifact | – | – | `Provider.deleteArtifact` |
| Attribution of events to subagents or turns | thread ids | `subagent_id`, turn ids | – | run ids (already stamped) | optional `origin` on events |
| Start from an existing environment (reuse, fork) | – | – | `environment: <id>`, fork | named cloud environments, pools, machines (`env`) | `StartOptions.environmentId` |
| Environment cleanup | archive/delete environment | environment lifecycle | `environments.delete` (else 7-day TTL) | archive/unarchive/delete agent | `Provider.dispose()` after `stop()` |
| Artifact download where the SDK lacks it | – | – | REST `files/environment-<id>:download` returns a tar of the sandbox | – | `artifactsRead: emulated` with a streaming tar scan |
| Hooks as a permission layer | native permission policies | – | `.agents/hooks.json` pre-tool hooks (allow/deny with reason) | – | `permissions` emulated for Gemini |

## Needs a new concept

| Feature | Vendors | Verdict |
|---|---|---|
| Webhooks for session state | anthropic, openai, cursor (v0 only), google (`webhook_config`) | No. A pull/stream adapter has nowhere to receive them; a relay above anyplex does. |
| Scheduled or triggered runs | anthropic scheduled deployments, google triggers, cursor automations (dashboard only) | Maybe, as a separate resource type. Different lifecycle from a session. |
| Multi-agent orchestration, threads, subagents | anthropic (coordinator, roster, threads, advisor), openai (`agent.multi_agent`, spawn/wait tools), cursor `customSubagents` | Yes, eventually: it is event shaped. Needs a thread concept in `SessionEvent` and a `multiAgent` capability. |
| Memory stores, dreams | anthropic | New top-level resource with its own CRUD. |
| Skills and plugins | anthropic skills, openai plugins | Maybe, as a `skills` field pointing at uploaded bundles; the bundle CRUD stays outside. |
| Outcome-driven sessions (rubric, grader loop) | anthropic | Maybe, as a `start()` variant. |
| Self-hosted sandboxes, pools, machines | anthropic self-hosted sandboxes, openai self-hosted environments, cursor pools and machines | No. Inverts the control flow (the caller executes tools) or is fleet operations. Routing to one (Cursor `env`) already works through `providerOptions`. |
| Vaults as reusable credentials | anthropic, openai | Maybe. anyplex covers per-session bearer tokens; reusable credentials need CRUD. |
| Deep Research agent | google (`agent_config.type: deep-research`) | Maybe. Same interaction shape, no sandbox; a different capability profile. |
| Tracing, observability, computer use, private connectivity | openai, cursor | No. Not reachable through the APIs anyplex uses, or account-level configuration. |

## Limits worth knowing

Taken from the docs; the live figures in the README pitfalls win where they differ.

- **Anthropic**: 300 creates/min and 1,200 reads/min per organisation; sandbox 8 GB RAM, 10 GB disk; tool output over 100,000 characters spills to a file; 500 files, 500 skills, 8 memory stores per session; 20 MCP servers and 128 tools per agent; sandbox state kept 30 days; budgets are whole cents.
- **OpenAI**: hosted sandbox expires after one hour; restricted network mode takes 1 to 100 exact hostnames; a failed setup command fails the session; five subagents plus a coordinator by default; US data residency.
- **Gemini**: environment idles to a snapshot after 15 minutes, is kept 7 days; 4 CPU, 16 GB; git sources up to 500 MB, inline files 1 MB each; 1,000 agents per project; MCP over Streamable HTTP only; `temperature` and friends rejected for Antigravity; retention 55 days paid, 1 day free.
- **Cursor**: Pro plan required; 5 images per prompt at 15 MB; 20 repositories, 50 MCP servers, 20 custom subagents, 50 `envVars`; artifact URLs live 15 minutes; stream retained 24 hours; `/v1/repositories` limited to 1 call per minute.

## Fake fidelity backlog

Things the docs describe that the fakes still do not model: Anthropic session statuses
`rescheduling` and `terminated`, thread events, 429/403 responses; OpenAI environment
lifecycle, pagination, webhooks; Gemini `queued`, the `errors` array, environment states,
the May 2026 `interaction.in_progress`/`interaction.requires_action` event names; Cursor
`EXPIRED`, `heartbeat`, pagination and list filters, most of the documented error codes.
