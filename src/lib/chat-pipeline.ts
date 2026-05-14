// Shared chat-turn pipeline. The HTTP adapters stay thin; all side
// effects (DB writes, Redis counters, AI calls, outbound dispatch)
// live here. v0.7: steps 10-12 moved to ./chat-persistence; Spanish
// corpus fetched in parallel with history/vehicles when lang='es'.

import {
  callClaude,
  AiReplyError,
  AI_MAX_OUTPUT_TOKENS,
  estimateMessagesChars,
  buildSystemPrompt,
} from "./ai";
import {
  assertBudgetAvailable,
  BudgetExceededError,
  estimateCallUsd,
} from "./budget";
import { detectKeyword, suppressedAck } from "./keywords";
import { captureFirstTurnConsent } from "./consent-capture";
import { dispatchOutbound } from "./chat-outbound";
import { handleKeyword, persistAiReply } from "./chat-persistence";
import { log } from "./log";
import { checkRate } from "./ratelimit";
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

export type PipelineKind =
  | "ai_reply"
  | "pending"
  | "keyword"
  | "suppressed"
  | "rate_limited"
  | "budget_exhausted"
  | "ai_error"
  | "save_error";

export interface PipelineResult {
  kind: PipelineKind;
  conversationId: string;
  reply: string | null;
  ackReply: string | null;
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
  userAgent: string | null;
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

function calendlyTail(lang: Lang, url: string, conversationId: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const linked = `${url}${sep}utm_content=${encodeURIComponent(conversationId)}`;
  return lang === "es" ? `\n\nReserva aquí: ${linked}` : `\n\nBook here: ${linked}`;
}

function saveError(conversation: ConversationRow, lang: Lang): PipelineResult {
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

export async function runChatTurn(input: PipelineInput): Promise<PipelineResult> {
  const sb = createServiceSupabase();
  const { dealer, conversation, channel, requestId } = input;
  const lang: Lang = conversation.language;

  // 0. Sanitise.
  const sanitized = sanitizeBuyerMessage(input.rawBuyerMessage);
  if (!sanitized) return saveError(conversation, lang);

  // 1. Per-conversation rate limit.
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

  // 3. Suppressed (opted-out) + not START → audit + ack.
  if (conversation.suppressed_at && keyword !== "START") {
    log.info("chat.suppressed_inbound", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      channel,
    });
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

  // 4. First-buyer check BEFORE we insert (so the count check is unambiguous).
  const firstMsgRes = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation.id)
    .eq("role", "buyer");
  const isFirstBuyerMessage = (firstMsgRes.count ?? 0) === 0;

  // 5. Insert buyer message.
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
    return saveError(conversation, lang);
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

  // 6. Keyword handling.
  if (keyword) {
    const replyText = await handleKeyword({
      sb,
      dealer,
      conversation,
      keyword,
      lang,
      channel,
      rawMessage: sanitized.text,
      buyerPhone: input.buyerPhone,
      requestId,
    });
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

  // 7. Load history + vehicles. Spanish corpus injection is wired up
  //    end-to-end at v0.7.1 (requires ai.ts buildSystemPrompt/AiCallArgs
  //    signature changes + 0009_spanish_phrases migration before this
  //    pipeline can hand examples to Claude).
  const [historyRes, vehiclesRes] = await Promise.all([
    sb
      .from("messages")
      .select("role,body,intent,created_at,approval_status")
      .eq("conversation_id", conversation.id)
      .or("role.eq.buyer,and(role.in.(ai,dealer),approval_status.in.(approved,auto,sent))")
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
    return saveError(conversation, lang);
  }
  const historyAll = (historyRes.data ?? []) as Pick<
    MessageRow,
    "role" | "body" | "intent" | "created_at"
  >[];
  const historyContext = historyAll.slice(0, -1).map((m) => ({
    role: m.role as MessageRow["role"],
    body: m.body,
  }));
  const vehicles = (vehiclesRes.data ?? []) as VehicleRow[];

  // 8. Budget pre-check.
  const systemChars = buildSystemPrompt(dealer, vehicles).length;
  const messagesChars = estimateMessagesChars(historyContext, sanitized.wrapped);
  const estimatedUsd = estimateCallUsd(systemChars, messagesChars, AI_MAX_OUTPUT_TOKENS);

  try {
    await assertBudgetAvailable({ dealerId: dealer.id, estimatedUsd });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn("chat.budget_exhausted", { requestId, dealer_id: dealer.id, detail: err.message });
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

  // 9. Call Claude.
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

  // Compose final reply (Calendly tail).
  let finalReply = aiReply.reply;
  if (aiReply.intent === "test_drive" && aiReply.offered_calendly && dealer.calendly_url) {
    finalReply = `${aiReply.reply}${calendlyTail(aiReply.language, dealer.calendly_url, conversation.id)}`;
  }

  // 10-12. Save AI message + update conversation + record spend.
  const approvalStatus = dealer.approve_before_send ? "pending" : "auto";
  const persisted = await persistAiReply({
    sb,
    conversation,
    dealer,
    historyAll,
    aiReply,
    finalReply,
    approvalStatus,
    channel,
    requestId,
  });

  // Approve-before-send: do NOT return reply text to the buyer.
  if (approvalStatus === "pending") {
    if (!persisted.saved) {
      log.error("chat.pending_save_exhausted_strands_buyer", {
        requestId,
        dealer_id: dealer.id,
        conversation_id: conversation.id,
      });
      return saveError(conversation, lang);
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

  // 13. Per-channel outbound dispatch (SMS + WhatsApp). STAYS in pipeline.
  if (persisted.savedMessageId) {
    await dispatchOutbound({
      sb,
      channel,
      dealer,
      conversationId: conversation.id,
      buyerPhone: input.buyerPhone,
      savedMessageId: persisted.savedMessageId,
      finalReply,
      requestId,
    });
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
