-- LotPilot v0.2: review pipeline, lead status, TCPA, SMS scaffold.
--
-- v0.1 RLS posture carries forward: the public widget reaches messages /
-- conversations through /api/chat with the service role; the anon
-- policies are belt-and-suspenders. v0.2 adds dealer-side INSERT/UPDATE
-- policies (dashboard reply / approve / reject / edit, lead-status
-- pipeline updates) and tightens the anon read on messages so a future
-- direct-from-browser path cannot leak pending AI drafts.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 Update intent CHECK constraints to allow new 'ready_to_close' value.
alter table public.messages drop constraint if exists messages_intent_check;
alter table public.messages add constraint messages_intent_check
  check (intent is null or intent in ('test_drive','financing','trade_in','general','ready_to_close'));
alter table public.conversations drop constraint if exists conversations_last_intent_check;
alter table public.conversations add constraint conversations_last_intent_check
  check (last_intent is null or last_intent in ('test_drive','financing','trade_in','general','ready_to_close'));

-- 1.1 dealers: approval mode + SMS number (E.164).
alter table public.dealers
  add column if not exists approve_before_send  boolean not null default false;
alter table public.dealers
  add column if not exists sms_number           text
    check (sms_number is null or sms_number ~ '^\+[1-9][0-9]{7,14}$');
create unique index if not exists dealers_sms_number_idx
  on public.dealers(sms_number) where sms_number is not null;

-- Anon must NOT see approve_before_send / sms_number; the v0.1 column
-- grant on dealers (id, slug, name, signature, calendly_url,
-- business_hours, timezone) is still in force. Re-applying for clarity.
revoke all on public.dealers from anon;
grant select (id, slug, name, signature, calendly_url, business_hours, timezone)
  on public.dealers to anon;

-- 1.2 conversations: lead pipeline + channel + suppression timestamp.
alter table public.conversations
  add column if not exists lead_status      text not null default 'new';
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_lead_status_check') then
    alter table public.conversations drop constraint conversations_lead_status_check;
  end if;
end $$;
alter table public.conversations
  add constraint conversations_lead_status_check
    check (lead_status in ('new','qualified','booked','sold','lost'));

alter table public.conversations
  add column if not exists notes            text
    check (notes is null or char_length(notes) <= 4000);
alter table public.conversations
  add column if not exists assigned_user_id uuid
    references auth.users(id) on delete set null;
alter table public.conversations
  add column if not exists channel          text not null default 'web';
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table public.conversations drop constraint conversations_channel_check;
  end if;
end $$;
alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('web','sms'));

alter table public.conversations
  add column if not exists buyer_phone      text
    check (buyer_phone is null or buyer_phone ~ '^\+[1-9][0-9]{7,14}$');
alter table public.conversations
  add column if not exists suppressed_at    timestamptz;

create index if not exists conversations_dealer_status_idx
  on public.conversations(dealer_id, lead_status, updated_at desc);
create index if not exists conversations_buyer_phone_idx
  on public.conversations(dealer_id, buyer_phone) where buyer_phone is not null;

-- 1.3 messages: approval workflow.
alter table public.messages
  add column if not exists approval_status   text not null default 'auto';
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'messages_approval_status_check') then
    alter table public.messages drop constraint messages_approval_status_check;
  end if;
end $$;
alter table public.messages
  add constraint messages_approval_status_check
    check (approval_status in ('auto','pending','approved','rejected','sent'));

alter table public.messages
  add column if not exists approved_by       uuid
    references auth.users(id) on delete set null;
alter table public.messages
  add column if not exists approved_at       timestamptz;
alter table public.messages
  add column if not exists original_body     text
    check (original_body is null or char_length(original_body) <= 8000);
alter table public.messages
  add column if not exists delivery_channel  text;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'messages_delivery_channel_check') then
    alter table public.messages drop constraint messages_delivery_channel_check;
  end if;
end $$;
alter table public.messages
  add constraint messages_delivery_channel_check
    check (delivery_channel is null or delivery_channel in ('web','sms'));
alter table public.messages
  add column if not exists delivery_sid      text;

create index if not exists messages_pending_idx
  on public.messages(conversation_id, created_at) where approval_status = 'pending';

-- 1.4 consents (TCPA capture).
create table if not exists public.consents (
  id              uuid primary key default gen_random_uuid(),
  dealer_id       uuid not null references public.dealers(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  channel         text not null check (channel in ('web','sms')),
  consent_text    text not null check (char_length(consent_text) between 1 and 2000),
  ip_address      inet,
  user_agent      text check (user_agent is null or char_length(user_agent) <= 500),
  buyer_phone     text check (buyer_phone is null or buyer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at      timestamptz not null default now()
);
create index if not exists consents_dealer_idx on public.consents(dealer_id, created_at desc);
create index if not exists consents_conv_idx   on public.consents(conversation_id);
-- One consent row per (conversation, channel). Backstops the racy
-- count-then-insert in chat-pipeline.ts when two near-simultaneous
-- first messages from the same buyer both read count==0; the second
-- writer hits 23505 and is silently swallowed (audit trail intact).
create unique index if not exists consents_conv_channel_uniq
  on public.consents(conversation_id, channel);

-- 1.5 keyword_events.
create table if not exists public.keyword_events (
  id              uuid primary key default gen_random_uuid(),
  dealer_id       uuid not null references public.dealers(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  keyword         text not null check (keyword in ('STOP','HELP','START')),
  channel         text not null check (channel in ('web','sms')),
  raw_message     text not null check (char_length(raw_message) between 1 and 8000),
  created_at      timestamptz not null default now()
);
create index if not exists keyword_events_dealer_idx on public.keyword_events(dealer_id, created_at desc);

-- 1.6 conversations_with_latest view (N+1 fix). security_invoker so RLS
-- on conversations + messages applies.
create or replace view public.conversations_with_latest as
select c.*,
       lm.body        as last_message_body,
       lm.role        as last_message_role,
       lm.created_at  as last_message_at,
       (select count(*) from public.messages m
         where m.conversation_id = c.id and m.approval_status = 'pending') as pending_count
  from public.conversations c
  left join lateral (
    select body, role, created_at from public.messages
     where conversation_id = c.id order by created_at desc limit 1
  ) lm on true;
alter view public.conversations_with_latest set (security_invoker = on);

grant select on public.conversations_with_latest to authenticated;

-- 1.7 RLS: new tables + dealer write policies + tightened anon read.
alter table public.consents       enable row level security;
alter table public.keyword_events enable row level security;

drop policy if exists consents_owner_read   on public.consents;
drop policy if exists consents_anon_insert  on public.consents;
create policy consents_owner_read on public.consents
  for select to authenticated
  using (exists (select 1 from public.dealers d where d.id = consents.dealer_id and d.owner_user_id = auth.uid()));
create policy consents_anon_insert on public.consents
  for insert to anon
  with check (exists (select 1 from public.conversations c
                       where c.id = consents.conversation_id
                         and c.buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session'));

drop policy if exists keyword_events_owner_read  on public.keyword_events;
drop policy if exists keyword_events_anon_insert on public.keyword_events;
create policy keyword_events_owner_read on public.keyword_events
  for select to authenticated
  using (exists (select 1 from public.dealers d where d.id = keyword_events.dealer_id and d.owner_user_id = auth.uid()));
create policy keyword_events_anon_insert on public.keyword_events
  for insert to anon
  with check (exists (select 1 from public.conversations c
                       where c.id = keyword_events.conversation_id
                         and c.buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session'));

-- conversations: dealer can UPDATE + INSERT.
drop policy if exists conversations_owner_update on public.conversations;
create policy conversations_owner_update on public.conversations
  for update to authenticated
  using  (exists (select 1 from public.dealers d where d.id = conversations.dealer_id and d.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.dealers d where d.id = conversations.dealer_id and d.owner_user_id = auth.uid()));
drop policy if exists conversations_owner_insert on public.conversations;
create policy conversations_owner_insert on public.conversations
  for insert to authenticated
  with check (exists (select 1 from public.dealers d where d.id = conversations.dealer_id and d.owner_user_id = auth.uid()));

-- messages: dealer INSERT + UPDATE.
drop policy if exists messages_owner_insert on public.messages;
drop policy if exists messages_owner_update on public.messages;
create policy messages_owner_insert on public.messages
  for insert to authenticated
  with check (exists (select 1 from public.conversations c
                       join public.dealers d on d.id = c.dealer_id
                       where c.id = messages.conversation_id and d.owner_user_id = auth.uid()));
create policy messages_owner_update on public.messages
  for update to authenticated
  using (exists (select 1 from public.conversations c
                  join public.dealers d on d.id = c.dealer_id
                  where c.id = messages.conversation_id and d.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c
                       join public.dealers d on d.id = c.dealer_id
                       where c.id = messages.conversation_id and d.owner_user_id = auth.uid()));

-- v0.1 messages_anon_read drop+recreate to ADD approval_status filter.
-- Defense in depth (lead reviewer's must-fix #3): a future direct-from-
-- browser anon read path must never see pending/rejected AI drafts.
drop policy if exists messages_anon_read on public.messages;
create policy messages_anon_read on public.messages
  for select to anon
  using (
    (role = 'buyer' OR approval_status IN ('approved','auto','sent'))
    AND exists (select 1 from public.conversations c
                where c.id = messages.conversation_id
                  and c.buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session')
  );
