-- LotPilot T3.2 (MVP): inventory acquisition signal.
--
-- "Saturday-auction shopping list" — surface (make, model) profiles
-- where the last 30d of buyer-intent capture (from T2.5 / 0015 columns)
-- shows demand the dealer's current inventory can't satisfy.
--
-- Sections:
--   1.0 conversations indexes for buyer_intent_* aggregation (cheap;
--       backfills the read path the view depends on).
--   2.0 acquisition_signal_30d view — demand vs supply, scored.
--   3.0 Final-state assertion.
--
-- MVP scope (explicit non-goals):
--   - body_type aggregation: vehicles.body_type doesn't exist yet, so
--     we rank on (make, model) only. The body_type signal still
--     captures in conversations and feeds T2.5 re-engagement; the
--     auction list is make+model.
--   - regional pricing / ACV: out of scope until we wire Manheim MMR
--     (see docs/T1.5-T1.6-provider-onboarding.md).
--   - "loss leader" inference: same — pricing-aware.
--
-- View choice: plain VIEW (not MATERIALIZED). A dealer with 1000 cold
-- leads + 200 vehicles will read ~1ms here; the materialized version
-- is the v2 optimization once we see real volume. The view also has
-- security_invoker=on so RLS on conversations + vehicles applies — the
-- dealer dashboard sees only their own data.
--
-- Idempotent: safe to re-run.

create extension if not exists "pgcrypto";

-- 1.0 Supporting indexes ---------------------------------------------------
-- Buyer-intent aggregation filters by dealer_id + created_at window +
-- non-null make. A partial index keeps the aggregation cheap once the
-- captured-buyer-intent share is < 50% of total conversations (early
-- T2.5 / T3.2 days).
create index if not exists conversations_buyer_intent_recent_idx
  on public.conversations(dealer_id, created_at desc)
  where buyer_intent_make is not null;

-- Vehicles available-inventory count groups by (dealer_id, make, model).
-- Existing vehicles_dealer_status_idx (0002:65) covers the WHERE; this
-- aux index sharpens the GROUP BY on hot dealers.
create index if not exists vehicles_available_make_model_idx
  on public.vehicles(dealer_id, make, model)
  where status = 'available';

-- 2.0 acquisition_signal_30d view -----------------------------------------
-- Per (dealer, make, model):
--   demand_count     — number of conversations in the last 30d whose
--                      buyer_intent_make = make and buyer_intent_model
--                      = model (case-insensitive match).
--   hot_count        — subset whose lead_score = 'hot'.
--   warm_count       — subset whose lead_score = 'warm'.
--   cold_count       — subset whose lead_score = 'cold' OR null.
--   inventory_count  — current available vehicles matching make+model.
--   score            — composite ranking signal (see below).
--
-- score formula:
--   demand_count
--     * (1 + (2 * hot_count + warm_count) / NULLIF(demand_count, 0))
--     / (1 + inventory_count)
--
-- Intuition: raw demand, weighted UP by lead heat (hot=2x, warm=1x,
-- cold=0x bonus), penalized by current supply (every existing
-- in-stock unit halves the urgency until you're stocked up). A
-- dealer who already has 5 Camrys gets a low Camry score even if 20
-- people asked — they're served. A dealer with 0 F-150s and 5 hot
-- leads gets a high F-150 score.
--
-- We deliberately use FULL OUTER JOIN (not LEFT) so the list also
-- surfaces profiles the dealer ALREADY stocks but nobody is asking
-- about — those rank low (demand=0 → score=0) so they sort off the
-- bottom of the list automatically, but having them present lets a
-- dealer reading the export see "you have 8 Altimas, 0 buyers asked."
drop view if exists public.acquisition_signal_30d;
create view public.acquisition_signal_30d as
with demand as (
  select
    c.dealer_id,
    lower(c.buyer_intent_make)  as make,
    lower(c.buyer_intent_model) as model,
    count(*)                    as demand_count,
    count(*) filter (where c.lead_score = 'hot')                          as hot_count,
    count(*) filter (where c.lead_score = 'warm')                         as warm_count,
    count(*) filter (where c.lead_score = 'cold' or c.lead_score is null) as cold_count
  from public.conversations c
  where c.buyer_intent_make is not null
    and c.buyer_intent_model is not null
    and c.created_at > now() - interval '30 days'
  group by c.dealer_id, lower(c.buyer_intent_make), lower(c.buyer_intent_model)
),
supply as (
  select
    v.dealer_id,
    lower(v.make)  as make,
    lower(v.model) as model,
    count(*)       as inventory_count
  from public.vehicles v
  where v.status = 'available'
    and v.make is not null
    and v.model is not null
  group by v.dealer_id, lower(v.make), lower(v.model)
)
select
  coalesce(d.dealer_id, s.dealer_id) as dealer_id,
  coalesce(d.make,  s.make)          as make,
  coalesce(d.model, s.model)         as model,
  coalesce(d.demand_count,   0)      as demand_count,
  coalesce(d.hot_count,      0)      as hot_count,
  coalesce(d.warm_count,     0)      as warm_count,
  coalesce(d.cold_count,     0)      as cold_count,
  coalesce(s.inventory_count, 0)     as inventory_count,
  case
    when coalesce(d.demand_count, 0) = 0 then 0::numeric
    else round(
      (d.demand_count::numeric
        * (1 + (2 * d.hot_count + d.warm_count)::numeric / d.demand_count::numeric))
       / (1 + coalesce(s.inventory_count, 0)::numeric)
      , 3)
  end as score
from demand d
full outer join supply s
  on d.dealer_id = s.dealer_id
 and d.make      = s.make
 and d.model     = s.model;

alter view public.acquisition_signal_30d set (security_invoker = on);
grant select on public.acquisition_signal_30d to authenticated;

-- 3.0 Final-state assertion ----------------------------------------------
do $$
declare
  has_view boolean;
  has_dem_idx boolean;
  has_sup_idx boolean;
begin
  select exists (
    select 1 from information_schema.views
     where table_schema = 'public' and table_name = 'acquisition_signal_30d'
  ) into has_view;
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'conversations_buyer_intent_recent_idx'
  ) into has_dem_idx;
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'vehicles_available_make_model_idx'
  ) into has_sup_idx;

  if not has_view then
    raise exception 'T3.2 FAIL: public.acquisition_signal_30d missing';
  end if;
  if not has_dem_idx then
    raise exception 'T3.2 FAIL: conversations_buyer_intent_recent_idx missing';
  end if;
  if not has_sup_idx then
    raise exception 'T3.2 FAIL: vehicles_available_make_model_idx missing';
  end if;
end $$;
