// OpenAI Agents API (public beta 2026-09-10).
//
// Mapping: the definition becomes one Agent (function tools, MCP servers with bearer or
// headers) per definition; each start() is a Session on the `openai_hosted` environment with
// inline files, network policy, packages, and setup commands. Repositories are emulated with
// a `git clone` setup command. Client tool results go back as `agent.session.input.tool_result`
// keyed by the turn. Verified live 2026-09-13 with gpt-6-astra: turn events carry
// `usage: null`; the turn object fills in ~2 s after idle and the session object ~7 s, sometimes
// much later, so spend is polled from the session (falling back to the sum of turns).

import OpenAI from "openai";
import type { Provider, ProviderContext } from "../provider.ts";
import {
  type Capabilities,
  CONTINUE,
  num,
  preview,
  type RawEvent,
  record,
  resultText,
  skip,
  stale,
  str,
  type TokenUsage,
  type ToolRequest,
  type Translation,
} from "../types.ts";

export const openaiCapabilities: Capabilities = {
  multiTurn: "native",
  clientTools: "native",
  approvals: "unsupported",
  permissions: "unsupported",
  mcp: "native",
  mcpAuth: "native",
  mcpHeaders: "native",
  files: "native",
  repositories: "emulated",
  repositoryAuth: "emulated",
  network: "native",
  packages: "native",
  setupCommands: "native",
  artifactsList: "native",
  artifactsRead: "native",
  nativeBudget: "unsupported",
  artifactsDirectory: "/workspace/outputs",
};

export function openaiTokenUsage(raw: unknown): TokenUsage | null {
  const usage = record(raw);
  if (!usage) return null;
  const cached = num(record(usage.input_tokens_details)?.cached_tokens);
  return {
    inputTokens: Math.max(0, num(usage.input_tokens) - cached),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: cached,
  };
}

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => record(part))
    .filter((part) => part?.type === "output_text")
    .map((part) => str(part?.text) ?? "")
    .join("");
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function itemEvents(item: Record<string, unknown>): {
  events: RawEvent[];
  requests?: ToolRequest[];
} {
  switch (item.type) {
    case "message": {
      if (item.role !== "assistant") return { events: [] };
      const text = outputText(item.content);
      return { events: text ? [{ type: "message.delta", payload: { text } }] : [] };
    }
    case "function_call": {
      // The agent wants the application to run one of its tools.
      const id = str(item.call_id) ?? str(item.id) ?? "call";
      const name = str(item.name) ?? "function";
      const input = parseArguments(item.arguments);
      return {
        events: [{ type: "tool.request", payload: { id, name, input: preview(input) } }],
        requests: [{ id, kind: "tool", name, input, handle: { turnId: item.turn_id ?? null } }],
      };
    }
    case "command_execution": {
      const exit = item.exit_code;
      return {
        events: [
          {
            type: "tool.call",
            payload: {
              id: item.id,
              name: "bash",
              input: { command: item.command, cwd: item.cwd ?? null },
            },
          },
          {
            type: "tool.result",
            payload: {
              id: item.id,
              name: "bash",
              is_error: typeof exit === "number" && exit !== 0,
              content: preview(item.output ?? ""),
            },
          },
        ],
      };
    }
    case "web_search_call":
      return {
        events: [
          {
            type: "tool.call",
            payload: { id: item.id, name: "web_search", input: preview(item.action) },
          },
        ],
      };
    case "mcp_call":
      return {
        events: [
          {
            type: "tool.call",
            payload: { id: item.id, name: str(item.name) ?? "mcp", input: preview(item.arguments) },
          },
          ...(item.output === undefined
            ? []
            : [
                {
                  type: "tool.result",
                  payload: {
                    id: item.id,
                    name: str(item.name) ?? "mcp",
                    is_error: item.error != null,
                    content: preview(item.output),
                  },
                },
              ]),
        ],
      };
    case "reasoning":
      return { events: [] };
    default:
      return {
        events: [
          {
            type: "harness.event",
            payload: { type: `item.${String(item.type)}`, item: preview(item) },
          },
        ],
      };
  }
}

export function translateOpenAI(raw: unknown): Translation {
  const ev = record(raw);
  if (!ev) return skip();
  if (ev.stale === true) return stale(translateOpenAI({ ...ev, stale: false }));
  const type = str(ev.type) ?? "";
  const eventId = str(ev.event_id);
  const done = (
    upstreamId: string | null,
    events: RawEvent[],
    extra: Partial<Translation> = {},
  ): Translation => ({ upstreamId, events, outcome: CONTINUE, ...extra });

  switch (type) {
    case "agent.session.turn.item.done": {
      const item = record(ev.item);
      if (!item) return skip(eventId);
      const { events, requests } = itemEvents(item);
      return done(str(item.id) ?? eventId, events, requests ? { requests } : {});
    }
    case "agent.session.turn.completed": {
      const turnId = str(ev.turn_id) ?? eventId;
      return done(
        turnId,
        [{ type: "harness.event", payload: { type, turn_id: turnId, usage: ev.usage ?? null } }],
        { pollSpend: true },
      );
    }
    case "agent.session.turn.failed": {
      const turnId = str(ev.turn_id) ?? eventId;
      const error = record(record(ev.turn)?.error);
      const code = str(error?.code);
      const message = str(error?.message) ?? "managed agent turn failed";
      return done(
        turnId,
        [{ type: "harness.event", payload: { type, turn_id: turnId, error: message, code } }],
        {
          pollSpend: true,
          outcome:
            code === "session_budget_exceeded" || code === "usage_limit_exceeded"
              ? { kind: "budget_exceeded" }
              : { kind: "failed", error: message },
        },
      );
    }
    case "agent.session.turn.cancelled": {
      const turnId = str(ev.turn_id) ?? eventId;
      return done(turnId, [{ type: "harness.event", payload: { type, turn_id: turnId } }], {
        pollSpend: true,
        outcome: { kind: "terminated" },
      });
    }
    case "agent.session.turn.item.added":
      // A function_call item alone "does not establish that a result is pending"
      // (guides/agents-api/tools/functions.md); `required_actions` on the requires_action
      // event is the only source of requests. The item is announced again as `item.done`.
      return skip(eventId);
    case "agent.session.idle":
    case "agent.session.requires_action":
    case "agent.session.failed": {
      const session = record(ev.session);
      const sessionId = str(session?.id) ?? str(ev.session_id) ?? "session";
      const status = type.slice("agent.session.".length);
      const events: RawEvent[] = [{ type: "harness.event", payload: { type, status } }];
      const key = `${sessionId}:${status}`;
      if (type === "agent.session.idle")
        return done(key, events, { pollSpend: true, outcome: { kind: "completed" } });
      if (type === "agent.session.requires_action") {
        // The session object lists exactly what it is waiting on (observed live 2026-09-14).
        const actions = (Array.isArray(session?.required_actions) ? session.required_actions : [])
          .map((action) => record(action))
          .filter((action): action is Record<string, unknown> => action !== null);
        const foreign = actions
          .map((action) => str(action.type))
          .filter((kind): kind is string => kind !== null && kind !== "function_call");
        if (foreign.length)
          return done(key, events, {
            outcome: {
              kind: "failed",
              error: `session requires an action anyplex cannot provide: ${foreign.join(", ")}`,
            },
          });
        const requests: ToolRequest[] = actions
          .filter((action) => action.type === "function_call")
          .map((action) => ({
            id: str(action.call_id) ?? "call",
            kind: "tool" as const,
            name: str(action.name) ?? "function",
            input: parseArguments(action.arguments),
            handle: { turnId: action.turn_id ?? null },
          }));
        // One session can wait on the application several times; the id must differ each time.
        return done(
          `${key}:${requests.map((r) => r.id).join(",")}`,
          [
            ...events,
            ...requests.map((r) => ({
              type: "tool.request",
              payload: { id: r.id, name: r.name, input: preview(r.input) },
            })),
          ],
          { pollSpend: true, requests, outcome: { kind: "requires_action", requests: [] } },
        );
      }
      const error = str(session?.error) ?? "managed agent session failed";
      return done(key, events, { pollSpend: true, outcome: { kind: "failed", error } });
    }
    case "error": {
      const message = str(record(ev.error)?.message) ?? "managed agent error";
      return done(eventId, [{ type: "harness.event", payload: { type, error: message } }], {
        outcome: { kind: "failed", error: message },
      });
    }
    case "agent.session.created":
    case "agent.session.in_progress":
    case "agent.session.turn.created":
      return done(eventId, [{ type: "harness.event", payload: { type } }]);
    default:
      if (
        type.startsWith("agent.session.environment.") ||
        type.startsWith("agent.session.subagent.")
      )
        return done(eventId, [{ type: "harness.event", payload: { type } }]);
      // Text, reasoning, and command-output deltas duplicate the finished items above.
      return skip(eventId);
  }
}

const client = (ctx: { apiKey: string; baseUrl: string | null }) =>
  new OpenAI({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl ?? undefined, maxRetries: 2 });
const ignore = () => undefined;
const TERMINAL_TURN = new Set(["completed", "failed", "cancelled"]);
const nonZero = (usage: TokenUsage | null) =>
  usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) > 0 ? usage : null;

function network(spec: ProviderContext["definition"]["environment"]["network"]) {
  if (spec === undefined) return undefined;
  if (spec === "unrestricted") return { access: "enabled" as const };
  if (spec === "none") return { access: "disabled" as const };
  return { access: "restricted" as const, allowed_domains: spec.allowedHosts };
}

function cloneCommand(repo: { url: string; path?: string; ref?: string; token?: string }): string {
  const name = repo.path ?? (repo.url.split("/").pop() ?? "repo").replace(/\.git$/, "");
  const url = repo.token
    ? repo.url.replace(/^https:\/\//, `https://x-access-token:${repo.token}@`)
    : repo.url;
  const clone = `git clone ${repo.ref ? `--branch ${repo.ref} ` : ""}${url} ${name}`;
  return repo.token ? `${clone} && git -C ${name} remote set-url origin ${repo.url}` : clone;
}

export const openai: Provider = {
  name: "openai",
  capabilities: openaiCapabilities,

  async createAgent(ctx, signal) {
    const d = ctx.definition;
    const agent = await client(ctx).beta.agents.create(
      {
        model: d.model,
        name: `anyplex-${ctx.agentKey.slice(0, 12)}`,
        instructions: d.instructions,
        tools: [
          ...d.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          ...d.mcpServers.map((server) => ({
            type: "mcp" as const,
            server_label: server.name,
            transport: {
              type: "http" as const,
              server_url: server.url,
              authorization: server.authorization ?? null,
              headers: server.headers ?? null,
            },
          })),
        ],
        ...(d.providerOptions.agent ?? {}),
      },
      { signal },
    );
    return { agentId: agent.id, environmentId: null };
  },

  async createSession(ctx, agent, prompt, signal) {
    const d = ctx.definition;
    const env = d.environment;
    const packages = env.packages;
    const setup = [
      ...(env.repositories ?? []).map((repo) => ({ command: cloneCommand(repo) })),
      ...(env.setupCommands ?? []).map((command) => ({ command })),
    ];
    const session = await client(ctx).beta.agents.sessions.create(
      {
        agent_id: agent.agentId,
        environment: {
          type: "openai_hosted",
          ...(env.files?.length
            ? {
                files: env.files.map((file) => ({
                  type: "inline" as const,
                  path: file.path,
                  // Verified live 2026-09-14: inline data must be standard base64.
                  data: Buffer.from(file.content).toString("base64"),
                })),
              }
            : {}),
          ...(network(env.network) ? { network: network(env.network) } : {}),
          ...(packages
            ? { packages: { npm: packages.npm, python: packages.pip, system: packages.apt } }
            : {}),
          ...(setup.length ? { setup_commands: setup } : {}),
          ...(d.providerOptions.environment ?? {}),
        },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
        ...(d.providerOptions.session ?? {}),
      },
      { signal },
    );
    return {
      sessionId: session.id,
      environmentId: (record(session.environment)?.id as string | null) ?? null,
    };
  },

  async *follow(ctx, ref, signal) {
    const c = client(ctx);
    const id = ref.sessionId;
    const stream = await c.beta.agents.sessions.events.stream(id, { signal });
    try {
      // History is reconstructed from items and turns (the event stream itself has no replay).
      // Only the latest turn may end the pass or ask for input; older turns are transcript only.
      const turns = [];
      for await (const turn of c.beta.agents.sessions.turns.list(id, { order: "asc" }, { signal }))
        turns.push(turn);
      const current = turns.at(-1)?.id ?? null;
      for await (const item of c.beta.agents.sessions.items.list(id, { order: "asc" }, { signal }))
        yield {
          type: "agent.session.turn.item.done",
          event_id: item.id ?? "",
          item,
          output_index: 0,
          session_id: id,
          turn_id: item.turn_id ?? null,
          stale: (item.turn_id ?? null) !== current,
        };
      for (const turn of turns)
        if (TERMINAL_TURN.has(turn.status))
          yield {
            type: `agent.session.turn.${turn.status}`,
            event_id: turn.id,
            session_id: id,
            turn,
            turn_id: turn.id,
            usage: turn.usage,
            stale: turn.id !== current,
          };
      const session = await c.beta.agents.sessions.retrieve(id, { signal });
      const settled = turns.length > 0 && turns.every((turn) => TERMINAL_TURN.has(turn.status));
      if (settled && session.status !== "in_progress") {
        yield {
          type: `agent.session.${session.status}`,
          event_id: `${id}:${session.status}`,
          session,
        };
        return;
      }
      // A session already waiting on the application says so on the object; the live stream
      // then carries whatever follows the application's answer.
      if (session.status === "requires_action")
        yield { type: "agent.session.requires_action", event_id: `${id}:requires_action`, session };
      for await (const event of stream) yield event;
    } finally {
      stream.controller.abort();
    }
  },

  translate: translateOpenAI,

  /**
   * Cumulative usage priced with the local rate table. The session figure lands seconds after a
   * turn ends and the per-turn figure a little earlier, so sum the turns while the session is null.
   */
  async pollSpend(ctx, ref, signal) {
    const c = client(ctx);
    const session = await c.beta.agents.sessions.retrieve(ref.sessionId, { signal });
    const fromSession = nonZero(openaiTokenUsage(session.usage));
    if (fromSession) return { kind: "tokens_total", usage: fromSession };
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    for await (const turn of c.beta.agents.sessions.turns.list(ref.sessionId, {}, { signal })) {
      const usage = nonZero(openaiTokenUsage(turn.usage));
      if (!usage) continue;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    }
    return nonZero(total) ? { kind: "tokens_total", usage: total } : null;
  },

  async sendMessage(ctx, ref, text) {
    await client(ctx).beta.agents.sessions.events.create(ref.sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
        },
      ],
    });
    return undefined;
  },

  async sendToolResult(ctx, ref, request, result) {
    const turnId = str(record(request.handle)?.turnId);
    if (!turnId) throw new Error(`tool request ${request.id} has no turn id`);
    await client(ctx).beta.agents.sessions.events.create(ref.sessionId, {
      events: [
        {
          type: "agent.session.input.tool_result",
          call_id: request.id,
          turn_id: turnId,
          success: result.error === undefined,
          ...(result.error !== undefined
            ? { error: result.error }
            : { output: resultText(result.output) }),
        },
      ],
    });
    return undefined;
  },

  async listArtifacts(ctx, ref) {
    const out = [];
    for await (const artifact of client(ctx).beta.agents.sessions.artifacts.list(ref.sessionId, {
      order: "asc",
    }))
      out.push({ id: artifact.id, path: artifact.path, sizeBytes: artifact.size_bytes ?? null });
    return out;
  },

  async readArtifact(ctx, ref, artifact) {
    const response = await client(ctx).beta.agents.sessions.artifacts.content(artifact.id, {
      session_id: ref.sessionId,
    });
    return new Uint8Array(await response.arrayBuffer());
  },

  async stop(ctx, ref, reason) {
    const c = client(ctx);
    // Cancel the running turn for any caller-requested stop; delete only on an explicit stop().
    // An idle session keeps its transcript attachable; the hosted container times out on its own.
    if (reason === "kill" || reason === "budget_exceeded")
      await c.beta.agents.sessions.events
        .create(ref.sessionId, { events: [{ type: "agent.session.input.cancel" }] })
        .catch(ignore);
    if (reason !== "kill") return;
    // Deleting while the cancelled turn is still winding down is refused; give it a moment.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const session = await c.beta.agents.sessions.retrieve(ref.sessionId).catch(() => null);
      if (session?.status !== "in_progress") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await c.beta.agents.sessions.delete(ref.sessionId).catch(ignore);
  },
};
