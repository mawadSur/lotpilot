// Public chat endpoint. Called by the buyer-facing widget at /c/[slug].
//
// HTTP adapter only — the heavy lifting lives in `lib/chat-pipeline.ts`
// so /api/sms/inbound can share the same logic.
//
// Contract:
//   POST { slug: string, conversationId?: string, message: string }
//   200  { conversationId, reply, intent, language, pendingApproval }
//   400  { error }   — bad request shape, message too long, etc.
//   404  { error }   — unknown dealer slug
//   429  { error }   — rate-limited; sets Retry-After
//   503  { error }   — service unavailable (env, AI, save, budget)

import { NextResponse, type NextRequest } from "next/server";
import { runChatTurn } from "@/lib/chat-pipeline";
import { checkRate, readClientIp } from "@/lib/ratelimit";
import { createServiceSupabase } from "@/lib/supabase-service";
import { log } from "@/lib/log";
import { newBuyerSession, BUYER_SESSION_COOKIE, isValidBuyerSession } from "@/lib/session";
import { anthropicConfigured, supabaseServiceConfigured } from "@/lib/env";
import type { ConversationRow, DealerRow } from "@/lib/db-types";

interface ChatRequestBody {
  slug?: unknown;
  conversationId?: unknown;
  message?: unknown;
}

function bad(status: number, error: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  if (!supabaseServiceConfigured) {
    log.error("chat.misconfigured", { requestId, missing: "SUPABASE_SERVICE_ROLE_KEY" });
    return bad(503, "Service temporarily unavailable.");
  }
  if (!anthropicConfigured) {
    log.error("chat.misconfigured", { requestId, missing: "ANTHROPIC_API_KEY" });
    return bad(503, "Service temporarily unavailable.");
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return bad(400, "Invalid JSON body.");
  }

  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug)) {
    return bad(400, "Invalid dealer slug.");
  }

  const ip = readClientIp(request.headers);

  // Rate-limit order: ip → dealer → conversation. ip + dealer here;
  // conversation rule lives inside the pipeline (we don't have the
  // conversation ID resolved yet).
  const ipLimit = await checkRate("ip", ip);
  if (!ipLimit.ok) {
    log.warn("chat.rate_limited", { requestId, rule: "ip", reset_sec: ipLimit.resetSec });
    return bad(429, "Too many requests. Please wait a moment.", {
      "retry-after": String(ipLimit.resetSec),
    });
  }

  const sb = createServiceSupabase();

  // 1. Dealer lookup.
  const dealerRes = await sb.from("dealers").select("*").eq("slug", slug).maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) return bad(404, "Dealer not found.");

  const dealerLimit = await checkRate("dealer", dealer.id);
  if (!dealerLimit.ok) {
    log.warn("chat.rate_limited", {
      requestId,
      rule: "dealer",
      dealer_id: dealer.id,
      reset_sec: dealerLimit.resetSec,
    });
    return bad(429, "Too many requests for this dealership. Please wait a moment.", {
      "retry-after": String(dealerLimit.resetSec),
    });
  }

  // 2. Session cookie (mint if missing or invalid).
  const cookieValue = request.cookies.get(BUYER_SESSION_COOKIE)?.value;
  const session = isValidBuyerSession(cookieValue) ? cookieValue : newBuyerSession();
  const issuedNewCookie = session !== cookieValue;

  // 3. Get-or-create conversation.
  const conversationLookup = await sb
    .from("conversations")
    .select("*")
    .eq("dealer_id", dealer.id)
    .eq("buyer_session", session)
    .maybeSingle();

  let conversation = conversationLookup.data as ConversationRow | null;
  if (!conversation) {
    const insertConv = await sb
      .from("conversations")
      .insert({
        dealer_id: dealer.id,
        buyer_session: session,
        language: "en",
        status: "open",
        channel: "web",
        lead_status: "new",
      })
      .select("*")
      .single();
    if (insertConv.error || !insertConv.data) {
      log.error("chat.conversation_create_failed", { requestId, code: insertConv.error?.code });
      return bad(503, "Could not start conversation.");
    }
    conversation = insertConv.data as ConversationRow;
  }

  // Trust cookie over body — log mismatch so we can spot abuse.
  if (typeof body.conversationId === "string" && body.conversationId !== conversation.id) {
    log.warn("chat.conversation_id_mismatch", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
    });
  }

  if (typeof body.message !== "string" || !body.message.trim()) {
    return bad(400, "Message is empty or missing.");
  }
  if (body.message.length > 4000) {
    return bad(400, "Message is too long.");
  }

  const userAgent = request.headers.get("user-agent");

  const result = await runChatTurn({
    dealer,
    conversation,
    rawBuyerMessage: body.message,
    channel: "web",
    ip,
    userAgent,
    buyerPhone: null,
    requestId,
  });

  if (result.kind === "rate_limited") {
    return bad(429, result.ackReply ?? "Slow down and try again.", {
      "retry-after": String(result.retryAfterSec ?? 10),
    });
  }
  if (result.kind === "save_error" || result.kind === "ai_error" || result.kind === "budget_exhausted") {
    return bad(503, result.ackReply ?? "Service temporarily unavailable.");
  }

  const replyForBuyer = result.reply ?? result.ackReply ?? "";
  const response = NextResponse.json({
    conversationId: result.conversationId,
    reply: replyForBuyer,
    intent: result.intent,
    language: result.language,
    pendingApproval: result.pendingApproval,
  });

  if (issuedNewCookie) {
    response.cookies.set({
      name: BUYER_SESSION_COOKIE,
      value: session,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  log.info("chat.ok", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: result.conversationId,
    duration_ms: Date.now() - startedAt,
    intent: result.intent,
    language: result.language,
    kind: result.kind,
    pending: result.pendingApproval,
  });

  return response;
}
