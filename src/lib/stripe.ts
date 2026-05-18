// LotPilot v0.8 — thin Stripe client wrapper.
//
// Three responsibilities, deliberately small:
//   1. Lazy-init a singleton Stripe SDK client. Lazy because a deploy
//      that ships without STRIPE_SECRET_KEY should still boot — the
//      checkout/portal/webhook routes 503 themselves, but importing
//      this module from a server component or test harness must not
//      throw at import-time.
//   2. Map a tier name ('starter' | 'pro' | 'network') to its Stripe
//      price id from env. Throws when the caller asks for a tier we
//      can't price — the caller turns that into a 503 with a tier-
//      specific reason.
//   3. Map a Stripe subscription status string to our internal enum.
//      This is the single chokepoint so a Stripe API rename (e.g.
//      'paused' → 'pause') only touches this file.
//
// We intentionally do NOT export the raw Stripe client; everything
// goes through helpers that return narrow types. Webhook verification
// is the only place that needs the underlying webhooks namespace —
// constructEvent is re-exported for that.

import Stripe from "stripe";
import {
  readStripePriceId,
  requireStripeSecretKey,
  requireStripeWebhookSecret,
} from "./env";
import type { SubscriptionStatus, SubscriptionTier } from "./db-types";

export class StripeNotConfiguredError extends Error {
  constructor(message = "Stripe is not configured.") {
    super(message);
    this.name = "StripeNotConfiguredError";
  }
}

export class StripeTierPriceMissingError extends Error {
  constructor(public readonly tier: SubscriptionTier) {
    super(`No Stripe price id configured for tier '${tier}'.`);
    this.name = "StripeTierPriceMissingError";
  }
}

// Singleton — Stripe's docs explicitly recommend reusing a single
// client across requests so HTTP keep-alive works.
let cached: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (cached) return cached;
  let key: string;
  try {
    key = requireStripeSecretKey();
  } catch {
    throw new StripeNotConfiguredError();
  }
  // apiVersion: omit so the SDK pins itself to the version baked into
  // the installed Stripe package (currently 2026-04-22.dahlia per
  // node_modules/stripe/esm/apiVersion.js). Pinning here would require
  // a code change every time we bump the SDK; this way the SDK and the
  // wire version move together.
  cached = new Stripe(key, {
    typescript: true,
    // Tag every request with our app for Stripe support ticket triage.
    appInfo: {
      name: "LotPilot",
      version: "0.8.0",
    },
  });
  return cached;
}

// Test-seam: lets unit tests inject a stub so we never make a real
// Stripe HTTP call. Production code path never imports this.
export function __setStripeClientForTests(stub: Stripe | null): void {
  cached = stub;
}

export function getTierPriceId(tier: SubscriptionTier): string {
  const priceId = readStripePriceId(tier);
  if (!priceId) {
    throw new StripeTierPriceMissingError(tier);
  }
  return priceId;
}

// Inverse: given a Stripe price id (from a webhook payload's
// subscription.items.data[0].price.id), figure out which tier it is.
// Returns null when the price id doesn't match any tier env var. We
// log the unknown case in the webhook and skip the tier write rather
// than guess.
export function priceIdToTier(priceId: string): SubscriptionTier | null {
  const candidates: SubscriptionTier[] = ["starter", "pro", "network"];
  for (const tier of candidates) {
    if (readStripePriceId(tier) === priceId) return tier;
  }
  return null;
}

// Stripe subscription statuses we know about, mapped 1:1 to our enum.
// Any new Stripe status reaches us as 'incomplete' (the most cautious
// default — feature access is off; the dealer is prompted to update
// payment method). Mapping happens at this single chokepoint so adding
// a new Stripe status in a future Stripe release is a one-line edit.
export function mapStatusToInternal(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return stripeStatus;
    default:
      // Unknown status: be conservative. Returns 'incomplete' so feature
      // gating treats the dealer as not-yet-paying.
      return "incomplete";
  }
}

// Webhook signature verification entry point. We expose this as a
// helper rather than re-exporting `stripe.webhooks.constructEvent`
// directly so the route handler doesn't need to import Stripe itself —
// keeps the dependency graph tight, and makes the test mock surface
// trivial (one function to stub, not a whole nested namespace).
export function constructWebhookEvent(
  rawBody: string | Buffer,
  signatureHeader: string,
): Stripe.Event {
  const secret = requireStripeWebhookSecret();
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

// Re-export the SDK type for callers that need to discriminate event
// shapes without importing stripe themselves.
export type { Stripe };
