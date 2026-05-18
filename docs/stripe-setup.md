# Stripe billing setup (v0.8)

End-to-end instructions for wiring the LotPilot Stripe integration on a
fresh Stripe account. Three Products, three Prices, one webhook
endpoint, five Vercel env vars. Plan on ~30 minutes.

There are two parallel tracks: **Test mode** (sandbox cards, no real
money) and **Live mode** (real cards, real money). Do **everything**
in Test first; flip to Live only after a full end-to-end checkout
succeeds.

---

## 1. Create the three Products + Prices

1. Sign in to https://dashboard.stripe.com.
2. Make sure the dashboard toggle in the top-right reads **Test mode**
   (orange "TEST DATA" badge). Every step below applies to Test mode
   first; we redo it in Live mode at the end.
3. Go to **Product catalog → + Add product** and create one product per
   tier. Use these exact names — they show up on the buyer's Stripe
   receipt:

   | Product name           | Description                                       |
   |------------------------|---------------------------------------------------|
   | `LotPilot Starter`     | Solo dealer · web chat + SMS + bilingual AI       |
   | `LotPilot Pro`         | WhatsApp + Marketplace + post-drive follow-up     |
   | `LotPilot Network`     | Voice + lead-share network + priority support     |

4. For each product, add a **recurring price**:

   | Tier      | Amount  | Interval | Currency |
   |-----------|---------|----------|----------|
   | Starter   | $199.00 | Monthly  | USD      |
   | Pro       | $499.00 | Monthly  | USD      |
   | Network   | $999.00 | Monthly  | USD      |

5. After each price is saved, copy its **Price ID** (looks like
   `price_1Q...`). Keep all three in a scratchpad — you'll paste them
   into Vercel in step 3.

---

## 2. Create the webhook endpoint

1. In the Stripe dashboard, go to **Developers → Webhooks → + Add
   endpoint**.
2. **Endpoint URL**:
   - Test mode: `https://<your-preview-domain>.vercel.app/api/stripe/webhook`
     (the auto-generated Vercel preview URL works for testing).
   - Live mode (later): `https://app.lotpilot.com/api/stripe/webhook`
     (or whatever your production domain ends up being).
3. **Events to send** — subscribe to exactly these four event types:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - (Optional) `invoice.payment_succeeded` — our handler treats this
     as a no-op but logs it, which is useful for sanity-checking
     renewals in production. Skip if you don't want the noise.
4. Save the endpoint, then click into it. Click **Reveal signing
   secret** and copy the value (starts with `whsec_`). That's the
   `STRIPE_WEBHOOK_SECRET` env var.

> **Important:** Test-mode and Live-mode webhooks have **different**
> signing secrets. You will create two endpoints (one per mode) and
> use the matching `STRIPE_WEBHOOK_SECRET` for each Vercel
> environment (Preview vs Production).

---

## 3. Copy the five env vars into Vercel

In the Vercel dashboard go to **Project → Settings → Environment
Variables** and add the following. For each, set the appropriate
**Environment** (Production for Live keys, Preview/Development for
Test keys; you can also tick Production for Test keys during early
roll-out, then swap once you're ready to go live).

| Name                      | Value                                  | Notes                                  |
|---------------------------|----------------------------------------|----------------------------------------|
| `STRIPE_SECRET_KEY`       | `sk_test_...` or `sk_live_...`         | Stripe → Developers → API keys         |
| `STRIPE_WEBHOOK_SECRET`   | `whsec_...`                            | From the webhook endpoint you created  |
| `STRIPE_PRICE_STARTER`    | `price_...` (Starter monthly)          | From step 1                            |
| `STRIPE_PRICE_PRO`        | `price_...` (Pro monthly)              | From step 1                            |
| `STRIPE_PRICE_NETWORK`    | `price_...` (Network monthly)          | From step 1                            |

After saving, **redeploy** the affected environment (Vercel does not
auto-redeploy on env-var changes). The `stripeConfigured` boolean in
`src/lib/env.ts` flips on after both `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are present; the checkout / portal / webhook
routes 503 cleanly when it's false.

---

## 4. End-to-end smoke test (Test mode)

1. Sign up for a dealer account on your preview deploy.
2. Hit `POST /api/stripe/checkout` from the browser console:

   ```js
   const r = await fetch("/api/stripe/checkout", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ tier: "pro" }),
   });
   const { url } = await r.json();
   window.location = url;
   ```

3. On Stripe's hosted checkout, use a sandbox card:
   - Card number: `4242 4242 4242 4242`
   - Expiry: any future date
   - CVC: any 3 digits
   - ZIP: any 5 digits

4. After the redirect, you should land at `/dashboard?checkout=success`.
   Open the Stripe dashboard → **Webhooks** → your endpoint and confirm
   the `customer.subscription.created` event was delivered with a 200
   response.

5. Query the database (or the dealer-detail page) and confirm:
   - `stripe_customer_id` is populated
   - `stripe_subscription_id` is populated
   - `subscription_status` is `trialing` or `active`
   - `subscription_tier` is `pro`
   - `subscription_current_period_end` is ~1 month out

6. Trigger a payment failure to test the past-due path. In the
   Stripe dashboard, find your test customer → invoice → **... →
   Pay invoice → Fail with a code** (or just use the test card
   `4000 0000 0000 0341`, which always declines after attaching to a
   subscription). Confirm the webhook fires `invoice.payment_failed`
   and the dealer's `subscription_status` is `past_due`.

7. Test cancellation. In the Stripe dashboard, cancel the subscription.
   Confirm `customer.subscription.deleted` fires and the dealer's
   `subscription_status` is `canceled`.

8. Test the customer portal: `POST /api/stripe/portal` from the
   dashboard, follow the URL, confirm the buyer can update card / cancel.

---

## 5. Flip to Live mode

1. In the Stripe dashboard, toggle to **Live mode** (top-right toggle).
2. Repeat step 1 (create three Products + Prices). Save the new Live
   Price IDs — they are **different** from the Test ones.
3. Repeat step 2 (create a webhook endpoint). The signing secret is
   different from the Test one.
4. Update the Vercel env vars on the **Production** environment with
   the Live values:
   - `STRIPE_SECRET_KEY` → `sk_live_...`
   - `STRIPE_WEBHOOK_SECRET` → the Live signing secret
   - `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_NETWORK`
     → the Live price IDs
5. Redeploy Production.
6. Do a real $1 test charge if you can stomach it — or trust the
   Test-mode smoke test and let your first paying dealer be the
   integration test.

---

## 6. Operational notes

- **Idempotency.** The webhook handler is idempotent by construction:
  re-delivering the same event a second time writes the same row. If
  Stripe retries because we 5xx'd once, the second attempt succeeds and
  the state is correct.
- **Failed signature verification.** We return 400 only on signature
  failure — that's the one path where we want Stripe's dashboard to
  surface the delivery failure. Every other handler failure returns
  200 + a log line, so Stripe doesn't retry forever.
- **Service-role writes only.** No authenticated user can update the
  `stripe_*` columns on `dealers` (migration 0018 deliberately omits
  the UPDATE policy). A misbehaving frontend cannot flip a dealer to
  `active` from the client — the only writer is the Stripe webhook.
- **What we don't store.** Card numbers, last4, expiry — none of it.
  The portal session is the only path a dealer has to see card detail.

---

## 7. Troubleshooting

| Symptom                                            | Likely cause / fix                                                                 |
|----------------------------------------------------|------------------------------------------------------------------------------------|
| Webhook returns 503 `stripe_not_configured`        | `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` missing → set env + redeploy        |
| Webhook returns 400 `invalid_signature`            | Wrong `STRIPE_WEBHOOK_SECRET` (mixed Test/Live) → re-copy from Stripe dashboard    |
| Checkout returns 503 `tier_price_missing`          | The tier's `STRIPE_PRICE_*` env var is unset → set it for the current environment  |
| Dealer row never updates after successful payment  | Check `stripe.webhook.unhandled` log lines — wrong event types subscribed?         |
| `subscription_tier` is null on a paid dealer       | Price ID in subscription doesn't match any env var → re-verify price IDs           |
