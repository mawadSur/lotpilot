// Deterministic lead-quality scoring. No Claude call — the heuristic
// is recomputed on every AI reply turn from data the chat pipeline
// already has in hand (last intent + buyer message count + intent
// sequence). Persisted to conversations.lead_score so the inbox query
// is a single index seek instead of a per-row CASE.
//
// Three tiers (text enum, mirrors the conversations.lead_score CHECK):
//
//   hot  : buyer signalled "ready to buy" semantics. Surface in the
//          existing hot-buyer banner; route to a human closer ASAP.
//   warm : buyer engaged but not at the buying line yet — usually
//          test-drive intent or a small (2-3) back-and-forth.
//   cold : minimal engagement — single buyer turn, no intent
//          escalation. Default fallback when the signal is ambiguous.
//
// Why heuristic, not Claude:
//   - Cost: scoring is a UI surface that fires on every turn. Calling
//     Claude here would double our per-turn AI cost for a feature
//     that's "look at the conversation shape", not "synthesize new
//     reasoning".
//   - Latency: the dashboard refresh has a 60s revalidate (see
//     /dashboard/page.tsx). A heuristic answers in <1ms.
//   - Determinism: a dealer who sees a 'hot' score on Tuesday should
//     see the same score on Wednesday given the same data. An LLM
//     drifts; a function doesn't.

import type { Intent, MessageRow } from "./db-types";

export type LeadScore = "hot" | "warm" | "cold";

export interface ScoreInput {
  // Conversation-level last intent (the value chat-pipeline will write
  // to conversations.last_intent on this turn).
  lastIntent: Intent | null;
  // Number of buyer turns persisted in the conversation, INCLUDING
  // the one we just inserted in this pipeline run.
  buyerMessageCount: number;
  // Rolling window of recent intents off the AI replies (oldest →
  // newest). The chat pipeline appends the current intent to this
  // list before passing it in. We use this to detect intent
  // *escalation* — multiple distinct intents — which is a stronger
  // hot-lead signal than a single high-value turn.
  intentSequence: (Intent | null)[];
}

const HOT_INTENTS: ReadonlySet<Intent> = new Set(["ready_to_close", "financing"]);

// Returns true iff the buyer hopped between at least two distinct
// intents inside the rolling sequence. "general" is filtered first
// because the AI defaults to general when it has nothing better and
// we don't want a couple of generic turns to count as "engagement".
function hasIntentEscalation(seq: (Intent | null)[]): boolean {
  const nonGeneric = seq.filter((i): i is Intent => i != null && i !== "general");
  if (nonGeneric.length < 2) return false;
  const distinct = new Set(nonGeneric);
  return distinct.size >= 2;
}

export function scoreConversation(input: ScoreInput): LeadScore {
  const { lastIntent, buyerMessageCount, intentSequence } = input;

  // Hot path 1: explicit ready-to-close or financing intent on the
  // current turn. The system prompt is calibrated to set
  // ready_to_close only when the buyer signals "I'll take it" or
  // similar — so this is a high-precision signal.
  if (lastIntent && HOT_INTENTS.has(lastIntent)) {
    return "hot";
  }

  // Hot path 2: sustained engagement with intent escalation and the
  // latest turn is NOT a generic placeholder. Catches the buyer who
  // started by asking about a Civic (general), then test-drive, then
  // financing — by the time the count hits 4 with 2+ distinct
  // non-general intents, they're a real lead.
  if (
    buyerMessageCount >= 4 &&
    hasIntentEscalation(intentSequence) &&
    lastIntent != null &&
    lastIntent !== "general"
  ) {
    return "hot";
  }

  // Warm path 1: any test_drive intent. The buyer asked to come see
  // the car — meaningful signal, but not "ready to buy" yet.
  if (lastIntent === "test_drive") {
    return "warm";
  }

  // Warm path 2: 2-3 buyer turns. They're past "did you even read
  // this listing", before they're a hot lead. Engagement without
  // commitment.
  if (buyerMessageCount >= 2 && buyerMessageCount <= 3) {
    return "warm";
  }

  // Warm path 3: sustained engagement (4+) that previously showed
  // intent escalation but drifted back to general. Keep them warm —
  // they were a real lead once; the dealer should still see them
  // distinguished from a one-turn cold visitor.
  if (buyerMessageCount >= 4 && hasIntentEscalation(intentSequence)) {
    return "warm";
  }

  // Cold default. Single buyer turn, or ambiguous shape, or generic
  // intent. The dashboard de-emphasises cold rows so the dealer
  // focuses on warm + hot first.
  return "cold";
}

// Convenience wrapper for chat-pipeline.ts so the call site stays one
// line. Reuses the historyAll list the pipeline already loaded for
// the Claude prompt — no extra DB round-trip.
export function scoreFromHistory(
  historyAll: Pick<MessageRow, "role" | "intent">[],
  latestIntent: Intent,
): LeadScore {
  const buyerMessageCount = historyAll.filter((m) => m.role === "buyer").length;
  const intentSequence = historyAll
    .filter((m) => m.role === "ai")
    .map((m) => m.intent)
    .slice(-10);
  return scoreConversation({
    lastIntent: latestIntent,
    buyerMessageCount,
    intentSequence: [...intentSequence, latestIntent],
  });
}
