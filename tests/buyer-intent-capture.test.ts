// v0.7.3 / T3.2 pre-req: buyer_intent_* capture in chat-pipeline.
//
// T2.5 (re-engagement) and T3.2 (acquisition signal) both read from
// conversations.buyer_intent_make/model/body_type. Migration 0015
// shipped the columns; v0.7.2 shipped the consumers — but no writer
// was wired. This test guards the producer half end-to-end:
//   1. First turn writes all three when the model surfaces them.
//   2. First-write-wins: a later turn that returns DIFFERENT intent
//      must NOT clobber the captured row.
//   3. Null fields don't trigger a no-op patch (the chat-pipeline
//      logs `buyer_intent_captured` only when something actually
//      changed).
//
// We piggyback on the existing mock-pipeline harness so the schema +
// builder coverage matches the rest of the test suite.

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

describe("buyer_intent capture", () => {
  it("writes make + model + body_type on first turn when the model surfaces them", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer({ name: "Acme Motors" });
    const conversation = h.helper.seedConversation(dealer);
    h.helper.claudeMock.set({
      reply: "Yes — the 2018 Camry is on the lot.",
      intent: "test_drive",
      language: "en",
      offered_calendly: false,
      buyer_intent: { make: "toyota", model: "camry", body_type: "sedan" },
    });

    await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "Hi, do you still have the 2018 Toyota Camry?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-intent-1",
    });

    const after = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;
    expect(after.buyer_intent_make).toBe("toyota");
    expect(after.buyer_intent_model).toBe("camry");
    expect(after.buyer_intent_body_type).toBe("sedan");
  });

  it("first-write-wins: a later turn with different intent does NOT overwrite", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer();
    const conversation = h.helper.seedConversation(dealer);

    // Turn 1: buyer asks about a Camry.
    h.helper.claudeMock.set({
      reply: "Sure, the Camry is available.",
      intent: "general",
      language: "en",
      offered_calendly: false,
      buyer_intent: { make: "toyota", model: "camry", body_type: "sedan" },
    });
    await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "Got the Toyota Camry?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-intent-pivot-1",
    });

    // Re-load the conversation row — the pipeline mutates the row in the
    // store; tests should refetch rather than reuse the seed object.
    const afterT1 = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;

    // Turn 2: buyer pivots — but we feed the same conversation back in
    // (chat-pipeline reads the *current* row to check null-ness). The
    // first-write-wins guard must NOT overwrite Camry with F-150.
    h.helper.claudeMock.set({
      reply: "We also have an F-150.",
      intent: "general",
      language: "en",
      offered_calendly: false,
      buyer_intent: { make: "ford", model: "f-150", body_type: "truck" },
    });
    await runChatTurn({
      dealer,
      conversation: afterT1,
      rawBuyerMessage: "Actually I want an F-150.",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-intent-pivot-2",
    });

    const afterT2 = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;
    expect(afterT2.buyer_intent_make).toBe("toyota");
    expect(afterT2.buyer_intent_model).toBe("camry");
    expect(afterT2.buyer_intent_body_type).toBe("sedan");
  });

  it("backfills a single null field on a later turn without clobbering populated ones", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer();
    // Seed a conversation with make+model already captured but body_type null.
    const conversation = h.helper.seedConversation(dealer, {
      buyer_intent_make: "honda",
      buyer_intent_model: "civic",
      buyer_intent_body_type: null,
    });

    h.helper.claudeMock.set({
      reply: "Yes, the Civic is a sedan.",
      intent: "general",
      language: "en",
      offered_calendly: false,
      buyer_intent: { make: "toyota", model: "camry", body_type: "sedan" },
    });
    await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "Is it a sedan?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-intent-backfill",
    });

    const after = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;
    // make + model preserved; body_type backfilled.
    expect(after.buyer_intent_make).toBe("honda");
    expect(after.buyer_intent_model).toBe("civic");
    expect(after.buyer_intent_body_type).toBe("sedan");
  });

  it("no-op when the model returns all-null intent (no patch row, no error)", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer();
    const conversation = h.helper.seedConversation(dealer);

    h.helper.claudeMock.set({
      reply: "Hours are 9-6 today.",
      intent: "general",
      language: "en",
      offered_calendly: false,
      buyer_intent: { make: null, model: null, body_type: null },
    });
    await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "What are your hours?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-intent-noop",
    });

    const after = h.helper.getStore().conversations.get(conversation.id) as ConversationRow;
    expect(after.buyer_intent_make).toBeNull();
    expect(after.buyer_intent_model).toBeNull();
    expect(after.buyer_intent_body_type).toBeNull();
  });
});
