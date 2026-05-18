-- LotPilot v0.8 — Stripe billing columns on dealers.
--
-- Adds the minimal set of columns the Stripe Checkout + webhook
-- pipeline needs to know which tier a dealer is on and whether their
-- subscription is in good standing. Subscription state is a write-only
-- surface for the service role: the dashboard reads it, the Stripe
-- webhook handler writes it, no authenticated update policy exists.
--
-- Why these five columns and not more:
--   * stripe_customer_id / stripe_subscription_id — id-level handles
--     for the two Stripe objects we care about. Unique to enforce a
--     1:1 (dealer ↔ customer) relationship at the DB layer; a dealer
--     who churns and signs up again gets the SAME customer id (we
--     fetch by id, never create a duplicate).
--   * subscription_tier — denormalised from the price id on every
--     webhook so the dashboard can gate features without round-
--     tripping to Stripe.
--   * subscription_status — mapped to our enum (mapStatusToInternal in
--     src/lib/stripe.ts) so Stripe-API spelling changes don't reach
--     our policy layer.
--   * subscription_current_period_end — drives "your subscription
--     renews on" UI + grace-period checks. Updated on every
--     subscription.updated event.
--
-- RLS posture:
--   * READ: the existing dealer SELECT policy already covers these
--     columns (owner_user_id match). No change needed.
--   * WRITE: NO authenticated UPDATE policy is added. Subscription
--     state is service-role-only. A dealer cannot flip themselves to
--     'active' from the client. The Stripe webhook is the sole writer.
--
-- Idempotent: safe to re-run.

-- 1.0 Columns -------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'stripe_customer_id'
  ) then
    alter table public.dealers
      add column stripe_customer_id text;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'stripe_subscription_id'
  ) then
    alter table public.dealers
      add column stripe_subscription_id text;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'subscription_tier'
  ) then
    alter table public.dealers
      add column subscription_tier text;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'subscription_status'
  ) then
    alter table public.dealers
      add column subscription_status text;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'dealers'
       and column_name = 'subscription_current_period_end'
  ) then
    alter table public.dealers
      add column subscription_current_period_end timestamptz;
  end if;
end $$;

-- 2.0 Constraints ---------------------------------------------------------
-- Enum-shaped check constraints. Stored as text + check rather than a
-- pg enum so adding a tier later (e.g. 'enterprise') is a one-line
-- migration, not a DDL juggle. The 'is null or in (...)' shape lets
-- a brand-new dealer row exist without a subscription assigned yet.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'dealers_subscription_tier_check'
  ) then
    alter table public.dealers
      add constraint dealers_subscription_tier_check
      check (subscription_tier is null
             or subscription_tier in ('starter','pro','network'));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'dealers_subscription_status_check'
  ) then
    alter table public.dealers
      add constraint dealers_subscription_status_check
      check (subscription_status is null
             or subscription_status in (
               'trialing',
               'active',
               'past_due',
               'canceled',
               'incomplete',
               'incomplete_expired',
               'unpaid',
               'paused'
             ));
  end if;
end $$;

-- 3.0 Indexes -------------------------------------------------------------
-- Unique on stripe_customer_id: enforce the 1:1 dealer ↔ Stripe customer
-- invariant at the DB layer. Partial — null-safe so dealers without a
-- customer id yet don't collide.
create unique index if not exists dealers_stripe_customer_id_unique_idx
  on public.dealers(stripe_customer_id)
  where stripe_customer_id is not null;

-- Subscription id is also unique (defensive: the webhook keys writes by
-- subscription id; duplicate ids would mean we mixed up two dealers).
create unique index if not exists dealers_stripe_subscription_id_unique_idx
  on public.dealers(stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Hot path for the dashboard: "is this dealer active?" — partial index
-- keeps the lookup cheap as the dealers table grows.
create index if not exists dealers_subscription_active_idx
  on public.dealers(id)
  where subscription_status = 'active';

-- 4.0 No authenticated UPDATE policy ------------------------------------
-- We deliberately do NOT add an UPDATE policy for these columns. The
-- existing dealers UPDATE policy (in 0001_init.sql) covers the
-- onboarding-mutable surface only. Subscription state transitions are
-- driven by the Stripe webhook via the service role. A dealer flipping
-- themselves to 'active' from the client would bypass billing —
-- regulatory / commercial unsafe.

-- 5.0 Final-state assertion ----------------------------------------------
do $$
declare
  col_count int;
  unique_customer boolean;
  unique_subscription boolean;
  active_partial boolean;
  tier_check_exists boolean;
  status_check_exists boolean;
begin
  select count(*) into col_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'dealers'
     and column_name in (
       'stripe_customer_id',
       'stripe_subscription_id',
       'subscription_tier',
       'subscription_status',
       'subscription_current_period_end'
     );
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'dealers_stripe_customer_id_unique_idx'
  ) into unique_customer;
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'dealers_stripe_subscription_id_unique_idx'
  ) into unique_subscription;
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'dealers_subscription_active_idx'
  ) into active_partial;
  select exists (
    select 1 from pg_constraint
     where conname = 'dealers_subscription_tier_check'
  ) into tier_check_exists;
  select exists (
    select 1 from pg_constraint
     where conname = 'dealers_subscription_status_check'
  ) into status_check_exists;

  if col_count <> 5 then
    raise exception 'v0.8 stripe FAIL: expected 5 stripe columns on dealers, got %', col_count;
  end if;
  if not unique_customer then
    raise exception 'v0.8 stripe FAIL: dealers_stripe_customer_id_unique_idx missing';
  end if;
  if not unique_subscription then
    raise exception 'v0.8 stripe FAIL: dealers_stripe_subscription_id_unique_idx missing';
  end if;
  if not active_partial then
    raise exception 'v0.8 stripe FAIL: dealers_subscription_active_idx missing';
  end if;
  if not tier_check_exists then
    raise exception 'v0.8 stripe FAIL: dealers_subscription_tier_check missing';
  end if;
  if not status_check_exists then
    raise exception 'v0.8 stripe FAIL: dealers_subscription_status_check missing';
  end if;
end $$;
