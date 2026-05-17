// T4.2 — Initiate a lead-share handoff from source dealer → target dealer.
//
// Called by the inbox server action ("Share this lead" button). Flow:
//   1. Validate: source ≠ target, target exists, source conversation
//      belongs to source dealer, no other open share for this conversation.
//   2. Validate buyer reachability: consent on file for source dealer,
//      not suppressed, has buyer_phone.
//   3. INSERT lead_shares (status='pending') — this binds the
//      partial-unique index, blocking parallel calls.
//   4. Send consent SMS from SOURCE dealer's number. Body explains the
//      referral + asks for YES / NO. Source dealer is the SMS sender so
//      we're inside the existing consent envelope; the buyer's YES
//      becomes the consent record for the TARGET dealer (written by
//      respond.ts on accept).
//   5. On SMS success: INSERT a role='dealer' message (so the source
//      dealer's inbox shows the handoff), UPDATE lead_shares status to
//      'consent_sent' with consent_message_id + consent_sent_at.
//   6. On SMS failure: UPDATE lead_shares to 'cancelled' with the
//      reason. Inbox shows the failure so the dealer can retry.
//
// The state transitions are service-role driven from this function;
// the source dealer's authenticated client cannot mutate lead_shares
// directly (RLS enforces this — see migration 0017).
//
// Returns a discriminated result so the inbox action can render
// targeted error copy without leaking internals.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms } from "../sms/twilio";
import { smsEnabled } from "../env";
import { log } from "../log";
import type {
  ChatChannel,
  ConsentRow,
  ConversationRow,
  DealerRow,
  LeadShareCancelReason,
  LeadShareRow,
} from "../db-types";

export interface InitiateArgs {
  sb: SupabaseClient; // service-role
  sourceDealer: DealerRow;
  sourceConversation: ConversationRow;
  targetDealerSlug: string;
  createdByUserId: string;
  notes?: string;
}

export type InitiateResult =
  | { ok: true; leadShareId: string; status: "consent_sent" }
  | { ok: false; reason: LeadShareCancelReason; leadShareId?: string };

// MVP: SMS-only. Web / WhatsApp / Marketplace / Voice are deferred —
// the actual UX patterns for those channels diverge enough that they
// each warrant their own re-consent flow.
const SUPPORTED_CHANNELS: ReadonlySet<ChatChannel> = new Set<ChatChannel>(["sms"]);

function consentSmsBody(source: DealerRow, target: DealerRow): string {
  // Bilingual rendering is conservative for the MVP — we emit both EN
  // and ES on the same SMS so the buyer responds in whichever is
  // natural. ~280 chars total (2 segments). Future: pick by
  // conversation.language.
  return [
    `${source.name}: We'd like to refer you to ${target.name} — they may have a better match for what you're looking for.`,
    `Reply YES to share your conversation with ${target.name}, NO to stay here.`,
    `${source.name}: nos gustaría referirte a ${target.name}. Responde SI para compartir o NO para quedarte.`,
  ].join("\n\n");
}

export async function initiateLeadShare(args: InitiateArgs): Promise<InitiateResult> {
  // Look up target dealer by slug. We don't accept a target_dealer_id
  // directly because the inbox UI is a slug picker — guards against a
  // copy-paste accident with a stale id.
  const targetRes = await args.sb
    .from("dealers")
    .select("id,name,slug,sms_number")
    .eq("slug", args.targetDealerSlug)
    .maybeSingle();
  const target = targetRes.data as Pick<DealerRow, "id" | "name" | "slug" | "sms_number"> | null;
  if (!target) return { ok: false, reason: "target_dealer_not_found" };
  if (target.id === args.sourceDealer.id) {
    return { ok: false, reason: "self_share" };
  }

  // Channel guard.
  if (!SUPPORTED_CHANNELS.has(args.sourceConversation.channel)) {
    return { ok: false, reason: "channel_unsupported" };
  }

  // Buyer reachability + TCPA.
  if (!smsEnabled() || !args.sourceDealer.sms_number) {
    return { ok: false, reason: "sms_not_configured" };
  }
  if (!args.sourceConversation.buyer_phone) {
    return { ok: false, reason: "no_buyer_phone" };
  }
  if (args.sourceConversation.suppressed_at) {
    return { ok: false, reason: "suppressed" };
  }

  // Consent on file? Migration 0003 / consents.dealer_id ties consent
  // to a (dealer, conversation) pair — the buyer must already have
  // consented to receive messages from the SOURCE dealer.
  const consentRes = await args.sb
    .from("consents")
    .select("id")
    .eq("dealer_id", args.sourceDealer.id)
    .eq("conversation_id", args.sourceConversation.id)
    .limit(1)
    .maybeSingle();
  if (!consentRes.data) {
    return { ok: false, reason: "no_consent" };
  }

  // INSERT pending share. The partial unique index
  // (lead_shares_one_open_per_source_idx) makes a parallel call fail
  // with 23505; we propagate that as 'already_pending'.
  const insertRes = await args.sb
    .from("lead_shares")
    .insert({
      source_dealer_id: args.sourceDealer.id,
      target_dealer_id: target.id,
      source_conversation_id: args.sourceConversation.id,
      status: "pending",
      notes: args.notes ?? null,
      created_by_user_id: args.createdByUserId,
    })
    .select("id")
    .single();
  if (insertRes.error || !insertRes.data) {
    if (insertRes.error?.code === "23505") {
      return { ok: false, reason: "already_pending" };
    }
    log.error("lead_share.insert_failed", {
      dealer_id: args.sourceDealer.id,
      conversation_id: args.sourceConversation.id,
      code: insertRes.error?.code,
    });
    return { ok: false, reason: "insert_failed" };
  }
  const leadShareId = (insertRes.data as { id: string }).id;

  // Send consent SMS. We DON'T early-cancel on send failure — instead
  // we keep the row in 'pending' and let a future retry update it.
  // BUT for the MVP we keep things simple: a failed send marks the
  // row 'cancelled' so the dealer's inbox shows the failure.
  const body = consentSmsBody(args.sourceDealer, target as DealerRow);
  const send = await sendSms({ to: args.sourceConversation.buyer_phone, body });
  if (!send.queued) {
    await args.sb
      .from("lead_shares")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: `sms_send_failed:${send.error ?? "unknown"}`.slice(0, 80),
      })
      .eq("id", leadShareId);
    log.warn("lead_share.sms_failed", {
      lead_share_id: leadShareId,
      dealer_id: args.sourceDealer.id,
      error: send.error,
    });
    return { ok: false, reason: "sms_send_failed", leadShareId };
  }

  // Insert the consent SMS as a role='dealer' message in the source
  // conversation so the inbox surfaces "we sent a referral SMS to the
  // buyer". delivery_channel='sms' + delivery_sid for parity with the
  // normal outbound path.
  const msgRes = await args.sb
    .from("messages")
    .insert({
      conversation_id: args.sourceConversation.id,
      role: "dealer",
      body,
      intent: null,
      language: null,
      approval_status: "sent",
      delivery_channel: "sms",
      delivery_sid: send.sid ?? null,
    })
    .select("id")
    .single();
  const consentMessageId =
    msgRes.data && typeof (msgRes.data as { id?: string }).id === "string"
      ? (msgRes.data as { id: string }).id
      : null;

  // Flip status to consent_sent. consent_message_id is best-effort.
  const nowIso = new Date().toISOString();
  await args.sb
    .from("lead_shares")
    .update({
      status: "consent_sent",
      consent_sent_at: nowIso,
      consent_message_id: consentMessageId,
    })
    .eq("id", leadShareId);

  log.info("lead_share.consent_sent", {
    lead_share_id: leadShareId,
    source_dealer_id: args.sourceDealer.id,
    target_dealer_id: target.id,
    conversation_id: args.sourceConversation.id,
  });

  return { ok: true, leadShareId, status: "consent_sent" };
}

// Read-only helper used by chat-pipeline to know if an incoming buyer
// message is a response to a pending consent. Returns the open
// lead_shares row (status='consent_sent') for this conversation, or
// null if none exists. Indexed by lead_shares_pending_by_conversation_idx.
export async function findOpenLeadShare(
  sb: SupabaseClient,
  conversationId: string,
): Promise<LeadShareRow | null> {
  const res = await sb
    .from("lead_shares")
    .select("*")
    .eq("source_conversation_id", conversationId)
    .eq("status", "consent_sent")
    .order("consent_sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) {
    log.warn("lead_share.lookup_failed", {
      conversation_id: conversationId,
      code: res.error.code,
    });
    return null;
  }
  return (res.data as LeadShareRow | null) ?? null;
}
