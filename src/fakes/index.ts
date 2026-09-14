// Test doubles for the three hosted agent APIs, shaped from live traffic on 2026-09-13. Start
// one, point `baseUrl` at it, and exercise sessions without a key or a bill. They model the
// shapes and lifecycles; they do not yet model timing quirks (late OpenAI usage, delete refused
// while a turn cancels, Anthropic zeros until turn end). Requires `hono` and `@hono/node-server`.

export * from "./anthropic.ts";
export * from "./google.ts";
export * from "./openai.ts";
export * from "./timeline.ts";
