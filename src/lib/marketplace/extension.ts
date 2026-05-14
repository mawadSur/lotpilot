// Marketplace browser-extension HMAC verification.
//
// ARCHITECTURE DECISION RECORD (v0.5 → v0.6)
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
//      operating their account), HMAC-signs the payload with its
//      dealer-scoped secret, and POSTs to /api/marketplace/inbound.
//
// v0.6 R2: Per-dealer secret derivation, fixing v0.5's "leaked
// extension binary spoofs every dealer" issue. The master secret
// (MARKETPLACE_MASTER_SECRET, renamed from MARKETPLACE_EXTENSION_SECRET)
// stays on the server; the dealer-scoped secret is
//   HMAC-SHA256(master, dealer_id) -> hex
// and is handed to the dealer at install time via the new
// /api/dashboard/marketplace/secret endpoint (audited, rate-limited).
// A leaked install only spoofs ITS OWN dealer; rotating the master
// invalidates every install at once (catastrophic recovery lever).
//
// Wire format change: the extension now sends the dealer_id in the
// `x-lotpilot-dealer-id` header so the server knows which secret to
// HMAC against BEFORE it parses the body. The body STILL carries the
// same dealer_id field, and we require header == body for tamper
// resistance — a forged header+body would have to forge the HMAC
// against the right derived secret anyway.
// -----------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireMarketplaceMasterSecret } from "../env";

const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-dealer secret derivation. HMAC-SHA256(master, dealer_id) -> hex.
// Stable: same dealerId always derives the same secret, so the
// extension can be installed once and keep working across pod
// restarts. Reversible only via the master secret, which never leaves
// the server. Returned as 64-char hex to match the rest of our
// signature plumbing.
export function deriveDealerSecret(dealerId: string): string {
  if (!UUID_RE.test(dealerId)) {
    throw new Error("deriveDealerSecret: dealerId must be a UUID");
  }
  return createHmac("sha256", requireMarketplaceMasterSecret())
    .update(dealerId, "utf8")
    .digest("hex");
}

// Verify the extension's HMAC signature over the raw request body.
// MUST be called as the very first thing in /api/marketplace/inbound —
// before parsing the JSON body, before any DB lookup. JSON.parse on
// an unauthenticated POST is a DoS surface.
//
// Returns true iff hex(HMAC-SHA256(deriveDealerSecret(dealerId), raw))
// equals the signature header (timing-safe compare). Wrong dealerId,
// wrong master, or unsigned request → false.
export function verifyExtensionSignature(args: {
  rawBody: string;
  signature: string | null;
  dealerId: string | null;
}): boolean {
  if (!args.signature) return false;
  if (!HEX_SIG_RE.test(args.signature)) return false;
  if (!args.dealerId || !UUID_RE.test(args.dealerId)) return false;

  let dealerSecret: string;
  try {
    dealerSecret = deriveDealerSecret(args.dealerId);
  } catch {
    return false;
  }
  const expected = createHmac("sha256", dealerSecret).update(args.rawBody, "utf8").digest("hex");
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
