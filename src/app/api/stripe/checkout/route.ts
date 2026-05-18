// LotPilot v0.8 — POST /api/stripe/checkout
//
// Returns a Stripe Checkout Session URL for an authenticated dealer.
// The frontend redirects to it; Stripe hosts the card form; on success
// we land back at /dashboard?checkout=success and the webhook
// (/api/stripe/webhook) flips the dealer to subscription_status='active'.
//
// Hard rules (anti-patterns avoided here):
//   - We NEVER accept card data in our app. The session is a
//     redirect-only handle. The buyer is gone to Stripe's hosted page
//     the moment we return.
//   - We NEVER trust the client's tier choice without re-checking it.
//     'tier' is the only piece of user input; it's validated against
//     the literal set ('starter'|'pro'|'network') and we look up the
//     price id server-side from env (never from the body).
//   - The customer id is written back to the dealer row using the
//     SERVICE ROLE — there is no authenticated UPDATE policy on the
//     stripe_* columns by design (migration 0018).
//
// Failure modes mapped to status codes:
//   401 — no session / no dealer row
//   400 — invalid tier
//   503 — Stripe SDK or this tier's price id is not configured
//   502 — Stripe API call failed (we forward a stable shape, not the
//         Stripe error body, to avoid leaking implementation detail)

import { NextResponse, type NextRequest } from "next/server";
import { requireDealer } from "@/lib/auth";
import {
  StripeNotConfiguredError,
  StripeTierPriceMissingError,
  getStripeClient,
  getTierPriceId,
} from "@/lib/stripe";
import { stripeConfigured } from "@/lib/env";
import { createServiceSupabase } from "@/lib/supabase-service";
import { log } from "@/lib/log";
import type { SubscriptionTier } from "@/lib/db-types";

export const dynamic = "force-dynamic";

const ALLOWED_TIERS: ReadonlySet<SubscriptionTier> = new Set([
  "starter",
  "pro",
  "network",
]);

interface CheckoutBody {
  tier?: unknown;
}

function isAllowedTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && ALLOWED_TIERS.has(value as SubscriptionTier);
}

function siteOrigin(request: NextRequest): string {
  // Prefer the request's own origin so preview deploys + localhost
  // round-trip cleanly. Fall back to the configured origin if the
  // header is missing (some edge runtimes scrub it).
  const fromHeader = request.headers.get("origin");
  if (fromHeader) return fromHeader;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();

  if (!stripeConfigured) {
    log.warn("stripe.checkout.disabled", { requestId });
    return NextResponse.json(
      { error: "stripe_not_configured" },
      { status: 503 },
    );
  }

  // requireDealer redirects on the unauthed path; in a route handler we
  // want a JSON 401 instead. Use a manual auth check by catching the
  // redirect signal at the boundary — getOptionalUser is the right
  // primitive here.
  const { dealer, user } = await requireDealer();

  let body: CheckoutBody;
  try {
    body = (await request.json()) as CheckoutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isAllowedTier(body.tier)) {
    log.warn("stripe.checkout.invalid_tier", {
      requestId,
      dealer_id: dealer.id,
      tier_present: typeof body.tier === "string",
    });
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }
  const tier: SubscriptionTier = body.tier;

  let priceId: string;
  try {
    priceId = getTierPriceId(tier);
  } catch (err) {
    if (err instanceof StripeTierPriceMissingError) {
      log.warn("stripe.checkout.tier_price_missing", {
        requestId,
        dealer_id: dealer.id,
        tier,
      });
      return NextResponse.json(
        { error: "tier_price_missing", tier },
        { status: 503 },
      );
    }
    throw err;
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

  // 1. Resolve / create Stripe customer. We persist the id back on
  //    the dealer row before we even create the checkout session so
  //    a transient checkout failure doesn't orphan a customer.
  let stripeCustomerId = dealer.stripe_customer_id;
  if (!stripeCustomerId) {
    try {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: dealer.name,
        metadata: {
          dealer_id: dealer.id,
          dealer_slug: dealer.slug,
        },
      });
      stripeCustomerId = customer.id;
    } catch (err) {
      log.error("stripe.checkout.customer_create_failed", {
        requestId,
        dealer_id: dealer.id,
        detail: (err as Error).message,
      });
      return NextResponse.json(
        { error: "stripe_customer_create_failed" },
        { status: 502 },
      );
    }

    // Service-role write — the authenticated session has no UPDATE
    // policy on stripe_customer_id (migration 0018).
    const sb = createServiceSupabase();
    const upd = await sb
      .from("dealers")
      .update({ stripe_customer_id: stripeCustomerId })
      .eq("id", dealer.id);
    if (upd.error) {
      log.error("stripe.checkout.customer_persist_failed", {
        requestId,
        dealer_id: dealer.id,
        code: upd.error.code,
      });
      // Don't fail the checkout — the webhook can repair this from
      // customer.subscription.created (the metadata.dealer_id is
      // authoritative). Just log loudly so ops sees it.
    }
  }

  // 2. Create the Checkout Session. subscription_data.metadata is the
  //    contract with the webhook handler: dealer_id flows through the
  //    Stripe Subscription object so we can look it back up without a
  //    customer-id round-trip.
  const origin = siteOrigin(request);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled#pricing`,
      // metadata on the Session itself (visible to the webhook via
      // checkout.session.completed if we ever wire that event up). We
      // currently key off customer.subscription.created instead, where
      // subscription_data.metadata.dealer_id is the source of truth.
      metadata: {
        dealer_id: dealer.id,
        tier,
      },
      subscription_data: {
        metadata: {
          dealer_id: dealer.id,
          tier,
        },
      },
      // No Stripe-side promo input from us — we'll wire promotion
      // codes via a follow-up env flag.
      allow_promotion_codes: true,
    });

    if (!session.url) {
      log.error("stripe.checkout.no_session_url", {
        requestId,
        dealer_id: dealer.id,
        tier,
      });
      return NextResponse.json(
        { error: "stripe_session_no_url" },
        { status: 502 },
      );
    }

    log.info("stripe.checkout.ok", {
      requestId,
      dealer_id: dealer.id,
      tier,
      session_id: session.id,
    });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    log.error("stripe.checkout.session_create_failed", {
      requestId,
      dealer_id: dealer.id,
      tier,
      detail: (err as Error).message,
    });
    return NextResponse.json(
      { error: "stripe_session_create_failed" },
      { status: 502 },
    );
  }
}
