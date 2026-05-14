// Unit tests for the deterministic lead-quality scorer. We cover the
// four canonical branches (hot via intent, hot via escalation, warm
// via test_drive, warm via msg count, cold default) plus edge cases
// the chat pipeline can hand in (null lastIntent, empty sequence,
// generic-only sequence, message count of 1).

import { describe, expect, it } from "vitest";
import { scoreConversation } from "../src/lib/lead-scoring";

describe("scoreConversation", () => {
  it("hot: ready_to_close lastIntent", () => {
    expect(
      scoreConversation({
        lastIntent: "ready_to_close",
        buyerMessageCount: 1,
        intentSequence: ["ready_to_close"],
      }),
    ).toBe("hot");
  });

  it("hot: financing lastIntent", () => {
    expect(
      scoreConversation({
        lastIntent: "financing",
        buyerMessageCount: 2,
        intentSequence: ["general", "financing"],
      }),
    ).toBe("hot");
  });

  it("hot: sustained engagement with intent escalation (4+ buyer turns, 2 distinct non-general intents)", () => {
    expect(
      scoreConversation({
        lastIntent: "test_drive",
        buyerMessageCount: 4,
        intentSequence: ["general", "trade_in", "test_drive"],
      }),
    ).toBe("hot");
  });

  it("warm: test_drive intent without escalation", () => {
    expect(
      scoreConversation({
        lastIntent: "test_drive",
        buyerMessageCount: 1,
        intentSequence: ["test_drive"],
      }),
    ).toBe("warm");
  });

  it("warm: 2-3 buyer messages, generic intent", () => {
    expect(
      scoreConversation({
        lastIntent: "general",
        buyerMessageCount: 2,
        intentSequence: ["general", "general"],
      }),
    ).toBe("warm");
    expect(
      scoreConversation({
        lastIntent: "general",
        buyerMessageCount: 3,
        intentSequence: ["general", "general", "general"],
      }),
    ).toBe("warm");
  });

  it("cold: single buyer message, generic intent (default)", () => {
    expect(
      scoreConversation({
        lastIntent: "general",
        buyerMessageCount: 1,
        intentSequence: ["general"],
      }),
    ).toBe("cold");
  });

  it("cold: null lastIntent, single turn", () => {
    expect(
      scoreConversation({
        lastIntent: null,
        buyerMessageCount: 1,
        intentSequence: [],
      }),
    ).toBe("cold");
  });

  it("cold: 4+ buyer messages but no escalation (all general)", () => {
    expect(
      scoreConversation({
        lastIntent: "general",
        buyerMessageCount: 6,
        intentSequence: ["general", "general", "general", "general"],
      }),
    ).toBe("cold");
  });

  it("does not promote hot via escalation when lastIntent is general", () => {
    // The escalation rule requires lastIntent to be NOT general — the
    // buyer might have escalated and then drifted back. We treat the
    // drift as "lost focus" and downgrade.
    expect(
      scoreConversation({
        lastIntent: "general",
        buyerMessageCount: 5,
        intentSequence: ["test_drive", "trade_in", "general"],
      }),
    ).toBe("warm");
  });

  it("treats an empty intent sequence as no escalation", () => {
    expect(
      scoreConversation({
        lastIntent: "test_drive",
        buyerMessageCount: 5,
        intentSequence: [],
      }),
    ).toBe("warm");
  });
});
