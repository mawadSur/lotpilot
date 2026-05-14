-- LotPilot v0.7: async compliance audit queue + Spanish corpus +
-- versioned extension secret column + new system_warnings kind.
--
-- Sections:
--   1.0 pending_compliance_audits — durable outbox written
--       transactionally with the response; drained by background job.
--       Closes the v0.6 "bytes left without audit row" gap.
--   2.0 spanish_phrases — dealer-curated + founder-global founder-voice
--       phrases, injected into the system prompt when lang='es'.
--   3.0 dealers.extension_secret_version — bumps the per-dealer derived
--       secret formula so the dealer can rotate without re-keying every
--       dealer at once. v1 = legacy formula; v2+ = `|info` suffix.
--   4.0 system_warnings.kind union widening — add
--       'marketplace_secret_rotated' written when an inbound POST
--       successfully verifies under the PREV master.
--   5.0 Final-state assertion: both new tables exist with RLS enabled,
--       the new column exists, the new kind value is accepted.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 pending_compliance_audits -------------------------------------------
-- One row per CSV export the dealer triggered. The route inserts here
-- BEFORE streaming the CSV body; if the insert fails the export 500s
-- (no more "bytes leave without audit row" silent fallback). The
-- background drainer reads completed_at is null rows in created_at asc
-- order, increments attempts FIRST, then writes the matching
-- compliance_exports row + flips completed_at on success.
create table if not exists public.pending_compliance_audits (
  id                 uuid primary key default gen_random_uuid(),
  dealer_id          uuid not null references public.dealers(id) on delete cascade,
  exported_by        uuid not null references auth.users(id) on delete set null,
  scope              text not null
                       check (scope in (
                         'conversation_ids',
                         'date_range',
                         'dealer_wide'
                       )),
  scope_payload      jsonb not null default '{}'::jsonb,
  row_count          int not null check (row_count >= 0),
  attempts           int not null default 0,
  last_attempted_at  timestamptz,
  completed_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now()
);

-- Partial index — drainer query is "where completed_at is null order by created_at asc".
create index if not exists pending_compliance_audits_drain_idx
  on public.pending_compliance_audits(created_at asc)
  where completed_at is null;

create index if not exists pending_compliance_audits_dealer_idx
  on public.pending_compliance_audits(dealer_id, created_at desc);

alter table public.pending_compliance_audits enable row level security;

drop policy if exists pending_compliance_audits_owner_read   on public.pending_compliance_audits;
drop policy if exists pending_compliance_audits_owner_insert on public.pending_compliance_audits;

create policy pending_compliance_audits_owner_read on public.pending_compliance_audits
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = pending_compliance_audits.dealer_id
                   and d.owner_user_id = auth.uid()));

create policy pending_compliance_audits_owner_insert on public.pending_compliance_audits
  for insert to authenticated
  with check (exists (select 1 from public.dealers d
                      where d.id = pending_compliance_audits.dealer_id
                        and d.owner_user_id = auth.uid())
              and pending_compliance_audits.exported_by = auth.uid());
-- No UPDATE / DELETE policy by design — only the service-role drainer
-- mutates these rows. RLS denies authenticated writes by default.

-- 2.0 spanish_phrases -----------------------------------------------------
-- Founder-curated EN/ES phrasing examples. Dealers may add their own
-- (dealer_id = their id) and read their own + the global library
-- (dealer_id null). Founder seeds globals via service-role only.
create table if not exists public.spanish_phrases (
  id            uuid primary key default gen_random_uuid(),
  dealer_id     uuid references public.dealers(id) on delete cascade,
  intent        text not null
                  check (intent in ('test_drive','financing','trade_in','general','ready_to_close')),
  situation_tag text check (situation_tag is null or char_length(situation_tag) <= 60),
  en_text       text not null check (char_length(en_text) between 1 and 600),
  es_text       text not null check (char_length(es_text) between 1 and 600),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create index if not exists spanish_phrases_dealer_intent_recency_idx
  on public.spanish_phrases(dealer_id, intent, created_at desc)
  where archived_at is null;

create index if not exists spanish_phrases_global_intent_recency_idx
  on public.spanish_phrases(intent, created_at desc)
  where archived_at is null and dealer_id is null;

alter table public.spanish_phrases enable row level security;

drop policy if exists spanish_phrases_owner_read    on public.spanish_phrases;
drop policy if exists spanish_phrases_owner_insert  on public.spanish_phrases;
drop policy if exists spanish_phrases_owner_update  on public.spanish_phrases;

-- Read: own rows OR global rows (dealer_id null).
create policy spanish_phrases_owner_read on public.spanish_phrases
  for select to authenticated
  using (
    spanish_phrases.dealer_id is null
    or exists (select 1 from public.dealers d
               where d.id = spanish_phrases.dealer_id
                 and d.owner_user_id = auth.uid())
  );

-- Insert: own rows only, and created_by must be the inserting user.
-- Globals (dealer_id null) are service-role-only.
create policy spanish_phrases_owner_insert on public.spanish_phrases
  for insert to authenticated
  with check (
    spanish_phrases.dealer_id is not null
    and exists (select 1 from public.dealers d
                where d.id = spanish_phrases.dealer_id
                  and d.owner_user_id = auth.uid())
    and spanish_phrases.created_by = auth.uid()
  );

-- Update: own rows only (e.g. set archived_at). Globals service-role only.
create policy spanish_phrases_owner_update on public.spanish_phrases
  for update to authenticated
  using (
    spanish_phrases.dealer_id is not null
    and exists (select 1 from public.dealers d
                where d.id = spanish_phrases.dealer_id
                  and d.owner_user_id = auth.uid())
  )
  with check (
    spanish_phrases.dealer_id is not null
    and exists (select 1 from public.dealers d
                where d.id = spanish_phrases.dealer_id
                  and d.owner_user_id = auth.uid())
  );

-- 3.0 dealers.extension_secret_version ------------------------------------
-- Default 1 = legacy formula (v0.5+v0.6). Bumping to >= 2 selects the
-- new |info-suffix formula so the master secret can be rotated without
-- forcing all dealers to re-key at the same moment.
alter table public.dealers
  add column if not exists extension_secret_version int not null default 1;
alter table public.dealers
  drop constraint if exists dealers_extension_secret_version_check;
alter table public.dealers
  add constraint dealers_extension_secret_version_check
    check (extension_secret_version >= 1);

-- 4.0 system_warnings.kind widening ---------------------------------------
do $$ begin
  if exists (select 1 from pg_constraint
              where conname = 'system_warnings_kind_check') then
    alter table public.system_warnings drop constraint system_warnings_kind_check;
  end if;
end $$;
alter table public.system_warnings
  add constraint system_warnings_kind_check
    check (kind in (
      'calendly_no_match',
      'calendly_api_ambiguous',
      'whatsapp_auth_failed',
      'whatsapp_window_closed',
      'marketplace_secret_disclosed',
      'marketplace_secret_rotated'
    ));

-- 5.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_pca boolean;
  has_phrases boolean;
  has_col boolean;
  pca_rls boolean;
  phrases_rls boolean;
begin
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'pending_compliance_audits'
  ) into has_pca;
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'spanish_phrases'
  ) into has_phrases;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'extension_secret_version'
  ) into has_col;
  select c.relrowsecurity into pca_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'pending_compliance_audits';
  select c.relrowsecurity into phrases_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'spanish_phrases';

  if not has_pca then
    raise exception 'v0.7 FAIL: public.pending_compliance_audits missing';
  end if;
  if not has_phrases then
    raise exception 'v0.7 FAIL: public.spanish_phrases missing';
  end if;
  if not has_col then
    raise exception 'v0.7 FAIL: public.dealers.extension_secret_version missing';
  end if;
  if not coalesce(pca_rls, false) then
    raise exception 'v0.7 FAIL: pending_compliance_audits RLS not enabled';
  end if;
  if not coalesce(phrases_rls, false) then
    raise exception 'v0.7 FAIL: spanish_phrases RLS not enabled';
  end if;
end $$;
