# LotPilot Roadmap

> Source of truth for what we're building, in priority order.
> Mode: **SCOPE EXPANSION** — build the cathedral, ship the full vision.
> All tiers are committed; we will build all of T0 → T4 over time.

Effort: **S** ≤1wk · **M** 1–3wk · **L** 1–2mo · **XL** 3+mo
Value: ★→★★★★★ (impact on retention/revenue/moat)

## v0.1 — Active build (current swarm)

These T0 items are scoped for the first working iteration:

- **T0.7** Dealer onboarding wizard (magic-link auth, dealership profile, signature, business hours, slug)
- **T0.8** Inventory ingestion (CSV upload to start; DMS connectors deferred to v0.2)
- **T0.1** Inbound capture — **web widget only** (`/c/[dealer-slug]`); SMS + Marketplace deferred
- **T0.2** AI reply engine — Anthropic Claude (Sonnet 4.6), founder-voice system prompt + inventory RAG
- **T0.3** Bilingual EN/ES with auto-detect per thread
- **T0.5** Test drive booking — **Calendly link** rendered on intent (per dealer's Calendly URL)
- **T0.6** Per-dealer lead inbox (read-only listing for v0.1; status pipeline in v0.2)
- **T0.10** Per-dealer settings (name, slug, signature, hours, Calendly URL) — minimum viable

## v0.2 — Next swarm (after v0.1 ships)

- **T0.4** Human-in-loop review queue (approve-before-send mode for first 60 days per dealer)
- **T0.6** Lead status pipeline (new → qualified → booked → sold/lost) + assignment
- **T0.11** TCPA compliance foundation (consent capture, STOP/HELP keywords, send-window enforcement)
- **T0.1** SMS channel via Twilio (10DLC registration in parallel)
- **T1.7** No-show predictor + auto-confirmation reminders
- **T1.8** Hot-buyer handoff alerts (push/SMS to closer)

## v0.3 — Marketplace channel

- **T0.9** Marketplace TOS-safe architecture decision (browser extension vs. human-relay) — **needs separate spike + legal**
- **T0.1** Marketplace ingestion (per chosen architecture)
- **T2.3** Auto-repost cadence

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
