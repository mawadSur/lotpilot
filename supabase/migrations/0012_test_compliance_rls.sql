-- LotPilot v0.7.1 regression test for `public.compliance_exports`
-- cross-dealer isolation. Sibling to 0011 (system_warnings).
--
-- Why this and not also `pending_compliance_audits`: coder A's audit
-- of migration 0009 confirms that `pending_compliance_audits` has no
-- authenticated INSERT policy (0009:59-73 only grants
-- owner_read + owner_insert with `exported_by = auth.uid()`, plus
-- the table is written exclusively by the service_role drainer).
-- The "no policies → service-role only" architectural pattern
-- fails CLOSED by definition: an authenticated user without a matching
-- policy gets 0 rows from any SELECT and 0 inserts. Writing a separate
-- RLS regression for it is redundant — the cross-dealer leak surface
-- isn't reachable from authenticated. If a future migration ever
-- adds a permissive policy on that table, *then* clone this file to
-- 0013_test_audit_queue_rls.sql.
--
-- For `compliance_exports`, the owner_read policy IS authenticated-
-- facing (0008:142-146), so it's the real cross-dealer leak risk and
-- the regression worth guarding.
--
-- Shape (matches 0011 exactly):
--   - 2 ephemeral users + 2 ephemeral dealers
--   - 1 compliance_exports row per dealer with required columns
--     (dealer_id, exported_by, scope='dealer_wide', scope_payload='{}',
--     row_count=0)
--   - Impersonate user A via dual JWT-claim mechanism (0006:85-95
--     idiom for cross-environment compatibility)
--   - POSITIVE CONTROL: dealer A must see its OWN export row
--   - LEAK ASSERTION: dealer A must see 0 rows when filtering on
--     dealer_b_id; >0 → raise
--   - Cleanup on happy path AND exception path (best-effort, matches
--     0006:143-159)

do $$
declare
  user_a    constant uuid := '00000000-0000-0000-0000-0000000d0011';
  user_b    constant uuid := '00000000-0000-0000-0000-0000000d0012';
  dealer_a  uuid;
  dealer_b  uuid;
  export_a  uuid;
  export_b  uuid;
  leak_count     int;
  positive_count int;
begin
  -- 1. Ephemeral users.
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_a, 'comp-iso-test-a@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_b, 'comp-iso-test-b@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  -- 2. Ephemeral dealers.
  insert into public.dealers (owner_user_id, slug, name)
       values (user_a, 'comp-iso-test-a', 'Comp Iso Test A')
  returning id into dealer_a;
  insert into public.dealers (owner_user_id, slug, name)
       values (user_b, 'comp-iso-test-b', 'Comp Iso Test B')
  returning id into dealer_b;

  -- 3. One compliance_exports row per dealer. exported_by points at
  --    the dealer's owner (matches the with-check on the insert policy
  --    at 0008:147-152, though we're writing as postgres so RLS doesn't
  --    gate us here — but we keep the value consistent so the row would
  --    survive an authenticated-side replay). scope='dealer_wide' is
  --    one of the allowed enum values (0008:126-130).
  insert into public.compliance_exports
       (dealer_id, exported_by, scope, scope_payload, row_count)
       values (dealer_a, user_a, 'dealer_wide', '{}'::jsonb, 0)
  returning id into export_a;
  insert into public.compliance_exports
       (dealer_id, exported_by, scope, scope_payload, row_count)
       values (dealer_b, user_b, 'dealer_wide', '{}'::jsonb, 0)
  returning id into export_b;

  -- 4. Impersonate user A via BOTH JWT-claim mechanisms (0006 idiom).
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', user_a::text, true);

  -- 5a. POSITIVE CONTROL: user A reading dealer A's exports → must be 1.
  select count(*) into positive_count
    from public.compliance_exports
   where dealer_id = dealer_a;
  if positive_count = 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'compliance-rls FAIL (positive control): user % impersonating dealer % '
      'could not read their OWN compliance_exports row. Either auth.uid() is '
      'null in this environment or the compliance_exports_owner_read policy is '
      'too restrictive. The cross-dealer leak check below is meaningless until '
      'owners can read their own rows.',
      user_a, dealer_a;
  end if;

  -- 5b. LEAK ASSERTION: user A reading dealer B's exports → must be 0.
  --     >0 means compliance_exports_owner_read (0008:142-146) lost its
  --     owner_user_id = auth.uid() predicate. Fail the migration.
  select count(*) into leak_count
    from public.compliance_exports
   where dealer_id = dealer_b;

  if leak_count > 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'compliance-rls FAIL: dealer A (user %) leaked % compliance_exports row(s) '
      'from dealer % (user %). The compliance_exports_owner_read policy '
      '(0008:142-146) is missing or has dropped its owner_user_id = auth.uid() '
      'predicate. CSV audit history must never cross dealer boundaries.',
      user_a, leak_count, dealer_b, user_b;
  end if;

  -- 6. Cleanup, happy path.
  perform set_config('role', 'postgres', true);
  delete from public.compliance_exports where id in (export_a, export_b);
  delete from public.dealers where id in (dealer_a, dealer_b);
  delete from auth.users where id in (user_a, user_b);

exception
  -- Best-effort cleanup on unexpected SQLSTATEs; re-raise so the
  -- workflow still fails. Inner EXCEPTION block lets the cleanup
  -- swallow its own errors without masking the outer RAISE.
  when others then
    perform set_config('role', 'postgres', true);
    begin
      delete from public.compliance_exports where dealer_id in (
        select id from public.dealers
         where slug in ('comp-iso-test-a','comp-iso-test-b')
      );
      delete from public.dealers where slug in
        ('comp-iso-test-a','comp-iso-test-b');
      delete from auth.users where id in
        ('00000000-0000-0000-0000-0000000d0011'::uuid,
         '00000000-0000-0000-0000-0000000d0012'::uuid);
    exception when others then
      null;
    end;
    raise;
end $$;
