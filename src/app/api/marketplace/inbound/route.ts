// Marketplace browser-extension inbound webhook (v0.5).
//
// See src/lib/marketplace/extension.ts for the full ARCHITECTURE
// DECISION RECORD. Short version: the LotPilot Chrome extension
// scrapes the dealer's own facebook.com/marketplace inbox, HMAC-signs
// the payload, and POSTs to this route. We thread the message into
// the standard chat pipeline as channel='marketplace' so the dealer
// sees it in the same inbox + dashboard as web/sms/voice.
//
// Order of operations (signature ALWAYS first):
//   1. Verify x-lotpilot-extension-signature on raw body. Mismatch → 403.
//   2. Hard-fail with 503 when MARKETPLACE_EXTENSION_SECRET is unset
//      — there is no point pretending to receive inbound when we can't
//      authenticate it. (Contrast with Calendly, where we ack+drop.)
//   3. Parse + validate JSON shape. Bad → 400.
//   4. Per-dealer rate limit.
//   5. Resolve dealer by dealer_id (the extension knows its dealer at
//      install time). Unknown → 404.
//   6. findOrCreateConversation: channel='marketplace',
//      buyerSession='marketplace:<thread_id>'. No buyer_phone — Meta
//      doesn't expose it.
//   7. Run runChatTurn. Return JSON {draft, intent, conversation_id,
//      kind} so the extension can render the AI draft in the inbox UI
//      (or, in approve-mode, the ack text).

import { NextResponse, type NextRequest } from "next/server";
import { runChatTurn } from "@/lib/chat-pipeline";
import {
  ConversationRouterError,
  findOrCreateConversation,
} from "@/lib/conversation-router";
import { createServiceSupabase } from "@/lib/supabase-service";
import {
  parseMarketplacePayload,
  verifyExtensionSignature,
} from "@/lib/marketplace/extension";
import { checkRate, readClientIp } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import {
  anthropicConfigured,
  marketplaceExtensionConfigured,
  supabaseServiceConfigured,
} from "@/lib/env";
import type { DealerRow } from "@/lib/db-types";

function ok(payload: Record<string, unknown>): NextResponse {
  return NextResponse.json(payload, { status: 200 });
}
function badRequest(): NextResponse {
  return new NextResponse("", { status: 400 });
}
function forbidden(): NextResponse {
  return new NextResponse("", { status: 403 });
}
function notFound(): NextResponse {
  return new NextResponse("", { status: 404 });
}
function unavailable(): NextResponse {
  return new NextResponse("", { status: 503 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const signature = request.headers.get("x-lotpilot-extension-signature");
  // v0.6: dealer_id moved to a header so we can derive the per-dealer
  // secret BEFORE computing the HMAC. Body still carries dealer_id;
  // header MUST match body (tamper resistance — a forged header+body
  // would still have to forge a valid HMAC).
  const dealerIdHeader = request.headers.get("x-lotpilot-dealer-id");

  log.info("marketplace.inbound.received", {
    requestId,
    signature_present: Boolean(signature),
    dealer_id_header_present: Boolean(dealerIdHeader),
  });

  // 2. Hard-fail when the secret isn't set. Done BEFORE we even read
  //    the body so a misconfigured deploy can't be DoS'd by spammy
  //    POSTs to this endpoint.
  if (!marketplaceExtensionConfigured) {
    log.error("marketplace.inbound.misconfigured", {
      requestId,
      missing: "MARKETPLACE_EXTENSION_SECRET",
    });
    return unavailable();
  }
  if (!supabaseServiceConfigured) {
    log.error("marketplace.inbound.misconfigured", {
      requestId,
      missing: "SUPABASE_SERVICE_ROLE_KEY",
    });
    return unavailable();
  }
  if (!anthropicConfigured) {
    log.error("marketplace.inbound.misconfigured", {
      requestId,
      missing: "ANTHROPIC_API_KEY",
    });
    return unavailable();
  }

  // v0.6: dealer_id header is required and must be a UUID — we need it
  // to derive the per-dealer secret before computing the HMAC.
  if (!dealerIdHeader || !UUID_RE.test(dealerIdHeader)) {
    log.warn("marketplace.inbound.dealer_id_header_missing", { requestId });
    return forbidden();
  }

  // 1. SIGNATURE FIRST. Read the raw body once; we'll JSON.parse only
  //    after verification.
  const rawBody = await request.text();
  if (
    !verifyExtensionSignature({
      rawBody,
      signature,
      dealerId: dealerIdHeader,
    })
  ) {
    log.warn("marketplace.inbound.signature_invalid", { requestId });
    return forbidden();
  }

  // 3. Parse + validate.
  const payload = parseMarketplacePayload(rawBody);
  if (!payload) {
    log.warn("marketplace.inbound.bad_payload", { requestId });
    return badRequest();
  }
  // Header and body dealer_id MUST agree — tamper resistance. A
  // malicious extension that managed to swap one but not the other
  // would still fail HMAC, but this rejects earlier with a clearer
  // signal.
  if (payload.dealer_id !== dealerIdHeader) {
    log.warn("marketplace.inbound.dealer_id_mismatch", {
      requestId,
      header_dealer_id: dealerIdHeader,
      body_dealer_id: payload.dealer_id,
    });
    return forbidden();
  }

  // 4. Per-dealer rate limit. Marketplace inboxes are bursty (a popular
  //    listing can fire 10+ in a minute) — the dealer rule (120/min) is
  //    the right ceiling. We do NOT 429 the extension (it'd retry into
  //    a loop) — drop with 200-shaped JSON instead, so the extension
  //    can show "rate limited, try again" inline.
  const dealerLimit = await checkRate("dealer", payload.dealer_id);
  if (!dealerLimit.ok) {
    log.warn("marketplace.inbound.rate_limited", {
      requestId,
      dealer_id: payload.dealer_id,
    });
    return ok({
      kind: "rate_limited",
      retry_after_sec: dealerLimit.resetSec,
      conversation_id: null,
      draft: null,
    });
  }

  const sb = createServiceSupabase();

  // 5. Resolve dealer.
  const dealerRes = await sb
    .from("dealers")
    .select("*")
    .eq("id", payload.dealer_id)
    .maybeSingle();
  const dealer = dealerRes.data as DealerRow | null;
  if (!dealer) {
    log.warn("marketplace.inbound.unknown_dealer", {
      requestId,
      dealer_id: payload.dealer_id,
    });
    return notFound();
  }

  // 6. Find-or-create conversation. buyer_session uses the marketplace
  //    thread id directly (it's already unique per buyer-per-listing
  //    on Meta's side); the "marketplace:" prefix keeps it disjoint
  //    from sms:/voice:/web: sessions for the same dealer.
  const buyerSession = `marketplace:${payload.marketplace_thread_id}`.slice(0, 128);
  let conversation;
  try {
    const result = await findOrCreateConversation({
      sb,
      dealer,
      channel: "marketplace",
      buyerSession,
      buyerPhone: null,
      language: "en",
      requestId,
    });
    conversation = result.conversation;
  } catch (err) {
    if (err instanceof ConversationRouterError) {
      log.error("marketplace.inbound.conv_create_failed", {
        requestId,
        code: err.code,
      });
      return unavailable();
    }
    throw err;
  }

  // 7. Pipeline.
  const result = await runChatTurn({
    dealer,
    conversation,
    rawBuyerMessage: payload.buyer_message,
    channel: "marketplace",
    ip: readClientIp(request.headers),
    userAgent: null,
    buyerPhone: null,
    requestId,
  });

  log.info("marketplace.inbound.processed", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: result.conversationId,
    kind: result.kind,
  });

  // The extension UI shows either the AI draft (auto / keyword reply)
  // or the ack text (pending / rate_limited / suppressed) — with the
  // pipeline kind so it can pick the right copy variant.
  return ok({
    kind: result.kind,
    conversation_id: result.conversationId,
    draft: result.reply ?? result.ackReply ?? null,
    intent: result.intent,
    language: result.language,
    pending_approval: result.pendingApproval,
  });
}
