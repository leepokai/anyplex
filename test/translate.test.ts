import { describe, expect, it } from "vitest";
import { parseListCostUsd, translateAnthropic, usdToCents } from "../src/providers/anthropic.ts";
import { cursorTokenUsage, translateCursor } from "../src/providers/cursor.ts";
import { googleTokenUsage, translateGoogle } from "../src/providers/google.ts";
import { openaiTokenUsage, translateOpenAI } from "../src/providers/openai.ts";

describe("anthropic", () => {
  it("converts money both ways", () => {
    expect(usdToCents(0.3)).toBe("30");
    expect(usdToCents(0.001)).toBe("1");
    expect(parseListCostUsd({ amount: "42", currency: "USD" })).toBe(0.42);
    expect(parseListCostUsd({ amount: "0.42", currency: "USD" })).toBe(0.42);
    expect(parseListCostUsd(null)).toBeNull();
  });
  it("follows a retrying session.error and names MCP results by mcp_tool_use_id", () => {
    const retrying = translateAnthropic({
      id: "e1",
      type: "session.error",
      error: {
        type: "model_error",
        message: "upstream hiccup",
        retry_status: { type: "retrying" },
      },
    });
    expect(retrying.outcome).toEqual({ kind: "continue" });
    expect(retrying.events[0]?.payload).toMatchObject({ retry_status: "retrying" });
    expect(
      translateAnthropic({
        id: "e2",
        type: "session.error",
        error: { type: "billing_error", message: "no credits", retry_status: { type: "terminal" } },
      }).outcome,
    ).toEqual({ kind: "failed", error: "no credits", code: "billing_error" });
    expect(
      translateAnthropic({
        id: "e3",
        type: "agent.mcp_tool_result",
        mcp_tool_use_id: "m1",
        content: [],
      }).events[0]?.payload,
    ).toMatchObject({ id: "m1" });
  });
  it("maps messages, tools, usage, and idle reasons", () => {
    const message = translateAnthropic({
      id: "sevt_1",
      type: "agent.message",
      content: [{ type: "text", text: "hello" }],
    });
    expect(message.upstreamId).toBe("sevt_1");
    expect(message.events).toEqual([{ type: "message.delta", payload: { text: "hello" } }]);
    expect(
      translateAnthropic({
        id: "s2",
        type: "agent.tool_use",
        name: "bash",
        input: { command: "ls" },
      }).events[0]?.type,
    ).toBe("tool.call");
    expect(
      translateAnthropic({ id: "s3", type: "agent.tool_result", tool_use_id: "s2", content: [] })
        .events[0]?.payload,
    ).toMatchObject({ id: "s2", is_error: false });
    expect(
      translateAnthropic({
        id: "s4",
        type: "session.usage",
        usage: { list_cost: { amount: "45", currency: "USD" } },
      }).spend,
    ).toEqual({ kind: "list_cost_usd", totalUsd: 0.45 });
    expect(
      translateAnthropic({
        id: "s",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      }).outcome,
    ).toEqual({ kind: "completed" });
    expect(
      translateAnthropic({
        id: "s",
        type: "session.status_idle",
        stop_reason: { type: "budget_reached" },
      }).outcome,
    ).toEqual({ kind: "budget_exceeded" });
    expect(
      translateAnthropic({ id: "s", type: "session.error", error: { message: "boom" } }).outcome,
    ).toEqual({ kind: "failed", error: "boom" });
    expect(translateAnthropic({ id: "s", type: "user.message" }).events).toEqual([]);
  });
});

describe("openai", () => {
  it("prices cached input separately", () => {
    expect(
      openaiTokenUsage({
        input_tokens: 1000,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 400 },
      }),
    ).toEqual({ inputTokens: 600, outputTokens: 20, cacheReadTokens: 400 });
  });
  it("maps finished items, turns, and session status", () => {
    const message = translateOpenAI({
      type: "agent.session.turn.item.done",
      event_id: "e1",
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    });
    expect(message.upstreamId).toBe("msg_1");
    expect(message.events).toEqual([{ type: "message.delta", payload: { text: "hi" } }]);
    const command = translateOpenAI({
      type: "agent.session.turn.item.done",
      event_id: "e2",
      item: { id: "cmd_1", type: "command_execution", command: "ls", exit_code: 1, output: "err" },
    });
    expect(command.events.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
    expect(command.events[1]?.payload).toMatchObject({ id: "cmd_1", is_error: true });
    const turn = translateOpenAI({
      type: "agent.session.turn.completed",
      event_id: "e3",
      turn_id: "turn_1",
      usage: null,
    });
    expect(turn.upstreamId).toBe("turn_1");
    expect(turn.pollSpend).toBe(true);
    expect(
      translateOpenAI({ type: "agent.session.idle", event_id: "e", session: { id: "sess_1" } }),
    ).toMatchObject({ upstreamId: "sess_1:idle", outcome: { kind: "completed" } });
    // A function_call item alone does not establish a pending result; required_actions does,
    // and each wait gets its own id so a second one in the same session is not deduped.
    expect(
      translateOpenAI({
        type: "agent.session.turn.item.added",
        event_id: "e4",
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      }).requests,
    ).toBeUndefined();
    const waiting = translateOpenAI({
      type: "agent.session.requires_action",
      event_id: "e5",
      session: {
        id: "sess_1",
        required_actions: [
          { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
        ],
      },
    });
    expect(waiting.upstreamId).toBe("sess_1:requires_action:call_1");
    expect(waiting.requests?.map((r) => r.id)).toEqual(["call_1"]);
    expect(
      translateOpenAI({
        type: "agent.session.turn.failed",
        turn_id: "t2",
        turn: { error: { code: "session_budget_exceeded", message: "cap" } },
      }).outcome,
    ).toEqual({ kind: "budget_exceeded" });
    expect(
      translateOpenAI({ type: "agent.session.turn.output_text.delta", event_id: "d", delta: "x" })
        .events,
    ).toEqual([]);
  });
});

describe("google", () => {
  it("maps cumulative usage", () => {
    expect(
      googleTokenUsage({
        total_input_tokens: 100,
        total_output_tokens: 7,
        total_thought_tokens: 3,
        total_cached_tokens: 40,
      }),
    ).toEqual({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 40 });
  });
  it("maps steps, deltas, and lifecycle as observed live", () => {
    expect(
      translateGoogle({
        event_type: "step.start",
        event_id: "i:1",
        index: 1,
        step: { type: "code_execution_call", id: "call_1", signature: "" },
      }).events,
    ).toEqual([]);
    const call = translateGoogle({
      event_type: "step.delta",
      event_id: "i:2",
      index: 1,
      step: { type: "code_execution_call", id: "call_1" },
      delta: { type: "code_execution_call", arguments: { code: "print(1)" } },
    });
    expect(call.events[0]).toMatchObject({
      type: "tool.call",
      payload: { id: "call_1", name: "code_execution" },
    });
    const result = translateGoogle({
      event_type: "step.delta",
      event_id: "i:3",
      index: 2,
      step: { type: "code_execution_result", call_id: "call_1" },
      delta: { type: "code_execution_result", result: "1\n", is_error: false },
    });
    expect(result.events[0]).toMatchObject({
      type: "tool.result",
      payload: { id: "call_1", is_error: false },
    });
    expect(
      translateGoogle({
        event_type: "step.delta",
        event_id: "i:4",
        index: 0,
        delta: { type: "text", text: "hi" },
      }).events,
    ).toEqual([{ type: "message.delta", payload: { text: "hi" } }]);
    expect(
      translateGoogle({
        event_type: "step.stop",
        event_id: "i:5",
        index: 0,
        usage: { total_input_tokens: 5, total_output_tokens: 2 },
      }).spend,
    ).toEqual({
      kind: "tokens_total",
      usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0 },
    });
    expect(
      translateGoogle({
        event_type: "interaction.status_update",
        interaction_id: "i",
        status: "budget_exceeded",
      }).outcome,
    ).toEqual({ kind: "budget_exceeded" });
    expect(
      translateGoogle({
        event_type: "interaction.completed",
        event_id: "i:6",
        interaction: { id: "i", status: "completed" },
      }).outcome,
    ).toEqual({ kind: "completed" });
    expect(translateGoogle({ event_type: "error", error: { message: "nope" } }).outcome).toEqual({
      kind: "failed",
      error: "nope",
    });
  });
});

describe("cursor", () => {
  it("maps usage with both cache directions", () => {
    expect(
      cursorTokenUsage({
        inputTokens: 10,
        outputTokens: 2,
        cacheWriteTokens: 3,
        cacheReadTokens: 4,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 });
    expect(cursorTokenUsage(null)).toBeNull();
  });
  it("maps stream frames and run objects per the published spec", () => {
    const text = translateCursor({
      runId: "run-1",
      event: "assistant",
      id: "1-0",
      data: { text: "hi" },
    });
    expect(text.upstreamId).toBe("run-1:1-0");
    expect(text.events).toEqual([{ type: "message.delta", payload: { text: "hi" } }]);
    const running = translateCursor({
      runId: "run-1",
      event: "tool_call",
      id: "1-1",
      data: { callId: "c1", name: "read_file", status: "running", args: { path: "README.md" } },
    });
    expect(running.events[0]).toMatchObject({
      type: "tool.call",
      payload: { id: "c1", name: "read_file" },
    });
    const completed = translateCursor({
      runId: "run-1",
      event: "tool_call",
      id: "1-2",
      data: {
        callId: "c1",
        name: "read_file",
        status: "completed",
        result: { success: { content: "# P" } },
      },
    });
    expect(completed.events[0]).toMatchObject({
      type: "tool.result",
      payload: { id: "c1", is_error: false, content: { content: "# P" } },
    });
    expect(
      translateCursor({
        runId: "run-1",
        event: "tool_call",
        id: "1-3",
        data: {
          callId: "c2",
          name: "run_terminal_cmd",
          status: "completed",
          result: { error: "boom" },
        },
      }).events[0]?.payload,
    ).toMatchObject({ is_error: true });
    const finished = translateCursor({
      runId: "run-1",
      event: "result",
      id: "1-9",
      data: { runId: "run-1", status: "FINISHED", text: "done", durationMs: 5 },
    });
    expect(finished).toMatchObject({
      upstreamId: "run-1:1-9",
      pollSpend: true,
      outcome: { kind: "completed" },
    });
    expect(
      translateCursor({ runId: "run-1", event: "result", id: "1-9", data: { status: "ERROR" } })
        .outcome.kind,
    ).toBe("failed");
    expect(
      translateCursor({ runId: "run-1", event: "result", id: "1-9", data: { status: "CANCELLED" } })
        .outcome,
    ).toEqual({ kind: "terminated" });
    // The sticky status frame has no id and never dedupes; heartbeats and interaction_update are noise.
    expect(
      translateCursor({ runId: "run-1", event: "status", id: null, data: { status: "RUNNING" } })
        .upstreamId,
    ).toBeNull();
    expect(
      translateCursor({ runId: "run-1", event: "heartbeat", id: "1-4", data: {} }).events,
    ).toEqual([]);
    expect(
      translateCursor({ runId: "run-1", event: "interaction_update", id: "1-5", data: {} }).events,
    ).toEqual([]);
    // A run object stands in for a stream that expired; an earlier run is transcript only.
    const fromObject = translateCursor({
      runId: "run-1",
      event: "run",
      id: "result",
      data: { id: "run-1", status: "FINISHED", result: "Added README." },
    });
    expect(fromObject.events[0]).toEqual({
      type: "message.delta",
      payload: { text: "Added README." },
    });
    expect(fromObject.outcome).toEqual({ kind: "completed" });
    const earlier = translateCursor({
      runId: "run-0",
      event: "run",
      id: "result",
      data: { id: "run-0", status: "FINISHED", result: "old" },
      stale: true,
    });
    expect(earlier.outcome).toEqual({ kind: "continue" });
    expect(earlier.pollSpend).toBeUndefined();
  });
});
