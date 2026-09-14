// Test doubles for the hosted agent APIs, shaped from live traffic (Anthropic, OpenAI, Gemini on
// 2026-09-13) or the published spec (Cursor). Start one, point `baseUrl` at it, and exercise
// sessions without a key or a bill. They model shapes, lifecycles, and the timing quirks seen
// live (late usage, refused deletes, replay without ids). Requires `hono` and `@hono/node-server`.

export * from "./anthropic.ts";
export * from "./cursor.ts";
export * from "./google.ts";
export * from "./openai.ts";
export * from "./timeline.ts";
