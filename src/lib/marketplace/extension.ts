// Marketplace browser-extension HMAC verification.
//
// ARCHITECTURE DECISION RECORD (v0.5)
// -----------------------------------------------------------------
// LotPilot needs to ingest Facebook Marketplace buyer messages. Three
// architectures were on the table:
//
//   A. Reverse-engineered Marketplace HTTP/GraphQL API. Blocked: Meta
//      explicitly forbids this in their TOS, and the surface is
//      actively-detected. We'd lose access (and accounts) within days.
//
//   B. Email-bridge (Marketplace -> seller email -> our SMTP catcher).
//      Latency is poor (Meta batches), and the email contents are
//      thin (no thread id, no listing id) — we'd lose the
//      conversation-router primary key.
//
//   C. Browser extension (chosen). The dealer installs a Chrome
//      extension scoped to facebook.com/marketplace/inbox/*. The
//      extension scrapes its OWN inbox (TOS-safe — the dealer is
//      operating their account), HMAC-signs the payload, and POSTs
//      to /api/marketplace/inbound. Per-dealer rotating secrets are
//      v0.6 (see R2 below); v0.5 uses a single global shared secret
//      for the bootstrap.
//
// R2 (architect): Per-dealer secret derivation is deferred to v0.6.
// The shared MARKETPLACE_EXTENSION_SECRET means every install carries
// the same key — a leaked extension binary could spoof any dealer.
// This is acceptable for the v0.5 closed pilot (5-10 dealers, founder
// hands them the extension) and v0.6 derives per-dealer keys via
// HKDF(MARKETPLACE_EXTENSION_SECRET, dealer_id) so a leaked install
// only spoofs that one dealer.
// -----------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireMarketplaceExtensionSecret } from "../env";

const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;

// Verify the extension's HMAC signature over the raw request body.
// MUST be called as the very first thing in /api/marketplace/inbound —
// before parsing the JSON body, before any DB lookup. JSON.parse on
// an unauthenticated POST is a DoS surface.
//
// Returns true iff hex(HMAC-SHA256(MARKETPLACE_EXTENSION_SECRET, raw))
// equals the signature header (timing-safe compare).
export function verifyExtensionSignature(args: {
  rawBody: string;
  signature: string | null;
}): boolean {
  if (!args.signature) return false;
  if (!HEX_SIG_RE.test(args.signature)) return false;
  let secret: string;
  try {
    secret = requireMarketplaceExtensionSecret();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(args.rawBody, "utf8").digest("hex");
  if (expected.length !== args.signature.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(args.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export interface MarketplaceInboundPayload {
  dealer_id: string;
  marketplace_thread_id: string;
  buyer_name: string;
  buyer_message: string;
  // Optional listing reference (if the buyer messaged about a specific
  // listing). v0.5 ignores this in pipeline routing; v0.6 will pin it
  // to a vehicles row when it matches.
  listing_id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse + validate the JSON body. Returns null on any shape failure;
// the route handler should 400 on null.
export function parseMarketplacePayload(raw: string): MarketplaceInboundPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const dealerId = typeof o.dealer_id === "string" ? o.dealer_id : "";
  const threadId = typeof o.marketplace_thread_id === "string" ? o.marketplace_thread_id : "";
  const buyerName = typeof o.buyer_name === "string" ? o.buyer_name : "";
  const buyerMessage = typeof o.buyer_message === "string" ? o.buyer_message : "";
  const listingId =
    typeof o.listing_id === "string" && o.listing_id.length > 0 ? o.listing_id : undefined;

  if (!UUID_RE.test(dealerId)) return null;
  if (!threadId || threadId.length > 200) return null;
  if (!buyerName || buyerName.length > 200) return null;
  if (!buyerMessage.trim() || buyerMessage.length > 4000) return null;
  if (listingId && listingId.length > 200) return null;

  return {
    dealer_id: dealerId,
    marketplace_thread_id: threadId,
    buyer_name: buyerName,
    buyer_message: buyerMessage,
    listing_id: listingId,
  };
}
