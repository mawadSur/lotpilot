-- LotPilot v0.7 T1.7: no-show predictor + auto-confirmation reminders.
--
-- Sections:
--   1.0 dealers.auto_confirm_enabled — per-dealer kill switch for the
--       T1.7 auto-confirm cadence. Default TRUE so existing dealers
--       opt in by default (this is a retention feature; defaulting OFF
--       would silently leave money on the table). Settings UI is the
--       follow-up — for v0.7.2 we live with the column default.
--   2.0 scheduled_reminders — durable outbox of pending reminder sends
--       enqueued by the calendly webhook on booked + drained by
--       /api/internal/drain-reminders. Mirrors the v0.7
--       pending_compliance_audits shape (created/attempts/completed_at)
--       so a single cron pattern handles both queues — no new
--       scheduler is introduced.
--   3.0 Final-state assertions.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 dealers.auto_confirm_enabled ----------------------------------------
-- Per-dealer opt-out. The drainer reads this on every send so a dealer
-- can flip the toggle and stop reminders mid-queue (we DO NOT delete
-- queued rows on flip — they're skipped at send time, marked
-- completed with last_error='auto_confirm_disabled' for auditability).
alter table public.dealers
  add column if not exists auto_confirm_enabled boolean not null default true;

-- 2.0 scheduled_reminders -------------------------------------------------
-- One row per scheduled outbound send. Two rows per booking when risk
-- tier is medium/high (24h + 2h); one row for low (24h only).
--
-- kind:
--   'confirm_24h' — friendly EN/ES confirmation, fired ~24h before.
--   'confirm_2h'  — medium/high risk follow-up, fired ~2h before.
--
-- payload jsonb carries the snapshotted message body + risk score +
-- tier at enqueue time so the drainer doesn't re-compute risk (the
-- conversation could've evolved between enqueue and drain).
--
-- The send_at column is what the drainer queries. We use a partial
-- index over (send_at) WHERE completed_at IS NULL so the drainer is
-- a fast index scan.
create table if not exists public.scheduled_reminders (
  id                 uuid primary key default gen_random_uuid(),
  dealer_id          uuid not null references public.dealers(id) on delete cascade,
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  kind               text not null check (kind in ('confirm_24h','confirm_2h')),
  -- Snapshot at enqueue time. Drainer reads these and DOES NOT recompute
  -- risk (the conversation could've changed; we want stable "what we
  -- decided at booking time" for audit).
  risk_score         numeric(4,3) not null check (risk_score >= 0 and risk_score <= 1),
  risk_tier          text not null check (risk_tier in ('low','medium','high')),
  -- Bilingual message bodies. We pick one at drain time based on
  -- conversation.language. Stored at enqueue time so a re-key on the
  -- AI provider doesn't change historical reminder copy.
  body_en            text not null check (char_length(body_en) between 1 and 600),
  body_es            text not null check (char_length(body_es) between 1 and 600),
  -- When the drainer should pick this row up. Drainer query:
  -- WHERE completed_at IS NULL AND send_at <= now().
  send_at            timestamptz not null,
  -- Outbox bookkeeping mirrors pending_compliance_audits exactly.
  attempts           int not null default 0,
  last_attempted_at  timestamptz,
  completed_at       timestamptz,
  last_error         text,
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Drainer hot path: pending rows whose send_at is due. Partial index
-- keeps the working set small even as completed rows accumulate.
create index if not exists scheduled_reminders_due_idx
  on public.scheduled_reminders(send_at asc)
  where completed_at is null;

-- Dealer-scoped listing for the (future) dashboard surface.
create index if not exists scheduled_reminders_dealer_idx
  on public.scheduled_reminders(dealer_id, created_at desc);

-- One pending row per (conversation_id, kind). If the calendly webhook
-- fires twice for the same booking (Calendly retries) we DO NOT want a
-- second reminder enqueued. This partial unique index allows
-- re-enqueueing AFTER completion (e.g. if the user re-books), which is
-- correct behaviour — completed rows are historical.
create unique index if not exists scheduled_reminders_pending_unique_idx
  on public.scheduled_reminders(conversation_id, kind)
  where completed_at is null;

alter table public.scheduled_reminders enable row level security;

drop policy if exists scheduled_reminders_owner_read on public.scheduled_reminders;

-- Read-only RLS for dealers (audit/inbox surface). Writes are
-- service-role only — the calendly webhook + drainer both run under
-- service-role keys, never authenticated user sessions.
create policy scheduled_reminders_owner_read on public.scheduled_reminders
  for select to authenticated
  using (exists (
    select 1 from public.dealers d
    where d.id = scheduled_reminders.dealer_id
      and d.owner_user_id = auth.uid()
  ));

-- 3.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_col boolean;
  has_table boolean;
  table_rls boolean;
  has_due_idx boolean;
  has_unique_idx boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'auto_confirm_enabled'
  ) into has_col;
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'scheduled_reminders'
  ) into has_table;
  select c.relrowsecurity into table_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'scheduled_reminders';
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'scheduled_reminders_due_idx'
  ) into has_due_idx;
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'scheduled_reminders_pending_unique_idx'
  ) into has_unique_idx;

  if not has_col then
    raise exception 'T1.7 FAIL: public.dealers.auto_confirm_enabled missing';
  end if;
  if not has_table then
    raise exception 'T1.7 FAIL: public.scheduled_reminders missing';
  end if;
  if not coalesce(table_rls, false) then
    raise exception 'T1.7 FAIL: scheduled_reminders RLS not enabled';
  end if;
  if not has_due_idx then
    raise exception 'T1.7 FAIL: scheduled_reminders_due_idx missing';
  end if;
  if not has_unique_idx then
    raise exception 'T1.7 FAIL: scheduled_reminders_pending_unique_idx missing';
  end if;
end $$;
