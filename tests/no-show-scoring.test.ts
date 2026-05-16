// T1.7 — Unit tests for the no-show risk scorer.
//
// We cover the five heuristic dimensions documented in
// src/lib/no-show.ts:
//   1. Very-short booking gap (< 2h) — high.
//   2. Very-long booking gap (> 14d) — high.
//   3. High reply latency (median > 12h) lifts the score on a warm
//      lead with a mid booking gap.
//   4. Cold lead in the sweet-spot 6-24h window stays low overall
//      because the dominant factor (booking gap) is favorable.
//   5. Hot lead, same window — even lower; never reaches medium.
// Plus:
//   - Consent withdrawn (STOP) lifts the score.
//   - Prior no-shows lift the score.
//   - Empty conversation_messages → reply-latency factor neutral.
//
// We pin `now` to a fixed ISO so the tests are stable under daylight
// saving and across CI environments.

import { describe, expect, it } from "vitest";
import { scoreNoShowRisk, NO_SHOW_WEIGHTS } from "../src/lib/no-show";

const NOW = "2026-05-15T12:00:00Z";

function isoPlus(hours: number): string {
  return new Date(new Date(NOW).getTime() + hours * 60 * 60 * 1000).toISOString();
}

describe("scoreNoShowRisk", () => {
  it("very-short booking gap (1h out) flags high regardless of lead score", () => {
    const out = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(1),
      now: NOW,
    });
    expect(out.factors.bookingGap).toBeCloseTo(0.9, 5);
    expect(out.tier).toBe("high");
    expect(out.score).toBeGreaterThanOrEqual(0.55);
  });

  it("very-long booking gap (20 days out) flags at least medium; high when paired with a cold lead", () => {
    // 20-day-out warm lead with no other negatives: bookingGap dominates
    // but the lift alone doesn't clear HIGH_T (0.55). This is intentional
    // — a single high-risk dimension shouldn't trigger the full reminder
    // cadence; the buyer might be perfectly serious.
    const warm = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(20 * 24),
      now: NOW,
    });
    expect(warm.factors.bookingGap).toBeCloseTo(0.85, 5);
    expect(warm.tier === "medium" || warm.tier === "high").toBe(true);
    // 20-day-out cold lead — booking gap + cold lead clears HIGH_T.
    const cold = scoreNoShowRisk({
      conversation: { lead_score: "cold", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(20 * 24),
      now: NOW,
    });
    expect(cold.tier).toBe("high");
  });

  it("high reply latency (median 14h) lifts a 12h-gap warm-lead booking into medium", () => {
    // Build 3 AI->buyer pairs with 14h latency each.
    const base = new Date(NOW).getTime() - 3 * 24 * 60 * 60 * 1000;
    const fourteenH = 14 * 60 * 60 * 1000;
    const msgs = [
      { role: "ai" as const, created_at: new Date(base).toISOString() },
      { role: "buyer" as const, created_at: new Date(base + fourteenH).toISOString() },
      { role: "ai" as const, created_at: new Date(base + fourteenH + 60_000).toISOString() },
      { role: "buyer" as const, created_at: new Date(base + 2 * fourteenH).toISOString() },
    ];
    const out = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      conversation_messages: msgs,
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(out.factors.replyLatency).toBeCloseTo(0.85, 5);
    expect(out.tier === "medium" || out.tier === "high").toBe(true);
  });

  it("cold lead in 12h window scores higher than warm lead, but bookingGap dominates so tier stays medium-or-lower", () => {
    const cold = scoreNoShowRisk({
      conversation: { lead_score: "cold", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    const warm = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(cold.score).toBeGreaterThan(warm.score);
    // Sweet-spot bookingGap = 0.3 caps total even with cold leadScore.
    expect(cold.tier === "low" || cold.tier === "medium").toBe(true);
  });

  it("hot lead in 12h window scores lowest of all paths", () => {
    const hot = scoreNoShowRisk({
      conversation: { lead_score: "hot", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(hot.tier).toBe("low");
    expect(hot.score).toBeLessThan(0.3);
  });

  it("consent withdrawn (STOP) lifts the score above the no-STOP baseline", () => {
    const withConsent = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    const withoutConsent = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: "2026-05-15T10:00:00Z" },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(withoutConsent.score).toBeGreaterThan(withConsent.score);
  });

  it("prior no-shows lift the score linearly up to 3+", () => {
    const zero = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null, prior_no_show_count: 0 },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    const two = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null, prior_no_show_count: 2 },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(two.score).toBeGreaterThan(zero.score);
    expect(two.factors.priorNoShows).toBeCloseTo(0.75, 5);
  });

  it("weights sum to 1.0 (invariant the scoring math relies on)", () => {
    const sum =
      NO_SHOW_WEIGHTS.bookingGap +
      NO_SHOW_WEIGHTS.replyLatency +
      NO_SHOW_WEIGHTS.leadScore +
      NO_SHOW_WEIGHTS.consent +
      NO_SHOW_WEIGHTS.priorNoShows;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("score is clamped naturally to [0,1] by weighted-sum-of-[0,1] inputs", () => {
    const worst = scoreNoShowRisk({
      conversation: {
        lead_score: "cold",
        suppressed_at: "2026-05-15T10:00:00Z",
        prior_no_show_count: 5,
      },
      dealer: { id: "d1" },
      scheduledAt: isoPlus(1), // panic appointment
      now: NOW,
    });
    expect(worst.score).toBeLessThanOrEqual(1.0);
    expect(worst.score).toBeGreaterThanOrEqual(0.0);
    expect(worst.tier).toBe("high");
  });

  it("empty message list yields neutral reply-latency factor (0.5)", () => {
    const out = scoreNoShowRisk({
      conversation: { lead_score: "warm", suppressed_at: null },
      dealer: { id: "d1" },
      conversation_messages: [],
      scheduledAt: isoPlus(12),
      now: NOW,
    });
    expect(out.factors.replyLatency).toBe(0.5);
  });
});
