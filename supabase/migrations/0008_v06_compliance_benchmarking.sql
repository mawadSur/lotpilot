-- LotPilot v0.6: lead-quality scoring + system warnings + compliance
-- export audit + dealer ZIP3 benchmarking view. v0.5 RLS posture carries
-- forward unchanged. New columns are additive + nullable, new tables
-- scope read+update to the owning dealer.
--
-- Migration order:
--   1.0 dealers.zip / dealers.zip3 + derive-trigger    (benchmark + onboarding)
--   2.0 conversations.lead_score                       (heuristic temperature)
--   3.0 system_warnings table                          (operator banner)
--   4.0 compliance_exports table                       (CSV audit)
--   5.0 conversations_with_latest view extension       (project lead_score)
--   6.0 dealer_zip_benchmarks view (3-dealer floor in SQL, NOT app code)
--   7.0 Re-apply anon column allow-list on dealers     (zip / zip3 server-only)
--   8.0 Privacy-floor migration-time assertion         (belt + braces)
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 dealers.zip + dealers.zip3 -------------------------------------------
-- Full 5-digit ZIP captured at onboarding (Settings / wizard). zip3 is
-- the 3-digit prefix derived by trigger, used as the aggregation key in
-- the benchmark view so the privacy floor (count distinct dealer >= 3
-- per zip3) is broad enough to actually be reachable in a pilot.
alter table public.dealers
  add column if not exists zip text
    check (zip is null or zip ~ '^[0-9]{5}$');
alter table public.dealers
  add column if not exists zip3 text
    check (zip3 is null or zip3 ~ '^[0-9]{3}$');

-- Trigger: keep zip3 in sync with zip on insert/update. We deliberately
-- DO NOT compute zip3 in a GENERATED column because we want app code
-- to be free to set zip3 directly for backfill / test seeding without
-- a dependency on a real zip value.
create or replace function public.derive_zip3() returns trigger as $$
begin
  if new.zip is not null then
    new.zip3 := substr(new.zip, 1, 3);
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists dealers_derive_zip3 on public.dealers;
create trigger dealers_derive_zip3
  before insert or update of zip on public.dealers
  for each row execute function public.derive_zip3();

create index if not exists dealers_zip3_idx
  on public.dealers(zip3) where zip3 is not null;

-- 2.0 conversations.lead_score ---------------------------------------------
-- TEXT enum ('hot'|'warm'|'cold'). Recomputed by chat-pipeline.ts on
-- every AI reply turn from a heuristic over (last_intent,
-- buyer_message_count, intent_sequence). Nullable so old conversations
-- stay null until their next turn — no migration backfill.
alter table public.conversations
  add column if not exists lead_score text;
do $$ begin
  if exists (select 1 from pg_constraint
              where conname = 'conversations_lead_score_check') then
    alter table public.conversations
      drop constraint conversations_lead_score_check;
  end if;
end $$;
alter table public.conversations
  add constraint conversations_lead_score_check
    check (lead_score is null or lead_score in ('hot','warm','cold'));
create index if not exists conversations_lead_score_idx
  on public.conversations(dealer_id, lead_score, updated_at desc)
  where lead_score is not null;

-- 3.0 system_warnings ------------------------------------------------------
-- Operator-visible warnings the dashboard surfaces as a dismissible
-- banner. Written by the service role from the Calendly / WhatsApp /
-- Marketplace paths. Dealers may UPDATE only to set resolved_at; the
-- with-check predicate scopes ownership.
create table if not exists public.system_warnings (
  id           uuid primary key default gen_random_uuid(),
  dealer_id    uuid not null references public.dealers(id) on delete cascade,
  kind         text not null
                 check (kind in (
                   'calendly_no_match',
                   'calendly_api_ambiguous',
                   'whatsapp_auth_failed',
                   'whatsapp_window_closed',
                   'marketplace_secret_disclosed'
                 )),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index if not exists system_warnings_dealer_unresolved_idx
  on public.system_warnings(dealer_id, created_at desc)
  where resolved_at is null;

alter table public.system_warnings enable row level security;

drop policy if exists system_warnings_owner_read   on public.system_warnings;
drop policy if exists system_warnings_owner_update on public.system_warnings;
create policy system_warnings_owner_read on public.system_warnings
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = system_warnings.dealer_id
                   and d.owner_user_id = auth.uid()));
create policy system_warnings_owner_update on public.system_warnings
  for update to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = system_warnings.dealer_id
                   and d.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.dealers d
                      where d.id = system_warnings.dealer_id
                        and d.owner_user_id = auth.uid()));
-- No authenticated INSERT policy on purpose — only the service role
-- writes warnings.

-- 4.0 compliance_exports ---------------------------------------------------
-- Audit row per CSV download. scope captures which mode the dealer
-- chose; scope_payload carries the raw filter (conversation ids,
-- date range, or {} for dealer_wide).
create table if not exists public.compliance_exports (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null references public.dealers(id) on delete cascade,
  exported_by    uuid not null references auth.users(id) on delete set null,
  scope          text not null
                   check (scope in (
                     'conversation_ids',
                     'date_range',
                     'dealer_wide'
                   )),
  scope_payload  jsonb not null default '{}'::jsonb,
  row_count      int not null check (row_count >= 0),
  created_at     timestamptz not null default now()
);
create index if not exists compliance_exports_dealer_idx
  on public.compliance_exports(dealer_id, created_at desc);

alter table public.compliance_exports enable row level security;

drop policy if exists compliance_exports_owner_read   on public.compliance_exports;
drop policy if exists compliance_exports_owner_insert on public.compliance_exports;
create policy compliance_exports_owner_read on public.compliance_exports
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = compliance_exports.dealer_id
                   and d.owner_user_id = auth.uid()));
create policy compliance_exports_owner_insert on public.compliance_exports
  for insert to authenticated
  with check (exists (select 1 from public.dealers d
                      where d.id = compliance_exports.dealer_id
                        and d.owner_user_id = auth.uid())
              and compliance_exports.exported_by = auth.uid());

-- 5.0 conversations_with_latest — project lead_score -----------------------
-- create-or-replace view STRIPS GRANTS + security_invoker flag.
-- Re-apply both immediately afterwards. (Same gotcha as 0005.)
create or replace view public.conversations_with_latest as
select c.*,
       lm.body                  as last_message_body,
       lm.role                  as last_message_role,
       lm.created_at            as last_message_at,
       ldr.last_dealer_reply_at as last_dealer_reply_at,
       (select count(*) from public.messages m
         where m.conversation_id = c.id and m.approval_status = 'pending') as pending_count
  from public.conversations c
  left join lateral (
    select body, role, created_at from public.messages
     where conversation_id = c.id
     order by created_at desc limit 1
  ) lm on true
  left join lateral (
    select created_at as last_dealer_reply_at
      from public.messages
     where conversation_id = c.id
       and (role = 'dealer'
            or (role = 'ai' and approval_status in ('approved','auto','sent')))
     order by created_at desc limit 1
  ) ldr on true;

alter view public.conversations_with_latest set (security_invoker = on);
grant select on public.conversations_with_latest to authenticated;

-- 6.0 dealer_zip_benchmarks ------------------------------------------------
-- Per-dealer rolling-30-day median response + conversion rate, joined
-- with per-zip3 medians. Privacy floor: HAVING count(*) >= 3 inside
-- the view forces dealer_count >= 3 BEFORE any row is returned. App
-- code does NOT filter — the view is the choke point. security_invoker
-- so RLS on conversations + dealers still applies.
create or replace view public.dealer_zip_benchmarks as
with per_dealer as (
  select d.id as dealer_id, d.zip3,
         percentile_cont(0.5) within group (order by
           extract(epoch from (m.created_at - c.created_at))
         ) as median_response_sec,
         avg(case when c.lead_status = 'sold' then 1.0 else 0.0 end) as conversion_rate
    from public.dealers d
    join public.conversations c on c.dealer_id = d.id
    join public.messages m on m.conversation_id = c.id and m.role = 'ai'
   where c.created_at > now() - interval '30 days'
     and d.zip3 is not null
   group by d.id, d.zip3
),
zip_stats as (
  select zip3,
         count(*) as dealer_count,
         percentile_cont(0.5) within group (order by median_response_sec) as zip_median_response_sec,
         percentile_cont(0.5) within group (order by conversion_rate) as zip_median_conversion
    from per_dealer
   group by zip3
  having count(*) >= 3
)
select pd.dealer_id, pd.zip3,
       pd.median_response_sec, pd.conversion_rate,
       zs.zip_median_response_sec, zs.zip_median_conversion,
       zs.dealer_count
  from per_dealer pd
  join zip_stats zs using (zip3);

alter view public.dealer_zip_benchmarks set (security_invoker = on);
grant select on public.dealer_zip_benchmarks to authenticated;

-- 7.0 Re-apply anon column allow-list on dealers ---------------------------
-- zip / zip3 are server-only. The widget never needs them; revoke+grant
-- here keeps the v0.1 + v0.5 posture intact (create-or-replace view +
-- alter table can disturb grants on related tables; safe to re-apply).
revoke all on public.dealers from anon;
grant select (id, slug, name, signature, calendly_url, business_hours, timezone)
  on public.dealers to anon;

-- 8.0 Privacy floor assertion ---------------------------------------------
-- Belt + braces around the SQL HAVING clause in §6. Computes a control
-- count of dealer rows whose zip3 group is below the 3-dealer floor in
-- per_dealer (the input CTE) and confirms NONE of those rows leak into
-- the public view. If any do, RAISE EXCEPTION and fail the migration.
-- Empty pilot databases naturally pass (zero rows in either side).
do $$
declare
  leak_count int;
begin
  with per_dealer as (
    select d.id as dealer_id, d.zip3
      from public.dealers d
      join public.conversations c on c.dealer_id = d.id
      join public.messages m on m.conversation_id = c.id and m.role = 'ai'
     where c.created_at > now() - interval '30 days'
       and d.zip3 is not null
     group by d.id, d.zip3
  ),
  small_zips as (
    select zip3 from per_dealer group by zip3 having count(*) < 3
  )
  select count(distinct b.dealer_id) into leak_count
    from public.dealer_zip_benchmarks b
    join small_zips s on s.zip3 = b.zip3;

  if leak_count > 0 then
    raise exception
      'iso-test FAIL: dealer_zip_benchmarks leaked % dealer rows under the '
      '3-dealer privacy floor. The HAVING count(*) >= 3 clause inside the '
      'view definition is missing or wrong. Fix the view definition; never '
      'rely on app code to filter this.', leak_count;
  end if;
end $$;
