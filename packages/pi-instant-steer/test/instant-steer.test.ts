import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import instantSteer from "../extensions/instant_steer.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

let handlers: Map<string, Handler>;
let ctx: ExtensionContext;
let controller: AbortController;
let draft: string;
let sendUserMessage: ReturnType<typeof vi.fn>;
let toggle: (args: string, ctx: ExtensionContext) => Promise<void>;

function emit(name: string, event: unknown) {
  return handlers.get(name)?.(event as never, ctx);
}

function queue(text = "Change direction") {
  emit("input", { text, source: "interactive", streamingBehavior: "steer" });
}

function interruptedMessage(): Extract<MessageEndEvent["message"], { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Partial response" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: 0,
  };
}

function finish(message = interruptedMessage()) {
  return emit("message_end", { message }) as MessageEndEventResult | undefined;
}

beforeEach(async () => {
  handlers = new Map();
  controller = new AbortController();
  draft = "";
  sendUserMessage = vi.fn();
  ctx = {
    mode: "tui",
    signal: controller.signal,
    ui: {
      getEditorText: () => draft,
      setEditorText: (text: string) => {
        draft = text;
      },
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;
  instantSteer({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendUserMessage,
    registerCommand: (_name: string, options: { handler: typeof toggle }) => {
      toggle = options.handler;
    },
  } as unknown as ExtensionAPI);
  emit("session_start", {});
  await toggle("on", ctx);
});

test("steering interrupt suppresses the abort row and still resubmits exactly once", () => {
  queue();
  draft = "Change direction\n\nFollow up\n\nMy draft";
  controller.abort();
  const message = interruptedMessage();
  const result = finish(message);
  assert.equal(result?.message?.role, "assistant");
  if (result?.message?.role !== "assistant") assert.fail("Expected assistant replacement");
  assert.equal(result.message.stopReason, "stop");
  assert.equal(result.message.errorMessage, undefined);
  assert.deepEqual(result.message.content, message.content);
  assert.equal(controller.signal.aborted, true);
  assert.equal(message.role === "assistant" && message.stopReason, "aborted");
  emit("agent_settled", { aborted: true });
  assert.deepEqual(sendUserMessage.mock.calls, [["Change direction"]]);
  assert.equal(draft, "Follow up\n\nMy draft");
  emit("agent_settled", { aborted: true });
  assert.equal(sendUserMessage.mock.calls.length, 1);
});

test("ordinary Esc without steering keeps the abort row", () => {
  controller.abort();
  assert.equal(finish(), undefined);
  emit("agent_settled", { aborted: true });
  assert.equal(sendUserMessage.mock.calls.length, 0);
});

test("disabled extension keeps the abort row and does not resubmit", async () => {
  queue();
  draft = "Change direction";
  controller.abort();
  await toggle("off", ctx);
  assert.equal(finish(), undefined);
  emit("agent_settled", { aborted: true });
  assert.equal(sendUserMessage.mock.calls.length, 0);
});

test("provider abort without local cancellation remains visible", () => {
  queue();
  draft = "Change direction";
  assert.equal(finish(), undefined);
});

test("nonstandard provider error remains visible", () => {
  queue();
  draft = "Change direction";
  controller.abort();
  const message = interruptedMessage();
  if (message.role !== "assistant") assert.fail("Expected assistant");
  message.errorMessage = "Connection unexpectedly closed";
  assert.equal(finish(message), undefined);
  message.stopReason = "error";
  assert.equal(finish(message), undefined);
});

test("only restored and undelivered steers suppress the abort row", () => {
  queue();
  controller.abort();
  draft = "Unrelated draft";
  assert.equal(finish(), undefined);
  draft = "Change direction";
  emit("message_start", { message: { role: "user", content: "Change direction" } });
  assert.equal(finish(), undefined);
});

test("tool-call and non-TUI responses remain unchanged", () => {
  queue();
  draft = "Change direction";
  controller.abort();
  const message = interruptedMessage();
  if (message.role !== "assistant") assert.fail("Expected assistant");
  message.content.push({ type: "toolCall", id: "call-1", name: "read", arguments: {} });
  assert.equal(finish(message), undefined);
  ctx = { ...ctx, mode: "rpc" };
  assert.equal(finish(), undefined);
});

test("missing or generic abort text is suppressed for steering", () => {
  queue();
  draft = "Change direction";
  controller.abort();
  const message = interruptedMessage();
  if (message.role !== "assistant") assert.fail("Expected assistant");
  for (const errorMessage of [undefined, "Operation aborted"]) {
    message.errorMessage = errorMessage;
    assert.ok(finish(message)?.message);
  }
});
