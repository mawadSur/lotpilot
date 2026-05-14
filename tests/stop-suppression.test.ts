// Integration test: STOP keyword + suppression follow-up.
//
// Cluster A: a buyer sends "STOP" — we persist a keyword_event, flip
// suppressed_at on the conversation, return the canned bilingual ack,
// and DO NOT call Claude.
//
// Cluster B: a follow-up message lands on a conversation whose
// suppressed_at is already set — we return kind='suppressed' with the
// generic ack, and again DO NOT call Claude. (TCPA: opt-out is sticky
// across turns until the buyer sends START.)

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(async () => {
  const { vi: viInner } = await import("vitest");
  const helper = await import("./helpers/mock-pipeline");
  return {
    helper,
    mockSb: helper.makeMockSb(),
    claudeCallSpy: viInner.fn(async () => helper.claudeMock.current),
    sendSmsSpy: viInner.fn(async () => ({ queued: true, sid: "SM_test" })),
  };
});

vi.mock("../src/lib/supabase-service", async () => {
  const h = await hoisted;
  return { createServiceSupabase: () => h.mockSb };
});

vi.mock("../src/lib/ratelimit", () => ({
  checkRate: vi.fn(async () => ({ ok: true, remaining: 100, resetSec: 60, rule: "conversation" })),
  readClientIp: () => "127.0.0.1",
}));

vi.mock("../src/lib/budget", () => ({
  assertBudgetAvailable: vi.fn(async () => ({ spentUsd: 0, limitUsd: 50, estimatedUsd: 0.001 })),
  recordSpend: vi.fn(async () => undefined),
  estimateCallUsd: () => 0.001,
  estimateUsdFromTokens: () => 0.001,
  BudgetExceededError: class BudgetExceededError extends Error {},
  readDealerBudget: vi.fn(async () => ({ spentUsd: 0, limitUsd: 50, remainingUsd: 50 })),
}));

vi.mock("../src/lib/sms/twilio", async () => {
  const h = await hoisted;
  return {
    sendSms: h.sendSmsSpy,
    maskPhone: (p: string) => p,
    verifyTwilioSignature: vi.fn(async () => true),
  };
});

vi.mock("../src/lib/ai", async () => {
  const h = await hoisted;
  return {
    AI_MAX_OUTPUT_TOKENS: 600,
    callClaude: h.claudeCallSpy,
    estimateMessagesChars: () => 100,
    buildSystemPrompt: () => "system prompt",
    AiReplyError: class AiReplyError extends Error {},
  };
});

import { runChatTurn } from "../src/lib/chat-pipeline";
import type { ConversationRow } from "../src/lib/db-types";

beforeEach(async () => {
  const h = await hoisted;
  h.helper.resetStore();
  h.helper.claudeMock.reset();
  h.claudeCallSpy.mockClear();
});

describe("STOP suppression", () => {
  it("Cluster A: STOP triggers canned ack, sets suppressed_at, never calls Claude", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer({ name: "Acme Motors" });
    const conversation = h.helper.seedConversation(dealer);

    const result = await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "STOP",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-stop-1",
    });

    expect(result.kind).toBe("keyword");
    expect(result.reply).toMatch(/won't receive replies on this channel/i);
    // Canned reply must NOT have hit Claude — full circumvention.
    expect(h.claudeCallSpy).not.toHaveBeenCalled();

    // keyword_event persisted with channel=web.
    const events = [...h.helper.getStore().keyword_events.values()];
    expect(events).toHaveLength(1);
    expect(events[0].keyword).toBe("STOP");
    expect(events[0].channel).toBe("web");

    // conversation.suppressed_at is now set.
    const updatedConv = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;
    expect(updatedConv.suppressed_at).not.toBeNull();
  });

  it("Cluster B: a follow-up after STOP returns 'suppressed' and never calls Claude", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer({ name: "Acme Motors" });
    const conversation = h.helper.seedConversation(dealer, {
      // Pre-flipped — simulates the state after Cluster A persisted.
      suppressed_at: new Date().toISOString(),
    });

    const result = await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "are you still there?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-stop-2",
    });

    expect(result.kind).toBe("suppressed");
    expect(result.reply).toMatch(/opted out/i);
    expect(h.claudeCallSpy).not.toHaveBeenCalled();
  });
});
