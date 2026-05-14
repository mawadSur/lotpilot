// Persistence helpers extracted from chat-pipeline.ts so the
// orchestrator stays under 400 lines (architect's v0.7 target: ~350).
//
// persistAiReply: steps 10-12 (AI-message insert with 3x retry,
//   conversation update, recordSpend). Step 13 (dispatchOutbound)
//   STAYS in chat-pipeline.ts — the pipeline owns per-channel routing.
//
// handleKeyword: writes keyword_event, flips suppressed_at, inserts
//   canned AI reply, dispatches SMS for sms channel. Returns the
//   bilingual reply text the pipeline will hand back to the buyer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordSpend } from "./budget";
import { autoReplyFor } from "./keywords";
import { withRetry } from "./retry";
import { scoreFromHistory } from "./lead-scoring";
import { log } from "./log";
import type {
  ChatChannel,
  ConversationRow,
  DealerRow,
  Intent,
  KeywordHit,
  Lang,
  MessageRow,
} from "./db-types";

export interface PersistAiReplyArgs {
  sb: SupabaseClient;
  conversation: ConversationRow;
  dealer: DealerRow;
  historyAll: Pick<MessageRow, "role" | "intent">[];
  aiReply: {
    reply: string;
    intent: Intent;
    language: Lang;
    offered_calendly: boolean;
    usage: { input_tokens: number; output_tokens: number };
  };
  finalReply: string;
  approvalStatus: "auto" | "pending";
  channel: ChatChannel;
  requestId: string;
}

export interface PersistAiReplyResult {
  saved: boolean;
  savedMessageId: string | null;
}

export async function persistAiReply(
  args: PersistAiReplyArgs,
): Promise<PersistAiReplyResult> {
  const { sb, conversation, dealer, historyAll, aiReply, finalReply, approvalStatus, channel, requestId } =
    args;

  let savedMessageId: string | null = null;
  let saved = false;

  // 10. Insert the AI message with 3x retry.
  try {
    await withRetry(
      async (attempt) => {
        const res = await sb
          .from("messages")
          .insert({
            conversation_id: conversation.id,
            role: "ai",
            body: finalReply,
            intent: aiReply.intent,
            language: aiReply.language,
            approval_status: approvalStatus,
            delivery_channel: channel,
          })
          .select("id")
          .single();
        if (res.error) {
          log.warn("chat.ai_message_save_retry", {
            requestId,
            dealer_id: dealer.id,
            attempt,
            code: res.error.code,
          });
          throw new Error(res.error.message);
        }
        savedMessageId = (res.data as { id: string }).id;
      },
      { attempts: 3, baseMs: 100, factor: 3, jitter: 0.5 },
    );
    saved = true;
  } catch (err) {
    log.error("chat.ai_message_save_exhausted", {
      requestId,
      dealer_id: dealer.id,
      detail: (err as Error).message,
    });
  }

  // 11. Update conversation language / intent / lead_score / scheduled_at
  //     only when the AI insert succeeded. scheduled_at is only set when
  //     null so subsequent turns don't stomp a real Calendly booking.
  if (saved) {
    const update: Record<string, unknown> = {
      language: aiReply.language,
      last_intent: aiReply.intent,
      lead_score: scoreFromHistory(historyAll, aiReply.intent),
    };
    if (
      aiReply.intent === "test_drive" &&
      aiReply.offered_calendly &&
      conversation.scheduled_at == null
    ) {
      update.scheduled_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    await sb.from("conversations").update(update).eq("id", conversation.id);
  }

  // 12. Record actual spend regardless of save state — we did pay.
  await recordSpend({
    dealerId: dealer.id,
    inputTokens: aiReply.usage.input_tokens,
    outputTokens: aiReply.usage.output_tokens,
  });

  return { saved, savedMessageId };
}

export interface KeywordHandlerArgs {
  sb: SupabaseClient;
  dealer: DealerRow;
  conversation: ConversationRow;
  keyword: KeywordHit;
  lang: Lang;
  channel: ChatChannel;
  rawMessage: string;
  buyerPhone: string | null;
  requestId: string;
}

export async function handleKeyword(args: KeywordHandlerArgs): Promise<string> {
  const { sb, dealer, conversation, keyword, lang, channel, rawMessage, buyerPhone, requestId } = args;

  await sb.from("keyword_events").insert({
    dealer_id: dealer.id,
    conversation_id: conversation.id,
    keyword,
    channel,
    raw_message: rawMessage,
  });
  if (keyword === "STOP") {
    await sb.from("conversations").update({ suppressed_at: new Date().toISOString() }).eq("id", conversation.id);
  } else if (keyword === "START") {
    await sb.from("conversations").update({ suppressed_at: null }).eq("id", conversation.id);
  }

  const replyText = autoReplyFor(keyword, dealer.name, lang);
  const aiInsert = await sb.from("messages").insert({
    conversation_id: conversation.id,
    role: "ai",
    body: replyText,
    intent: null,
    language: lang,
    approval_status: "auto",
    delivery_channel: channel,
  });
  if (aiInsert.error) {
    log.error("chat.keyword_reply_save_failed", { requestId, code: aiInsert.error.code });
  }

  if (channel === "sms" && buyerPhone) {
    const { sendSms, maskPhone } = await import("./sms/twilio");
    const r = await sendSms({ to: buyerPhone, body: replyText });
    log.info("chat.keyword_reply_sms", {
      requestId,
      queued: r.queued,
      sid: r.sid,
      to_redacted: maskPhone(buyerPhone),
    });
  }

  return replyText;
}
