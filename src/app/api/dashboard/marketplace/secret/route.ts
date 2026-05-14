// Per-dealer marketplace extension secret disclosure.
//
// The Chrome extension needs its dealer-scoped HMAC secret at install
// time. This endpoint returns
//   { dealer_id, secret: deriveDealerSecret(dealer.id) }
// to the authenticated dealer (and only that dealer). Use cases:
//   1. Founder hands the dealer the extension binary, then walks them
//      through Settings → Marketplace, where the UI calls this route to
//      reveal the secret + dealer_id (copy-to-clipboard).
//   2. Re-issuing the secret after a suspected leak (rotation is via
//      master-secret roll; this endpoint just discloses the current
//      derived value).
//
// Posture:
//   - requireDealer() — Supabase session.
//   - Per-dealer rate limit (120/min ceiling shared with the inbox).
//   - Audit log via system_warnings (kind='marketplace_secret_disclosed')
//     so the dealer can see in the warnings banner that the secret was
//     read and roll the master if they didn't initiate the read.
//   - 503 when the master secret is unset (a deploy without the env
//     can't disclose anything coherent).

import { NextResponse } from "next/server";
import { requireDealer } from "@/lib/auth";
import { deriveDealerSecret } from "@/lib/marketplace/extension";
import { createServiceSupabase } from "@/lib/supabase-service";
import { checkRate } from "@/lib/ratelimit";
import { marketplaceExtensionConfigured } from "@/lib/env";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = crypto.randomUUID();

  if (!marketplaceExtensionConfigured) {
    log.warn("marketplace.secret_disclose.misconfigured", { requestId });
    return new NextResponse("", { status: 503 });
  }

  const { dealer } = await requireDealer();

  const rate = await checkRate("dealer", `marketplace-secret:${dealer.id}`);
  if (!rate.ok) {
    log.warn("marketplace.secret_disclose.rate_limited", {
      requestId,
      dealer_id: dealer.id,
    });
    return new NextResponse("", {
      status: 429,
      headers: { "retry-after": String(rate.resetSec) },
    });
  }

  let secret: string;
  try {
    secret = deriveDealerSecret(dealer.id);
  } catch (err) {
    log.error("marketplace.secret_disclose.derive_failed", {
      requestId,
      dealer_id: dealer.id,
      detail: (err as Error).message,
    });
    return new NextResponse("", { status: 500 });
  }

  // Audit: drop a warning row so the dealer can see in their banner
  // that the secret was just read. Best-effort — a failed insert
  // doesn't block disclosure (the founder demoing the extension
  // shouldn't be blocked by a transient Supabase issue), but we DO
  // log loudly so a backfill is possible.
  const sb = createServiceSupabase();
  const insertRes = await sb.from("system_warnings").insert({
    dealer_id: dealer.id,
    kind: "marketplace_secret_disclosed",
    payload: { request_id: requestId },
  });
  if (insertRes.error) {
    log.warn("marketplace.secret_disclose.audit_failed", {
      requestId,
      dealer_id: dealer.id,
      code: insertRes.error.code,
    });
  }

  log.info("marketplace.secret_disclosed", {
    requestId,
    dealer_id: dealer.id,
  });

  return NextResponse.json({
    dealer_id: dealer.id,
    secret,
  });
}
