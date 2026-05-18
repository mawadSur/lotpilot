# Analytics + Error Monitoring Setup

v0.8.2 ships the dev-side wiring required to support analytics and
error monitoring; the actual activation requires you (the operator) to
click through the vendor flows because both require account creation.
Both are zero-cost-at-pilot-scale.

---

## 1. Vercel Analytics — page views, web vitals, top pages (5 min)

The Vercel Analytics product is **enabled in the Vercel dashboard, no
code changes needed.** The free tier covers ~2,500 events/month — more
than enough for the early pilot phase.

### Steps

1. Open https://vercel.com/mawadsurs-projects/lotpilot/analytics
2. Click **Enable Analytics**
3. Choose **Hobby** (free) tier
4. The next deploy will start collecting page views automatically.

### What you get

- Page views per route (`/`, `/pricing#`, `/dashboard`, etc.)
- Top referrers, top countries
- Core Web Vitals (LCP, INP, CLS) per route
- Real-time visitor count

### Custom events (optional, requires code)

If you later want to track CTA clicks (e.g. "how many people clicked
'Start free pilot' before signing up"), install `@vercel/analytics`:

```bash
npm install @vercel/analytics
```

Then drop the component into `src/app/layout.tsx`:

```tsx
import { Analytics } from "@vercel/analytics/next";

// inside <body>:
<Analytics />
```

And fire events from button onClick:

```tsx
import { track } from "@vercel/analytics";
track("pricing-cta", { tier: "pro" });
```

For pilot v0.8.x scale, just enable the dashboard product and skip the
SDK. Revisit if you outgrow the free tier or want CTA-level funnels.

---

## 2. Sentry — error monitoring (20 min one-time)

LotPilot currently surfaces errors via `console.error` and `log.error`
calls that go to Vercel's runtime logs. That's fine for the pilot but
opaque — you only see a problem when you go looking. Sentry alerts you
in Slack/email the moment a real dealer's session 500s.

### Free-tier limits

5,000 errors/month, 10,000 performance events/month. The pilot won't
come close.

### Steps

1. Create a free account at https://sentry.io
2. Create a new project: **Platform → Next.js**, name `lotpilot`
3. Copy the DSN that Sentry shows you (looks like
   `https://<hash>@<region>.ingest.sentry.io/<project-id>`)
4. From the LotPilot repo root, run the official installer:
   ```bash
   npx @sentry/wizard@latest -i nextjs --saas
   ```
   It will:
   - Install `@sentry/nextjs`
   - Create `sentry.client.config.ts`, `sentry.server.config.ts`,
     `sentry.edge.config.ts` (you can prune the edge file later if
     unused)
   - Wrap `next.config.ts` with `withSentryConfig()`
   - Add a `/api/sentry-example-api` test route (delete this after
     verifying)
5. Add these env vars to Vercel
   (https://vercel.com/mawadsurs-projects/lotpilot/settings/environment-variables):
   ```
   NEXT_PUBLIC_SENTRY_DSN     = <the DSN from step 3>
   SENTRY_AUTH_TOKEN          = <create at https://sentry.io/settings/account/api/auth-tokens/ with project:releases scope>
   SENTRY_ORG                 = mawadsur                  # whatever you set in Sentry
   SENTRY_PROJECT             = lotpilot
   ```
6. Commit the wizard-generated files (sentry.*.config.ts +
   next.config.ts changes) — they don't contain secrets.
7. Trigger a redeploy on Vercel. First real production error within
   24h confirms it's wired.

### Pruning the noise

Sentry's defaults capture ALL errors including expected ones. Once
you've seen a week of traffic, add an `ignoreErrors` config:

```ts
// sentry.client.config.ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  ignoreErrors: [
    "Network request failed",     // user offline
    "AbortError",                  // user navigated away mid-fetch
    /Twilio.+rate.+limited/,       // we handle these in-app
  ],
  tracesSampleRate: 0.1,           // 10% performance traces
});
```

Tune to your noise floor.

### Alerts

In Sentry dashboard → Alerts → Create Alert Rule:
- "New issue in production" → Slack channel #lotpilot-alerts
- "Error rate > 1% in 5 minutes" → email
- "P95 latency on /api/chat > 5s" → Slack (after you opt into
  performance traces)

---

## What's already in the codebase

- Structured logger at `src/lib/log.ts` — every backend write call
  already logs structured events (`chat.suppressed_inbound`,
  `follow_up.cancelled`, `lead_share.consent_sent`, etc.). These will
  show up as Sentry breadcrumbs once Sentry's auto-instrumentation
  hooks in, giving you the trail leading to any error.
- The Vercel runtime logs are searchable for ~24h on Hobby. That's
  your fallback while Sentry isn't wired.

---

## Recommended priority for v0.8.2

1. Enable Vercel Analytics today (5 min, dashboard toggle).
2. Wire Sentry **after the first 5 dealers are using the product** —
   it's the natural escalation point for "real user reported error
   we'd have missed."
3. Skip @vercel/analytics SDK until you have a specific funnel
   question worth answering.
