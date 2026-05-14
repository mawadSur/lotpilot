// Shared chat-turn pipeline for the web widget (/api/chat), the SMS
// webhook (/api/sms/inbound), the relay action, and the voice webhook.
// All side effects (DB writes, Redis counters, AI calls, outbound SMS)
// live here so the HTTP adapters stay thin.
//
// Pipeline order per turn: rate-limit conversation; detect STOP/HELP/
// START; honour suppression; capture TCPA consent on first turn;
// insert buyer message; budget pre-check; call Claude; insert AI
// reply (pending if dealer wants approval, else auto, retried 3x);
// update conversation last_intent + language (and scheduled_at on
// test_drive turns); record actual spend; send outbound SMS for sms
// channel when not in approve mode. Route handler owns HTTP shape.

import { callClaude, AiReplyError, AI_MAX_OUTPUT_TOKENS, estimateMessagesChars, buildSystemPrompt } from "./ai";
import {
  assertBudgetAvailable,
  BudgetExceededError,
  estimateCallUsd,
  recordSpend,
} from "./budget";
import { autoReplyFor, detectKeyword, suppressedAck } from "./keywords";
import { captureFirstTurnConsent } from "./consent-capture";
import { log } from "./log";
import { checkRate } from "./ratelimit";
import { withRetry } from "./retry";
import { sendSms, maskPhone } from "./sms/twilio";
import { sanitizeBuyerMessage } from "./sanitize";
import { createServiceSupabase } from "./supabase-service";
import type {
  ChatChannel,
  ConversationRow,
  DealerRow,
  Intent,
  Lang,
  MessageRow,
  VehicleRow,
} from "./db-types";

export type PipelineKind = "ai_reply" | "pending" | "keyword" | "suppressed" | "rate_limited" | "budget_exhausted" | "ai_error" | "save_error";

export interface PipelineResult {
  kind: PipelineKind;
  conversationId: string;
  // Reply text shown to the buyer; null when we deliberately have nothing
  // to display (e.g. pending approval, rate-limited).
  reply: string | null;
  ackReply: string | null; // optional generic ack for buyer when reply is null
  intent: Intent | null;
  language: Lang;
  pendingApproval: boolean;
  retryAfterSec?: number;
}

export interface PipelineInput {
  dealer: DealerRow;
  conversation: ConversationRow;
  rawBuyerMessage: string;
  channel: ChatChannel;
  ip: string;
  // For TCPA consent capture; web only typically.
  userAgent: string | null;
  // For SMS: the buyer's phone (E.164) so we can send the outbound reply.
  buyerPhone: string | null;
  requestId: string;
}

const GENERIC_SERVICE_REPLY_EN = "Service is temporarily unavailable. Please try again shortly.";
const GENERIC_SERVICE_REPLY_ES = "El servicio no está disponible. Inténtalo de nuevo en un momento.";

const PENDING_ACK_EN = "Thanks — the dealer will reply shortly.";
const PENDING_ACK_ES = "Gracias — el equipo del concesionario te responderá en breve.";

const RATE_LIMITED_EN = "You are messaging too quickly. Please wait a moment and try again.";
const RATE_LIMITED_ES = "Estás enviando mensajes muy rápido. Espera un momento e inténtalo de nuevo.";

function pickEs(lang: Lang, en: string, es: string): string {
  return lang === "es" ? es : en;
}

// v0.4: Calendly webhook prefers utm_content=<conversation_id> for
// deterministic conversation matching. Append it to the dealer's
// Calendly link before showing it to the buyer; an existing query
// string is preserved.
function calendlyTail(lang: Lang, url: string, conversationId: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const linked = `${url}${sep}utm_content=${encodeURIComponent(conversationId)}`;
  return lang === "es" ? `\n\nReserva aquí: ${linked}` : `\n\nBook here: ${linked}`;
}

export async function runChatTurn(input: PipelineInput): Promise<PipelineResult> {
  const sb = createServiceSupabase();
  const { dealer, conversation, channel, requestId } = input;
  const lang: Lang = conversation.language;

  // 0. Sanitise the buyer message.
  const sanitized = sanitizeBuyerMessage(input.rawBuyerMessage);
  if (!sanitized) {
    return {
      kind: "save_error",
      conversationId: conversation.id,
      reply: null,
      ackReply: null,
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  // 1. Per-conversation rate limit. (ip + dealer are upstream concerns
  //    of the HTTP adapter — they need to know the dealer slug before
  //    we even reach this function. The conversation rule lives here.)
  const convLimit = await checkRate("conversation", conversation.id);
  if (!convLimit.ok) {
    log.warn("chat.rate_limited", {
      requestId,
      rule: "conversation",
      conversation_id: conversation.id,
      reset_sec: convLimit.resetSec,
    });
    return {
      kind: "rate_limited",
      conversationId: conversation.id,
      reply: null,
      ackReply: pickEs(lang, RATE_LIMITED_EN, RATE_LIMITED_ES),
      intent: null,
      language: lang,
      pendingApproval: false,
      retryAfterSec: convLimit.resetSec,
    };
  }

  // 2. Keyword detection.
  const keyword = detectKeyword(sanitized.text);

  // 3. Suppressed (opted-out) and not START → ignore.
  if (conversation.suppressed_at && keyword !== "START") {
    log.info("chat.suppressed_inbound", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      channel,
    });
    // Persist the buyer message for audit even though we won't reply.
    await sb.from("messages").insert({
      conversation_id: conversation.id,
      role: "buyer",
      body: sanitized.text,
      intent: null,
      language: null,
      approval_status: "auto",
    });
    return {
      kind: "suppressed",
      conversationId: conversation.id,
      reply: suppressedAck(dealer.name, lang),
      ackReply: null,
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  // 5. First buyer message? Capture TCPA consent BEFORE we save the
  //    buyer message so the "first" check is unambiguous.
  const firstMsgRes = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation.id)
    .eq("role", "buyer");
  const isFirstBuyerMessage = (firstMsgRes.count ?? 0) === 0;

  // 6. Insert buyer message.
  const buyerInsert = await sb.from("messages").insert({
    conversation_id: conversation.id,
    role: "buyer",
    body: sanitized.text,
    intent: null,
    language: null,
    approval_status: "auto",
  });
  if (buyerInsert.error) {
    log.error("chat.buyer_insert_failed", { requestId, dealer_id: dealer.id, code: buyerInsert.error.code });
    return {
      kind: "save_error",
      conversationId: conversation.id,
      reply: null,
      ackReply: pickEs(lang, GENERIC_SERVICE_REPLY_EN, GENERIC_SERVICE_REPLY_ES),
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  if (isFirstBuyerMessage) {
    await captureFirstTurnConsent({
      sb,
      dealer,
      conversation,
      channel,
      ip: input.ip,
      userAgent: input.userAgent,
      buyerPhone: input.buyerPhone,
      requestId,
    });
  }

  // 4 (continued). Handle keyword side effects after we've got the
  // buyer message persisted (audit trail).
  if (keyword) {
    await sb.from("keyword_events").insert({
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      keyword,
      channel,
      raw_message: sanitized.text,
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
      approval_status: "auto", // canned replies aren't approval-gated
      delivery_channel: channel,
    });
    if (aiInsert.error) {
      log.error("chat.keyword_reply_save_failed", { requestId, code: aiInsert.error.code });
    }

    if (channel === "sms" && input.buyerPhone) {
      const r = await sendSms({ to: input.buyerPhone, body: replyText });
      log.info("chat.keyword_reply_sms", {
        requestId,
        queued: r.queued,
        sid: r.sid,
        to_redacted: maskPhone(input.buyerPhone),
      });
    }

    return {
      kind: "keyword",
      conversationId: conversation.id,
      reply: replyText,
      ackReply: null,
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  // 7. Pre-call budget check.
  // Load history + vehicles in parallel, then estimate cost.
  const [historyRes, vehiclesRes] = await Promise.all([
    // Exclude pending and rejected AI/dealer drafts from the history we
    // hand to Claude. Without this filter, a rejected draft would still
    // appear in `assistant` turns next time, and Claude would double
    // down on the angle the dealer just rejected. Buyer messages always
    // pass through (they're persisted with approval_status='auto').
    sb
      .from("messages")
      .select("role,body,created_at,approval_status")
      .eq("conversation_id", conversation.id)
      .or(
        "role.eq.buyer,and(role.in.(ai,dealer),approval_status.in.(approved,auto,sent))",
      )
      .order("created_at", { ascending: true })
      .limit(20),
    sb
      .from("vehicles")
      .select("*")
      .eq("dealer_id", dealer.id)
      .eq("status", "available")
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  if (historyRes.error || vehiclesRes.error) {
    log.error("chat.context_load_failed", {
      requestId,
      dealer_id: dealer.id,
      detail: historyRes.error?.message ?? vehiclesRes.error?.message,
    });
    return {
      kind: "save_error",
      conversationId: conversation.id,
      reply: null,
      ackReply: pickEs(lang, GENERIC_SERVICE_REPLY_EN, GENERIC_SERVICE_REPLY_ES),
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  const historyAll = (historyRes.data ?? []) as Pick<MessageRow, "role" | "body" | "created_at">[];
  // Drop the buyer message we just inserted from the rolling-context
  // list and pass it as the live "user" turn instead.
  const historyContext = historyAll.slice(0, -1).map((m) => ({
    role: m.role as MessageRow["role"],
    body: m.body,
  }));
  const vehicles = (vehiclesRes.data ?? []) as VehicleRow[];

  const systemChars = buildSystemPrompt(dealer, vehicles).length;
  const messagesChars = estimateMessagesChars(historyContext, sanitized.wrapped);
  const estimatedUsd = estimateCallUsd(systemChars, messagesChars, AI_MAX_OUTPUT_TOKENS);

  try {
    await assertBudgetAvailable({ dealerId: dealer.id, estimatedUsd });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn("chat.budget_exhausted", {
        requestId,
        dealer_id: dealer.id,
        detail: err.message,
      });
      return {
        kind: "budget_exhausted",
        conversationId: conversation.id,
        reply: null,
        ackReply: pickEs(lang, GENERIC_SERVICE_REPLY_EN, GENERIC_SERVICE_REPLY_ES),
        intent: null,
        language: lang,
        pendingApproval: false,
      };
    }
    throw err;
  }

  // 8. Call Claude.
  let aiReply;
  try {
    aiReply = await callClaude({
      dealer,
      vehicles,
      history: historyContext,
      buyerWrappedMessage: sanitized.wrapped,
      conversationLanguage: lang,
    });
  } catch (err) {
    const detail = err instanceof AiReplyError ? err.message : "AI request failed";
    log.warn("chat.ai_error", { requestId, dealer_id: dealer.id, detail });
    return {
      kind: "ai_error",
      conversationId: conversation.id,
      reply: null,
      ackReply: pickEs(
        lang,
        "AI is taking a moment — please try again shortly.",
        "La IA está tardando — por favor, intenta de nuevo en un momento.",
      ),
      intent: null,
      language: lang,
      pendingApproval: false,
    };
  }

  // 9. Compose final reply (Calendly tail). v0.4: append the
  // conversation id as ?utm_content so the Calendly webhook can do
  // deterministic conversation matching (vs. the fuzzier
  // phone-then-email lookups it falls back to).
  let finalReply = aiReply.reply;
  if (aiReply.intent === "test_drive" && aiReply.offered_calendly && dealer.calendly_url) {
    finalReply = `${aiReply.reply}${calendlyTail(aiReply.language, dealer.calendly_url, conversation.id)}`;
  }

  // 10. Insert AI message — pending if dealer wants approval, else auto.
  const approvalStatus = dealer.approve_before_send ? "pending" : "auto";
  let saved = false;
  let savedMessageId: string | null = null;
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

  // 11. Update conversation language / intent — only if save succeeded.
  // v0.3 also stamps scheduled_at on a successful test_drive +
  // offered_calendly turn (24h-from-now placeholder; v0.4 Calendly
  // webhook supersedes) so the dashboard reminder query can do a
  // single index seek instead of an N+1 count loop. Only when null,
  // so we don't stomp a real booking value.
  if (saved) {
    const update: Record<string, unknown> = { language: aiReply.language, last_intent: aiReply.intent };
    if (aiReply.intent === "test_drive" && aiReply.offered_calendly && conversation.scheduled_at == null) {
      update.scheduled_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    await sb.from("conversations").update(update).eq("id", conversation.id);
  }

  // 12. Record actual spend regardless of save state — we did pay for it.
  await recordSpend({
    dealerId: dealer.id,
    inputTokens: aiReply.usage.input_tokens,
    outputTokens: aiReply.usage.output_tokens,
  });

  // Approve-before-send: do NOT return reply text to the buyer.
  if (approvalStatus === "pending") {
    if (!saved) {
      // All 3 retries of the AI-message insert failed in pending mode.
      // Without a row to approve, the buyer's poll would return empty
      // for 5 minutes and the typing indicator would hang silently.
      // Surface a 503 instead so the widget shows the retry button.
      log.error("chat.pending_save_exhausted_strands_buyer", {
        requestId,
        dealer_id: dealer.id,
        conversation_id: conversation.id,
      });
      return {
        kind: "save_error",
        conversationId: conversation.id,
        reply: null,
        ackReply: pickEs(lang, GENERIC_SERVICE_REPLY_EN, GENERIC_SERVICE_REPLY_ES),
        intent: null,
        language: lang,
        pendingApproval: false,
      };
    }
    return {
      kind: "pending",
      conversationId: conversation.id,
      reply: null,
      ackReply: pickEs(lang, PENDING_ACK_EN, PENDING_ACK_ES),
      intent: aiReply.intent,
      language: aiReply.language,
      pendingApproval: true,
    };
  }

  // 13. SMS-channel: ship the reply via Twilio.
  if (channel === "sms" && input.buyerPhone && savedMessageId) {
    const send = await sendSms({ to: input.buyerPhone, body: finalReply });
    if (send.queued && send.sid) {
      await sb
        .from("messages")
        .update({ delivery_sid: send.sid, approval_status: "sent" })
        .eq("id", savedMessageId);
    }
  }

  return {
    kind: "ai_reply",
    conversationId: conversation.id,
    reply: finalReply,
    ackReply: null,
    intent: aiReply.intent,
    language: aiReply.language,
    pendingApproval: false,
  };
}
