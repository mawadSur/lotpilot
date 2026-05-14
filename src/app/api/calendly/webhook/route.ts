// Calendly inbound webhook. Mirrors the SMS / voice contract:
//   1. Verify HMAC signature on the raw body BEFORE parsing.
//   2. Ack 200 with empty body when feature-disabled (Calendly retries
//      forever on non-2xx).
//   3. On `invitee.created`, match the Calendly event back to one of
//      our conversations (utm_content > phone > email regex), then
//      overwrite scheduled_at + lead_status='booked' + insert a
//      system message.
//   4. ALWAYS return 200 after the signature passes — even on no-match
//      paths — for the same retry reason.
//
// Conversation matching priority (deterministic > fuzzy):
//   A. tracking.utm_content carries our conversation id (set by the
//      chat pipeline when it appends Calendly link tail). Best.
//   B. invitee.text_reminder_number matches a conversation buyer_phone
//      under the same dealer (channel in sms/voice).
//   C. invitee.email appears verbatim in a recent buyer message body
//      under the same dealer. Last resort; ambiguous matches abort.
//
// Dealer scoping: the calendly event_type uri is mapped to a dealer by
// matching dealers.calendly_url. No match → ack + log; never fall
// back to "any dealer".

import { NextResponse, type NextRequest } from "next/server";
import {
  isInviteeCreated,
  verifyCalendlySignature,
  type CalendlyInviteeCreatedPayload,
} from "@/lib/calendly";
import { lookupEventTypeOwner } from "@/lib/calendly-api";
import { calendlyApiConfigured, calendlyConfigured, requireCalendlySecret } from "@/lib/env";
import { checkRate } from "@/lib/ratelimit";
import { createServiceSupabase } from "@/lib/supabase-service";
import { log } from "@/lib/log";
import type { ConversationRow, DealerRow } from "@/lib/db-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RECENT_MESSAGE_DAYS = 7;
const RECENT_MESSAGE_LIMIT = 200;

function ok(): NextResponse {
  return new NextResponse(null, { status: 200 });
}

function forbidden(): NextResponse {
  return new NextResponse("", { status: 403 });
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const signatureHeader = request.headers.get("calendly-webhook-signature");

  log.info("calendly.received", {
    requestId,
    signature_present: Boolean(signatureHeader),
  });

  // 1. SIGNATURE FIRST. Read the raw body once; we'll JSON.parse it
  //    only after verification succeeds.
  const rawBody = await request.text();

  // Feature flag: when CALENDLY_WEBHOOK_SECRET isn't set we silently
  // ack 200. Calendly will keep delivering, but with no secret to
  // verify against the only safe behaviour is to drop. (Returning
  // non-2xx would cause Calendly to retry forever and pollute logs.)
  if (!calendlyConfigured) {
    log.warn("calendly.disabled", { requestId });
    return ok();
  }

  let secret: string;
  try {
    secret = requireCalendlySecret();
  } catch {
    return ok();
  }

  const verify = verifyCalendlySignature({
    rawBody,
    signatureHeader,
    secret,
  });
  if (!verify.ok) {
    log.warn("calendly.signature_invalid", { requestId, reason: verify.reason });
    return forbidden();
  }

  // 2. Generous global rate limit so a misbehaving Calendly account
  //    can't drown out other traffic. Per-dealer scoping is enforced
  //    after we resolve the dealer below.
  const rate = await checkRate("ip", "calendly:webhook");
  if (!rate.ok) {
    log.warn("calendly.rate_limited", { requestId });
    return ok();
  }

  // 3. Parse + filter to invitee.created. Anything else gets a clean
  //    200 so Calendly stops retrying.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    log.warn("calendly.bad_json", { requestId });
    return ok();
  }

  if (!isInviteeCreated(parsed)) {
    const eventName =
      typeof (parsed as { event?: unknown })?.event === "string"
        ? (parsed as { event: string }).event
        : "unknown";
    log.info("calendly.event_ignored", { requestId, event: eventName });
    return ok();
  }

  const payload = parsed as CalendlyInviteeCreatedPayload;
  const sb = createServiceSupabase();

  // 4. Resolve dealer from event_type uri. We match by suffix so a
  //    schema like https://calendly.com/<slug>/<event-type-slug>
  //    matches dealers.calendly_url that points to the user-level slug.
  const eventTypeUri = payload.payload.event.event_type.uri;
  const dealer = await resolveDealer(sb, eventTypeUri);
  if (!dealer) {
    log.warn("calendly.unknown_dealer", { requestId });
    return ok();
  }

  // 5. Match conversation. Priority A → B → C; first hit wins. If
  //    none match, ack + log (the booking is real but we just can't
  //    attribute it to a thread).
  const conversation = await matchConversation({
    sb,
    dealer,
    payload,
    requestId,
  });
  if (!conversation) {
    log.warn("calendly.no_match", { requestId, dealer_id: dealer.id });
    return ok();
  }

  // 6. Overwrite scheduled_at + flip to booked. The placeholder
  //    scheduled_at the chat pipeline writes (now+24h) gets replaced
  //    by the real Calendly slot.
  const startTime = payload.payload.event.start_time;
  const updateRes = await sb
    .from("conversations")
    .update({ scheduled_at: startTime, lead_status: "booked" })
    .eq("id", conversation.id)
    .eq("dealer_id", dealer.id);
  if (updateRes.error) {
    log.error("calendly.update_failed", {
      requestId,
      dealer_id: dealer.id,
      conversation_id: conversation.id,
      code: updateRes.error.code,
    });
    return ok();
  }

  // 7. Drop a system message into the thread so the dealer sees
  //    the booking inline in the inbox transcript.
  const formatted = formatBookingDate(startTime, dealer.timezone);
  const systemBody =
    conversation.language === "es"
      ? `Prueba de manejo reservada para ${formatted}.`
      : `Test drive booked for ${formatted}.`;
  const insertRes = await sb.from("messages").insert({
    conversation_id: conversation.id,
    role: "ai",
    body: systemBody,
    intent: "test_drive",
    language: conversation.language,
    approval_status: "auto",
    delivery_channel: null,
  });
  if (insertRes.error) {
    log.warn("calendly.system_message_failed", {
      requestId,
      conversation_id: conversation.id,
      code: insertRes.error.code,
    });
  }

  log.info("calendly.matched", {
    requestId,
    dealer_id: dealer.id,
    conversation_id: conversation.id,
    via: conversation.matched_via,
  });

  return ok();
}

// ---------------------------------------------------------------------
// Helpers

async function resolveDealer(
  sb: ReturnType<typeof createServiceSupabase>,
  eventTypeUri: string,
): Promise<DealerRow | null> {
  // v0.5 resolution order:
  //   1. Cache hit on dealers.calendly_event_type_uri (exact equality).
  //      Steady state — written by step 3 below the first time we see
  //      this dealer.
  //   2. Calendly REST API lookup against /event_types/<id> when
  //      CALENDLY_API_KEY is set. Match the returned owner_slug
  //      against dealers.calendly_url. On a match, write the URI
  //      back to dealers.calendly_event_type_uri so step 1 catches
  //      it next time.
  //   3. v0.4 slug-substring heuristic. Exact for one-dealer-per-
  //      Calendly-account; ambiguous when two dealers share a slug
  //      substring. We only land here when the API is unconfigured
  //      or it failed.

  // 1. Cache hit.
  const cachedRes = await sb
    .from("dealers")
    .select("*")
    .eq("calendly_event_type_uri", eventTypeUri)
    .maybeSingle();
  if (!cachedRes.error && cachedRes.data) {
    return cachedRes.data as DealerRow;
  }

  // 2. Calendly REST API lookup. Only when the key is configured —
  //    otherwise the helper returns null immediately and we fall
  //    through to the heuristic.
  if (calendlyApiConfigured) {
    const owner = await lookupEventTypeOwner(eventTypeUri);
    if (owner && owner.ownerSlug) {
      // Match owner_slug against dealers.calendly_url. We use ilike
      // wildcards rather than substring match so we get the same
      // shape as the v0.4 heuristic but bounded to the slug from
      // the Calendly API (not a free-form slug-from-url guess).
      const apiMatch = await sb
        .from("dealers")
        .select("*")
        .ilike("calendly_url", `%/${owner.ownerSlug}%`);
      const apiMatchRows = (apiMatch.data ?? []) as DealerRow[];
      if (apiMatchRows.length === 1) {
        const dealer = apiMatchRows[0];
        // Cache the URI back on the dealer row so step 1 catches it
        // next time. Best-effort; a failed write doesn't block the
        // current webhook.
        await sb
          .from("dealers")
          .update({ calendly_event_type_uri: eventTypeUri })
          .eq("id", dealer.id);
        return { ...dealer, calendly_event_type_uri: eventTypeUri };
      }
      if (apiMatchRows.length > 1) {
        // Multiple dealers share this user_slug — ambiguous, but we
        // know more than the heuristic does. Log + drop rather than
        // pick wrong.
        log.warn("calendly.api_match_ambiguous", {
          dealer_count: apiMatchRows.length,
          owner_slug: owner.ownerSlug,
        });
        return null;
      }
      // 0 dealers matched — fall through to heuristic. The slug we
      // got from the API might be a personal account that's not in
      // our dealers table.
    }
  }

  // 3. v0.4 slug-substring heuristic. Exact for one-dealer-per-
  //    Calendly-account; ambiguous when two dealers happen to share
  //    a slug substring.
  const dealersRes = await sb
    .from("dealers")
    .select("*")
    .not("calendly_url", "is", null);
  if (dealersRes.error || !dealersRes.data) return null;
  const dealers = dealersRes.data as DealerRow[];

  let best: DealerRow | null = null;
  let bestLen = 0;
  for (const d of dealers) {
    if (!d.calendly_url) continue;
    const slug = extractCalendlySlug(d.calendly_url);
    if (!slug) continue;
    if (eventTypeUri.includes(slug) && slug.length > bestLen) {
      best = d;
      bestLen = slug.length;
    }
  }
  return best;
}

function extractCalendlySlug(url: string): string | null {
  // Pull the path's first segment off the dealer's Calendly URL —
  // that's the user_slug. Tolerate trailing slashes + query strings.
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+/, "");
    const first = path.split("/")[0]?.trim();
    if (!first) return null;
    return first;
  } catch {
    return null;
  }
}

interface MatchedConversation extends ConversationRow {
  matched_via: "utm_content" | "phone" | "email";
}

interface MatchInput {
  sb: ReturnType<typeof createServiceSupabase>;
  dealer: DealerRow;
  payload: CalendlyInviteeCreatedPayload;
  requestId: string;
}

async function matchConversation(input: MatchInput): Promise<MatchedConversation | null> {
  const { sb, dealer, payload, requestId } = input;

  // A. utm_content. Deterministic — written by chat-pipeline.ts when
  //    the AI offered Calendly. Validate as UUID + confirm dealer
  //    ownership before trusting it.
  const utm = payload.payload.tracking?.utm_content?.trim() ?? "";
  if (utm && UUID_RE.test(utm)) {
    const res = await sb
      .from("conversations")
      .select("*")
      .eq("id", utm)
      .eq("dealer_id", dealer.id)
      .maybeSingle();
    const row = res.data as ConversationRow | null;
    if (row) {
      return { ...row, matched_via: "utm_content" };
    }
  }

  // B. text_reminder_number → conversations.buyer_phone match. Channel
  //    filter to sms/voice keeps a coincidental web-widget row from
  //    matching on phone (web rows don't have buyer_phone today, but
  //    belt-and-braces).
  const phone = payload.payload.invitee.text_reminder_number?.trim() ?? "";
  if (phone) {
    const res = await sb
      .from("conversations")
      .select("*")
      .eq("dealer_id", dealer.id)
      .eq("buyer_phone", phone)
      .in("channel", ["sms", "voice"])
      .order("updated_at", { ascending: false })
      .limit(1);
    const rows = (res.data ?? []) as ConversationRow[];
    if (rows.length === 1) {
      return { ...rows[0], matched_via: "phone" };
    }
  }

  // C. email regex over recent buyer messages. Capped at 200 rows
  //    over 7 days to bound cost. Multiple matches → ambiguous; abort.
  const email = payload.payload.invitee.email?.trim().toLowerCase() ?? "";
  if (email && EMAIL_RE.test(email)) {
    const sinceIso = new Date(
      Date.now() - RECENT_MESSAGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // We need messages whose conversation belongs to this dealer.
    // Doing a server-side join would be tidier, but PostgREST's
    // foreign-table filter requires a relation. Two-step is cheap.
    const convRes = await sb
      .from("conversations")
      .select("id,language")
      .eq("dealer_id", dealer.id)
      .gt("updated_at", sinceIso);
    if (convRes.error || !convRes.data) return null;
    const convIds = (convRes.data as { id: string; language: string }[]).map(
      (c) => c.id,
    );
    if (convIds.length === 0) return null;

    const msgRes = await sb
      .from("messages")
      .select("conversation_id,body,created_at")
      .in("conversation_id", convIds)
      .eq("role", "buyer")
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGE_LIMIT);

    if (msgRes.error || !msgRes.data) return null;
    const matches = new Set<string>();
    for (const m of msgRes.data as {
      conversation_id: string;
      body: string;
    }[]) {
      if (m.body.toLowerCase().includes(email)) {
        matches.add(m.conversation_id);
      }
    }
    if (matches.size > 1) {
      log.warn("calendly.email_ambiguous", {
        requestId,
        dealer_id: dealer.id,
        match_count: matches.size,
      });
      return null;
    }
    if (matches.size === 1) {
      const matchedId = [...matches][0];
      const res = await sb
        .from("conversations")
        .select("*")
        .eq("id", matchedId)
        .eq("dealer_id", dealer.id)
        .maybeSingle();
      const row = res.data as ConversationRow | null;
      if (row) return { ...row, matched_via: "email" };
    }
  }

  return null;
}

function formatBookingDate(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString();
  }
}
