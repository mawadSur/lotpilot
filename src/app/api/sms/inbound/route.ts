// Twilio inbound-SMS webhook. Signature validation MUST be the very
// first thing we do — before form parsing, before any DB lookup, before
// logging anything beyond `signature_present`. The classical mistake is
// validating after parsing, which makes the parser DoS-able.
//
// Always return TwiML <Response/> with HTTP 200 on success; the actual
// outbound SMS is sent via twilio.messages.create() inside the chat
// pipeline. On signature failure we return 403 with empty body — never
// leak why.

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { runChatTurn } from "@/lib/chat-pipeline";
import {
  ConversationRouterError,
  findOrCreateConversation,
} from "@/lib/conversation-router";
import { createServiceSupabase } from "@/lib/supabase-service";
import { verifyTwilioSignature } from "@/lib/sms/twilio";
import { checkRate, readClientIp } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import { anthropicConfigured, smsEnabled, supabaseServiceConfigured } from "@/lib/env";
import type { DealerRow } from "@/lib/db-types";

const E164 = /^\+[1-9][0-9]{7,14}$/;
const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function twimlOk(): NextResponse {
  return new NextResponse(TWIML_OK, {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

function forbidden(): NextResponse {
  return new NextResponse("", { status: 403 });
}

function badRequest(): NextResponse {
  return new NextResponse("", { status: 400 });
}

function fullUrl(request: NextRequest): string | null {
  // Twilio signs the absolute URL the request hit. Behind Vercel, both
  // host and x-forwarded-proto are set. We pin both — defaulting proto
  // to "https" silently is a footgun on any deploy target that proxies
  // HTTP→HTTPS or runs locally over HTTP, because the signature would
  // mismatch and we'd 403 with no useful log.
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  if (!proto || !host) return null;
  return `${proto}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const signature = request.headers.get("x-twilio-signature");

  log.info("sms.inbound.received", { requestId, signature_present: Boolean(signature) });

  // 1. SIGNATURE FIRST. Read the raw form body once; we'll reuse it.
  const rawBody = await request.text();
  const params = parseFormUrlEncoded(rawBody);
  const url = fullUrl(request);
  if (!url) {
    log.error("sms.inbound.no_proto_or_host", { requestId });
    return forbidden();
  }

  const signatureOk = await verifyTwilioSignature({ url, params, signature });
  if (!signatureOk) {
    log.warn("sms.inbound.signature_invalid", { requestId });
    return forbidden();
  }

  // From here on we know the request really came from Twilio.

  if (!smsEnabled()) {
    log.warn("sms.inbound.disabled", { requestId });
    return twimlOk(); // ack so Twilio doesn't retry
  }
  if (!supabaseServiceConfigured) {
    log.error("sms.inbound.misconfigured", { requestId, missing: "SUPABASE_SERVICE_ROLE_KEY" });
    return twimlOk();
  }
  if (!anthropicConfigured) {
    log.error("sms.inbound.misconfigured", { requestId, missing: "ANTHROPIC_API_KEY" });
    return twimlOk();
  }

  const fromRaw = params["From"] ?? "";
  const toRaw = params["To"] ?? "";
  const messageBody = params["Body"] ?? "";

  if (!E164.test(fromRaw) || !E164.test(toRaw)) {
    log.warn("sms.inbound.bad_numbers", { requestId });
    return badRequest();
  }
  if (!messageBody.trim() || messageBody.length > 4000) {
    return badRequest();
  }

  // 2. Per-IP-equivalent rate limit. Use From as the key — same buyer
  // can't spam us regardless of which carrier route they're on.
  const ipLimit = await checkRate("ip", `sms:${fromRaw}`);
  if (!ipLimit.ok) {
    log.warn("sms.inbound.rate_limited", { requestId, rule: "ip" });
    return twimlOk(); // We do NOT 429 Twilio — they'll retry. Ack + drop.
  }

  const sb = createServiceSupabase();

  // 3. Resolve dealer by inbound `To` number.
  const dealerRes = await sb.from("dealers").select("*").eq("sms_number", toRaw).maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) {
    log.warn("sms.inbound.unknown_dealer_number", { requestId });
    return twimlOk();
  }

  const dealerLimit = await checkRate("dealer", dealer.id);
  if (!dealerLimit.ok) {
    log.warn("sms.inbound.rate_limited", { requestId, rule: "dealer", dealer_id: dealer.id });
    return twimlOk();
  }

  // 4. Find-or-create conversation keyed (dealer_id, channel='sms',
  // buyer_phone). v0.3.1 carry-over E3: this used to be inlined here
  // and in /api/voice/inbound; both copies had to remember the channel
  // filter to dodge a cross-channel collision. Now centralised in
  // findOrCreateConversation, which keeps the buyer_session prefix
  // ("sms:" vs "voice:") so the unique (dealer_id, buyer_session)
  // constraint still distinguishes a buyer who both texts AND calls.
  const buyerSession = `sms:${createHash("sha256").update(`${dealer.id}:${fromRaw}`).digest("hex")}`;
  let conversation;
  try {
    const result = await findOrCreateConversation({
      sb,
      dealer,
      channel: "sms",
      buyerSession,
      buyerPhone: fromRaw,
      language: "en",
      requestId,
    });
    conversation = result.conversation;
  } catch (err) {
    if (err instanceof ConversationRouterError) {
      log.error("sms.inbound.conv_create_failed", { requestId, code: err.code });
      return twimlOk();
    }
    throw err;
  }

  // 5. Run the shared pipeline.
  const result = await runChatTurn({
    dealer,
    conversation,
    rawBuyerMessage: messageBody,
    channel: "sms",
    ip: readClientIp(request.headers),
    userAgent: null,
    buyerPhone: fromRaw,
    requestId,
  });

  log.info("sms.inbound.processed", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: result.conversationId,
    kind: result.kind,
  });

  // Twilio expects TwiML or empty 200. We always send empty Response —
  // the outbound SMS is fired from inside the pipeline (or queued for
  // approval).
  return twimlOk();
}

function parseFormUrlEncoded(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}
