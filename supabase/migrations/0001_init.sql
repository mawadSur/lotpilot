-- LotPilot MVP — initial schema
-- Single core table: dealer waitlist signups from the landing page.
-- RLS: anonymous (anon role) can INSERT only. Reads require service_role.

create extension if not exists "pgcrypto";

create table if not exists public.dealer_signups (
  id              uuid primary key default gen_random_uuid(),
  dealership_name text not null check (char_length(dealership_name) between 1 and 200),
  contact_name    text not null check (char_length(contact_name) between 1 and 120),
  email           text not null check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone           text check (phone is null or char_length(phone) between 7 and 30),
  inventory_size  int  check (inventory_size is null or inventory_size between 1 and 10000),
  primary_channel text check (primary_channel in ('marketplace','autotrader','cars_com','website','walk_in','other')),
  notes           text check (notes is null or char_length(notes) <= 2000),
  user_agent      text check (user_agent is null or char_length(user_agent) <= 500),
  created_at      timestamptz not null default now()
);

create index if not exists dealer_signups_created_at_idx
  on public.dealer_signups (created_at desc);

create index if not exists dealer_signups_email_idx
  on public.dealer_signups (lower(email));

alter table public.dealer_signups enable row level security;

-- Anonymous users (the public landing page) may insert a signup.
drop policy if exists "anon can insert signups" on public.dealer_signups;
create policy "anon can insert signups"
  on public.dealer_signups
  for insert
  to anon
  with check (true);

-- Authenticated users may insert as well (in case auth is added later).
drop policy if exists "authenticated can insert signups" on public.dealer_signups;
create policy "authenticated can insert signups"
  on public.dealer_signups
  for insert
  to authenticated
  with check (true);

-- No SELECT/UPDATE/DELETE policies: only the service_role key can read,
-- which is correct for an MVP waitlist (the founder reviews via Supabase dashboard).
