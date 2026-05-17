-- LotPilot T4.2 (MVP): Lead-share network with TCPA re-consent.
--
-- The hand-off flow:
--   1. Source dealer marks a conversation as "share to dealer X".
--      → INSERT lead_shares (status='pending').
--   2. Backend sends a consent SMS from SOURCE dealer's number:
--      "[Source] is referring you to [Target] for a [vehicle type].
--       Reply YES to share your conversation, NO to stay here."
--      → status='consent_sent', consent_sent_at=now().
--   3a. Buyer YES → status='accepted', fork the conversation into a new
--       row under target_dealer_id, copy the source consent into a new
--       consent row for the target dealer (consent_text captures the
--       full source-dealer SMS body), create a 'system' message in the
--       source thread noting the handoff.
--   3b. Buyer NO → status='declined', system message in source thread.
--   3c. No reply after 48h → status='expired' (lazy check at access
--       time for MVP; cron sweep is a v2 addition).
--
-- Sections:
--   1.0 conversations.forked_from_conversation_id — provenance link
--       (target → source) so the forked thread always knows where it
--       came from. NULL for non-fork conversations.
--   2.0 lead_shares table — the share lifecycle row.
--   3.0 RLS — both source and target dealer can READ their own shares;
--       only the service role mutates state (transitions are driven by
--       the keyword pipeline / inbox action route).
--   4.0 Append-only audit constraint: no UPDATE policy for
--       authenticated. Lifecycle state transitions are service-role
--       only — the source dealer cannot retroactively rewrite a
--       'declined' to 'accepted' to escape an audit trail.
--   5.0 Final-state assertion.
--
-- TCPA notes:
--   - The source dealer must already have consent on file with the
--     buyer (consents row + not suppressed_at). initiateLeadShare()
--     in src/lib/lead-share/initiate.ts is the only writer; it checks
--     consent BEFORE the SMS goes out and marks the share 'cancelled'
--     with last_error='no_consent' if absent.
--   - The target dealer NEVER messages the buyer until status='accepted'.
--     The fork creates the target conversation but the chat-pipeline
--     for that conversation can only send IF the consent row carried
--     over.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 conversations.forked_from_conversation_id ---------------------------
-- Provenance link on the FORKED (target dealer) side. NULL on every
-- non-fork row. We don't add a reverse `forked_to_conversation_id` to
-- the source row because a single source conversation can theoretically
-- spawn multiple fork attempts over time (each with its own lead_shares
-- row) — the lead_shares table is the authoritative join.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'conversations'
       and column_name = 'forked_from_conversation_id'
  ) then
    alter table public.conversations
      add column forked_from_conversation_id uuid
        references public.conversations(id) on delete set null;
  end if;
end $$;

create index if not exists conversations_forked_from_idx
  on public.conversations(forked_from_conversation_id)
  where forked_from_conversation_id is not null;

-- 2.0 lead_shares ---------------------------------------------------------
-- One row per handoff attempt. status moves forward only:
--   pending → consent_sent → (accepted | declined | expired | cancelled)
-- 'pending' exists only briefly between the INSERT and the consent SMS
-- send; persisted so we have a row to rollback to on SMS failure.
create table if not exists public.lead_shares (
  id                       uuid primary key default gen_random_uuid(),
  source_dealer_id         uuid not null references public.dealers(id) on delete cascade,
  target_dealer_id         uuid not null references public.dealers(id) on delete cascade,
  source_conversation_id   uuid not null references public.conversations(id) on delete cascade,
  forked_conversation_id   uuid references public.conversations(id) on delete set null,
  status                   text not null default 'pending'
                            check (status in (
                              'pending',       -- row inserted, SMS not yet sent
                              'consent_sent',  -- SMS sent, awaiting buyer YES/NO
                              'accepted',      -- buyer YES → fork created
                              'declined',      -- buyer NO
                              'expired',       -- 48h timeout
                              'cancelled'      -- pre-send abort (no_consent, missing_phone, etc.)
                            )),
  -- The default 50/50 split is a placeholder — real cuts come from a
  -- per-pair agreement; the column exists for record-keeping only and
  -- is not enforced by any payment processing in the MVP.
  revenue_split_pct        numeric(5,2) not null default 50.00
                            check (revenue_split_pct between 0 and 100),
  consent_message_id       uuid references public.messages(id) on delete set null,
  consent_sent_at          timestamptz,
  accepted_at              timestamptz,
  declined_at              timestamptz,
  expired_at               timestamptz,
  cancelled_at             timestamptz,
  cancel_reason            text check (cancel_reason is null or char_length(cancel_reason) <= 80),
  notes                    text check (notes is null or char_length(notes) <= 500),
  created_by_user_id       uuid not null references auth.users(id) on delete restrict,
  created_at               timestamptz not null default now(),

  -- TCPA guard: source and target must differ. A self-share would
  -- double-message the buyer with no new value.
  constraint lead_shares_source_target_differ_check
    check (source_dealer_id <> target_dealer_id)
);

-- Only ONE open share per source conversation at a time. Re-sharing is
-- allowed AFTER the prior one terminates (accepted/declined/expired/
-- cancelled). Partial unique index, same pattern as
-- scheduled_reminders_pending_unique_idx (0013).
create unique index if not exists lead_shares_one_open_per_source_idx
  on public.lead_shares(source_conversation_id)
  where status in ('pending', 'consent_sent');

-- Status lookups — source-dealer inbox + target-dealer "incoming"
-- listing. Two indexes because both sides need to walk by recency.
create index if not exists lead_shares_source_dealer_idx
  on public.lead_shares(source_dealer_id, created_at desc);
create index if not exists lead_shares_target_dealer_idx
  on public.lead_shares(target_dealer_id, created_at desc);
-- Hot path: respond.ts looks up "pending consent for THIS conversation"
-- when a buyer SMS arrives. Partial index keeps it cheap.
create index if not exists lead_shares_pending_by_conversation_idx
  on public.lead_shares(source_conversation_id)
  where status = 'consent_sent';

alter table public.lead_shares enable row level security;

drop policy if exists lead_shares_owner_read on public.lead_shares;
drop policy if exists lead_shares_target_read on public.lead_shares;

-- 3.0 RLS read policies ---------------------------------------------------
-- Source dealer can read every share they initiated.
create policy lead_shares_owner_read on public.lead_shares
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = lead_shares.source_dealer_id
                   and d.owner_user_id = auth.uid()));
-- Target dealer can read every share that named them (so the inbox can
-- surface "incoming referrals"). They CAN read pending/consent_sent
-- rows — surfacing "1 referral pending consent" is useful UX. They
-- CANNOT mutate (no INSERT/UPDATE policy for authenticated).
create policy lead_shares_target_read on public.lead_shares
  for select to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = lead_shares.target_dealer_id
                   and d.owner_user_id = auth.uid()));

-- 4.0 No authenticated INSERT/UPDATE/DELETE. The source dealer's
-- inbox action is a Next.js server action that calls into the service
-- role (mirrors how updateConversation's lead_status=sold/lost path
-- already does in inbox/actions.ts). Anti-tamper: a source dealer
-- cannot flip status='declined' → 'accepted' after the buyer said no.

-- 5.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_col boolean;
  has_table boolean;
  table_rls boolean;
  has_unique_idx boolean;
  writer_policies int;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'conversations'
       and column_name = 'forked_from_conversation_id'
  ) into has_col;
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'lead_shares'
  ) into has_table;
  select c.relrowsecurity into table_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'lead_shares';
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'lead_shares_one_open_per_source_idx'
  ) into has_unique_idx;
  -- Mutations must remain service-role only. This count must stay 0.
  select count(*) into writer_policies
    from pg_policies
   where schemaname = 'public'
     and tablename = 'lead_shares'
     and cmd in ('INSERT','UPDATE','DELETE');

  if not has_col then
    raise exception 'T4.2 FAIL: conversations.forked_from_conversation_id missing';
  end if;
  if not has_table then
    raise exception 'T4.2 FAIL: public.lead_shares missing';
  end if;
  if not coalesce(table_rls, false) then
    raise exception 'T4.2 FAIL: lead_shares RLS not enabled';
  end if;
  if not has_unique_idx then
    raise exception 'T4.2 FAIL: lead_shares_one_open_per_source_idx missing';
  end if;
  if writer_policies > 0 then
    raise exception 'T4.2 FAIL: lead_shares has writer policies (mutations must be service-role only)';
  end if;
end $$;
