# Changelog

## 0.1.0 (2026-09-14)

First release. One session interface over Anthropic Managed Agents, the OpenAI Agents API,
and Gemini Managed Agents: unified events, provider-reported spend, a client-side budget
watchdog, `stop()`, `detached` on signal abort, and lossless `attach()` after a restart.
`anyplex/fakes` ships test doubles for all three APIs. Verified live against each vendor on
2026-09-13; the README lists what was checked and what will bite.
