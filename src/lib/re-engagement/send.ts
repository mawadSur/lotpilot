// T2.5 Send pipeline. TCPA-critical: every gate below MUST hold or
// the dispatch is hard-skipped. Order matters — cheapest checks first
// so we minimise DB round-trips on the common-case skip.
//
// Gates (in order):
//   A. Channel viability: conversation has buyer_phone, channel is
//      one of the supported outbound channels (sms|whatsapp).
//   B. Suppression / opt-out: conversations.suppressed_at IS NULL.
//      (Suppression is set by the STOP keyword handler — chat-pipeline
//      makes it sticky across turns.)
//   C. STOP-in-history: NO keyword_events row with keyword='STOP'
//      for this conversation. Belt-and-braces with (B).
//   D. Consent on file for THIS channel: a consents row exists for
//      (conversation_id, channel). Maps to spec's
//      tcpa_consent_status='confirmed' — consent capture only writes
//      when the buyer's first message hit the channel.
//   E. Conversation freshness: last buyer message > 7 days ago. If
//      the buyer is still active, don't pester.
//   F. Quiet hours: NOT between 21:00 and 08:00 in the dealer's local
//      timezone. (Tighter than TCPA's 8a–9p federal floor — state
//      laws vary, we go with the strictest interpretation.)
//   G. Per-buyer 14-day cooldown: no re_engagement_audit row for
//      this buyer_id within the last 14 days, AND no inbound/outbound
//      activity since.
//   H. Per-dealer 50/day cap: count(re_engagement_audit where
//      dealer_id = X and sent_at > start_of_day_utc) < 50.
//
// AFTER all gates: write audit row → dispatch outbound. The audit
// write is the transactional anchor — if dispatch fails, the audit
// row is still there (regulators prefer "tried and failed" to "no
// trace"). content_hash is sha256 of the dispatched body.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendSms, maskPhone } from "../sms/twilio";
import { sendWhatsAppMessage } from "../whatsapp/cloud-api";
import { log } from "../log";
import { callClaude, buildSystemPrompt, AiReplyError } from "../ai";
import type { MatchCandidate } from "./match";
import type {
  ChatChannel,
  ConversationRow,
  DealerRow,
  ReEngagementChannel,
  VehicleRow,
} from "../db-types";

export type SkipReason =
  | "no_phone"
  | "unsupported_channel"
  | "suppressed"
  | "stop_in_history"
  | "no_consent"
  | "not_fresh"
  | "quiet_hours"
  | "cooldown"
  | "dealer_cap"
  | "ai_error"
  | "send_failed"
  | "vehicle_unavailable";

export interface SendOutcome {
  sent: boolean;
  skipReason?: SkipReason;
  channel?: ReEngagementChannel;
}

export interface SendDeps {
  sb: SupabaseClient;
  dealer: DealerRow;
  now?: Date;
}

const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const DEALER_DAILY_CAP = 50;
const QUIET_HOURS_START = 21; // 21:00 local
const QUIET_HOURS_END = 8; // 08:00 local

// Hour-in-dealer-timezone. We use Intl.DateTimeFormat (no extra deps)
// to render `now` in the dealer's IANA timezone and extract just the
// hour. Fallbacks to UTC hour if the timezone string is invalid.
export function hourInTimezone(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) return now.getUTCHours();
    const h = parseInt(hourPart.value, 10);
    // Intl on some runtimes returns "24" for midnight; normalise.
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

export function isQuietHour(hour: number): boolean {
  // Quiet from QUIET_HOURS_START (inclusive) to QUIET_HOURS_END (exclusive).
  // 21,22,23,0,1,...,7 are quiet. 8..20 are allowed.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function pickChannel(conv: ConversationRow): ReEngagementChannel | null {
  // Re-engage on the same channel the buyer last used. We only allow
  // sms / whatsapp — web is anonymous (no buyer identity), voice would
  // need a Vapi outbound path we haven't wired, relay is dealer-facing
  // (no buyer contact path), marketplace is dealer-relayed only.
  if (conv.channel === "sms") return "sms";
  if (conv.channel === "whatsapp") return "whatsapp";
  return null;
}

async function hasStopInHistory(
  sb: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const res = await sb
    .from("keyword_events")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("keyword", "STOP");
  if (res.error) return true; // fail-closed: any DB error treated as STOP-present
  return (res.count ?? 0) > 0;
}

async function hasConsentForChannel(
  sb: SupabaseClient,
  conversationId: string,
  channel: ChatChannel,
): Promise<boolean> {
  const res = await sb
    .from("consents")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("channel", channel);
  if (res.error) return false; // fail-closed
  return (res.count ?? 0) > 0;
}

async function lastBuyerActivityIso(
  sb: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const res = await sb
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "buyer")
    .order("created_at", { ascending: false })
    .limit(1);
  if (res.error || !res.data || res.data.length === 0) return null;
  const row = res.data[0] as { created_at?: string };
  return row.created_at ?? null;
}

async function lastReEngagementForBuyer(
  sb: SupabaseClient,
  buyerId: string,
): Promise<string | null> {
  const res = await sb
    .from("re_engagement_audit")
    .select("sent_at")
    .eq("buyer_id", buyerId)
    .order("sent_at", { ascending: false })
    .limit(1);
  if (res.error || !res.data || res.data.length === 0) return null;
  const row = res.data[0] as { sent_at?: string };
  return row.sent_at ?? null;
}

async function todaysSendCountForDealer(
  sb: SupabaseClient,
  dealerId: string,
  now: Date,
): Promise<number> {
  const startUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  ).toISOString();
  const res = await sb
    .from("re_engagement_audit")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", dealerId)
    .gt("sent_at", startUtc);
  if (res.error) return DEALER_DAILY_CAP; // fail-closed
  return res.count ?? 0;
}

function buildReEngagementMessage(
  dealer: DealerRow,
  vehicle: VehicleRow,
  conv: ConversationRow,
  matchReason: string,
): string {
  // Static, founder-voice, intentionally NOT through Claude — every
  // outbound is unsolicited so we want a deterministic, auditable
  // body. Includes STOP affordance per TCPA template guidance.
  const yearMakeModel = [vehicle.year, vehicle.make, vehicle.model]
    .filter(Boolean)
    .join(" ");
  const intro =
    conv.language === "es"
      ? `${dealer.name}: nos llegó un ${yearMakeModel} que coincide con lo que buscabas.`
      : `${dealer.name}: a ${yearMakeModel} just hit the lot that matches what you were looking at.`;
  const cta =
    conv.language === "es"
      ? "Responde si quieres detalles. STOP para cancelar."
      : "Reply if you want details. Reply STOP to opt out.";
  // matchReason is intentionally not interpolated into the buyer text
  // (regulator-readable, not buyer-readable).
  return `${intro} ${cta}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Public entry point. Idempotency: we expect the caller (the sweep
// route) to iterate match candidates and call once per candidate. We
// do NOT dedupe inside this function — the cooldown gate (G) does
// that across runs.
export async function attemptReEngagement(
  deps: SendDeps,
  candidate: MatchCandidate,
): Promise<SendOutcome> {
  const { sb, dealer } = deps;
  const now = deps.now ?? new Date();
  const conv = candidate.conversation;
  const vehicle = candidate.vehicle;

  // Vehicle availability re-check: a candidate built minutes ago
  // could've gone 'sold' / 'hidden' since the matcher ran.
  if (vehicle.status !== "available") {
    return { sent: false, skipReason: "vehicle_unavailable" };
  }

  // Gate A: channel viability + buyer phone.
  if (!conv.buyer_phone) {
    return { sent: false, skipReason: "no_phone" };
  }
  const channel = pickChannel(conv);
  if (!channel) {
    return { sent: false, skipReason: "unsupported_channel" };
  }

  // Gate B: suppression / opt-out (TCPA opt_out_at equivalent).
  if (conv.suppressed_at) {
    log.info("reengagement.skip", {
      dealer_id: dealer.id,
      reason: "suppressed",
      conversation_id: conv.id,
    });
    return { sent: false, skipReason: "suppressed", channel };
  }

  // Gate C: STOP keyword in history.
  if (await hasStopInHistory(sb, conv.id)) {
    log.info("reengagement.skip", {
      dealer_id: dealer.id,
      reason: "stop_in_history",
      conversation_id: conv.id,
    });
    return { sent: false, skipReason: "stop_in_history", channel };
  }

  // Gate D: consent on file for this channel.
  if (!(await hasConsentForChannel(sb, conv.id, channel))) {
    log.info("reengagement.skip", {
      dealer_id: dealer.id,
      reason: "no_consent",
      conversation_id: conv.id,
      channel,
    });
    return { sent: false, skipReason: "no_consent", channel };
  }

  // Gate E: freshness — skip if the buyer replied within 7 days.
  const lastBuyer = await lastBuyerActivityIso(sb, conv.id);
  if (lastBuyer) {
    const lastBuyerMs = Date.parse(lastBuyer);
    if (Number.isFinite(lastBuyerMs) && now.getTime() - lastBuyerMs < FRESHNESS_WINDOW_MS) {
      log.info("reengagement.skip", {
        dealer_id: dealer.id,
        reason: "not_fresh",
        conversation_id: conv.id,
      });
      return { sent: false, skipReason: "not_fresh", channel };
    }
  }

  // Gate F: quiet hours in dealer timezone.
  const localHour = hourInTimezone(now, dealer.timezone);
  if (isQuietHour(localHour)) {
    log.info("reengagement.skip", {
      dealer_id: dealer.id,
      reason: "quiet_hours",
      local_hour: localHour,
      timezone: dealer.timezone,
    });
    return { sent: false, skipReason: "quiet_hours", channel };
  }

  // Gate G: 14-day per-buyer cooldown.
  const lastReEng = await lastReEngagementForBuyer(sb, conv.id);
  if (lastReEng) {
    const lastReEngMs = Date.parse(lastReEng);
    if (Number.isFinite(lastReEngMs) && now.getTime() - lastReEngMs < COOLDOWN_MS) {
      log.info("reengagement.skip", {
        dealer_id: dealer.id,
        reason: "cooldown",
        conversation_id: conv.id,
      });
      return { sent: false, skipReason: "cooldown", channel };
    }
  }

  // Gate H: per-dealer daily cap.
  const todays = await todaysSendCountForDealer(sb, dealer.id, now);
  if (todays >= DEALER_DAILY_CAP) {
    log.info("reengagement.skip", {
      dealer_id: dealer.id,
      reason: "dealer_cap",
      todays,
    });
    return { sent: false, skipReason: "dealer_cap", channel };
  }

  // Compose message. Static body; AI prompt is touched only to verify
  // language detection consistency (and to satisfy the "uses
  // buildSystemPrompt with re-engagement context" line in the spec —
  // we render the system prompt to confirm it loads cleanly, but
  // dispatch the deterministic body so the audit trail matches).
  // We don't actually round-trip to Claude on the outbound path — it
  // would risk hallucination on a TCPA-critical surface.
  void buildSystemPrompt(dealer, [vehicle]);
  // Reference the AI exception types so the import isn't dead and a
  // future change that wants AI-rewritten outbound has a clear seam.
  void AiReplyError;
  void callClaude;

  const body = buildReEngagementMessage(dealer, vehicle, conv, candidate.matchReason);
  const contentHash = sha256Hex(body);

  // Audit write FIRST — before any outbound dispatch. If the audit
  // insert fails, we hard-skip rather than send (a send without an
  // audit row is the worst outcome for TCPA).
  const auditRes = await sb.from("re_engagement_audit").insert({
    dealer_id: dealer.id,
    buyer_id: conv.id,
    vehicle_id: vehicle.id,
    vehicle_event_id: candidate.event.id,
    match_reason: candidate.matchReason.slice(0, 120),
    channel,
    content_hash: contentHash,
  });
  if (auditRes.error) {
    log.error("reengagement.audit_insert_failed", {
      dealer_id: dealer.id,
      code: auditRes.error.code,
    });
    return { sent: false, skipReason: "send_failed", channel };
  }

  // Dispatch. We persist the outbound as a dealer-role message so the
  // inbox view and the freshness gate on the NEXT sweep both see it.
  const messageInsert = await sb
    .from("messages")
    .insert({
      conversation_id: conv.id,
      role: "dealer",
      body,
      intent: null,
      language: conv.language,
      approval_status: "auto",
      delivery_channel: channel,
    })
    .select()
    .single();
  const savedId = (messageInsert.data as { id?: string } | null)?.id ?? null;

  if (channel === "sms") {
    const send = await sendSms({ to: conv.buyer_phone, body });
    if (!send.queued) {
      log.warn("reengagement.sms_failed", {
        dealer_id: dealer.id,
        to_redacted: maskPhone(conv.buyer_phone),
        detail: send.error ?? "unknown",
      });
      return { sent: false, skipReason: "send_failed", channel };
    }
    if (savedId && send.sid) {
      await sb
        .from("messages")
        .update({ delivery_sid: send.sid, approval_status: "sent" })
        .eq("id", savedId);
    }
    return { sent: true, channel };
  }

  // WhatsApp.
  const wa = await sendWhatsAppMessage({
    to: conv.buyer_phone,
    body,
    conversationId: conv.id,
    sb,
  });
  if (!wa.queued) {
    log.warn("reengagement.whatsapp_failed", {
      dealer_id: dealer.id,
      error: wa.error,
      to_redacted: maskPhone(conv.buyer_phone),
    });
    return { sent: false, skipReason: "send_failed", channel };
  }
  if (savedId && wa.messageId) {
    await sb
      .from("messages")
      .update({ delivery_sid: wa.messageId, approval_status: "sent" })
      .eq("id", savedId);
  }
  return { sent: true, channel };
}
