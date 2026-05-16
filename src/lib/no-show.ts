// T1.7 — Deterministic no-show risk scorer. Pure function, no I/O, no
// Claude call. Same design rationale as src/lib/lead-scoring.ts:
//   - Cost:        runs on every booking event + at drainer tick time.
//                  A Claude call here would double per-booking AI spend
//                  on a feature that's "look at the conversation shape",
//                  not "synthesize new reasoning".
//   - Latency:     <1ms vs. a 600ms model call.
//   - Determinism: a dealer who sees a 'high' risk on Tuesday should
//                  see the same risk on Wednesday given the same data.
//
// We blend five heuristic factors into a 0..1 score, then bucket the
// score into tier ∈ {'low','medium','high'}. The bucket is what the
// rest of the system reacts to:
//   - low tier:    24h confirm only (skip the 2h follow-up).
//   - medium/high: 24h confirm + 2h follow-up.
//
// Why bucket the score?
//   - The downstream consumer (T1.7-B scheduler) needs a discrete
//     enqueue decision. Floating-point cutoffs would invite drift if
//     we ever recompute risk at drainer time vs. enqueue time.
//   - The dashboard surface (future) renders a chip ('Low'|'Med'|'High')
//     not a number — the bucket IS the product UI.
//
// FACTOR WEIGHTS are documented as named constants below. They sum to
// 1.0 so the final score is naturally in [0,1] without clamping math.
// Any rebalance must keep the sum invariant — the test suite covers
// the canonical buckets and would surface a sum drift via the cold
// and hot fixtures.

import type {
  ConversationRow,
  DealerRow,
  LeadScore,
  MessageRow,
  NoShowTier,
} from "./db-types";

export type { NoShowTier };

// Weights sum to exactly 1.0. Booking gap dominates because it's the
// strongest no-show signal in dealer-floor reality: a buyer who books
// "right now" (panic appointment) and a buyer who books >10 days out
// (cold-storage) both no-show at roughly 2-3x the baseline rate.
//
// Reply latency comes second — a buyer who took 4 hours to reply on
// average during qualification is unlikely to be sitting by their
// phone the morning of the appointment.
//
// Lead score (hot/warm/cold) and consent state and prior no-shows are
// secondary lifts. We keep them in the model so the score CAN move
// the bucket on borderline cases, but they don't dominate.
const W_BOOKING_GAP = 0.4;
const W_REPLY_LATENCY = 0.25;
const W_LEAD_SCORE = 0.15;
const W_CONSENT = 0.1;
const W_PRIOR_NO_SHOWS = 0.1;

// Bucket thresholds. score >= HIGH_T is 'high'; >= MED_T is 'medium';
// else 'low'. Chosen so a single bad signal can't move you to 'high'
// alone — you need the booking-gap factor (0.4 weight) PLUS at least
// one other negative signal to clear 0.55.
const MED_T = 0.3;
const HIGH_T = 0.55;

export interface ScoreNoShowInput {
  // Conversation row. We read:
  //   - lead_score (hot/warm/cold)
  //   - suppressed_at (consent withdrawn → can't actually send reminder
  //     anyway, but we DO model it: the dealer should treat suppressed
  //     bookings as higher-risk because the auto-confirm path is gated).
  //   - prior_no_show_count if the column exists (future-proof; we
  //     read it via the optional field below — see ConversationLike).
  conversation: ConversationLike;
  // Dealer is currently unused by the scoring math but kept in the
  // signature so the caller has a stable contract — future weights
  // (e.g. dealer-segment baselines) plug in here without an API churn.
  dealer: Pick<DealerRow, "id">;
  // Recent buyer/AI message rows (oldest -> newest). We use them ONLY
  // for reply-latency estimation. Pass [] if you don't have them; the
  // factor drops to a neutral 0.5.
  conversation_messages?: Pick<MessageRow, "role" | "created_at">[];
  // ISO timestamp of the booked appointment.
  scheduledAt: string;
  // Reference time for "how soon is this booking". Tests inject a
  // fixed timestamp; production passes `new Date().toISOString()`.
  now: string;
}

// Subset of ConversationRow the scorer actually reads. Declared
// separately so we can pass synthetic rows in tests without lying
// about the full ConversationRow shape, and so a future schema column
// (prior_no_show_count) plugs in without a type churn on
// ConversationRow itself.
export interface ConversationLike {
  lead_score: LeadScore | null;
  suppressed_at: string | null;
  // OPTIONAL future column. If present + > 0 we lift the score. We
  // never write to this from this file — purely consumed.
  prior_no_show_count?: number | null;
}

export interface NoShowFactors {
  // 0..1, higher = more no-show risk. Per-factor breakout matches the
  // weight constants above so a dashboard surface can render the same
  // table for operators ("why is this high?").
  bookingGap: number;
  replyLatency: number;
  leadScore: number;
  consent: number;
  priorNoShows: number;
}

export interface NoShowScore {
  score: number;
  factors: NoShowFactors;
  tier: NoShowTier;
}

// Hour constants in ms.
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

// Booking-gap curve:
//   < 2h     : 0.9 (panic appointment; buyer barely thought about it)
//   2-6h     : 0.6
//   6-24h    : 0.3 (the sweet spot — already committed in the day)
//   1-3d     : 0.2
//   3-7d     : 0.4 (drifting; needs nudging)
//   7-14d    : 0.7 (cold-storage; common no-show pattern)
//   > 14d    : 0.85
function scoreBookingGap(scheduledAtMs: number, nowMs: number): number {
  const gapMs = scheduledAtMs - nowMs;
  if (gapMs < 0) return 0.5; // appointment is in the past; neutral
  if (gapMs < 2 * MS_HOUR) return 0.9;
  if (gapMs < 6 * MS_HOUR) return 0.6;
  if (gapMs < 1 * MS_DAY) return 0.3;
  if (gapMs < 3 * MS_DAY) return 0.2;
  if (gapMs < 7 * MS_DAY) return 0.4;
  if (gapMs < 14 * MS_DAY) return 0.7;
  return 0.85;
}

// Reply latency: median buyer-after-AI gap, in minutes.
// We compute one gap per AI->buyer adjacent pair, then take the median
// so a single outlier (buyer slept on it overnight) doesn't dominate.
//   <= 5 min   : 0.1
//   5-30 min   : 0.25
//   30-120 min : 0.5
//   2-12 hours : 0.7
//   > 12 hours : 0.85
// Empty/missing data → 0.5 (neutral; "we don't know").
function scoreReplyLatency(
  messages: Pick<MessageRow, "role" | "created_at">[],
): number {
  if (messages.length < 2) return 0.5;
  const gaps: number[] = [];
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (prev.role === "ai" && cur.role === "buyer") {
      const dt = new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime();
      if (Number.isFinite(dt) && dt > 0) gaps.push(dt);
    }
  }
  if (gaps.length === 0) return 0.5;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const min = median / (60 * 1000);
  if (min <= 5) return 0.1;
  if (min <= 30) return 0.25;
  if (min <= 120) return 0.5;
  if (min <= 12 * 60) return 0.7;
  return 0.85;
}

function scoreLeadScore(leadScore: LeadScore | null): number {
  if (leadScore === "hot") return 0.1;
  if (leadScore === "warm") return 0.4;
  if (leadScore === "cold") return 0.75;
  return 0.5; // null / unknown
}

// Consent withdrawn (STOP) → can't even send the auto-confirm reminder,
// AND it's a strong negative signal that the buyer is checked out.
function scoreConsent(suppressedAt: string | null): number {
  return suppressedAt ? 0.9 : 0.1;
}

function scorePriorNoShows(count: number | null | undefined): number {
  if (!count || count <= 0) return 0.1;
  if (count === 1) return 0.55;
  if (count === 2) return 0.75;
  return 0.9;
}

function bucket(score: number): NoShowTier {
  if (score >= HIGH_T) return "high";
  if (score >= MED_T) return "medium";
  return "low";
}

export function scoreNoShowRisk(input: ScoreNoShowInput): NoShowScore {
  const { conversation, scheduledAt, now } = input;
  const messages = input.conversation_messages ?? [];

  const scheduledAtMs = new Date(scheduledAt).getTime();
  const nowMs = new Date(now).getTime();

  const factors: NoShowFactors = {
    bookingGap: scoreBookingGap(scheduledAtMs, nowMs),
    replyLatency: scoreReplyLatency(messages),
    leadScore: scoreLeadScore(conversation.lead_score),
    consent: scoreConsent(conversation.suppressed_at),
    priorNoShows: scorePriorNoShows(conversation.prior_no_show_count ?? null),
  };

  const score =
    factors.bookingGap * W_BOOKING_GAP +
    factors.replyLatency * W_REPLY_LATENCY +
    factors.leadScore * W_LEAD_SCORE +
    factors.consent * W_CONSENT +
    factors.priorNoShows * W_PRIOR_NO_SHOWS;

  return { score, factors, tier: bucket(score) };
}

// Re-export the weights so a future dashboard surface can render the
// same numeric breakdown an operator would see in the audit log.
export const NO_SHOW_WEIGHTS = {
  bookingGap: W_BOOKING_GAP,
  replyLatency: W_REPLY_LATENCY,
  leadScore: W_LEAD_SCORE,
  consent: W_CONSENT,
  priorNoShows: W_PRIOR_NO_SHOWS,
} as const;

// Convenience wrapper that reads off a full ConversationRow (the shape
// the calendly webhook hands us). Keeps the call site one-liner.
export function scoreNoShowFromRow(args: {
  conversation: ConversationRow & { prior_no_show_count?: number | null };
  dealer: DealerRow;
  scheduledAt: string;
  messages?: Pick<MessageRow, "role" | "created_at">[];
  now?: string;
}): NoShowScore {
  return scoreNoShowRisk({
    conversation: {
      lead_score: args.conversation.lead_score,
      suppressed_at: args.conversation.suppressed_at,
      prior_no_show_count: args.conversation.prior_no_show_count ?? null,
    },
    dealer: { id: args.dealer.id },
    conversation_messages: args.messages ?? [],
    scheduledAt: args.scheduledAt,
    now: args.now ?? new Date().toISOString(),
  });
}
