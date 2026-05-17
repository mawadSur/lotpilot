// T4.2 — Handle a buyer's YES / NO response to a pending lead-share
// consent SMS.
//
// Called by chat-pipeline.ts AFTER STOP/HELP/START keyword detection
// but BEFORE the AI is invoked. Flow:
//   1. detect.ts → YES or NO (or null = not a share response, pipeline
//      continues normally).
//   2. If pending share for this conversation: transition accept/decline.
//      Otherwise the YES/NO is not for a share — pipeline continues.
//   3. On YES: load source/target dealers + consent SMS body →
//      forkConversation() → UPDATE lead_shares status='accepted',
//      accepted_at, forked_conversation_id.
//   4. On NO: UPDATE lead_shares status='declined', declined_at.
//   5. Return a canned bilingual ack to the buyer (no AI call, no
//      outbound dispatch — the canned reply IS the dealer's reply).
//
// The UPDATE has an `.is('forked_conversation_id', null)` guard on the
// YES path so a duplicate YES (e.g. carrier retry) can't double-fork.

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectLeadShareResponse } from "./detect";
import { findOpenLeadShare } from "./initiate";
import { forkConversation } from "./fork";
import { log } from "../log";
import type {
  ConversationRow,
  DealerRow,
  Lang,
  LeadShareRow,
  MessageRow,
} from "../db-types";

export interface RespondArgs {
  sb: SupabaseClient; // service-role
  conversation: ConversationRow;
  rawBuyerMessage: string;
  requestId: string;
}

export type RespondResult =
  | { handled: false }
  | {
      handled: true;
      outcome: "accepted" | "declined" | "no_open_share";
      replyText: string;
    };

function ackAccepted(lang: Lang, targetName: string): string {
  return lang === "es"
    ? `¡Listo! Te conectamos con ${targetName}. Te escribirán pronto.`
    : `Got it — we've connected you with ${targetName}. They'll reach out shortly.`;
}

function ackDeclined(lang: Lang, sourceName: string): string {
  return lang === "es"
    ? `Entendido — seguimos contigo. ${sourceName} continúa atendiéndote.`
    : `Got it — staying put. ${sourceName} will keep helping you.`;
}

function noOpenShareNote(lang: Lang): string {
  return lang === "es"
    ? `Gracias — ¿en qué te ayudamos?`
    : `Thanks — how can we help?`;
}

export async function handleLeadShareResponse(
  args: RespondArgs,
): Promise<RespondResult> {
  const response = detectLeadShareResponse(args.rawBuyerMessage);
  if (!response) return { handled: false };

  const share = await findOpenLeadShare(args.sb, args.conversation.id);
  if (!share) {
    // The buyer happened to start their message with "yes" / "no" but
    // there's no pending share. Hand back to the normal pipeline —
    // their text might be a real reply to a previous AI turn.
    return { handled: false };
  }

  // Load both dealers + the source consent SMS body in parallel.
  const [sourceRes, targetRes, consentMsgRes] = await Promise.all([
    args.sb.from("dealers").select("*").eq("id", share.source_dealer_id).maybeSingle(),
    args.sb.from("dealers").select("*").eq("id", share.target_dealer_id).maybeSingle(),
    share.consent_message_id
      ? args.sb
          .from("messages")
          .select("body")
          .eq("id", share.consent_message_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const sourceDealer = sourceRes.data as DealerRow | null;
  const targetDealer = targetRes.data as DealerRow | null;
  const lang: Lang = args.conversation.language;

  if (!sourceDealer || !targetDealer) {
    // Defensive: shouldn't happen (FK on delete cascade would have
    // killed the share row). Mark cancelled so the inbox is honest.
    await args.sb
      .from("lead_shares")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: "dealer_missing",
      })
      .eq("id", share.id);
    return {
      handled: true,
      outcome: "no_open_share",
      replyText: noOpenShareNote(lang),
    };
  }

  if (response === "no") {
    await args.sb
      .from("lead_shares")
      .update({
        status: "declined",
        declined_at: new Date().toISOString(),
      })
      .eq("id", share.id);
    log.info("lead_share.declined", {
      requestId: args.requestId,
      lead_share_id: share.id,
      conversation_id: args.conversation.id,
    });
    return {
      handled: true,
      outcome: "declined",
      replyText: ackDeclined(lang, sourceDealer.name),
    };
  }

  // YES → fork.
  const consentText =
    (consentMsgRes.data as Pick<MessageRow, "body"> | null)?.body
    ?? `Buyer consented via SMS to referral from ${sourceDealer.name} to ${targetDealer.name}.`;

  const fork = await forkConversation({
    sb: args.sb,
    share,
    sourceDealer,
    targetDealer,
    sourceConversation: args.conversation,
    consentText,
  });
  if (!fork.ok || !fork.forkedConversationId) {
    log.error("lead_share.fork_failed", {
      requestId: args.requestId,
      lead_share_id: share.id,
      error: fork.error,
    });
    await args.sb
      .from("lead_shares")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: `fork_failed:${fork.error ?? "unknown"}`.slice(0, 80),
      })
      .eq("id", share.id);
    return {
      handled: true,
      outcome: "no_open_share",
      // Buyer-facing: don't leak the internal fork failure. Drop them
      // back into the normal flow with a generic ack.
      replyText: noOpenShareNote(lang),
    };
  }

  // Guarded transition: only flip to accepted if forked_conversation_id
  // is still null — protects against a duplicate YES creating a second
  // fork.
  await args.sb
    .from("lead_shares")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      forked_conversation_id: fork.forkedConversationId,
    })
    .eq("id", share.id)
    .is("forked_conversation_id", null);

  log.info("lead_share.accepted", {
    requestId: args.requestId,
    lead_share_id: share.id,
    source_conversation_id: args.conversation.id,
    forked_conversation_id: fork.forkedConversationId,
  });

  return {
    handled: true,
    outcome: "accepted",
    replyText: ackAccepted(lang, targetDealer.name),
  };
}
