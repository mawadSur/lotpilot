// LotPilot v0.8 — POST /api/stripe/portal
//
// Returns a Stripe billing-portal session URL for an authenticated
// dealer. The portal is Stripe's hosted UI where the dealer manages
// their card, tier, invoices, and cancellation — we own nothing there.
//
// Auth: requireDealer().
// 404 when no stripe_customer_id is on file (the dealer never ran a
// checkout). The frontend should hide the "Manage billing" link in
// that case; the 404 is the defence in depth.

import { NextResponse, type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import {
  StripeNotConfiguredError,
  getStripeClient,
} from "@/lib/stripe";
import { stripeConfigured } from "@/lib/env";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

function siteOrigin(request: NextRequest): string {
  const fromHeader = request.headers.get("origin");
  if (fromHeader) return fromHeader;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();

  if (!stripeConfigured) {
    log.warn("stripe.portal.disabled", { requestId });
    return NextResponse.json(
      { error: "stripe_not_configured" },
      { status: 503 },
    );
  }

  const { dealer } = await requireDealer();

  if (!dealer.stripe_customer_id) {
    log.info("stripe.portal.no_customer", {
      requestId,
      dealer_id: dealer.id,
    });
    return NextResponse.json({ error: "no_customer" }, { status: 404 });
  }

  let stripe: ReturnType<typeof getStripeClient>;
  try {
    stripe = getStripeClient();
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return NextResponse.json(
        { error: "stripe_not_configured" },
        { status: 503 },
      );
    }
    throw err;
  }

  const origin = siteOrigin(request);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: dealer.stripe_customer_id,
      return_url: `${origin}/dashboard`,
    });
    log.info("stripe.portal.ok", {
      requestId,
      dealer_id: dealer.id,
      session_id: session.id,
    });
    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    log.error("stripe.portal.session_create_failed", {
      requestId,
      dealer_id: dealer.id,
      detail: (err as Error).message,
    });
    return NextResponse.json(
      { error: "stripe_portal_create_failed" },
      { status: 502 },
    );
  }
}
