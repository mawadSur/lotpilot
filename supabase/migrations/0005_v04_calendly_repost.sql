-- LotPilot v0.4: Calendly webhook overwrites + Marketplace auto-repost
-- cadence + listing-optimizer auto-sync (with rollback) + inbox
-- "no recent dealer reply" filter resurrected as a single SQL clause.
--
-- v0.3 RLS posture carries forward unchanged: the dashboard reaches new
-- columns via authenticated dealer policies; the Calendly webhook writes
-- via the service role just like the SMS / voice / web pipeline. No new
-- tables this migration — additive columns + view extension + helper
-- indexes only.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 vehicles.last_listed_at — the last time the dealer (re)posted this
-- vehicle to a marketplace. Drives T2.3 auto-repost cadence: the
-- dashboard tile surfaces vehicles whose last_listed_at is older than
-- the configured window (default 5 days) so the dealer can re-share
-- them. Default `now()` so freshly-uploaded inventory isn't flagged
-- stale on day one.
alter table public.vehicles
  add column if not exists last_listed_at timestamptz not null default now();
-- Partial index aligned to the dashboard repost-tile query — we only
-- ever scan available vehicles, ordered by oldest-first.
create index if not exists vehicles_repost_due_idx
  on public.vehicles(dealer_id, last_listed_at)
  where status = 'available';

-- 1.1 vehicles.title — optional dealer-curated title that overrides the
-- year/make/model fallback used in the inventory UI and (when synced
-- from the optimizer) on Marketplace.
alter table public.vehicles
  add column if not exists title text
    check (title is null or char_length(title) between 1 and 120);

-- 1.2 listing_suggestions.previous_title / previous_description —
-- captured at sync time BEFORE we overwrite vehicles.title /
-- vehicles.description, so a regretful dealer can recover the old copy
-- by re-reading the suggestion row. Researcher risk #1: without this,
-- accept-A → regenerate → accept-B silently stomps A.
alter table public.listing_suggestions
  add column if not exists previous_title text
    check (previous_title is null or char_length(previous_title) between 1 and 120);
alter table public.listing_suggestions
  add column if not exists previous_description text
    check (previous_description is null or char_length(previous_description) between 1 and 4000);

-- 2.0 conversations_with_latest view — extend with last_dealer_reply_at
-- so the dashboard reminder tile can drop bookings where the dealer has
-- already followed up in the past 4h, and the inbox can highlight
-- threads that need an answer.
--
-- "dealer reply" = role='dealer' OR an AI message that was approved /
-- auto-sent to the buyer. role='ai' + approval_status='pending' does
-- NOT count — the buyer has not seen anything yet.
--
-- create-or-replace view STRIPS GRANTS (and the security_invoker
-- setting). We re-apply both immediately afterwards.
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

-- 3.0 No SQL change for relay/voice consent text — those are
-- application-level changes in src/lib/consent.ts and
-- src/lib/chat-pipeline.ts. v0.3.1 carry-over C3: pipeline-level
-- decision is to SKIP the consent insert entirely for channel='relay'
-- (the dealer is the one driving the request, not the buyer). The
-- voice channel continues to write a consent row using a TCPA-compliant
-- voice-specific text helper.
