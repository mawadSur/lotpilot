// LotPilot v0.8 — POST /api/stripe/webhook
//
// The single chokepoint where Stripe-side subscription state is mirrored
// into our dealers table. Stripe will keep retrying 5xx until we 200,
// so the handler:
//   1. Verifies the stripe-signature header against STRIPE_WEBHOOK_SECRET
//      using stripe.webhooks.constructEvent (this is the SDK's
//      constant-time check on the RAW body bytes; we must NOT have JSON-
//      parsed first, hence request.text() reads the raw payload).
//   2. Dispatches on event type. Anything we don't handle is logged
//      and 200'd — we never want Stripe to retry a "noop" event.
//   3. Writes via the SERVICE ROLE. There is no authenticated UPDATE
//      policy on the stripe_* columns; this is the sole writer.
//   4. Is IDEMPOTENT. Replaying the same event a second time is a no-op
//      by construction — we key writes by stripe_subscription_id and
//      the new payload always re-derives the same state from the same
//      Stripe object.
//
// Returns:
//   400 — signature invalid (the only path we deliberately 4xx, so
//         Stripe surfaces the failure in their dashboard)
//   503 — STRIPE_WEBHOOK_SECRET missing (we silently 503 so a
//         half-configured deploy doesn't accept unsigned payloads)
//   200 — every other path, including unknown event types

import { NextResponse, type NextRequest } from "next/server";
import {
  constructWebhookEvent,
  mapStatusToInternal,
  priceIdToTier,
  type Stripe,
} from "@/lib/stripe";
import { stripeConfigured } from "@/lib/env";
import { createServiceSupabase } from "@/lib/supabase-service";
import { log } from "@/lib/log";
import type { SubscriptionStatus, SubscriptionTier } from "@/lib/db-types";

export const dynamic = "force-dynamic";
// Critical: Stripe signature verification needs the raw byte stream.
// We must not let Next.js / Vercel pre-parse the body.
export const runtime = "nodejs";

type Sb = ReturnType<typeof createServiceSupabase>;

function ok(): NextResponse {
  return NextResponse.json({ received: true }, { status: 200 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = crypto.randomUUID();

  if (!stripeConfigured) {
    log.warn("stripe.webhook.disabled", { requestId });
    return NextResponse.json(
      { error: "stripe_not_configured" },
      { status: 503 },
    );
  }

  // 1. Raw body + signature header. The Stripe SDK insists on these
  //    exact bytes — JSON.parse first and the signature check fails.
  const signatureHeader = request.headers.get("stripe-signature") ?? "";
  if (!signatureHeader) {
    log.warn("stripe.webhook.no_signature", { requestId });
    return NextResponse.json({ error: "missing_signature" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signatureHeader);
  } catch (err) {
    // Stripe signs as a JWT-like construct; a bad sig is the only
    // case we deliberately 4xx — it surfaces in the Stripe dashboard
    // as a delivery failure so the operator notices.
    log.warn("stripe.webhook.invalid_signature", {
      requestId,
      detail: (err as Error).message,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  log.info("stripe.webhook.received", {
    requestId,
    event_id: event.id,
    event_type: event.type,
  });

  const sb = createServiceSupabase();

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(sb, event, requestId);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(sb, event, requestId);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(sb, event, requestId);
        break;
      case "invoice.payment_succeeded":
        // No-op: customer.subscription.updated fires for renewals with
        // the new current_period_end. Logging once so operators can see
        // we're receiving them.
        log.info("stripe.webhook.invoice_payment_succeeded_noop", {
          requestId,
          event_id: event.id,
        });
        break;
      default:
        // Unknown event type: log + 200. Returning anything else makes
        // Stripe retry forever for events we have no contract for.
        log.info("stripe.webhook.unhandled", {
          requestId,
          event_id: event.id,
          event_type: event.type,
        });
        break;
    }
  } catch (err) {
    // The webhook handler should never propagate a 5xx — Stripe would
    // retry, and a partial write that already succeeded would be
    // duplicated on the retry. Log loudly and 200 instead; the next
    // subscription.updated event will reconcile any drift.
    log.error("stripe.webhook.handler_failed", {
      requestId,
      event_id: event.id,
      event_type: event.type,
      detail: (err as Error).message,
    });
  }

  return ok();
}

// ----------------------------------------------------------------------
// Handlers

async function handleSubscriptionUpsert(
  sb: Sb,
  event: Stripe.Event,
  requestId: string,
): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const dealerId = readDealerIdFromSubscription(subscription);
  if (!dealerId) {
    log.warn("stripe.webhook.no_dealer_id", {
      requestId,
      event_id: event.id,
      subscription_id: subscription.id,
    });
    return;
  }

  const status: SubscriptionStatus = mapStatusToInternal(subscription.status);
  const tier: SubscriptionTier | null = resolveTier(subscription);

  // current_period_end is on the subscription object (seconds since
  // epoch). null'd if Stripe ever omits it — defensive cast.
  const periodEndSec = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  const periodEndIso =
    typeof periodEndSec === "number"
      ? new Date(periodEndSec * 1000).toISOString()
      : null;

  // Idempotent: the same event delivered twice writes the same row.
  // We key on dealer id (from metadata) rather than subscription id
  // so a customer.subscription.created arriving before the dealer row
  // has stripe_subscription_id populated still attaches correctly.
  const patch: Record<string, unknown> = {
    stripe_subscription_id: subscription.id,
    subscription_status: status,
    subscription_current_period_end: periodEndIso,
  };
  if (tier) patch.subscription_tier = tier;

  // Also stamp the customer id, in case the checkout-time persist
  // failed (we'd then have a dealer with subscription but no customer
  // id). subscription.customer is `Stripe.Customer | string`; we coerce.
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? null;
  if (customerId) patch.stripe_customer_id = customerId;

  const upd = await sb.from("dealers").update(patch).eq("id", dealerId);
  if (upd.error) {
    log.error("stripe.webhook.subscription_upsert_failed", {
      requestId,
      event_id: event.id,
      dealer_id: dealerId,
      code: upd.error.code,
    });
    throw new Error(`subscription_upsert_failed: ${upd.error.message}`);
  }

  log.info("stripe.webhook.subscription_upserted", {
    requestId,
    event_id: event.id,
    dealer_id: dealerId,
    tier,
    status,
  });
}

async function handleSubscriptionDeleted(
  sb: Sb,
  event: Stripe.Event,
  requestId: string,
): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const dealerId = readDealerIdFromSubscription(subscription);
  if (!dealerId) {
    log.warn("stripe.webhook.no_dealer_id", {
      requestId,
      event_id: event.id,
      subscription_id: subscription.id,
    });
    return;
  }

  const upd = await sb
    .from("dealers")
    .update({ subscription_status: "canceled" satisfies SubscriptionStatus })
    .eq("id", dealerId);
  if (upd.error) {
    log.error("stripe.webhook.subscription_delete_failed", {
      requestId,
      event_id: event.id,
      dealer_id: dealerId,
      code: upd.error.code,
    });
    throw new Error(`subscription_delete_failed: ${upd.error.message}`);
  }
  log.info("stripe.webhook.subscription_canceled", {
    requestId,
    event_id: event.id,
    dealer_id: dealerId,
  });
}

async function handleInvoicePaymentFailed(
  sb: Sb,
  event: Stripe.Event,
  requestId: string,
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  // Resolve the dealer via subscription.id → dealers.stripe_subscription_id.
  // No metadata on the invoice itself, so we look up by subscription id
  // (which is on both the invoice and our dealer row).
  const subscriptionId =
    typeof (invoice as unknown as { subscription?: string | Stripe.Subscription })
      .subscription === "string"
      ? ((invoice as unknown as { subscription: string }).subscription)
      : null;
  if (!subscriptionId) {
    log.warn("stripe.webhook.invoice_no_subscription", {
      requestId,
      event_id: event.id,
    });
    return;
  }

  const upd = await sb
    .from("dealers")
    .update({ subscription_status: "past_due" satisfies SubscriptionStatus })
    .eq("stripe_subscription_id", subscriptionId);
  if (upd.error) {
    log.error("stripe.webhook.invoice_payment_failed_update_failed", {
      requestId,
      event_id: event.id,
      subscription_id: subscriptionId,
      code: upd.error.code,
    });
    throw new Error(`payment_failed_update_failed: ${upd.error.message}`);
  }
  log.info("stripe.webhook.past_due", {
    requestId,
    event_id: event.id,
    subscription_id: subscriptionId,
  });
}

// ----------------------------------------------------------------------
// Helpers

function readDealerIdFromSubscription(
  subscription: Stripe.Subscription,
): string | null {
  const metadata = subscription.metadata ?? {};
  const dealerId = metadata.dealer_id;
  if (typeof dealerId === "string" && dealerId.length > 0) return dealerId;
  return null;
}

function resolveTier(subscription: Stripe.Subscription): SubscriptionTier | null {
  // First preference: a 'tier' metadata field set at checkout time.
  // Falls back to price-id lookup so a Stripe-side update that drops
  // metadata still resolves correctly.
  const metaTier = subscription.metadata?.tier;
  if (
    metaTier === "starter" ||
    metaTier === "pro" ||
    metaTier === "network"
  ) {
    return metaTier;
  }

  const firstItem = subscription.items?.data?.[0];
  const priceId = firstItem?.price?.id;
  if (priceId) return priceIdToTier(priceId);
  return null;
}
