// Vapi inbound webhook. Mirrors /api/sms/inbound:
//   1. Verify HMAC signature on the raw body BEFORE parsing.
//   2. If voice disabled, ack 200 with empty payload — Vapi will retry
//      on a non-2xx forever.
//   3. Resolve dealer by params.to === dealer.voice_number.
//   4. Find-or-create a `channel='voice'` conversation.
//   5. Run runChatTurn; respond `{ message: <reply | ack> }` so Vapi
//      can speak the line back to the buyer in-call.
//
// STOP/HELP/START suppression already happens inside runChatTurn (the
// keyword detector is channel-agnostic). A buyer who says "STOP" on a
// voice call therefore opts out of voice replies AND any future SMS to
// the same buyer_phone — that's the desired behaviour for TCPA.

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { runChatTurn } from "@/lib/chat-pipeline";
import {
  ConversationRouterError,
  findOrCreateConversation,
} from "@/lib/conversation-router";
import { createServiceSupabase } from "@/lib/supabase-service";
import { speakBack, verifyVapiSignature, type VapiTranscriptPayload } from "@/lib/voice/vapi";
import { checkRate, readClientIp } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import { anthropicConfigured, supabaseServiceConfigured, voiceEnabled } from "@/lib/env";
import type { DealerRow } from "@/lib/db-types";

const E164 = /^\+[1-9][0-9]{7,14}$/;

function ack(message: string): NextResponse {
  return NextResponse.json({ message }, { status: 200 });
}

function emptyAck(): NextResponse {
  return NextResponse.json({ message: "" }, { status: 200 });
}

function forbidden(): NextResponse {
  return new NextResponse("", { status: 403 });
}

function badRequest(): NextResponse {
  return new NextResponse("", { status: 400 });
}

function parseTranscript(raw: string): VapiTranscriptPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const callId = typeof parsed.callId === "string" ? parsed.callId : "";
    const from = typeof parsed.from === "string" ? parsed.from : "";
    const to = typeof parsed.to === "string" ? parsed.to : "";
    const transcript = typeof parsed.transcript === "string" ? parsed.transcript : "";
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    if (!callId || !from || !to || !transcript) return null;
    return { callId, from, to, transcript, timestamp };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const signature = request.headers.get("x-vapi-signature");

  log.info("voice.inbound.received", { requestId, signature_present: Boolean(signature) });

  // 1. SIGNATURE FIRST. We must read the raw body once and verify
  // before parsing — otherwise the JSON parser becomes a DoS surface.
  const rawBody = await request.text();
  const sigOk = await verifyVapiSignature({ rawBody, signature });
  if (!sigOk) {
    log.warn("voice.inbound.signature_invalid", { requestId });
    return forbidden();
  }

  // 2. Feature flag. Default off → ack with empty payload so Vapi
  // doesn't retry forever (a non-2xx triggers their backoff loop).
  if (!voiceEnabled()) {
    log.info("voice.inbound.disabled", { requestId });
    return emptyAck();
  }
  if (!supabaseServiceConfigured) {
    log.error("voice.inbound.misconfigured", { requestId, missing: "SUPABASE_SERVICE_ROLE_KEY" });
    return emptyAck();
  }
  if (!anthropicConfigured) {
    log.error("voice.inbound.misconfigured", { requestId, missing: "ANTHROPIC_API_KEY" });
    return emptyAck();
  }

  const payload = parseTranscript(rawBody);
  if (!payload) {
    log.warn("voice.inbound.bad_payload", { requestId });
    return badRequest();
  }
  if (!E164.test(payload.from) || !E164.test(payload.to)) {
    log.warn("voice.inbound.bad_numbers", { requestId });
    return badRequest();
  }
  if (payload.transcript.length > 4000) {
    return badRequest();
  }

  // 3. Per-buyer rate limit, keyed off From so a single caller can't
  // hammer us regardless of carrier route. We do NOT 429 Vapi (they'd
  // retry into a loop) — silently emptyAck.
  const ipLimit = await checkRate("ip", `voice:${payload.from}`);
  if (!ipLimit.ok) {
    log.warn("voice.inbound.rate_limited", { requestId, rule: "ip" });
    return emptyAck();
  }

  const sb = createServiceSupabase();

  const dealerRes = await sb.from("dealers").select("*").eq("voice_number", payload.to).maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) {
    log.warn("voice.inbound.unknown_dealer_number", { requestId });
    return emptyAck();
  }

  const dealerLimit = await checkRate("dealer", dealer.id);
  if (!dealerLimit.ok) {
    log.warn("voice.inbound.rate_limited", { requestId, rule: "dealer", dealer_id: dealer.id });
    return emptyAck();
  }

  // 4. Find-or-create conversation. v0.3.1 carry-over E3: shared helper
  // with /api/sms/inbound. Separate buyer_session prefix ("voice:") so
  // the unique (dealer_id, buyer_session) constraint allows a buyer
  // who both texts AND calls — they get distinct threads.
  const buyerSession = `voice:${createHash("sha256").update(`${dealer.id}:${payload.from}`).digest("hex")}`;
  let conversation;
  try {
    const result = await findOrCreateConversation({
      sb,
      dealer,
      channel: "voice",
      buyerSession,
      buyerPhone: payload.from,
      language: "en",
      requestId,
    });
    conversation = result.conversation;
  } catch (err) {
    if (err instanceof ConversationRouterError) {
      log.error("voice.inbound.conv_create_failed", { requestId, code: err.code });
      return emptyAck();
    }
    throw err;
  }

  // 5. Pipeline.
  const result = await runChatTurn({
    dealer,
    conversation,
    rawBuyerMessage: payload.transcript,
    channel: "voice",
    ip: readClientIp(request.headers),
    userAgent: null,
    buyerPhone: payload.from,
    requestId,
  });

  log.info("voice.inbound.processed", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: result.conversationId,
    kind: result.kind,
  });

  // 6. v0.5 outbound TTS. Inject the AI reply directly into the live
  //    call via Vapi's /call/{id}/control endpoint. ONLY for ai_reply
  //    in non-approve mode — pending drafts must NOT be spoken
  //    (the dealer hasn't seen them yet) and keyword acks are short
  //    enough that the JSON-message path is fine.
  //
  //    R1 (architect): if speakBack queued the message, Vapi will
  //    already speak it. Returning the same text in the JSON ack
  //    would speak it twice. So when queued, ack empty; else fall
  //    back to text so the buyer hears something even if speakBack
  //    failed.
  if (
    result.kind === "ai_reply" &&
    result.reply &&
    !dealer.approve_before_send
  ) {
    const spoken = await speakBack({ callId: payload.callId, body: result.reply });
    if (spoken.queued) return ack("");
    // speakBack failed — fall through to the JSON ack path so the
    // buyer at least hears the line via Vapi's response handler.
    log.warn("voice.inbound.speak_fallback_to_ack", {
      requestId,
      detail: spoken.error,
    });
  }

  // Always send Vapi a non-empty message when we have one — pending /
  // rate_limited / suppressed all carry an ackReply.
  return ack(result.reply ?? result.ackReply ?? "");
}
