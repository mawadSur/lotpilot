// WhatsApp Cloud API inbound webhook (v0.5 scaffold).
//
// Two handlers:
//   GET  — Meta's one-time subscription verification. We echo `hub.challenge`
//          back as plain text when `hub.mode == 'subscribe'` and the verify
//          token matches WHATSAPP_VERIFY_TOKEN.
//   POST — inbound message delivery. Verify X-Hub-Signature-256 over the
//          raw body, parse Meta's batched payload, route to the chat
//          pipeline as channel='whatsapp'. v0.5 logs a "would_send" line
//          instead of actually replying — outbound is wired in v0.6
//          after WABA bookkeeping is complete.
//
// Signature MUST be the very first thing in POST — before parsing JSON,
// before any DB lookup. Meta sends the signature as `sha256=<hex>`; we
// strip that prefix and timing-safe-compare. HMAC is computed over the
// raw body bytes under WHATSAPP_APP_SECRET.

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { runChatTurn } from "@/lib/chat-pipeline";
import {
  ConversationRouterError,
  findOrCreateConversation,
} from "@/lib/conversation-router";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  checkWhatsAppGetVerification,
  extractFirstWhatsAppMessage,
  normaliseE164,
  sendWhatsAppMessage,
  verifyWhatsAppSignature,
} from "@/lib/whatsapp/cloud-api";
import { checkRate, readClientIp } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import {
  anthropicConfigured,
  supabaseServiceConfigured,
  whatsappPostConfigured,
  whatsappVerifyConfigured,
} from "@/lib/env";
import { maskPhone } from "@/lib/sms/twilio";
import type { DealerRow } from "@/lib/db-types";

function ok(): NextResponse {
  return new NextResponse(null, { status: 200 });
}
function forbidden(): NextResponse {
  return new NextResponse("", { status: 403 });
}
function unavailable(): NextResponse {
  return new NextResponse("", { status: 503 });
}

// -------------------------------------------------------------------
// GET — Meta subscription verification.

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID();
  if (!whatsappVerifyConfigured) {
    log.warn("whatsapp.verify.unconfigured", { requestId });
    return forbidden();
  }
  const sp = request.nextUrl.searchParams;
  const result = checkWhatsAppGetVerification({
    mode: sp.get("hub.mode"),
    token: sp.get("hub.verify_token"),
    challenge: sp.get("hub.challenge"),
  });
  if (!result.ok) {
    log.warn("whatsapp.verify.failed", { requestId });
    return forbidden();
  }
  log.info("whatsapp.verify.ok", { requestId });
  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// -------------------------------------------------------------------
// POST — message delivery.

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const signature = request.headers.get("x-hub-signature-256");

  log.info("whatsapp.inbound.received", {
    requestId,
    signature_present: Boolean(signature),
  });

  // Hard-fail when the secret isn't set. Done BEFORE we even read the
  // body so a misconfigured deploy can't be DoS'd. (Meta retries 5xx
  // forever, but until the secret is configured there's nothing we can
  // do safely with the body, so 503 is the honest answer.)
  if (!whatsappPostConfigured) {
    log.error("whatsapp.inbound.misconfigured", {
      requestId,
      missing: "WHATSAPP_APP_SECRET",
    });
    return unavailable();
  }
  if (!supabaseServiceConfigured) {
    log.error("whatsapp.inbound.misconfigured", {
      requestId,
      missing: "SUPABASE_SERVICE_ROLE_KEY",
    });
    return unavailable();
  }
  if (!anthropicConfigured) {
    log.error("whatsapp.inbound.misconfigured", {
      requestId,
      missing: "ANTHROPIC_API_KEY",
    });
    return unavailable();
  }

  // SIGNATURE FIRST.
  const rawBody = await request.text();
  if (!verifyWhatsAppSignature({ rawBody, header: signature })) {
    log.warn("whatsapp.inbound.signature_invalid", { requestId });
    return forbidden();
  }

  // Parse the batched Meta payload + extract the first text message.
  // Status-only / non-text payloads are normal Meta deliveries — 200
  // and move on so they don't retry.
  const message = extractFirstWhatsAppMessage(rawBody);
  if (!message) {
    log.info("whatsapp.inbound.noop", { requestId });
    return ok();
  }

  const buyerPhone = normaliseE164(message.from);
  const dealerNumber = normaliseE164(message.dealerDisplayNumber);
  if (!buyerPhone || !dealerNumber) {
    log.warn("whatsapp.inbound.bad_numbers", { requestId });
    return ok();
  }
  if (message.text.length > 4000) {
    log.warn("whatsapp.inbound.body_too_long", { requestId });
    return ok();
  }

  // Per-buyer rate limit. Same posture as SMS: drop+200 instead of 429
  // so Meta doesn't retry into a loop.
  const ipLimit = await checkRate("ip", `whatsapp:${buyerPhone}`);
  if (!ipLimit.ok) {
    log.warn("whatsapp.inbound.rate_limited", { requestId, rule: "ip" });
    return ok();
  }

  const sb = createServiceSupabase();

  // Resolve dealer by their Meta-registered display number. We use the
  // E.164-normalised value — dealers.whatsapp_number is stored E.164.
  const dealerRes = await sb
    .from("dealers")
    .select("*")
    .eq("whatsapp_number", dealerNumber)
    .maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) {
    log.warn("whatsapp.inbound.unknown_dealer_number", {
      requestId,
      to_redacted: maskPhone(dealerNumber),
    });
    return ok();
  }

  const dealerLimit = await checkRate("dealer", dealer.id);
  if (!dealerLimit.ok) {
    log.warn("whatsapp.inbound.rate_limited", {
      requestId,
      rule: "dealer",
      dealer_id: dealer.id,
    });
    return ok();
  }

  // Find-or-create conversation. Match the SMS pattern: buyer_session
  // is sha256(dealer_id:buyer_phone) prefixed with "whatsapp:" so a
  // buyer who both texts AND WhatsApps gets distinct threads.
  const buyerSession = `whatsapp:${createHash("sha256")
    .update(`${dealer.id}:${buyerPhone}`)
    .digest("hex")}`;
  let conversation;
  try {
    const result = await findOrCreateConversation({
      sb,
      dealer,
      channel: "whatsapp",
      buyerSession,
      buyerPhone,
      language: "en",
      requestId,
    });
    conversation = result.conversation;
  } catch (err) {
    if (err instanceof ConversationRouterError) {
      log.error("whatsapp.inbound.conv_create_failed", {
        requestId,
        code: err.code,
      });
      return ok();
    }
    throw err;
  }

  const result = await runChatTurn({
    dealer,
    conversation,
    rawBuyerMessage: message.text,
    channel: "whatsapp",
    ip: readClientIp(request.headers),
    userAgent: null,
    buyerPhone,
    requestId,
  });

  log.info("whatsapp.inbound.processed", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: result.conversationId,
    kind: result.kind,
  });

  // v0.5: outbound is a stub. We log what we WOULD send so v0.6 wiring
  // can be tested against the existing approve-before-send queue.
  if (result.kind === "ai_reply" && result.reply && !dealer.approve_before_send) {
    const send = await sendWhatsAppMessage({ to: buyerPhone, body: result.reply });
    log.info("whatsapp.would_send", {
      requestId,
      queued: send.queued,
      to_redacted: maskPhone(buyerPhone),
      reason: send.error ?? "stub",
    });
  }

  // Always 200 to Meta after the signature passes. Non-2xx triggers
  // their retry storm.
  return ok();
}
