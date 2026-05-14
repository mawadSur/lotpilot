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
import {
  marketplaceMasterPrevConfigured,
  readMarketplaceMasterPrev,
  requireMarketplaceMasterSecret,
} from "../env";

const HEX_SIG_RE = /^[A-Fa-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// v0.7: versioned per-dealer secret derivation.
//   v1 = legacy: HMAC(master, dealer_id)             [unchanged from v0.6]
//   v2+ = HMAC(master, `${dealer_id}|lotpilot.marketplace.v<N>`)
//
// We keep v1 as the legacy formula on purpose so that the v0.6 install
// base does NOT need to re-key at the moment we ship v0.7. New dealers
// onboarded on v0.7+ default to v1 too; the version is only bumped per
// dealer when the operator chooses to rotate.
//
// Master-secret rotation is independent: the deploy can hold both
// MARKETPLACE_MASTER_SECRET and MARKETPLACE_MASTER_SECRET_PREV during
// a roll; the inbound verifier tries current, then PREV (only for v >= 2),
// then writes a system_warnings row so the dealer can re-issue at their
// convenience.
function deriveBytes(
  dealerId: string,
  version: number,
  master: string,
): string {
  if (!UUID_RE.test(dealerId)) {
    throw new Error("deriveDealerSecret: dealerId must be a UUID");
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("deriveDealerSecret: version must be an integer >= 1");
  }
  if (version === 1) {
    // LEGACY — do not change this branch. v0.6 install base depends
    // on the exact bytes this produces.
    return createHmac("sha256", master).update(dealerId, "utf8").digest("hex");
  }
  return createHmac("sha256", master)
    .update(`${dealerId}|lotpilot.marketplace.v${version}`, "utf8")
    .digest("hex");
}

// Derive the per-dealer secret against the CURRENT master. The route
// handlers call this on the happy path. Throws if the master is unset
// — pair with `marketplaceExtensionConfigured` upstream.
export function deriveDealerSecret(dealerId: string, version = 1): string {
  return deriveBytes(dealerId, version, requireMarketplaceMasterSecret());
}

// Derive against an arbitrary master — used for the PREV-master grace
// path during rotation. Never throws on missing master; caller passes
// the bytes explicitly.
export function deriveDealerSecretWithMaster(
  dealerId: string,
  version: number,
  master: string,
): string {
  return deriveBytes(dealerId, version, master);
}

export interface VerifyExtensionResult {
  ok: boolean;
  // True when verification succeeded against the PREV master, signalling
  // the route to write a `marketplace_secret_rotated` warning so the
  // dealer rolls their extension binary.
  usedPrev: boolean;
}

// Verify the extension's HMAC signature over the raw request body.
// MUST be called as the very first thing in /api/marketplace/inbound —
// before parsing the JSON body, before any DB lookup. JSON.parse on
// an unauthenticated POST is a DoS surface.
//
// v0.7 contract: returns { ok, usedPrev }. On a current-master miss
// we retry with MARKETPLACE_MASTER_SECRET_PREV when configured AND
// version >= 2 (v1 always shipped with the only master we'd ever
// rolled, so the prev path doesn't help). v1 with prev-master is
// rejected — the operator should bump the dealer to v2+ before rolling.
export function verifyExtensionSignature(args: {
  rawBody: string;
  signature: string | null;
  dealerId: string | null;
  // Defaults to 1 when the extension doesn't send the header; preserves
  // wire compat with v0.6 installs.
  version?: number;
}): VerifyExtensionResult {
  if (!args.signature) return { ok: false, usedPrev: false };
  if (!HEX_SIG_RE.test(args.signature)) return { ok: false, usedPrev: false };
  if (!args.dealerId || !UUID_RE.test(args.dealerId)) {
    return { ok: false, usedPrev: false };
  }
  const version = args.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, usedPrev: false };
  }

  // Try CURRENT master.
  let currentSecret: string;
  try {
    currentSecret = deriveDealerSecret(args.dealerId, version);
  } catch {
    return { ok: false, usedPrev: false };
  }
  if (verifyAgainstSecret(args.rawBody, args.signature, currentSecret)) {
    return { ok: true, usedPrev: false };
  }

  // Try PREV master — only for v >= 2 installs, only when configured.
  if (marketplaceMasterPrevConfigured && version >= 2) {
    const prev = readMarketplaceMasterPrev();
    if (prev) {
      let prevSecret: string;
      try {
        prevSecret = deriveDealerSecretWithMaster(args.dealerId, version, prev);
      } catch {
        return { ok: false, usedPrev: false };
      }
      if (verifyAgainstSecret(args.rawBody, args.signature, prevSecret)) {
        return { ok: true, usedPrev: true };
      }
    }
  }
  return { ok: false, usedPrev: false };
}

function verifyAgainstSecret(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
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
