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

## v0.4 — SHIPPED (deploying)

- Calendly webhook (`/api/calendly/webhook`) — signature-first HMAC + 5-min
  replay window + utm_content-deterministic conversation matching with
  phone + email fallbacks. Updates `scheduled_at` + lead_status='booked' +
  inserts system message
- T2.3 Auto-repost cadence — vehicles older than 5 days surface in
  dashboard tile with "Mark as reposted" + deep link to optimizer
- Listing optimizer auto-sync — opt-in checkbox (default OFF), captures
  `previous_title`/`previous_description` on suggestion row before
  overwriting `vehicles` (recoverable)
- Inbox no-recent-reply filter — re-added as single-SQL `.or()` via
  `last_dealer_reply_at` column on `conversations_with_latest` view
- v0.3.1 carry-overs: relay consent skip with audit log, per-channel
  consent text (TCPA-compliant voice copy), `findOrCreateConversation`
  helper used by both SMS and voice routes
- Pg regression test in `0006_test_isolation.sql` for SECURITY DEFINER
  ownership predicate — catches future cross-dealer leaks
- Reviewer ship-blocker fix: invalid UUID literals (`test01`/`test02`)
  in 0006 replaced with valid hex (`aaaaaa`/`bbbbbb`)

## v0.5 — SHIPPED (deploying)

- **T0.1 / T0.9 partial:** Marketplace browser-extension webhook
  (`/api/marketplace/inbound`) with HMAC signature + ADR documenting the
  extension-bridge architecture (Meta forbids server-side API).
- **T1.2 partial:** WhatsApp Business webhook scaffold
  (`/api/whatsapp/inbound`) — GET verify-token handshake + POST with
  `X-Hub-Signature-256` validation, channel='whatsapp'. Outbound stub
  pending v0.6 (needs verified WABA + phone-number ID).
- **T1.1 activation:** Vapi outbound TTS via direct `POST /call/{id}/control`
  (SDK shape didn't fit HTTP third-party use). Wired to voice route on
  `ai_reply` + non-approve-mode. R1 double-delivery resolved via queued
  gate.
- Calendly API resolver (`lookupEventTypeOwner`) replaces v0.4 slug
  heuristic when `CALENDLY_API_KEY` set. Cache hit → API lookup with
  write-back → fallback.
- Migration 0006 positive control: asserts `dashboard_sla_stats(dealer_a)`
  returns >0 rows BEFORE the leak check (catches false-negative when
  auth.uid() is broken).
- Migration 0007: `dealers.calendly_event_type_uri`,
  `dealers.whatsapp_number`, channel CHECK widening to include
  'marketplace' and 'whatsapp' on all 4 tables.
- **First test scaffold:** vitest + in-process mock harness + 3 tests
  passing (approve-before-send triple filter, STOP suppression cluster A
  + cluster B). Critical TCPA paths now regression-protected.

## v0.6 — SHIPPED (deploying)

- **WhatsApp outbound activation** — real `graph.facebook.com/v18.0`
  POST with bearer auth + 24h-window template fallback + Meta error
  code 131047 detection + 8s `AbortSignal.timeout`. Wired in
  chat-pipeline after AI reply save.
- **Per-dealer Marketplace secret derivation** —
  `deriveDealerSecret(dealerId) = hmac(MASTER, dealerId)` (64-char hex)
  + UUID guard + `dealers.extension_secret_version` column for v0.7
  rotation. Webhook reads `x-lotpilot-dealer-id` header BEFORE HMAC,
  verifies body.dealer_id matches header for tamper resistance.
- **Calendly dashboard warning** — webhook writes `system_warnings`
  rows on no-match / api-ambiguous (PII masked to last 4). Banner +
  dismiss action on dashboard.
- **CI gate** (`.github/workflows/migrations.yml`) — Postgres 15
  service + auth.users stub + `psql -v ON_ERROR_STOP=1` per migration.
  `RAISE EXCEPTION` (0006 positive control, 0008 privacy floor) fails
  the build.
- **T1.4 Lead-quality scoring** — heuristic hot/warm/cold scorer
  reusing `historyAll`. 10 unit tests covering all branches.
- **T1.10 Dealer benchmarking** — `dealer_zip_benchmarks` view with
  3-dealer privacy floor enforced TWICE (SQL `HAVING` + post-migration
  `RAISE EXCEPTION` assertion). Tile renders empty-state below floor.
- **T2.7 Compliance CSV exporter** — `/dashboard/compliance` page +
  streaming `ReadableStream` via authenticated client (RLS-scoped, NOT
  service-role) + 10k row cap + audit row in `compliance_exports`.
- Reviewer ship-blocker fix: contradicting comment on audit-insert
  failure path rewritten to match actual code behavior.

## v0.7.0 — SHIPPED (refactor + CI hardening, deploying)

- chat-persistence.ts extraction — pipeline shrunk from 497 → 402
  lines. `persistAiReply({sb, conversation, dealer, historyAll,
  aiReply, finalReply, approvalStatus, channel, requestId})` returns
  `{saved, savedMessageId}`. dispatchOutbound stays in chat-pipeline.
- CI hardening: `.github/workflows/migrations.yml` uses
  `set -euo pipefail` + load-bearing `cat "$f" | psql` pipe (without
  pipefail, a missing migration file would silently exit 0).

## v0.7.1 — Carry-over (coder stalled mid-build, needs fresh swarm)

- Versioned secret derivation: `hmac(MASTER, "dealerId|lotpilot.marketplace.vN")`
  with `MARKETPLACE_MASTER_SECRET_PREV` grace window. Requires
  `dealers.extension_secret_version int default 1` column.
- Async compliance audit queue: `pending_compliance_audits` table +
  synchronous insert from export route + `/api/internal/drain-audit-queue`
  cron endpoint that drains into `compliance_exports`.
- 0010 regression test for `dealer_zip_benchmarks` (2 dealers in zip3='100'
  below floor must not surface; positive control on zip3='200').
- T1.5 Trade-in valuation scaffold (KBB primary, Manheim secondary,
  `TRADE_IN_PROVIDER=none` default, lazy-import adapter pattern).
- T1.6 Financing pre-qual scaffold (RouteOne primary, 700Credit
  secondary, `FINANCING_PROVIDER=none` default). SSN HARD RULES:
  never accept full 9-digit, only ssn_last4; whitelist log fields;
  sha256(provider_id) reference_hash only.
- T2.1 Spanish-native corpus: `spanish_phrases` table + `/dashboard/spanish-corpus`
  page + `buildSystemPrompt(dealer, vehicles, spanishExamples?)` signature
  extension + `AiCallArgs.spanishExamples` + pipeline fetch when
  `lang==='es'`. Budget cap drops examples before inventory when over
  PROMPT_BUDGET_CHARS.
- 4 new tests: marketplace-tamper, warning-rls, compliance-rls,
  secret-versioning.

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
