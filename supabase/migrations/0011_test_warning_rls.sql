-- LotPilot v0.7.1 regression test for `public.system_warnings`
-- cross-dealer isolation. Sibling to 0006 (dashboard_sla_stats) and
-- 0010 (dealer_zip_benchmarks).
--
-- Why a separate migration: v0.6 introduced system_warnings WITH the
-- owner-scoped RLS policies (0008:97-115), but no runtime regression
-- guard. v0.7 widens the `kind` check to include
-- 'marketplace_secret_rotated' (0009:158-174) and the route that
-- writes that kind is the master-rotation grace path — exactly the
-- kind of change that could regress a SELECT policy if someone
-- carelessly refactors the policy USING expression. This migration
-- proves end-to-end that dealer A can never read dealer B's warnings,
-- regardless of how the policy is restated downstream.
--
-- Shape (matches 0006):
--   - 2 ephemeral users + 2 ephemeral dealers
--   - 1 system_warnings row per dealer (kind='marketplace_secret_rotated',
--     the v0.7 new kind, so we also exercise that the widened constraint
--     accepts the value)
--   - Impersonate user A via BOTH `request.jwt.claims` AND
--     `request.jwt.claim.sub` (the dual-mechanism pattern from
--     0006:85-95 — works regardless of which auth.uid() resolution
--     order the target environment honours)
--   - POSITIVE CONTROL: dealer A must see ITS OWN warning. Without
--     this, an overly-restrictive policy (e.g. always-null auth.uid())
--     would make the leak check pass spuriously.
--   - LEAK ASSERTION: dealer A must see 0 rows when filtering
--     `where dealer_id = <dealer_b_id>`. >0 → raise.
--   - Cleanup on both happy path and exception path (best-effort).

do $$
declare
  user_a    constant uuid := '00000000-0000-0000-0000-0000000d0001';
  user_b    constant uuid := '00000000-0000-0000-0000-0000000d0002';
  dealer_a  uuid;
  dealer_b  uuid;
  warn_a    uuid;
  warn_b    uuid;
  leak_count     int;
  positive_count int;
begin
  -- 1. Ephemeral test users. ON CONFLICT DO NOTHING so re-runs after a
  --    mid-flight raise don't trip the auth.users PK.
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_a, 'warn-iso-test-a@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_b, 'warn-iso-test-b@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  -- 2. Ephemeral dealers.
  insert into public.dealers (owner_user_id, slug, name)
       values (user_a, 'warn-iso-test-a', 'Warn Iso Test A')
  returning id into dealer_a;
  insert into public.dealers (owner_user_id, slug, name)
       values (user_b, 'warn-iso-test-b', 'Warn Iso Test B')
  returning id into dealer_b;

  -- 3. One warning row per dealer. kind='marketplace_secret_rotated' is
  --    the v0.7-new value (0009:172-173); the insert also doubles as a
  --    smoke check on the widened constraint.
  insert into public.system_warnings (dealer_id, kind, payload)
       values (dealer_a, 'marketplace_secret_rotated',
               jsonb_build_object('note', 'iso-test-a'))
  returning id into warn_a;
  insert into public.system_warnings (dealer_id, kind, payload)
       values (dealer_b, 'marketplace_secret_rotated',
               jsonb_build_object('note', 'iso-test-b'))
  returning id into warn_b;

  -- 4. Impersonate user A. Both JWT-claim mechanisms set, matching
  --    0006:85-95. The role MUST be 'authenticated' or the
  --    `to authenticated` clause on the policy filters out our query.
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', user_a::text, true);

  -- 5a. POSITIVE CONTROL: user A reading dealer A's warnings → must be 1.
  --     A 0-result here means auth.uid() is null or the policy is too
  --     restrictive — the leak check below would silently false-negative.
  select count(*) into positive_count
    from public.system_warnings
   where dealer_id = dealer_a;
  if positive_count = 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'warning-rls FAIL (positive control): user % impersonating dealer % '
      'could not read their OWN system_warnings row. Either auth.uid() is '
      'returning null in this environment or the system_warnings_owner_read '
      'policy is too restrictive. The cross-dealer leak check is meaningless '
      'until owners can read their own rows.',
      user_a, dealer_a;
  end if;

  -- 5b. LEAK ASSERTION: user A reading dealer B's warnings → must be 0.
  --     >0 means the system_warnings_owner_read policy (0008:101-105)
  --     stopped scoping by owner_user_id = auth.uid(). Fail loudly.
  select count(*) into leak_count
    from public.system_warnings
   where dealer_id = dealer_b;

  if leak_count > 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'warning-rls FAIL: dealer A (user %) leaked % system_warnings row(s) '
      'from dealer % (user %). The system_warnings_owner_read policy (0008:101-105) '
      'is missing or has dropped its owner_user_id = auth.uid() predicate.',
      user_a, leak_count, dealer_b, user_b;
  end if;

  -- 6. Cleanup, happy path. Reset role to postgres so the DELETEs run
  --    as the migrating user (RLS doesn't apply to postgres in vanilla
  --    PG). The cascading FK on dealers takes the warning rows with us,
  --    but be explicit for clarity.
  perform set_config('role', 'postgres', true);
  delete from public.system_warnings where id in (warn_a, warn_b);
  delete from public.dealers where id in (dealer_a, dealer_b);
  delete from auth.users where id in (user_a, user_b);

exception
  -- Best-effort cleanup on unexpected SQLSTATEs. Wraps the cleanup in
  -- its own EXCEPTION block so a failing cleanup statement can't mask
  -- the original RAISE. Matches 0006:143-159 idiom.
  when others then
    perform set_config('role', 'postgres', true);
    begin
      delete from public.system_warnings where dealer_id in (
        select id from public.dealers
         where slug in ('warn-iso-test-a','warn-iso-test-b')
      );
      delete from public.dealers where slug in
        ('warn-iso-test-a','warn-iso-test-b');
      delete from auth.users where id in
        ('00000000-0000-0000-0000-0000000d0001'::uuid,
         '00000000-0000-0000-0000-0000000d0002'::uuid);
    exception when others then
      null;
    end;
    raise;
end $$;
