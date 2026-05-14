-- LotPilot v0.1 core: dealers, vehicles, conversations, messages.
--
-- The existing 0001_init.sql migration owns the marketing-side waitlist
-- (`dealer_signups`). This migration adds the live product schema:
--
--   dealers        — one row per onboarded dealership, owned by an auth user
--   vehicles       — lot inventory (CSV-uploaded for v0.1)
--   conversations  — one buyer thread per dealer + buyer session
--   messages       — append-only buyer / ai / dealer turns
--
-- RLS posture:
--   - The owning dealer (authenticated) gets full CRUD on their own rows.
--   - Anon may read a single dealer by slug (column-restricted) and read
--     vehicles whose status = 'available' (so the public widget can render).
--   - Anon may insert/read conversations + messages **scoped by the
--     `x-buyer-session` request header**, so a buyer can never see another
--     buyer's thread even if they guess a UUID.
--   - In practice the public chat widget reaches the database through the
--     /api/chat route handler with the service-role key; the anon policies
--     above are belt-and-suspenders.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- DEALERS -------------------------------------------------------------
create table if not exists public.dealers (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  slug            text not null unique
                    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$'),
  name            text not null check (char_length(name) between 1 and 200),
  signature       text check (signature is null or char_length(signature) <= 500),
  business_hours  jsonb not null default
                    '{"mon":["09:00","19:00"],"tue":["09:00","19:00"],"wed":["09:00","19:00"],"thu":["09:00","19:00"],"fri":["09:00","19:00"],"sat":["10:00","18:00"],"sun":null}'::jsonb,
  calendly_url    text check (calendly_url is null or calendly_url ~ '^https://(www\.)?calendly\.com/'),
  timezone        text not null default 'America/New_York',
  onboarded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists dealers_owner_idx on public.dealers(owner_user_id);
create index        if not exists dealers_slug_idx  on public.dealers(slug);

-- VEHICLES ------------------------------------------------------------
create table if not exists public.vehicles (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null references public.dealers(id) on delete cascade,
  stock_number   text not null check (char_length(stock_number) between 1 and 60),
  vin            text check (vin is null or char_length(vin) between 11 and 17),
  year           int  check (year is null or year between 1950 and 2100),
  make           text check (make is null or char_length(make) <= 60),
  model          text check (model is null or char_length(model) <= 80),
  trim           text check (trim is null or char_length(trim) <= 80),
  mileage        int  check (mileage is null or mileage between 0 and 1000000),
  price_cents    bigint check (price_cents is null or price_cents between 0 and 100000000),
  photo_url      text check (photo_url is null or char_length(photo_url) <= 2048),
  description    text check (description is null or char_length(description) <= 4000),
  status         text not null default 'available'
                   check (status in ('available','pending','sold','hidden')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (dealer_id, stock_number)
);
create index if not exists vehicles_dealer_status_idx on public.vehicles(dealer_id, status);

-- CONVERSATIONS -------------------------------------------------------
create table if not exists public.conversations (
  id             uuid primary key default gen_random_uuid(),
  dealer_id      uuid not null references public.dealers(id) on delete cascade,
  buyer_session  text not null check (char_length(buyer_session) between 16 and 128),
  language       text not null default 'en' check (language in ('en','es')),
  status         text not null default 'open' check (status in ('open','closed')),
  last_intent    text check (last_intent in ('test_drive','financing','trade_in','general')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (dealer_id, buyer_session)
);
create index if not exists conversations_dealer_updated_idx
  on public.conversations(dealer_id, updated_at desc);

-- MESSAGES (append-only) ---------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('buyer','ai','dealer')),
  body            text not null check (char_length(body) between 1 and 8000),
  intent          text check (intent in ('test_drive','financing','trade_in','general')),
  language        text check (language in ('en','es')),
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages(conversation_id, created_at);

-- updated_at trigger --------------------------------------------------
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end $$ language plpgsql;

drop trigger if exists dealers_touch       on public.dealers;
drop trigger if exists vehicles_touch      on public.vehicles;
drop trigger if exists conversations_touch on public.conversations;

create trigger dealers_touch       before update on public.dealers       for each row execute function public.touch_updated_at();
create trigger vehicles_touch      before update on public.vehicles      for each row execute function public.touch_updated_at();
create trigger conversations_touch before update on public.conversations for each row execute function public.touch_updated_at();

-- RLS -----------------------------------------------------------------
alter table public.dealers       enable row level security;
alter table public.vehicles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- dealers: owner full CRUD; anon may SELECT (column-grants below restrict
-- which fields are exposed).
drop policy if exists dealers_owner_all   on public.dealers;
drop policy if exists dealers_public_read on public.dealers;
create policy dealers_owner_all on public.dealers
  for all to authenticated
  using  (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
create policy dealers_public_read on public.dealers
  for select to anon
  using (true);

-- Lock the table-wide grant down so anon can only read safe public columns.
revoke all on public.dealers from anon;
grant select (id, slug, name, signature, calendly_url, business_hours, timezone)
  on public.dealers to anon;

-- vehicles: owner full CRUD; anon may read available vehicles for any dealer.
drop policy if exists vehicles_owner_all   on public.vehicles;
drop policy if exists vehicles_public_read on public.vehicles;
create policy vehicles_owner_all on public.vehicles
  for all to authenticated
  using  (exists (select 1 from public.dealers d where d.id = vehicles.dealer_id and d.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.dealers d where d.id = vehicles.dealer_id and d.owner_user_id = auth.uid()));
create policy vehicles_public_read on public.vehicles
  for select to anon
  using (status = 'available');

-- conversations: dealer-owner reads; anon insert + read scoped by buyer_session
-- via the x-buyer-session request header.
--
-- v0.1 NOTE: the public chat widget reaches conversations + messages
-- exclusively via the service role (see /api/chat and /c/[slug]/page.tsx),
-- which bypasses RLS. The anon policies below are forward-compatible
-- scaffolding for a v0.2 direct-from-browser path; no Supabase client
-- in the v0.1 codebase sets the `x-buyer-session` PostgREST header,
-- so these policies are correct on paper but never exercised today.
drop policy if exists conversations_owner_read   on public.conversations;
drop policy if exists conversations_anon_insert  on public.conversations;
drop policy if exists conversations_anon_read    on public.conversations;
create policy conversations_owner_read on public.conversations
  for select to authenticated
  using (exists (select 1 from public.dealers d where d.id = conversations.dealer_id and d.owner_user_id = auth.uid()));
create policy conversations_anon_insert on public.conversations
  for insert to anon
  with check (buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session');
create policy conversations_anon_read on public.conversations
  for select to anon
  using (buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session');

-- messages: dealer-owner reads; anon insert + read scoped via parent
-- conversation's buyer_session.
drop policy if exists messages_owner_read  on public.messages;
drop policy if exists messages_anon_insert on public.messages;
drop policy if exists messages_anon_read   on public.messages;
create policy messages_owner_read on public.messages
  for select to authenticated
  using (exists (
    select 1 from public.conversations c
    join public.dealers d on d.id = c.dealer_id
    where c.id = messages.conversation_id and d.owner_user_id = auth.uid()));
create policy messages_anon_insert on public.messages
  for insert to anon
  with check (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and c.buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session'));
create policy messages_anon_read on public.messages
  for select to anon
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and c.buyer_session = current_setting('request.headers', true)::json->>'x-buyer-session'));
