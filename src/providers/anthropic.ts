// Claude Managed Agents (beta managed-agents-2026-04-01).
//
// Mapping: the definition becomes one Environment (network, packages) and one Agent (built-in
// toolset with the permission policy, custom tools, MCP toolsets) per definition; MCP bearer
// tokens live in a Vault created alongside the agent. Each start() is a Session with the
// prompt as its first event, files uploaded through the Files API and repositories mounted as
// session resources. The SDK's SSE parser may drop `session.usage`, so the settled spend is
// read from the event history. Verified live 2026-09-13 on claude-haiku-4-5.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
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
  type ToolRequest,
  type Translation,
} from "../types.ts";

export const anthropicCapabilities: Capabilities = {
  multiTurn: "native",
  clientTools: "native",
  approvals: "native",
  permissions: "native",
  mcp: "native",
  mcpAuth: "native",
  mcpHeaders: "unsupported",
  files: "native",
  repositories: "native",
  repositoryAuth: "native",
  network: "native",
  packages: "native",
  setupCommands: "unsupported",
  artifactsList: "native",
  artifactsRead: "native",
  nativeBudget: "native",
  artifactsDirectory: "/mnt/session/outputs",
};

/** USD -> Managed Agents budget amount: integer cents as a string ("0.30" -> "30"); at least one cent. */
export function usdToCents(usd: number): string {
  return String(Math.max(1, Math.round(usd * 100)));
}

/** `{ amount, currency }` where amount is integer minor units as a string; tolerates a decimal dollar string. */
export function parseListCostUsd(listCost: unknown): number | null {
  const amount = record(listCost)?.amount;
  const raw = typeof amount === "number" ? String(amount) : amount;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return raw.includes(".") ? n : n / 100;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => record(block))
    .filter((block) => block?.type === "text")
    .map((block) => str(block?.text))
    .filter((text): text is string => text !== null);
}

export function translateAnthropic(raw: unknown): Translation {
  const ev = record(raw);
  if (!ev) return skip();
  if (ev.stale === true) return stale(translateAnthropic({ ...ev, stale: false }));
  const type = str(ev.type) ?? "";
  const id = str(ev.id);
  const done = (events: RawEvent[], extra: Partial<Translation> = {}): Translation => ({
    upstreamId: id,
    events,
    outcome: CONTINUE,
    ...extra,
  });

  switch (type) {
    case "agent.message":
      return done(
        textBlocks(ev.content).map((text) => ({ type: "message.delta", payload: { text } })),
      );
    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      const call: RawEvent = {
        type: "tool.call",
        payload: {
          id: ev.id,
          name: ev.name,
          input: preview(ev.input),
          source: type === "agent.tool_use" ? "builtin" : "mcp",
        },
      };
      if (ev.evaluated_permission !== "ask" || !id) return done([call]);
      const request: ToolRequest = {
        id,
        kind: "approval",
        name: str(ev.name) ?? "tool",
        input: ev.input,
      };
      return done(
        [
          call,
          {
            type: "approval.request",
            payload: { id, name: request.name, input: preview(ev.input) },
          },
        ],
        { requests: [request] },
      );
    }
    case "agent.custom_tool_use": {
      if (!id) return skip();
      const request: ToolRequest = {
        id,
        kind: "tool",
        name: str(ev.name) ?? "tool",
        input: ev.input,
      };
      return done(
        [{ type: "tool.request", payload: { id, name: request.name, input: preview(ev.input) } }],
        {
          requests: [request],
        },
      );
    }
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return done([
        {
          type: "tool.result",
          payload: {
            id: ev.tool_use_id,
            is_error: ev.is_error === true,
            content: preview(ev.content),
          },
        },
      ]);
    case "session.usage": {
      const usage = record(ev.usage) ?? ev;
      const totalUsd = parseListCostUsd(usage.list_cost);
      return done(
        [
          {
            type: "harness.event",
            payload: { type, list_cost_usd: totalUsd, active_seconds: num(usage.active_seconds) },
          },
        ],
        totalUsd === null ? {} : { spend: { kind: "list_cost_usd", totalUsd } },
      );
    }
    case "span.model_request_end":
      return done(
        [{ type: "harness.event", payload: { type, model_usage: ev.model_usage ?? null } }],
        { pollSpend: true },
      );
    case "session.status_running":
      return done([{ type: "harness.event", payload: { type } }]);
    case "session.status_idle": {
      const reason = str(record(ev.stop_reason)?.type) ?? "end_turn";
      const status: RawEvent = { type: "harness.event", payload: { type, stop_reason: reason } };
      if (reason === "requires_action")
        return done([status], {
          outcome: { kind: "requires_action", requests: [] },
          pollSpend: true,
        });
      if (reason === "budget_reached")
        return done([status], { outcome: { kind: "budget_exceeded" }, pollSpend: true });
      if (reason === "retries_exhausted")
        return done([status], {
          outcome: { kind: "failed", error: "managed agent: retries_exhausted" },
          pollSpend: true,
        });
      return done([status], { outcome: { kind: "completed" }, pollSpend: true });
    }
    case "session.status_terminated":
    case "session.deleted":
      return done([{ type: "harness.event", payload: { type } }], {
        outcome: { kind: "terminated" },
      });
    case "session.error": {
      const error = record(ev.error);
      const message = str(error?.message) ?? str(ev.message) ?? "managed agent session error";
      return done([{ type: "harness.event", payload: { type, error: message } }], {
        outcome: { kind: "failed", error: message },
      });
    }
    default:
      // User event echoes, live-preview deltas, thread and span starts stay out of the transcript.
      return skip(id);
  }
}

const client = (ctx: { apiKey: string; baseUrl: string | null }) =>
  new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl ?? undefined, maxRetries: 2 });
const ignore = () => undefined;
const BETAS = ["managed-agents-2026-04-01" as const];

type Networking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowed_hosts: string[];
      allow_mcp_servers: boolean;
      allow_package_managers: boolean;
    };

function networking(
  spec: ProviderContext["definition"]["environment"]["network"],
): Networking | undefined {
  if (spec === undefined) return undefined;
  if (spec === "unrestricted") return { type: "unrestricted" };
  if (spec === "none")
    return {
      type: "limited",
      allowed_hosts: [],
      allow_mcp_servers: false,
      allow_package_managers: false,
    };
  return {
    type: "limited",
    allowed_hosts: spec.allowedHosts,
    allow_mcp_servers: true,
    allow_package_managers: true,
  };
}

export const anthropic: Provider = {
  name: "anthropic",
  capabilities: anthropicCapabilities,

  async createAgent(ctx, signal) {
    const c = client(ctx);
    const d = ctx.definition;
    const label = `anyplex-${ctx.agentKey.slice(0, 12)}`;
    const packages = d.environment.packages;
    const environment = await c.beta.environments.create(
      {
        name: label,
        config: {
          type: "cloud",
          ...(networking(d.environment.network)
            ? { networking: networking(d.environment.network) }
            : {}),
          ...(packages
            ? {
                packages: {
                  type: "packages",
                  npm: packages.npm,
                  pip: packages.pip,
                  apt: packages.apt,
                },
              }
            : {}),
          ...(d.providerOptions.environment ?? {}),
        },
      },
      { signal },
    );
    const permission = d.permissions
      ? {
          type: ({ allow: "always_allow", ask: "always_ask", auto: "auto" } as const)[
            d.permissions
          ],
        }
      : null;
    const agent = await c.beta.agents.create(
      {
        name: label,
        model: d.model,
        system: d.instructions,
        tools: [
          {
            type: "agent_toolset_20260401",
            ...(permission ? { default_config: { permission_policy: permission } } : {}),
          },
          ...d.tools.map((tool) => ({
            type: "custom" as const,
            name: tool.name,
            description: tool.description,
            input_schema: { ...tool.parameters, type: "object" as const },
          })),
          ...d.mcpServers.map((server) => ({
            type: "mcp_toolset" as const,
            mcp_server_name: server.name,
          })),
        ],
        ...(d.mcpServers.length
          ? {
              mcp_servers: d.mcpServers.map((server) => ({
                type: "url" as const,
                name: server.name,
                url: server.url,
              })),
            }
          : {}),
        ...(d.providerOptions.agent ?? {}),
      },
      { signal },
    );
    const extra: Record<string, string> = {};
    const withAuth = d.mcpServers.filter((server) => server.authorization);
    if (withAuth.length) {
      const vault = await c.beta.vaults.create({ display_name: label }, { signal });
      for (const server of withAuth)
        await c.beta.vaults.credentials.create(
          vault.id,
          {
            auth: {
              type: "static_bearer",
              token: server.authorization as string,
              mcp_server_url: server.url,
            },
          },
          { signal },
        );
      extra.vaultId = vault.id;
    }
    return { agentId: agent.id, environmentId: environment.id, extra };
  },

  async createSession(ctx, agent, prompt, signal) {
    if (!agent.environmentId) throw new Error("anthropic managed agent needs an environment");
    const c = client(ctx);
    const d = ctx.definition;
    const resources = [];
    for (const file of d.environment.files ?? []) {
      const uploaded = await c.beta.files.upload(
        { file: await toFile(Buffer.from(file.content), file.path.split("/").pop() || "file") },
        { signal },
      );
      resources.push({ type: "file" as const, file_id: uploaded.id, mount_path: file.path });
    }
    for (const repo of d.environment.repositories ?? [])
      resources.push({
        type: "github_repository" as const,
        url: repo.url,
        ...(repo.path ? { mount_path: repo.path } : {}),
        ...(repo.token ? { authorization_token: repo.token } : {}),
        ...(repo.ref ? { checkout: { type: "branch" as const, name: repo.ref } } : {}),
      });
    const session = await c.beta.sessions.create(
      {
        agent: { type: "agent", id: agent.agentId },
        environment_id: agent.environmentId,
        title: `anyplex ${new Date().toISOString()}`,
        ...(ctx.remainingBudgetUsd === null
          ? {}
          : {
              budget: {
                type: "limit",
                max_list_cost: { amount: usdToCents(ctx.remainingBudgetUsd), currency: "USD" },
              },
            }),
        ...(resources.length ? { resources } : {}),
        ...(agent.extra?.vaultId ? { vault_ids: [agent.extra.vaultId] } : {}),
        initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
        ...(d.providerOptions.session ?? {}),
      },
      { signal },
    );
    return { sessionId: session.id, environmentId: agent.environmentId };
  },

  async *follow(ctx, ref, signal) {
    const c = client(ctx);
    // Stream first, then history: the overlap is what makes the dedupe lossless.
    const stream = await c.beta.sessions.events.stream(ref.sessionId, {}, { signal });
    try {
      const history: Record<string, unknown>[] = [];
      for await (const event of c.beta.sessions.events.list(
        ref.sessionId,
        { order: "asc" },
        { signal },
      ))
        history.push(event as unknown as Record<string, unknown>);
      // Everything before the last user input belongs to an earlier turn: it is replayed for the
      // transcript, but its idle/requires_action must not end the current pass.
      const boundary = history.reduce(
        (last, event, index) => (String(event.type).startsWith("user.") ? index : last),
        -1,
      );
      for (const [index, event] of history.entries())
        yield index < boundary ? { ...event, stale: true } : event;
      for await (const event of stream) yield event;
    } finally {
      stream.controller.abort();
    }
  },

  translate: translateAnthropic,

  /**
   * The session object's usage stays at zero while a turn runs and is filled in the same instant
   * the turn ends (observed live 2026-09-13), so a poll at idle can race it. The `session.usage`
   * event in the history is the settled figure for the turn; it is preferred whenever present.
   */
  async pollSpend(ctx, ref, signal) {
    const c = client(ctx);
    let settled: number | null = null;
    for await (const event of c.beta.sessions.events.list(
      ref.sessionId,
      { types: ["session.usage"], order: "asc" },
      { signal },
    )) {
      const usage = record((event as unknown as Record<string, unknown>).usage);
      const totalUsd = parseListCostUsd(usage?.list_cost);
      if (totalUsd !== null) settled = totalUsd;
    }
    if (settled !== null) return { kind: "list_cost_usd", totalUsd: settled };
    const session = await c.beta.sessions.retrieve(ref.sessionId, {}, { signal });
    const totalUsd = parseListCostUsd(session.usage?.list_cost);
    return totalUsd === null || totalUsd === 0 ? null : { kind: "list_cost_usd", totalUsd };
  },

  async sendMessage(ctx, ref, text) {
    await client(ctx).beta.sessions.events.send(ref.sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
    return undefined;
  },

  async sendToolResult(ctx, ref, request, result) {
    await client(ctx).beta.sessions.events.send(ref.sessionId, {
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: request.id,
          content: [{ type: "text", text: resultText(result.error ?? result.output) }],
          is_error: result.error !== undefined,
        },
      ],
    });
    return undefined;
  },

  async confirmTool(ctx, ref, request, allow, reason) {
    await client(ctx).beta.sessions.events.send(ref.sessionId, {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: request.id,
          result: allow ? "allow" : "deny",
          ...(reason ? { deny_message: reason } : {}),
        },
      ],
    });
  },

  async listArtifacts(ctx, ref) {
    // Outputs appear in files.list one to three seconds after the turn goes idle (documented
    // indexing lag), so an empty list right after completion is retried twice before it counts.
    for (let attempt = 0; ; attempt++) {
      const out = [];
      // The session scope also lists the files uploaded as inputs (downloadable: false); only what
      // the agent produced counts as an artifact.
      for await (const file of client(ctx).beta.files.list({
        scope_id: ref.sessionId,
        betas: BETAS,
      }))
        if (file.downloadable !== false)
          out.push({ id: file.id, path: file.filename, sizeBytes: file.size_bytes ?? null });
      if (out.length > 0 || attempt >= 2) return out;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  },

  async readArtifact(ctx, _ref, artifact) {
    const response = await client(ctx).beta.files.download(artifact.id, { betas: BETAS });
    return new Uint8Array(await response.arrayBuffer());
  },

  async stop(ctx, ref, reason) {
    const c = client(ctx);
    // Interrupt for any stop the caller asked for; delete only on an explicit stop(). A finished,
    // interrupted, or budget-paused session costs nothing while idle and stays attachable.
    if (reason === "kill" || reason === "budget_exceeded")
      await c.beta.sessions.events
        .send(ref.sessionId, { events: [{ type: "user.interrupt" }] })
        .catch(ignore);
    if (reason === "kill") await c.beta.sessions.delete(ref.sessionId).catch(ignore);
  },
};
