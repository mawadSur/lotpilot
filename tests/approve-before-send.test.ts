// Integration test: approve-before-send mode triple-filter.
//
// Asserts:
//   - dealer.approve_before_send=true causes the AI message to land in
//     'pending' state (not 'auto').
//   - runChatTurn returns kind='pending' and a null reply (never leaks
//     the draft to the buyer).
//   - the dashboard's poll-shaped filter
//     `approval_status IN ('approved','sent')` returns 0 rows for the
//     pending draft, so the buyer's UI never sees it.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs BEFORE vi.mock factories are pulled to the top of
// the file. Without this, the factory closures would reference
// `claudeCallSpy`/`mockSb` before they're initialised. Everything the
// factories need MUST come from inside this hoisted block.
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
import type { MessageRow } from "../src/lib/db-types";

beforeEach(async () => {
  const h = await hoisted;
  h.helper.resetStore();
  h.helper.claudeMock.reset();
  h.claudeCallSpy.mockClear();
});

describe("approve-before-send", () => {
  it("queues the AI draft as pending and never returns reply text to buyer", async () => {
    const h = await hoisted;
    const dealer = h.helper.seedDealer({ approve_before_send: true, name: "Acme Motors" });
    const conversation = h.helper.seedConversation(dealer);
    h.helper.claudeMock.set({
      reply: "Happy to set you up for a test drive!",
      intent: "test_drive",
      language: "en",
      offered_calendly: false,
    });

    const result = await runChatTurn({
      dealer,
      conversation,
      rawBuyerMessage: "Can I test drive the Civic tomorrow?",
      channel: "web",
      ip: "127.0.0.1",
      userAgent: "vitest",
      buyerPhone: null,
      requestId: "req-test-1",
    });

    expect(result.kind).toBe("pending");
    expect(result.reply).toBeNull();
    expect(result.ackReply).toMatch(/dealer will reply/i);
    expect(result.pendingApproval).toBe(true);

    // Inspect persisted messages — exactly one buyer turn + one
    // pending AI draft. The draft must be invisible to the poll.
    const allMessages = [...h.helper.getStore().messages.values()] as MessageRow[];
    const aiMessages = allMessages.filter((m) => m.role === "ai");
    expect(aiMessages).toHaveLength(1);
    expect(aiMessages[0].approval_status).toBe("pending");

    // Triple-filter: the dashboard / widget poll uses this exact set.
    const visibleToBuyer = aiMessages.filter((m) =>
      ["approved", "sent"].includes(m.approval_status),
    );
    expect(visibleToBuyer).toHaveLength(0);

    // Claude was called exactly once for this turn.
    expect(h.claudeCallSpy).toHaveBeenCalledTimes(1);
  });
});
