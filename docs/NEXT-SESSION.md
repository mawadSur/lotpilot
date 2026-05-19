# Next session — pick-up brief

> Last updated: **2026-05-18**, end of v0.8.2 sprint.
> Read this **first** when resuming.

---

## Where we are in one paragraph

LotPilot is a bilingual AI sales assistant for independent used-car
dealers. As of **`b7e6aa6` (v0.8.2)**, the SaaS is **technically
end-to-end sellable**: marketing landing, signup form, dashboard,
chat pipeline (web/SMS/WhatsApp/voice/Marketplace), inbox, AI replies,
auto-confirm reminders, post-drive follow-up, re-engagement, lead-share
network, acquisition signal, Stripe billing, Marketplace Chrome
extension, compliance CSV. **91 tests pass, typecheck + production
build clean, prod auto-deploys via Vercel + GitHub.** The bottleneck
is now distribution + a fixed list of manual setup steps below — NOT
engineering.

---

## What shipped (last 8 commits)

```
b7e6aa6 v0.8.2  operational sprint — Marketplace ext, Stripe, OG, terms, CI/cron polish
d07ddf6 v0.8.1  move sub-daily crons to GitHub Actions (unblocks Vercel Hobby deploy)
9e7cb55 v0.8.0  rebuild marketing landing + brand mark
43099a5 v0.7.4  T4.2 wrap-up — share UI, incoming-referral banner, expire sweep
c2a2adc v0.7.3  buyer_intent capture + T3.2 acquisition signal + T4.2 lead-share
23ad128 ci      match Supabase default ACL (grant select/etc to anon+authenticated)
bf8dde3 ci      drop+create conversations_with_latest in 0005 & 0008
9fcfc0f ci      bootstrap Supabase anon/authenticated/service_role roles
```

For deeper context on any version, see `ROADMAP.md`.

---

## 🟥 What blocks first paying dealer — START HERE next session

These are entirely operator-side; the code is done.

### 1. Set the rest of Vercel production env vars (~20 min)

Currently only `INTERNAL_DRAIN_TOKEN` is set on Vercel. Static landing
works without env, but signup form, dashboard, AI chat, SMS,
WhatsApp, Marketplace, and every cron drainer will 500 until the rest
are wired. Copy from local `.env.local` (or `.env.example`).

**Verify after**: trigger the cron-drainers workflow manually
(https://github.com/mawadSur/lotpilot/actions/workflows/cron-drainers.yml).
A 200 means the env is correctly wired; right now it returns 500.

**Mandatory for any real dealer to use the product:**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
ANTHROPIC_DAILY_BUDGET_USD       (e.g. 50)
KV_REST_API_URL                  (Upstash Redis)
KV_REST_API_TOKEN
```

**For SMS / Marketplace / WhatsApp / Calendly channels:**
```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER
SMS_ENABLED=true
MARKETPLACE_MASTER_SECRET
WHATSAPP_ACCESS_TOKEN
WHATSAPP_APP_SECRET
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN
WHATSAPP_TEMPLATE_NAME
CALENDLY_WEBHOOK_SECRET
CALENDLY_API_KEY
```

### 2. Stripe activation (~30 min)

Code is shipped; activation needs Stripe dashboard work + env vars.
Full walkthrough in `docs/stripe-setup.md`.

**Summary:**
- Create 3 Products in Stripe Dashboard (Starter $199 / Pro $499 / Network $999)
- Create 1 Webhook endpoint pointing at `https://lotpilot-chi.vercel.app/api/stripe/webhook` subscribing to: `customer.subscription.created` / `.updated` / `.deleted` + `invoice.payment_failed` (+ optional `invoice.payment_succeeded`)
- Set 5 env vars on Vercel: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_NETWORK`
- Do it once in Test mode, repeat in Live

### 3. Buy a custom domain (~10 min + DNS propagation)

`lotpilot-chi.vercel.app` reads as untrustworthy to dealers. Suggested:
buy `lotpilot.com` or `app.lotpilot.com`. Add in Vercel project
Settings → Domains; point CNAME at `cname.vercel-dns.com`.

### 4. Marketplace extension first install (~30 min)

The MV3 extension at `extensions/marketplace-bridge/` is built but:
- Selectors are educated guesses. First install on a real FB account
  may need one CONFIG tweak. README has the DevTools recipe.
- No icons shipped (default puzzle-piece). Add
  `icons/icon-{16,32,48,128}.png` before Chrome Web Store submission.
- Side-load only until Chrome Web Store approval.
- **Mobile Chrome cannot run MV3 extensions.** Landing copy already
  fixed to say "desktop or laptop browser." Real dealers on iOS
  Marketplace will need a different path long-term (Meta Cloud API
  was forbidden last we checked).

### 5. Send the 4 partner outreach emails (~10 min)

Drafts already written in `docs/T1.5-T1.6-partner-outreach-drafts.md`.
Personalize `[REP_NAME]` in email 2 (Manheim, via Cox Auto rep) and
send all four. The 60-90 day partner-onboarding clock for T1.5 / T1.6
trade-in + financing pre-qual doesn't start until you hit Send.

### 6. Enable Vercel Analytics (~5 min)

Toggle in https://vercel.com/mawadsurs-projects/lotpilot/analytics →
Enable. Hobby tier is free. No code change required. Without this we
can't see if anyone visits the landing.

---

## 🟧 Sellable-now polish (do in next session if 1-6 are done)

- **OG image visual verification** — `src/app/opengraph-image.tsx`
  generates dynamically. Hit
  `https://lotpilot-chi.vercel.app/opengraph-image` in a browser to
  preview the rendered PNG. Tweak typography/spacing if it looks off.
- **Sentry wiring** — `docs/analytics-and-monitoring-setup.md` has
  the runbook. Recommended priority: defer until 5 dealers are
  actually using the product.
- **Browser-extension Chrome Web Store submission** — needs icons +
  privacy policy hosted at a stable URL (we have `/privacy` already)
  + a screenshot. Allow 1-2 weeks for review.
- **Stripe upgrade flow (v0.8.3 follow-up)** — see follow-ups list at
  the bottom of the Stripe agent's notes captured in
  `docs/stripe-setup.md`. Specifically: plumb `isAuthed` into
  `Pricing`, swap the CTA from `#signup` scroll to
  `/api/stripe/checkout`, add `UpgradePrompt` client component,
  dashboard "Manage billing" deep-link to `/api/stripe/portal`.

---

## 🟨 Time-bound tech debt

- **GitHub Actions Node 20 → 24 forced cutover: June 2, 2026** (~2 weeks).
  We've already added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24="true"` to
  both workflows, so we're opted-in early. **No further action needed
  unless GitHub changes the rollout.**
- The marketing-site dev-server port collision (3000 was taken by
  another local project; Next.js fell back to 3001). Harmless but
  surprised the QA flow last session.

---

## 🟦 Roadmap items unstarted (pick based on dealer feedback)

**Activatable with partner creds** (waiting on the 4 emails to be sent):
- **T1.5 Trade-in valuation** — KBB primary, Manheim secondary.
  Adapter scaffolded at `src/lib/trade-in/kbb.ts` (throws
  `TODO: pending KBB API contract`). Once creds arrive, the activation
  is a 1-line env change + one adapter swap.
- **T1.6 Financing pre-qual** — RouteOne primary, 700Credit secondary.
  Same shape: `src/lib/financing/route_one.ts`. SSN-handling rules
  (ssn_last4 only, sha256 reference hash) already enforced.

**Unbuilt features from the roadmap** (pick based on real dealer ask):
- T0.8 DMS integrations (Frazer / DealerCenter / AutoManager) —
  scoped in `docs/T0.8-dms-ingestion-scope.md`.
- T2.4 Video generator (Reels / TikTok) — design only in
  `docs/T2.4-video-generator-design.md`.
- T2.6 Buyer intent enrichment beyond current capture.
- T2.8 Multi-location / multi-DBA support.
- T2.9 Mystery-shopper mode.
- T2.10 Dealer mobile PWA.

**Moonshots:**
- T3.1 Dynamic pricing recommender.
- T3.3 Voice clone for outbound.
- T3.4 Co-op subprime / BHPH financing marketplace.
- T3.5 Insurance partner offer at booking.
- T3.6 Title / registration concierge.

**Business model:**
- T4.1 White-glove tier ($999 add-on, "we run your Marketplace").
- T4.3 Weekly founder Loom — operationally ready, just record + send.
- T4.4 AutoTrader migration program.

---

## Repo health checkpoints

| Check | State |
|---|---|
| Test suite | 91/91 passing (`npm test`) |
| TypeScript | clean (`npx tsc --noEmit`) |
| Production build | clean (`npm run build`) |
| Migrations CI | green on last push |
| Vercel auto-deploy | wired (verified after v0.8.1) |
| GA cron auto-fire | wired (schedule entries in `cron-drainers.yml`) |
| Live URL | https://lotpilot-chi.vercel.app — serving v0.8.2 |
| Prod env vars set | **1 of ~25** (`INTERNAL_DRAIN_TOKEN` only) — this is the #1 blocker |

---

## How to resume in 5 minutes

1. Read this doc.
2. Skim `ROADMAP.md` "v0.8.2 — SHIPPED" section for the last sprint's detail.
3. `git log --oneline -10` for recent commits.
4. Pick from the 🟥 list above. Items 1, 2, 3 are independent; 4 needs item 1 first; 5 + 6 are 10-minute admin tasks.
5. If 🟥 items 1-6 are all done and a dealer is using the product, move to the polish + v0.8.3 follow-ups list, then back to ROADMAP for the next feature.

---

## Non-obvious gotchas worth remembering

- **Vercel Hobby plan silently rejects every deploy when `vercel.json`
  has sub-daily crons.** v0.7.1 added the first one and prod went
  3 days without an auto-deploy. We moved sub-daily crons to GitHub
  Actions in v0.8.1. Don't add new sub-daily entries to `vercel.json`
  until you upgrade to Pro.
- **Facebook Marketplace mobile = no extension support.** Chrome iOS
  has no extensions; Chrome Android is essentially extension-less
  outside Kiwi browser. The "install on your phone" pitch was
  wrong — landing now says "desktop or laptop." This is a real
  product gap for dealers who only use FB Marketplace on their phone.
- **TCPA append-only enforcement.** Migrations 0015 (`re_engagement_audit`),
  0017 (`lead_shares`), 0018 (Stripe `dealers` updates) all have
  `RAISE EXCEPTION` blocks that assert no authenticated INSERT/UPDATE/
  DELETE policies exist. Tests should never relax this without
  legal review.
- **`CREATE OR REPLACE VIEW` rejects column-order shifts** — we hit
  this on `conversations_with_latest` in 0005 and 0008 when `c.*`
  expanded to include new columns. The fix was `drop view if exists` +
  `create view` (no cascade — nothing depends on the view).
- **Supabase auto-grants `SELECT/INSERT/UPDATE/DELETE` to `anon` +
  `authenticated` on every table in `public`.** Vanilla Postgres
  doesn't. Our migrations CI compensates via
  `ALTER DEFAULT PRIVILEGES` in the bootstrap step. Don't drop that
  step.
