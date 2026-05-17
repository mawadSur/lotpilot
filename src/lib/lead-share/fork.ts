// T4.2 — Fork a source conversation into the target dealer's space
// once the buyer has consented (YES to the referral SMS).
//
// What "fork" means here:
//   1. Create a new conversations row under target_dealer_id with the
//      same buyer_phone + buyer_session + channel + language; mark
//      forked_from_conversation_id = source.
//   2. Copy the message history from source → target. We only carry
//      buyer-visible messages (role='buyer' OR
//      role in ('ai','dealer') AND approval_status in ('approved','auto','sent')) —
//      pending drafts in the source are private to the source dealer.
//   3. Write a NEW consents row for the target dealer using a
//      consent_text that captures what the buyer agreed to (the
//      source-dealer consent SMS body, carried via the lead_shares
//      consent_message_id).
//   4. Insert a 'dealer'-role system note into the target conversation
//      summarising the referral (so the receiving dealer sees a one-
//      line context: "Referred by <source_dealer.name>; original
//      conversation: <source_id>").
//
// Idempotent shield: callers should check share.forked_conversation_id
// is null BEFORE invoking; if it's already populated, the fork
// already happened. The accept-handler in respond.ts uses
// .update({...}).eq('id', share.id).is('forked_conversation_id', null)
// as a guarded write so a duplicate YES doesn't double-fork.

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../log";
import type {
  ChatChannel,
  ConsentRow,
  ConversationRow,
  DealerRow,
  LeadShareRow,
  MessageRow,
} from "../db-types";

export interface ForkArgs {
  sb: SupabaseClient; // service-role
  share: LeadShareRow;
  sourceDealer: DealerRow;
  targetDealer: DealerRow;
  sourceConversation: ConversationRow;
  // The exact SMS body the buyer said YES to. Carried into the new
  // consent row as consent_text. respond.ts loads this from the
  // share.consent_message_id row before calling here.
  consentText: string;
}

export interface ForkResult {
  ok: boolean;
  forkedConversationId?: string;
  error?: string;
}

export async function forkConversation(args: ForkArgs): Promise<ForkResult> {
  // 1. Create the target-side conversation. buyer_session gets a
  //    "_via_<source-id>" suffix so it's unique even on the same channel
  //    — buyer_session is a unique-ish identifier in widget/SMS land.
  const newSession = `${args.sourceConversation.buyer_session}_via_${args.share.id.slice(0, 8)}`;
  const convInsert = await args.sb
    .from("conversations")
    .insert({
      dealer_id: args.targetDealer.id,
      buyer_session: newSession,
      language: args.sourceConversation.language,
      status: "open",
      lead_status: "new",
      channel: args.sourceConversation.channel as ChatChannel,
      buyer_phone: args.sourceConversation.buyer_phone,
      // Carry buyer-intent capture forward — the target dealer
      // benefits from the same demand signal the source captured.
      buyer_intent_make: args.sourceConversation.buyer_intent_make,
      buyer_intent_model: args.sourceConversation.buyer_intent_model,
      buyer_intent_body_type: args.sourceConversation.buyer_intent_body_type,
      forked_from_conversation_id: args.sourceConversation.id,
    })
    .select("id")
    .single();
  if (convInsert.error || !convInsert.data) {
    log.error("lead_share.fork_conv_insert_failed", {
      lead_share_id: args.share.id,
      code: convInsert.error?.code,
    });
    return { ok: false, error: "fork_conv_insert_failed" };
  }
  const forkedConversationId = (convInsert.data as { id: string }).id;

  // 2. Copy buyer-visible messages. Server-side filter mirrors the
  //    chat-pipeline's history query (chat-pipeline.ts: history.or(...)).
  const msgsRes = await args.sb
    .from("messages")
    .select("role,body,intent,language,created_at,approval_status")
    .eq("conversation_id", args.sourceConversation.id)
    .or("role.eq.buyer,and(role.in.(ai,dealer),approval_status.in.(approved,auto,sent))")
    .order("created_at", { ascending: true })
    .limit(500);
  if (msgsRes.error) {
    log.warn("lead_share.fork_message_select_failed", {
      lead_share_id: args.share.id,
      code: msgsRes.error.code,
    });
    // Non-fatal — we still want the fork to complete with at least the
    // system note. Continue with an empty history.
  }
  const history = (msgsRes.data ?? []) as Pick<
    MessageRow,
    "role" | "body" | "intent" | "language" | "created_at" | "approval_status"
  >[];

  if (history.length > 0) {
    const copyRows = history.map((m) => ({
      conversation_id: forkedConversationId,
      role: m.role,
      body: m.body,
      intent: m.intent,
      language: m.language,
      // All copied messages are 'auto' on the target side — they're
      // historical, not draft. Stripping the approval pipeline keeps
      // them out of the target dealer's pending queue.
      approval_status: "auto",
    }));
    const copyRes = await args.sb.from("messages").insert(copyRows);
    if (copyRes.error) {
      log.warn("lead_share.fork_message_copy_failed", {
        lead_share_id: args.share.id,
        code: copyRes.error.code,
        attempted: copyRows.length,
      });
    }
  }

  // 3. Carry consent into the target dealer's consents table.
  //    consent_text = the source-dealer SMS body the buyer agreed to.
  //    This is the regulator-defensible record: "the buyer responded
  //    YES to receiving messages from this dealer after reading X."
  const consentInsert = await args.sb.from("consents").insert({
    dealer_id: args.targetDealer.id,
    conversation_id: forkedConversationId,
    channel: args.sourceConversation.channel,
    consent_text: args.consentText.slice(0, 2000),
    ip_address: null,
    user_agent: null,
    buyer_phone: args.sourceConversation.buyer_phone,
  });
  if (consentInsert.error) {
    log.error("lead_share.fork_consent_insert_failed", {
      lead_share_id: args.share.id,
      code: consentInsert.error.code,
    });
    // This IS fatal — the target dealer has no consent record. Mark
    // the fork failed; respond.ts will surface this to the source
    // dealer.
    return { ok: false, error: "fork_consent_insert_failed" };
  }

  // 4. System note for the target dealer's inbox.
  await args.sb.from("messages").insert({
    conversation_id: forkedConversationId,
    role: "dealer",
    body: `Referred by ${args.sourceDealer.name}. Original conversation: ${args.sourceConversation.id}.`,
    intent: null,
    language: null,
    approval_status: "auto",
  });

  log.info("lead_share.forked", {
    lead_share_id: args.share.id,
    source_conversation_id: args.sourceConversation.id,
    forked_conversation_id: forkedConversationId,
    messages_copied: history.length,
  });

  return { ok: true, forkedConversationId };
}
