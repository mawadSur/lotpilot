-- LotPilot v0.3: marketplace relay channel, voice scaffold, listing
-- optimizer suggestions, and a `scheduled_at` column on conversations
-- so the test-drive reminder query can drop its per-row N+1.
--
-- v0.2 RLS posture carries forward: the dashboard reaches relay /
-- voice / suggestion tables only via authenticated dealers; the chat
-- pipeline writes via the service role just like web/sms.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 conversations.scheduled_at — when the buyer's test drive is
-- on the books. Set inside chat-pipeline.ts when an AI test_drive +
-- offered_calendly turn fires; v0.4 will receive Calendly webhooks.
alter table public.conversations
  add column if not exists scheduled_at timestamptz;
-- Partial index aligned to the dashboard's "what's coming up?" query —
-- we only ever scan booked + scheduled rows.
create index if not exists conversations_scheduled_at_idx
  on public.conversations(dealer_id, scheduled_at)
  where scheduled_at is not null and lead_status = 'booked';

-- 1.1 Channel union widening. New channels: 'relay' (paste/copy
-- Marketplace) and 'voice' (Vapi). Drop+recreate the CHECKs on every
-- table that holds a channel value, including consents + keyword_events
-- (easy to miss; would 23514 on the very first relay turn).
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table public.conversations drop constraint conversations_channel_check;
  end if;
end $$;
alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('web','sms','relay','voice'));

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'messages_delivery_channel_check') then
    alter table public.messages drop constraint messages_delivery_channel_check;
  end if;
end $$;
alter table public.messages
  add constraint messages_delivery_channel_check
    check (delivery_channel is null or delivery_channel in ('web','sms','relay','voice'));

alter table public.consents drop constraint if exists consents_channel_check;
alter table public.consents add constraint consents_channel_check
  check (channel in ('web','sms','relay','voice'));

alter table public.keyword_events drop constraint if exists keyword_events_channel_check;
alter table public.keyword_events add constraint keyword_events_channel_check
  check (channel in ('web','sms','relay','voice'));

-- 1.2 dealers.voice_number — E.164 inbound voice number from Vapi.
alter table public.dealers
  add column if not exists voice_number text
    check (voice_number is null or voice_number ~ '^\+[1-9][0-9]{7,14}$');
create unique index if not exists dealers_voice_number_idx
  on public.dealers(voice_number) where voice_number is not null;

-- Re-apply the v0.2 anon column allow-list. voice_number is dealer-only;
-- the public widget never needs it.
revoke all on public.dealers from anon;
grant select (id, slug, name, signature, calendly_url, business_hours, timezone)
  on public.dealers to anon;

-- 1.3 listing_suggestions: cached AI-generated Marketplace variants
-- per vehicle. The endpoint that produces these caps at 3 per call;
-- we deliberately do NOT enforce "exactly 3 per vehicle" in SQL so a
-- regenerate can replace, accept-then-discard, or future-grow.
create table if not exists public.listing_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  vehicle_id         uuid not null references public.vehicles(id) on delete cascade,
  dealer_id          uuid not null references public.dealers(id)  on delete cascade,
  title              text not null check (char_length(title) between 1 and 120),
  description        text not null check (char_length(description) between 1 and 4000),
  photo_order_hint   text[] check (photo_order_hint is null or cardinality(photo_order_hint) <= 20),
  rationale          text   check (rationale is null or char_length(rationale) <= 1000),
  accepted_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists listing_suggestions_dealer_idx
  on public.listing_suggestions(dealer_id, created_at desc);
create index if not exists listing_suggestions_vehicle_accepted_idx
  on public.listing_suggestions(vehicle_id) where accepted_at is not null;

alter table public.listing_suggestions enable row level security;

drop policy if exists listing_suggestions_owner_all on public.listing_suggestions;
create policy listing_suggestions_owner_all on public.listing_suggestions
  for all to authenticated
  using (exists (select 1 from public.dealers d
                 where d.id = listing_suggestions.dealer_id
                   and d.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.dealers d
                      where d.id = listing_suggestions.dealer_id
                        and d.owner_user_id = auth.uid()));

-- 1.4 dashboard_sla_stats(dealer_id uuid) — per-day rollup of first
-- AI reply latency for the SLA tile. SECURITY DEFINER + a fixed
-- search_path so a server component can call it through the RLS-aware
-- session client. SECURITY DEFINER bypasses RLS, so we explicitly
-- enforce dealer ownership inside the CTE filter — without this,
-- any authenticated user could read another dealer's daily latency
-- and lead-volume stats by passing their dealer_id.
create or replace function public.dashboard_sla_stats(dealer_id uuid)
returns table (
  day_bucket  timestamptz,
  conv_count  bigint,
  under_60s   bigint,
  median_sec  double precision,
  p95_sec     double precision
)
language sql
security definer
set search_path = public
as $$
  with first_msgs as (
    select c.id as conv_id,
           min(case when m.role = 'buyer' then m.created_at end) as first_buyer,
           min(case when m.role = 'ai'
                     and m.approval_status in ('auto','approved','sent')
                    then m.created_at end) as first_ai,
           date_trunc('day', c.created_at) as day_bucket
      from public.conversations c
      join public.messages m on m.conversation_id = c.id
     where c.dealer_id = dashboard_sla_stats.dealer_id
       and exists (
         select 1 from public.dealers d
          where d.id = dashboard_sla_stats.dealer_id
            and d.owner_user_id = auth.uid()
       )
       and c.created_at > now() - interval '7 days'
     group by c.id, c.created_at
  )
  select day_bucket,
         count(*) filter (where first_ai is not null) as conv_count,
         count(*) filter (
           where first_ai is not null
             and extract(epoch from (first_ai - first_buyer)) < 60
         ) as under_60s,
         percentile_cont(0.5) within group (
           order by extract(epoch from (first_ai - first_buyer))
         ) filter (where first_ai is not null) as median_sec,
         percentile_cont(0.95) within group (
           order by extract(epoch from (first_ai - first_buyer))
         ) filter (where first_ai is not null) as p95_sec
    from first_msgs
   group by day_bucket
   order by day_bucket;
$$;

revoke all on function public.dashboard_sla_stats(uuid) from public;
grant execute on function public.dashboard_sla_stats(uuid) to authenticated;
