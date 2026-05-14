# LotPilot Roadmap

> Source of truth for what we're building, in priority order.
> Mode: **SCOPE EXPANSION** — build the cathedral, ship the full vision.
> All tiers are committed; we will build all of T0 → T4 over time.

Effort: **S** ≤1wk · **M** 1–3wk · **L** 1–2mo · **XL** 3+mo
Value: ★→★★★★★ (impact on retention/revenue/moat)

## v0.1 — SHIPPED (commit `85b0d91`, deployed)

- T0.7 Dealer onboarding wizard, T0.8 CSV inventory, T0.1 web widget,
  T0.2 Claude reply engine, T0.3 EN/ES bilingual, T0.5 Calendly,
  T0.6 read-only inbox, T0.10 per-dealer settings, plus privacy disclosure
  and `/privacy` route.

## v0.2 — SHIPPED (commit `85b0d91`, deployed)

- T0.4 Approve-before-send queue, T0.6 lead status pipeline, T0.11 TCPA
  foundation (consent capture, STOP/HELP/START), T0.1 SMS scaffold (Twilio
  feature-flagged), T1.7 in-app reminders, T1.8 hot-buyer banner.
- Hardening: Vercel KV rate limits, Anthropic budget circuit-breaker,
  structured logger, AI msg retry, CSV file-type validation,
  optimistic chat bubble UX.

## v0.3 — SHIPPED (deploying)

- T0.1 Marketplace human-relay UI (paste/copy workflow — TOS-safe
  bridge ahead of T0.9 spike)
- T2.2 AI listing optimizer (per-vehicle 3-variant generation)
- T1.1 Voice channel scaffold (Vapi adapter, feature-flagged)
- T1.3 Real-time SLA dashboard (median / p95 / leads-saved / 7-bar SVG)
- Carry-overs: `@vercel/kv` → `@upstash/redis`, `scheduled_at` column +
  single-SQL reminder query (drops v0.2 N+1)

## v0.3.1 — Carry-over patches (next)

- C3 from v0.3 review: relay consent insert silently rejected by Postgres
  `inet` column on `ip: "relay"` sentinel — fix null-mapping or skip
  consent entirely for `channel='relay'`
- C4: relay/voice consent text uses web-widget copy — split per-channel
- Pg regression test for SECURITY DEFINER ownership (catches v0.3 C1
  class of bug for any future SECURITY DEFINER function)
- `findOrCreateConversationByChannel(sb, {dealer_id, phone, channel})`
  helper to remove the duplication between SMS / voice / future WhatsApp

## v0.4 — Marketplace + Voice activation

- **T0.9** Marketplace TOS-safe architecture decision (browser extension
  vs. human-relay) — **needs separate spike + legal**
- **T0.1** Marketplace ingestion (per chosen architecture)
- **T2.3** Auto-repost cadence
- **T1.1** Voice — wire `@vapi-ai/server-sdk`, real signature scheme,
  outbound TTS via `speakBack`
- Calendly webhook overwrites `scheduled_at` with real slot
- Listing optimizer: auto-sync accepted variant into `vehicles.description`
- Inbox N+1 cleanup: re-add "no recent dealer reply" filter as SQL
  `not exists` clause
- Test coverage: 2 integration tests for approve-before-send triple-filter
  + STOP suppression (TCPA risk path)

## Tier 0 — Critical (the v1 baseline)

| # | Feature | Effort | Value | Status |
|---|---------|--------|-------|--------|
| T0.1 | Inbound capture: Marketplace + SMS + web form | L | ★★★★★ | v0.1 (web), v0.2 (SMS), v0.3 (Marketplace) |
| T0.2 | AI reply engine (Claude) + RAG over inventory | M | ★★★★★ | v0.1 |
| T0.3 | Bilingual EN/ES with auto-detect | S | ★★★★★ | v0.1 |
| T0.4 | Human-in-loop review queue (approve-before-send) | M | ★★★★★ | v0.2 |
| T0.5 | Test drive booking — **Calendly** | S | ★★★★ | v0.1 |
| T0.6 | Per-dealer lead inbox + status pipeline | M | ★★★★ | v0.1 (read), v0.2 (pipeline) |
| T0.7 | Dealer onboarding wizard | M | ★★★ | v0.1 |
| T0.8 | Inventory ingestion: CSV + DMS (Frazer, DealerCenter, AutoManager) | L | ★★★★ | v0.1 (CSV), v0.4 (DMS) |
| T0.9 | Marketplace TOS-safe architecture | L | ★★★★★ | v0.3 spike |
| T0.10 | Per-dealer settings (tone, signature, hours, after-hours mode) | S | ★★★ | v0.1 (basic), v0.2 (full) |
| T0.11 | TCPA / FCC compliance | M | ★★★★★ | v0.2 |

## Tier 1 — High-value (drives retention)

| # | Feature | Effort | Value |
|---|---------|--------|-------|
| T1.1 | Voice channel (Vapi/Retell) — answer missed calls | L | ★★★★★ |
| T1.2 | WhatsApp Business integration | M | ★★★★ |
| T1.3 | Real-time response SLA dashboard | M | ★★★★ |
| T1.4 | Lead-quality scoring (hot/warm/cold) | M | ★★★ |
| T1.5 | Trade-in valuation in-conversation (KBB / Manheim MMR) | M | ★★★★ |
| T1.6 | Financing pre-qual handoff (Capital One, RouteOne, 700Credit) | L | ★★★★ |
| T1.7 | No-show predictor + auto-confirmation reminders | S | ★★★★ |
| T1.8 | Hot-buyer handoff alerts to closer | S | ★★★★★ |
| T1.9 | Post-test-drive follow-up automation (24h/72h/7d) | M | ★★★★ |
| T1.10 | Dealer benchmarking | S | ★★★ |

## Tier 2 — Differentiators (the moat layer)

| # | Feature | Effort | Value |
|---|---------|--------|-------|
| T2.1 | Spanish-native conversation training (founder-coached corpus) | L | ★★★★★ |
| T2.2 | AI listing optimizer (title/desc/photo order) | L | ★★★★ |
| T2.3 | Auto-repost cadence to Marketplace | M | ★★★★ |
| T2.4 | Inventory video generator (Reels/TikTok) | L | ★★★ |
| T2.5 | Outbound re-engagement on inventory match | M | ★★★★ |
| T2.6 | Buyer intent enrichment | M | ★★★ |
| T2.7 | Compliance recorder (auditable conversation export) | M | ★★★★ |
| T2.8 | Multi-location / multi-DBA support | M | ★★★ |
| T2.9 | Mystery-shopper mode | S | ★★★ |
| T2.10 | Dealer mobile PWA | L | ★★★★ |

## Tier 3 — Moonshots

| # | Feature | Effort | Value |
|---|---------|--------|-------|
| T3.1 | Dynamic pricing recommender | XL | ★★★★ |
| T3.2 | Inventory acquisition signal (Saturday-auction shopping list) | XL | ★★★★★ |
| T3.3 | Dealer voice clone for outbound (with consent) | L | ★★★ |
| T3.4 | Co-op subprime / BHPH financing marketplace | XL | ★★★★ |
| T3.5 | Insurance partner offer at booking moment | M | ★★★ |
| T3.6 | Title/registration concierge | L | ★★ |

## Tier 4 — Business-model adjacencies

| # | Offering | Effort | Value |
|---|----------|--------|-------|
| T4.1 | White-glove "done-for-you Marketplace" tier ($999/mo) | S | ★★★★ |
| T4.2 | Lead-share network (revenue-share excess hot leads) | M | ★★★★★ |
| T4.3 | Weekly founder-led "Closes of the Week" Loom | S | ★★★★ |
| T4.4 | Switch-from-AutoTrader migration program | M | ★★★ |

## The "10x for 2x" picks (highest leverage)

1. **T1.1** Voice channel — same brain, doubles the value prop
2. **T2.1** Spanish-native training — incumbents cannot copy a founder-curated corpus
3. **T2.5** Outbound re-engagement — turns LotPilot from cost into revenue source
4. **T3.2** Inventory acquisition signal — ships founder's auction edge into the product, raises ACV 3–5x
5. **T4.2** Lead-share network — only feature here with true network effects

## Anti-features (do NOT build)

- ❌ A full DMS replacement
- ❌ A horizontal "marketing automation" suite
- ❌ Open API / Zapier / "build your own automations" — independents want it done for them
