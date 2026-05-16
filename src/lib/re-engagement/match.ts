// T2.5 Match logic: given a vehicle_event, find candidate cold-lead
// conversations to re-engage.
//
// Contract:
//   findCandidatesForVehicleEvent(sb, event) → up to 5
//     ConversationRow values ranked by lead-score recency
//     (cold > warm; recent > stale). The CALLER (send.ts) is
//     responsible for every TCPA gate — this module is pure search.
//
// Affinity scoring (intentionally simple, no LLM):
//   - make match: +3 (exact case-insensitive equality on a non-null
//     buyer_intent_make vs vehicle.make)
//   - model match: +3 (same shape on model)
//   - body_type match: +2 (substring contains on description because
//     body_type isn't a first-class vehicle column yet)
//   - Per-buyer baseline: 1 (so even a candidate with zero column
//     matches but a populated buyer_intent_* field can surface if
//     the dealer has under-5 cold leads).
//
// We deliberately scope the SELECT to cold/null lead_score — warm and
// hot leads are still inside an active sales funnel and should not get
// an unsolicited re-engagement nudge (would be a TCPA pestering risk
// even with consent on file). The matcher is allowed to surface a
// candidate; send.ts re-verifies every gate before dispatch.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationRow,
  VehicleEventRow,
  VehicleRow,
} from "../db-types";

export interface MatchCandidate {
  conversation: ConversationRow;
  vehicle: VehicleRow;
  event: VehicleEventRow;
  matchReason: string;
  affinityScore: number;
}

export const MAX_CANDIDATES_PER_EVENT = 5;

// Cold-lead window: we only consider conversations updated within the
// last 90 days. Older than that and the buyer has likely moved on /
// bought elsewhere; pinging them on a brand-new listing risks looking
// like spam even with consent intact.
const COLD_LEAD_WINDOW_DAYS = 90;

interface AffinityResult {
  score: number;
  reasons: string[];
}

function lower(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

function scoreAffinity(
  conv: ConversationRow,
  vehicle: VehicleRow,
): AffinityResult {
  const reasons: string[] = [];
  let score = 0;

  const buyerMake = lower(conv.buyer_intent_make);
  const buyerModel = lower(conv.buyer_intent_model);
  const buyerBody = lower(conv.buyer_intent_body_type);
  const vMake = lower(vehicle.make);
  const vModel = lower(vehicle.model);
  const vDesc = lower(vehicle.description);

  if (buyerMake && vMake && buyerMake === vMake) {
    score += 3;
    reasons.push("make");
  }
  if (buyerModel && vModel && buyerModel === vModel) {
    score += 3;
    reasons.push("model");
  }
  // body_type is captured free-form; vehicle.body_type doesn't exist
  // yet so we substring against vehicle.description (the dealer-
  // written description usually includes "sedan" / "SUV" / "truck").
  if (buyerBody && vDesc && vDesc.includes(buyerBody)) {
    score += 2;
    reasons.push("body_type");
  }
  return { score, reasons };
}

function asConversationRow(row: Record<string, unknown>): ConversationRow {
  return row as unknown as ConversationRow;
}

function asVehicleRow(row: Record<string, unknown>): VehicleRow {
  return row as unknown as VehicleRow;
}

export async function findCandidatesForVehicleEvent(
  sb: SupabaseClient,
  event: VehicleEventRow,
): Promise<MatchCandidate[]> {
  // 1. Load the vehicle so we have something to match against.
  //    A missing vehicle here is a real bug (FK guarantees it exists)
  //    but we tolerate it — better to no-op than to send on stale data.
  const vehicleRes = await sb
    .from("vehicles")
    .select("*")
    .eq("id", event.vehicle_id)
    .eq("dealer_id", event.dealer_id)
    .maybeSingle();
  if (vehicleRes.error || !vehicleRes.data) return [];
  const vehicle = asVehicleRow(vehicleRes.data);
  // Only match against vehicles still available — re-engaging a buyer
  // on a sold car is the worst possible UX.
  if (vehicle.status !== "available") return [];

  // 2. Pull cold-ish conversations for this dealer within the freshness
  //    window. We over-fetch (50) and rank in JS rather than push the
  //    affinity into SQL — keeps the schema dependency on
  //    buyer_intent_* columns trivial and lets us tune the scoring
  //    without a migration.
  const sinceIso = new Date(
    Date.now() - COLD_LEAD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const convRes = await sb
    .from("conversations")
    .select("*")
    .eq("dealer_id", event.dealer_id)
    .gt("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (convRes.error || !convRes.data) return [];

  const candidates: MatchCandidate[] = [];
  for (const raw of convRes.data) {
    const conv = asConversationRow(raw);
    // Only cold leads (or never-scored leads) qualify for outbound
    // re-engagement. Warm/hot stays in the active sales funnel.
    if (conv.lead_score === "warm" || conv.lead_score === "hot") continue;
    // Must have AT LEAST ONE buyer_intent_* field populated, otherwise
    // we have no signal to justify the outbound.
    if (!conv.buyer_intent_make && !conv.buyer_intent_model && !conv.buyer_intent_body_type) {
      continue;
    }
    const { score, reasons } = scoreAffinity(conv, vehicle);
    if (score === 0) continue;
    const matchReason =
      event.kind === "price_drop"
        ? `price_drop_${reasons.join("+")}`
        : reasons.join("+");
    candidates.push({
      conversation: conv,
      vehicle,
      event,
      matchReason,
      affinityScore: score,
    });
  }

  // 3. Rank: affinity desc, then updated_at desc (recency tiebreak).
  candidates.sort((a, b) => {
    if (b.affinityScore !== a.affinityScore) {
      return b.affinityScore - a.affinityScore;
    }
    return (
      Date.parse(b.conversation.updated_at) -
      Date.parse(a.conversation.updated_at)
    );
  });
  return candidates.slice(0, MAX_CANDIDATES_PER_EVENT);
}
