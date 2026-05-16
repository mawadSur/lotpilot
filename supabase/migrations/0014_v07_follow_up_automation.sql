-- LotPilot v0.7+ T1.9: Post-test-drive follow-up automation (24h/72h/7d).
--
-- Sections:
--   1.0 conversations.test_drive_status — tri-state lifecycle on the
--       booked test drive: null (not driven yet), 'completed' (event_ended
--       fired OR cron sweep noticed scheduled_at < now), 'no_show'
--       (Calendly invitee.no_show — reserved for T1.7).
--   2.0 follow_up_jobs — durable queue of post-drive follow-up sends.
--       Three rows are enqueued per completed test drive (+24h, +72h,
--       +168h). Cancelled-on-reply / cancelled-on-sold flips
--       cancelled_at; sent_at is set by the cron drainer.
--   3.0 RLS: dealer owners can READ their own rows for inspection;
--       only the service-role drainer mutates them.
--   4.0 Final-state assertion.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 conversations.test_drive_status -------------------------------------
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'conversations'
       and column_name = 'test_drive_status'
  ) then
    alter table public.conversations
      add column test_drive_status text
        check (test_drive_status is null
               or test_drive_status in ('completed','no_show'));
  end if;
end $$;

-- 2.0 follow_up_jobs ------------------------------------------------------
-- One row per planned send. step ∈ {1,2,3} maps to +24h/+72h/+168h.
-- send_at: when the cron drainer becomes eligible to dispatch this row.
-- sent_at: set by the drainer after a successful AI-reply + dispatch.
-- cancelled_at: set when the buyer replies on the thread, or
--   lead_status flips to 'sold' / 'lost', or the buyer opts out (STOP).
-- last_error / attempts: drainer telemetry, mirrors pending_compliance_audits.
create table if not exists public.follow_up_jobs (
  id                 uuid primary key default gen_random_uuid(),
  dealer_id          uuid not null references public.dealers(id) on delete cascade,
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  step               smallint not null check (step in (1, 2, 3)),
  send_at            timestamptz not null,
  sent_at            timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text check (cancel_reason is null or cancel_reason in (
                       'buyer_replied',
                       'lead_sold',
                       'lead_lost',
                       'opted_out',
                       'no_consent'
                     )),
  attempts           int not null default 0,
  last_attempted_at  timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  -- One row per (conversation, step). The drainer + the scheduler both
  -- rely on this to make ON CONFLICT DO NOTHING enqueue idempotent on
  -- a retried Calendly event_ended callback.
  constraint follow_up_jobs_conversation_step_uq
    unique (conversation_id, step)
);

-- Drainer query: "where sent_at is null and cancelled_at is null and
-- send_at <= now() order by send_at asc". Partial index keeps it cheap.
create index if not exists follow_up_jobs_due_idx
  on public.follow_up_jobs(send_at asc)
  where sent_at is null and cancelled_at is null;

-- Cancel-on-reply query reads "all open jobs for this conversation".
create index if not exists follow_up_jobs_conversation_open_idx
  on public.follow_up_jobs(conversation_id)
  where sent_at is null and cancelled_at is null;

-- Dealer dashboard inspection query: oldest-pending per dealer.
create index if not exists follow_up_jobs_dealer_idx
  on public.follow_up_jobs(dealer_id, created_at desc);

alter table public.follow_up_jobs enable row level security;

drop policy if exists follow_up_jobs_owner_read on public.follow_up_jobs;

-- Dealer owners may READ their own follow-up jobs (so a future
-- dashboard tile can show "queued: 12, sent: 47, cancelled: 9"). No
-- authenticated INSERT/UPDATE/DELETE policy on purpose — only the
-- service-role scheduler + drainer mutate these rows. RLS denies
-- authenticated writes by default in the absence of a policy.
create policy follow_up_jobs_owner_read on public.follow_up_jobs
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = follow_up_jobs.dealer_id
                   and d.owner_user_id = auth.uid()));

-- 3.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_fuj boolean;
  fuj_rls boolean;
  has_col boolean;
begin
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'follow_up_jobs'
  ) into has_fuj;
  select c.relrowsecurity into fuj_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'follow_up_jobs';
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'conversations'
       and column_name = 'test_drive_status'
  ) into has_col;

  if not has_fuj then
    raise exception 'T1.9 FAIL: public.follow_up_jobs missing';
  end if;
  if not coalesce(fuj_rls, false) then
    raise exception 'T1.9 FAIL: follow_up_jobs RLS not enabled';
  end if;
  if not has_col then
    raise exception 'T1.9 FAIL: conversations.test_drive_status missing';
  end if;
end $$;
