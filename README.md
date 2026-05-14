# LotPilot

The bilingual AI sales assistant for independent used-car dealers.
Every Marketplace, SMS, and web lead answered in 60 seconds, in
English or Spanish — 24/7.

This repo holds:

- the marketing landing page + dealer waitlist (live since v0.0)
- the v0.1 product: dealer dashboard, CSV inventory, public chat
  widget at `/c/<slug>`, and the Anthropic Claude reply engine

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript strict mode
- Tailwind CSS v4
- Supabase (Postgres + RLS) for auth, inventory, conversations, waitlist
- Anthropic Claude (Sonnet) for the bilingual reply engine
- Deployed to Vercel

## Run locally

```bash
npm install
cp .env.example .env.local   # then edit with your Supabase + Anthropic keys
npm run dev
```

Open http://localhost:3000.

The marketing site builds and runs without any keys — the waitlist
form just shows a thank-you message instead of persisting signups.
The dealer dashboard, public chat widget, and AI reply engine all
require the env vars below.

## Environment variables

| Variable | Where used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | Supabase anon key (RLS-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Used by `/api/chat`, CSV upload, and `/api/sms/inbound` to bypass RLS |
| `ANTHROPIC_API_KEY` | **server only** | Used by the reply engine. Do **not** prefix with `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` (optional) | server | Origin used for magic-link redirects (defaults to the request host) |
| `ANTHROPIC_MODEL` (optional) | server | Override the default Claude model id |
| `KV_REST_API_URL` (v0.2, optional in dev) | server | Upstash Redis REST URL — backs rate limiting + per-dealer Anthropic budget circuit breaker. v0.3 swapped the underlying client from `@vercel/kv` to `@upstash/redis`+`@upstash/ratelimit`; the env-var name is unchanged so existing Vercel/Upstash integrations keep working. Without it, both fall back to in-process counters (fine for local dev, useless in prod). |
| `KV_REST_API_TOKEN` (v0.2, optional in dev) | **server only** | Upstash Redis REST token. Required if `KV_REST_API_URL` is set. |
| `ANTHROPIC_DAILY_BUDGET_USD` (v0.2, optional) | server | Per-dealer daily USD cap for Claude calls. Defaults to `50`. |
| `SMS_ENABLED` (v0.2, optional) | server | Set to `true` to flip on outbound SMS + the inbound webhook. Defaults to off. |
| `TWILIO_ACCOUNT_SID` (v0.2) | **server only** | Required iff `SMS_ENABLED=true`. |
| `TWILIO_AUTH_TOKEN` (v0.2) | **server only** | Required iff `SMS_ENABLED=true`. Used to verify inbound webhook signatures. |
| `TWILIO_FROM_NUMBER` (v0.2) | **server only** | E.164 phone number you provisioned in Twilio. Required iff `SMS_ENABLED=true`. |
| `VOICE_ENABLED` (v0.3, optional) | server | Set to `true` to mount `/api/voice/inbound`. With the flag off (default) the route still ack-200s so a misconfigured Vapi webhook doesn't loop. |
| `VAPI_PUBLIC_KEY` (v0.3) | **server only** | Required iff `VOICE_ENABLED=true`. Reserved for future outbound calls. |
| `VAPI_PRIVATE_KEY` (v0.3) | **server only** | Required iff `VOICE_ENABLED=true`. HMAC secret used to verify the `x-vapi-signature` header on inbound webhooks. |

`.env.local` is gitignored. Never commit secrets.

Note: `.env.example` is intentionally not auto-edited by tooling. After
each milestone you should append the new variables above to it manually
so the next clone sees them. Suggested block:

```
# v0.2 (Upstash Redis — env-var names retained from the @vercel/kv era)
KV_REST_API_URL=
KV_REST_API_TOKEN=
ANTHROPIC_DAILY_BUDGET_USD=50
SMS_ENABLED=false
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

# v0.3 (voice scaffold; safe to leave blank)
VOICE_ENABLED=false
VAPI_PUBLIC_KEY=
VAPI_PRIVATE_KEY=
```

### v0.3 platform notes

- **KV swap.** The rate-limiter and per-dealer Anthropic budget now use
  `@upstash/redis` + `@upstash/ratelimit` (sliding window) under the
  hood. We deliberately kept the `KV_REST_API_URL` / `KV_REST_API_TOKEN`
  env-var names so an existing Vercel KV / Upstash integration keeps
  working without a dashboard edit.
- **Voice.** `VOICE_ENABLED=false` (default) means the inbound webhook
  ack-200s with an empty payload — useful if you want to point Vapi at a
  preview deploy without wiring secrets first.

## Set up Supabase

1. Create a project at https://supabase.com (free tier is fine).
2. In the dashboard: **SQL Editor → New query**, paste the contents of
   each migration in order and run it:
   - [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
     creates the marketing waitlist (`dealer_signups`).
   - [`supabase/migrations/0002_v01_core.sql`](supabase/migrations/0002_v01_core.sql)
     creates the v0.1 product schema (`dealers`, `vehicles`,
     `conversations`, `messages`) with row-level security and
     `x-buyer-session`-scoped anon policies for the public chat widget.
3. **Project Settings → API**, copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only)
4. Paste them into `.env.local` and restart the dev server.

To review signups, open the Supabase dashboard → **Table Editor →
dealer_signups**.

### Local Supabase (optional)

If you have the [Supabase CLI](https://supabase.com/docs/guides/cli)
installed:

```bash
supabase start
supabase db reset   # applies both 0001_init.sql and 0002_v01_core.sql
```

## Get an Anthropic API key

1. Sign in at https://console.anthropic.com and create an API key.
2. Paste it into `.env.local` as `ANTHROPIC_API_KEY=sk-ant-...`.
3. Restart the dev server. The default model is set inside
   `src/lib/ai.ts`; override it with `ANTHROPIC_MODEL` if needed.

If `ANTHROPIC_API_KEY` is missing, the chat API returns 503 — it does
**not** silently fall back to a canned reply (intentional: a quiet
failure on a buyer thread is worse than a clear "try again").

## Try it end-to-end

1. Visit http://localhost:3000 and sign up via the waitlist (optional,
   but populates `dealer_signups`).
2. Visit http://localhost:3000/login, enter your email, and click
   the magic link Supabase emails you.
3. You'll land on `/dashboard/onboarding`. Pick a slug like
   `my-dealership` and finish setup.
4. Go to `/dashboard/inventory` and upload a CSV. Required column:
   `stock_number`. Useful optional columns:
   `vin, year, make, model, trim, mileage, price, photo_url, description, status`.
5. Open `http://localhost:3000/c/my-dealership` in incognito. Send
   a message ("Do you have any 2018 Toyotas?"). The reply will
   reference only the inventory you uploaded.
6. Head back to `/dashboard/inbox` to see the conversation.

URLs:
- Marketing: http://localhost:3000
- Dealer login: http://localhost:3000/login
- Dealer dashboard: http://localhost:3000/dashboard
- Public buyer chat: http://localhost:3000/c/<slug>

## Deploy to Vercel

```bash
npm install -g vercel
vercel login
vercel              # first deploy creates the project + preview URL
vercel --prod       # promote to production
```

Set every env var listed above in the Vercel dashboard
(**Project → Settings → Environment Variables**) for both
`Production` and `Preview`. `SUPABASE_SERVICE_ROLE_KEY` and
`ANTHROPIC_API_KEY` must be set as **server-only** secrets — Vercel
does this automatically for any var without the `NEXT_PUBLIC_` prefix.

## Project layout

```
src/
  app/
    actions.ts                    Waitlist server action (existing)
    layout.tsx, page.tsx          Marketing landing page (existing)
    signup-form.tsx               Waitlist client form (existing)
    login/                        Magic-link sign-in
    auth/callback/                Magic-link redirect target
    auth/signout/                 POST -> sign out
    dashboard/                    Dealer-only UI (auth-gated)
      layout.tsx                  Auth guard + nav
      page.tsx                    Inbox snapshot
      onboarding/                 First-run wizard
      inventory/                  CSV upload + table
      inbox/                      Full conversation list + detail
      settings/                   Edit dealership profile
    c/[slug]/                     Public buyer chat widget
    api/chat/route.ts             POST endpoint for the widget (thin adapter)
    api/chat/poll/route.ts        Buyer poll for approve-before-send replies
    api/sms/inbound/route.ts      Twilio inbound webhook (signature-first)
    api/dashboard/messages/[id]/{approve,reject,edit}/route.ts
                                  Dealer-only AI-draft moderation
    api/dashboard/conversations/[id]/reminder/route.ts
                                  Test-drive reminder (SMS or copy-text)
  lib/
    ai.ts                         Anthropic client + system prompt
    auth.ts                       requireDealer / requireUser helpers
    budget.ts                     Per-dealer daily USD circuit breaker
    chat-pipeline.ts              Shared web/SMS chat-turn pipeline
    consent.ts                    TCPA consent text (web + SMS)
    csv.ts                        Tiny RFC-4180-ish parser + row cap
    db-types.ts                   Hand-written DB row types
    env.ts                        Env-var access + assertions
    keywords.ts                   STOP/HELP/START detection + canned replies
    log.ts                        Structured JSON logger w/ PII redaction
    ratelimit.ts                  IP / dealer / conversation rate limiter (KV)
    retry.ts                      Exponential-backoff helper
    sanitize.ts                   Buyer-input sanitiser (prompt-injection guard)
    session.ts                    Buyer cookie helpers (lp_session)
    sms/twilio.ts                 Outbound SMS + signature verifier
    supabase-server.ts            Server-side client (RLS-aware)
    supabase-browser.ts           Browser-side client
    supabase-service.ts           Service-role client (bypass-RLS, server only)
  proxy.ts                        Auth-session refresh (Next 16 "proxy" file)
supabase/
  migrations/
    0001_init.sql                 dealer_signups (existing)
    0002_v01_core.sql             dealers + vehicles + conversations + messages
    0003_v02_review_pipeline.sql  approve-before-send, lead pipeline,
                                  TCPA consents + keyword_events, SMS
                                  scaffolding, conversations_with_latest view
```

## Scope

- v0.0: marketing wedge — one screen, one CTA, the dealer waitlist.
- v0.1 (this build): magic-link auth, dealer onboarding, CSV
  inventory, bilingual AI reply engine, public chat widget,
  read-only inbox.
- v0.2+: see [`ROADMAP.md`](ROADMAP.md).
