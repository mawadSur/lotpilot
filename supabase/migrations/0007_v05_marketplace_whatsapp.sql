-- LotPilot v0.5: Marketplace browser-extension channel + WhatsApp Cloud
-- API channel + a cached Calendly event_type URI on the dealer row.
--
-- v0.4 RLS posture carries forward unchanged. No new tables this
-- migration — additive columns + CHECK widening on every channel-bearing
-- table, plus a partial index for the Calendly cache.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 dealers.calendly_event_type_uri — cache for the Calendly API
-- lookup the webhook now performs first (before the slug-substring
-- heuristic). Set as a side effect of the first successful lookup; once
-- written, the dealer is resolved by exact equality and we never touch
-- the API again for that dealer. Format is the canonical Calendly event
-- type URI: https://api.calendly.com/event_types/<id>.
alter table public.dealers
  add column if not exists calendly_event_type_uri text
    check (calendly_event_type_uri is null
           or calendly_event_type_uri ~ '^https://api\.calendly\.com/event_types/[A-Za-z0-9-]+$');
-- Partial index: every webhook hit does an equality lookup on this
-- column (cache hit path). Skip rows where the cache is unset.
create index if not exists dealers_calendly_event_type_uri_idx
  on public.dealers(calendly_event_type_uri)
  where calendly_event_type_uri is not null;

-- 1.1 dealers.whatsapp_number — E.164 inbound number registered with
-- the WhatsApp Business / Meta Cloud API. Same shape as sms_number /
-- voice_number; unique across dealers when set.
alter table public.dealers
  add column if not exists whatsapp_number text
    check (whatsapp_number is null or whatsapp_number ~ '^\+[1-9][0-9]{7,14}$');
create unique index if not exists dealers_whatsapp_number_idx
  on public.dealers(whatsapp_number) where whatsapp_number is not null;

-- 1.2 Re-apply the v0.2 anon column allow-list. None of the new columns
-- are public-facing — the widget never needs them.
revoke all on public.dealers from anon;
grant select (id, slug, name, signature, calendly_url, business_hours, timezone)
  on public.dealers to anon;

-- 2.0 Channel union widening: include 'marketplace' (browser-extension
-- ingest) and 'whatsapp' (Meta Cloud API). Drop+recreate the CHECKs on
-- every table that holds a channel value: conversations, messages
-- (delivery_channel), consents, keyword_events. Easy to miss; a missed
-- table 23514s on the very first turn for that channel.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table public.conversations drop constraint conversations_channel_check;
  end if;
end $$;
alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('web','sms','relay','voice','marketplace','whatsapp'));

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'messages_delivery_channel_check') then
    alter table public.messages drop constraint messages_delivery_channel_check;
  end if;
end $$;
alter table public.messages
  add constraint messages_delivery_channel_check
    check (delivery_channel is null or delivery_channel in
           ('web','sms','relay','voice','marketplace','whatsapp'));

alter table public.consents drop constraint if exists consents_channel_check;
alter table public.consents add constraint consents_channel_check
  check (channel in ('web','sms','relay','voice','marketplace','whatsapp'));

alter table public.keyword_events drop constraint if exists keyword_events_channel_check;
alter table public.keyword_events add constraint keyword_events_channel_check
  check (channel in ('web','sms','relay','voice','marketplace','whatsapp'));
