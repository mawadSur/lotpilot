// LotPilot v0.8 — Stripe webhook handler tests.
//
// Coverage goals:
//   1. customer.subscription.created → dealer row populated with the
//      mapped tier + status + period_end.
//   2. customer.subscription.updated → state transition recorded.
//   3. customer.subscription.deleted → status flips to 'canceled'.
//   4. invoice.payment_failed → status flips to 'past_due' (resolved
//      via stripe_subscription_id, not metadata).
//   5. unknown event type → handler returns 200 (no-op).
//   6. Idempotency: delivering the SAME event twice ends with the
//      same state (the second delivery is a no-op).
//
// We mock @/lib/stripe entirely — no real Stripe SDK calls. The
// constructWebhookEvent helper is the chokepoint we override; the spy
// returns whichever event object the test wants the handler to see.
// This means we do NOT exercise signature verification here (that's
// covered by the Stripe SDK's own tests and by the fact that a bad
// signature naturally throws from constructWebhookEvent — which the
// handler 400s on as a separate assertion below).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted helpers shared across module mocks.
const hoisted = vi.hoisted(async () => {
  const { vi: viInner } = await import("vitest");
  const helper = await import("./helpers/mock-pipeline");
  return {
    helper,
    mockSb: helper.makeMockSb(),
    // Default: throw `signature_verification_failed`. Tests override
    // this on a per-case basis to return the event they want.
    constructWebhookEventSpy: viInner.fn(() => {
      throw new Error("signature_verification_failed");
    }),
  };
});

vi.mock("../src/lib/supabase-service", async () => {
  const h = await hoisted;
  return { createServiceSupabase: () => h.mockSb };
});

// The route handler only imports a handful of helpers from @/lib/stripe
// — re-implement the surface as a passthrough that delegates the
// signature-verification step to our spy. The rest of the helpers
// (mapStatusToInternal, priceIdToTier) are pure and worth running
// against their real implementations, so we re-export the real ones.
vi.mock("../src/lib/stripe", async () => {
  const real = await vi.importActual<typeof import("../src/lib/stripe")>(
    "../src/lib/stripe",
  );
  const h = await hoisted;
  return {
    ...real,
    constructWebhookEvent: h.constructWebhookEventSpy,
  };
});

// env shims: feature-on, deterministic price ids per tier so
// priceIdToTier resolves correctly.
vi.mock("../src/lib/env", () => ({
  stripeConfigured: true,
  requireStripeSecretKey: () => "sk_test_dummy",
  requireStripeWebhookSecret: () => "whsec_test_dummy",
  readStripePriceId: (tier: string) => {
    if (tier === "starter") return "price_starter_test";
    if (tier === "pro") return "price_pro_test";
    if (tier === "network") return "price_network_test";
    return null;
  },
}));

// Service-supabase env defaults (so the createServiceSupabase factory
// inside src/lib/supabase-service doesn't throw at import-time before
// our supabase-service mock can intercept it).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-key";

import { POST as webhookPOST } from "../src/app/api/stripe/webhook/route";
import type { DealerRow } from "../src/lib/db-types";

// Stripe.Event-shaped builder. We don't import Stripe in the test
// because the real type is huge — a small structural type is all the
// handler reads.
type FakeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

function makeRequest(): Request {
  // The handler reads `stripe-signature` header + body text — value
  // contents don't matter because constructWebhookEvent is mocked.
  return new Request("https://test.invalid/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=fake" },
    body: "{}",
  });
}

async function seedDealer(): Promise<DealerRow> {
  const h = await hoisted;
  return h.helper.seedDealer({
    name: "Test Dealer",
    stripe_customer_id: "cus_test_123",
  });
}

function subscriptionEvent(
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  args: {
    eventId?: string;
    dealerId: string;
    subscriptionId?: string;
    status?: string;
    tierPriceId?: string;
    currentPeriodEnd?: number;
    customerId?: string;
    metadataTier?: "starter" | "pro" | "network";
  },
): FakeEvent {
  const items = args.tierPriceId
    ? { data: [{ price: { id: args.tierPriceId } }] }
    : { data: [] };
  const metadata: Record<string, string> = { dealer_id: args.dealerId };
  if (args.metadataTier) metadata.tier = args.metadataTier;
  return {
    id: args.eventId ?? `evt_${Math.random().toString(16).slice(2, 10)}`,
    type,
    data: {
      object: {
        id: args.subscriptionId ?? "sub_test_001",
        customer: args.customerId ?? "cus_test_123",
        status: args.status ?? "active",
        current_period_end:
          args.currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        items,
        metadata,
      },
    },
  };
}

function invoiceEvent(args: {
  eventId?: string;
  subscriptionId: string;
}): FakeEvent {
  return {
    id: args.eventId ?? `evt_inv_${Math.random().toString(16).slice(2, 8)}`,
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_test_001",
        subscription: args.subscriptionId,
      },
    },
  };
}

beforeEach(async () => {
  const h = await hoisted;
  h.helper.resetStore();
  h.constructWebhookEventSpy.mockReset();
});

describe("stripe webhook — signature verification", () => {
  it("returns 400 when the signature is invalid", async () => {
    const h = await hoisted;
    h.constructWebhookEventSpy.mockImplementationOnce(() => {
      throw new Error("signature_verification_failed");
    });
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_signature");
  });

  it("returns 400 when the stripe-signature header is missing", async () => {
    const req = new Request("https://test.invalid/api/stripe/webhook", {
      method: "POST",
      body: "{}",
    });
    const res = await webhookPOST(req as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("missing_signature");
  });
});

describe("stripe webhook — customer.subscription.created", () => {
  it("populates the dealer row with mapped status, tier from price id, and period_end", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    const nowSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_alpha",
        status: "trialing",
        tierPriceId: "price_pro_test",
        currentPeriodEnd: nowSec,
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );

    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);

    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.stripe_subscription_id).toBe("sub_alpha");
    expect(after?.subscription_status).toBe("trialing");
    expect(after?.subscription_tier).toBe("pro");
    expect(after?.subscription_current_period_end).toBe(
      new Date(nowSec * 1000).toISOString(),
    );
  });

  it("falls back to metadata.tier when items.data is empty", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_beta",
        status: "active",
        metadataTier: "starter",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.subscription_tier).toBe("starter");
  });
});

describe("stripe webhook — customer.subscription.updated", () => {
  it("updates the dealer status + tier on transition", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    // First: create at 'trialing'/pro.
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_gamma",
        status: "trialing",
        tierPriceId: "price_pro_test",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    await webhookPOST(makeRequest() as never);

    // Update to 'active'/network.
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.updated", {
        dealerId: dealer.id,
        subscriptionId: "sub_gamma",
        status: "active",
        tierPriceId: "price_network_test",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.subscription_status).toBe("active");
    expect(after?.subscription_tier).toBe("network");
  });
});

describe("stripe webhook — customer.subscription.deleted", () => {
  it("flips the dealer status to 'canceled' without nuking tier", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    // Seed an active subscription via .created.
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_delta",
        status: "active",
        tierPriceId: "price_pro_test",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    await webhookPOST(makeRequest() as never);

    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.deleted", {
        dealerId: dealer.id,
        subscriptionId: "sub_delta",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.subscription_status).toBe("canceled");
    // Tier stays — useful for the UI when reporting "your Pro plan ends on ..."
    expect(after?.subscription_tier).toBe("pro");
  });
});

describe("stripe webhook — invoice.payment_failed", () => {
  it("flips the dealer status to 'past_due' by subscription id lookup", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    // Seed a subscription so the dealer has stripe_subscription_id.
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_epsilon",
        status: "active",
        tierPriceId: "price_pro_test",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    await webhookPOST(makeRequest() as never);

    h.constructWebhookEventSpy.mockReturnValueOnce(
      invoiceEvent({ subscriptionId: "sub_epsilon" }) as unknown as ReturnType<
        typeof h.constructWebhookEventSpy
      >,
    );
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.subscription_status).toBe("past_due");
  });
});

describe("stripe webhook — unknown event types", () => {
  it("returns 200 and writes nothing", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    h.constructWebhookEventSpy.mockReturnValueOnce({
      id: "evt_unknown",
      type: "checkout.session.async_payment_succeeded",
      data: { object: {} },
    } as unknown as ReturnType<typeof h.constructWebhookEventSpy>);
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    // Untouched.
    expect(after?.subscription_status).toBeNull();
    expect(after?.subscription_tier).toBeNull();
  });

  it("treats invoice.payment_succeeded as a no-op", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    // Pre-seed a known state we can assert is unchanged.
    h.constructWebhookEventSpy.mockReturnValueOnce(
      subscriptionEvent("customer.subscription.created", {
        dealerId: dealer.id,
        subscriptionId: "sub_zeta",
        status: "active",
        tierPriceId: "price_pro_test",
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>,
    );
    await webhookPOST(makeRequest() as never);
    const before = h.helper.getStore().dealers.get(dealer.id);
    const beforeStatus = before?.subscription_status;

    h.constructWebhookEventSpy.mockReturnValueOnce({
      id: "evt_inv_ok",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_zeta" } },
    } as unknown as ReturnType<typeof h.constructWebhookEventSpy>);
    const res = await webhookPOST(makeRequest() as never);
    expect(res.status).toBe(200);
    const after = h.helper.getStore().dealers.get(dealer.id);
    expect(after?.subscription_status).toBe(beforeStatus);
  });
});

describe("stripe webhook — idempotency", () => {
  it("delivering the same .created event twice results in the same row state", async () => {
    const h = await hoisted;
    const dealer = await seedDealer();
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    const buildEvent = () =>
      subscriptionEvent("customer.subscription.created", {
        eventId: "evt_replay",
        dealerId: dealer.id,
        subscriptionId: "sub_replay",
        status: "active",
        tierPriceId: "price_pro_test",
        currentPeriodEnd: periodEnd,
      }) as unknown as ReturnType<typeof h.constructWebhookEventSpy>;

    h.constructWebhookEventSpy.mockReturnValueOnce(buildEvent());
    const first = await webhookPOST(makeRequest() as never);
    expect(first.status).toBe(200);
    const snapshot1 = { ...h.helper.getStore().dealers.get(dealer.id)! };

    h.constructWebhookEventSpy.mockReturnValueOnce(buildEvent());
    const second = await webhookPOST(makeRequest() as never);
    expect(second.status).toBe(200);
    const snapshot2 = h.helper.getStore().dealers.get(dealer.id)!;

    // The only field allowed to differ between deliveries is
    // updated_at (the mock-builder bumps it on every write). Every
    // subscription-state field must be identical.
    expect(snapshot2.stripe_subscription_id).toBe(snapshot1.stripe_subscription_id);
    expect(snapshot2.subscription_status).toBe(snapshot1.subscription_status);
    expect(snapshot2.subscription_tier).toBe(snapshot1.subscription_tier);
    expect(snapshot2.subscription_current_period_end).toBe(
      snapshot1.subscription_current_period_end,
    );
  });
});
