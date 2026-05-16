-- LotPilot T2.5: Outbound re-engagement on inventory match.
--
-- TCPA-critical surface. The schema here exists to back the gates
-- enforced in src/lib/re-engagement/send.ts; the SQL contract MUST
-- match the application contract or a buyer could receive an
-- unsolicited outbound. Every column is a TCPA failsafe:
--
--   re_engagement_audit  — append-only audit row written transactionally
--                          before each outbound dispatch. Regulator-
--                          visible. RLS: owner-read only.
--   vehicle_events       — driver table for the sweep cron. One row per
--                          new_listing / price_drop. Worker walks the
--                          last 24h and emits candidate sends.
--   conversations.buyer_intent_make / model / body_type
--                        — captured during normal chat turns; the
--                          matcher uses substring affinity against
--                          these to pick candidate cold leads.
--
-- Sections:
--   1.0 vehicle_events
--   2.0 re_engagement_audit
--   3.0 conversations.buyer_intent_* columns
--   4.0 Final-state assertion: tables exist with RLS enabled, audit
--       table has no UPDATE/DELETE policy (append-only by design).
--
-- Idempotent: safe to re-run. The application sets these rows via the
-- service role (no dealer auth context in the cron job), so RLS need
-- only enforce owner-read for dashboard surfaces.

create extension if not exists "pgcrypto";

-- 1.0 vehicle_events ------------------------------------------------------
-- The sweep cron reads "last 24h" worth of these and asks match.ts to
-- find cold-lead candidates per event. Source of new_listing rows: the
-- CSV uploader (and any future DMS sync); price_drop rows: the listing
-- optimizer / dealer dashboard. v0.7 ships ONLY the table — backfill
-- hooks land with the producer features.
create table if not exists public.vehicle_events (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid not null references public.dealers(id) on delete cascade,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  kind         text not null check (kind in ('new_listing','price_drop')),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Sweep query is "where created_at > now() - interval '24 hours' order by created_at desc".
create index if not exists vehicle_events_recent_idx
  on public.vehicle_events(created_at desc);
create index if not exists vehicle_events_dealer_idx
  on public.vehicle_events(dealer_id, created_at desc);

alter table public.vehicle_events enable row level security;

drop policy if exists vehicle_events_owner_read on public.vehicle_events;
create policy vehicle_events_owner_read on public.vehicle_events
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = vehicle_events.dealer_id
                   and d.owner_user_id = auth.uid()));
-- No authenticated insert/update/delete. Producers run service-role.

-- 2.0 re_engagement_audit -------------------------------------------------
-- One row per outbound send attempted by the sweep cron. The TCPA
-- guarantee is: NO send leaves the system without a matching audit row.
-- send.ts writes this row SYNCHRONOUSLY before calling sendSms /
-- sendWhatsAppMessage so a transient outbound failure still leaves the
-- attempt logged (preferred posture for a regulator audit).
--
-- content_hash: sha256(message_body). We hash rather than store the
-- body so PII / dealer-voice prompts don't leak into the audit log
-- itself — the actual outbound body lives in the messages table,
-- joined by buyer_id (== conversation_id) at audit time.
--
-- match_reason: free-form short string ("make+model", "body_type",
-- "price_drop_make_model") so a dealer reading the dashboard knows
-- WHY this buyer got pinged.
create table if not exists public.re_engagement_audit (
  id              uuid primary key default gen_random_uuid(),
  dealer_id       uuid not null references public.dealers(id) on delete cascade,
  -- buyer_id maps to conversations.id — the buyer's thread is the
  -- closest stable identity we have for an inbound lead.
  buyer_id        uuid not null references public.conversations(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  vehicle_event_id uuid references public.vehicle_events(id) on delete set null,
  match_reason    text not null check (char_length(match_reason) between 1 and 120),
  channel         text not null check (channel in ('sms','whatsapp')),
  content_hash    text not null check (char_length(content_hash) = 64),
  sent_at         timestamptz not null default now()
);

create index if not exists re_engagement_audit_dealer_sent_idx
  on public.re_engagement_audit(dealer_id, sent_at desc);
create index if not exists re_engagement_audit_buyer_sent_idx
  on public.re_engagement_audit(buyer_id, sent_at desc);
-- For the per-dealer 50/day cap query (sweep gate F).
create index if not exists re_engagement_audit_dealer_day_idx
  on public.re_engagement_audit(dealer_id, sent_at);

alter table public.re_engagement_audit enable row level security;

drop policy if exists re_engagement_audit_owner_read on public.re_engagement_audit;
create policy re_engagement_audit_owner_read on public.re_engagement_audit
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = re_engagement_audit.dealer_id
                   and d.owner_user_id = auth.uid()));
-- No authenticated INSERT/UPDATE/DELETE. Only service-role writes;
-- the append-only contract is enforced by the absence of policies +
-- the cron being the sole writer.

-- 3.0 conversations.buyer_intent_* ---------------------------------------
-- Lightweight free-text capture of what the buyer asked about. The
-- chat pipeline writes these opportunistically when the AI reply
-- mentions a make/model/body_type; the matcher reads them via simple
-- substring contains. We deliberately do NOT add a full-text index
-- here — the match query is bounded to cold leads (lead_score='cold'
-- or null) for a single dealer, so a sequential scan over (typically)
-- < 1k rows is fine.
alter table public.conversations
  add column if not exists buyer_intent_make      text
    check (buyer_intent_make is null or char_length(buyer_intent_make) <= 60);
alter table public.conversations
  add column if not exists buyer_intent_model     text
    check (buyer_intent_model is null or char_length(buyer_intent_model) <= 60);
alter table public.conversations
  add column if not exists buyer_intent_body_type text
    check (buyer_intent_body_type is null or char_length(buyer_intent_body_type) <= 60);

-- 4.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_ve boolean;
  has_audit boolean;
  has_cols boolean;
  ve_rls boolean;
  audit_rls boolean;
  audit_writer_policies int;
begin
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'vehicle_events'
  ) into has_ve;
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 're_engagement_audit'
  ) into has_audit;
  select (
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'conversations'
               and column_name = 'buyer_intent_make')
    and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'conversations'
                  and column_name = 'buyer_intent_model')
    and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'conversations'
                  and column_name = 'buyer_intent_body_type')
  ) into has_cols;
  select c.relrowsecurity into ve_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vehicle_events';
  select c.relrowsecurity into audit_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 're_engagement_audit';
  -- Audit is append-only: only owner_read allowed; no insert/update/delete
  -- policy for authenticated. Anything else means an authenticated user
  -- could rewrite or delete an audit row.
  select count(*) into audit_writer_policies
    from pg_policies
   where schemaname = 'public'
     and tablename = 're_engagement_audit'
     and cmd in ('INSERT','UPDATE','DELETE');

  if not has_ve then
    raise exception 'T2.5 FAIL: public.vehicle_events missing';
  end if;
  if not has_audit then
    raise exception 'T2.5 FAIL: public.re_engagement_audit missing';
  end if;
  if not has_cols then
    raise exception 'T2.5 FAIL: conversations.buyer_intent_* columns missing';
  end if;
  if not coalesce(ve_rls, false) then
    raise exception 'T2.5 FAIL: vehicle_events RLS not enabled';
  end if;
  if not coalesce(audit_rls, false) then
    raise exception 'T2.5 FAIL: re_engagement_audit RLS not enabled';
  end if;
  if audit_writer_policies > 0 then
    raise exception 'T2.5 FAIL: re_engagement_audit has writer policies (audit must be service-role only / append-only)';
  end if;
end $$;
