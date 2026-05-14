-- LotPilot v0.4 regression test (carry-over from v0.3 review).
--
-- Catches the v0.3 C1-class bug: a SECURITY DEFINER function that
-- bypasses RLS but forgets to enforce per-dealer ownership inside the
-- body. dashboard_sla_stats(uuid) (introduced in 0004) is the only
-- such function in the live schema today; if it ever stops checking
-- auth.uid() / owner_user_id, this migration fails — so the bug never
-- ships.
--
-- The test creates two ephemeral dealers + conversations + an approved
-- AI message each (so dashboard_sla_stats has rows to potentially leak),
-- impersonates dealer A via the request-jwt mechanism Supabase uses
-- for auth.uid(), then asserts dashboard_sla_stats(<dealer B id>)
-- returns zero rows. If it returns anything, dealer A just read
-- dealer B's stats — RAISE EXCEPTION, fail the migration, hold the
-- line.
--
-- JWT-claim wiring (researcher risk #4): Supabase's auth.uid() reads
-- from `request.jwt.claims` (preferred) but falls back to
-- `request.jwt.claim.sub` in some configurations. We set BOTH below
-- so this test works regardless of which mechanism the target
-- environment honours. Documenting the alternatives in case a future
-- auth migration changes the resolution order:
--
--   approach A (preferred):
--     set local "request.jwt.claims" to '{"sub":"<uuid>","role":"authenticated"}';
--   approach B (legacy fallback):
--     select set_config('request.jwt.claim.sub', '<uuid>', true);
--
-- Idempotent: wrapped in DO + EXCEPTION block; cleans up its own rows
-- whether the test passes or raises mid-flight.

do $$
declare
  user_a constant uuid := '00000000-0000-0000-0000-000000aaaaaa';
  user_b constant uuid := '00000000-0000-0000-0000-000000bbbbbb';
  dealer_a uuid;
  dealer_b uuid;
  conv_a   uuid;
  conv_b   uuid;
  leak_count int;
  -- v0.5: hoisted to top-level declare block (PL/pgSQL doesn't allow
  -- mid-body declare without a sub-block, and architect explicitly
  -- chose hoist over inner BEGIN/END so the variable is visible to
  -- the cleanup branch on the exception path).
  positive_count int;
begin
  -- 1. Ephemeral test users in auth.users.  ON CONFLICT DO NOTHING
  --    so a dirty re-run is harmless.
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_a, 'iso-test-a@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;
  insert into auth.users (id, email, instance_id, aud, role)
       values (user_b, 'iso-test-b@example.invalid',
               '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  -- 2. Ephemeral dealers + a conversation + first-AI message each so
  --    dashboard_sla_stats() has rows that could potentially leak.
  insert into public.dealers (owner_user_id, slug, name)
       values (user_a, 'iso-test-a', 'Iso Test A')
  returning id into dealer_a;
  insert into public.dealers (owner_user_id, slug, name)
       values (user_b, 'iso-test-b', 'Iso Test B')
  returning id into dealer_b;

  insert into public.conversations (dealer_id, buyer_session, language, channel)
       values (dealer_a, 'iso-test-session-a-padded-aaaaa', 'en', 'web')
  returning id into conv_a;
  insert into public.conversations (dealer_id, buyer_session, language, channel)
       values (dealer_b, 'iso-test-session-b-padded-bbbbb', 'en', 'web')
  returning id into conv_b;

  -- buyer turn + AI turn so the SLA aggregate has something to compute.
  insert into public.messages (conversation_id, role, body, approval_status)
       values (conv_a, 'buyer', 'iso test inbound a', 'auto');
  insert into public.messages (conversation_id, role, body, approval_status)
       values (conv_a, 'ai',    'iso test reply a',   'auto');
  insert into public.messages (conversation_id, role, body, approval_status)
       values (conv_b, 'buyer', 'iso test inbound b', 'auto');
  insert into public.messages (conversation_id, role, body, approval_status)
       values (conv_b, 'ai',    'iso test reply b',   'auto');

  -- 3. Impersonate dealer A. We set BOTH JWT-claim mechanisms because
  --    Supabase's auth.uid() resolution differs across deployments
  --    (researcher risk #4). Whichever one this database honours
  --    will null out auth.uid() to user_b for dealer_b queries.
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', user_a::text, true);

  -- 4a. POSITIVE CONTROL (v0.5): assert that dashboard_sla_stats RETURNS
  --     rows for the *owning* dealer first. Without this control, a
  --     broken auth.uid() (e.g. always-null in a future Supabase change)
  --     would let the leak assertion below pass spuriously: zero rows
  --     for dealer_b looks like correct isolation, but it's actually
  --     "function returns nothing for anyone". This control fails loudly
  --     if the predicate has gone too restrictive. positive_count is
  --     hoisted into the top-level declare block above.
  select count(*) into positive_count
    from public.dashboard_sla_stats(dealer_a);
  if positive_count = 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'iso-test FAIL (positive control): dashboard_sla_stats returned 0 rows '
      'for the OWNING dealer % impersonated as user %. The auth.uid() / '
      'owner_user_id predicate is too restrictive (or auth.uid() is null), '
      'which would make the cross-dealer leak check below silently '
      'false-negative. Fix the function first; the leak check is meaningless '
      'until owners can read their own stats.',
      dealer_a, user_a;
  end if;

  -- 4b. The asserting call — dealer A asks for dealer B's SLA stats.
  --     The function's internal `exists (select 1 from dealers ...
  --     owner_user_id = auth.uid())` predicate must zero out the result.
  select count(*) into leak_count
    from public.dashboard_sla_stats(dealer_b);

  if leak_count > 0 then
    perform set_config('role', 'postgres', true);
    raise exception
      'iso-test FAIL: dashboard_sla_stats leaked % rows from dealer % to user %. '
      'The SECURITY DEFINER function is missing the auth.uid() / owner_user_id '
      'predicate that 0004:127-132 added.',
      leak_count, dealer_b, user_a;
  end if;

  -- 5. Reset role + clean up. Cleanup runs even on the assertion path
  --    above only if we wrap callers in their own DO block; here we
  --    raise BEFORE cleanup so a failing migration leaves the
  --    evidence in place for inspection. On the happy path:
  perform set_config('role', 'postgres', true);
  delete from public.conversations where id in (conv_a, conv_b);
  delete from public.dealers where id in (dealer_a, dealer_b);
  delete from auth.users where id in (user_a, user_b);

exception
  -- Best-effort cleanup on unexpected SQLSTATEs (constraint violations
  -- inside test setup, missing auth.users table, etc). Re-raise so
  -- the migration still fails loudly.
  when others then
    perform set_config('role', 'postgres', true);
    begin
      delete from public.conversations where buyer_session in
        ('iso-test-session-a-padded-aaaaa','iso-test-session-b-padded-bbbbb');
      delete from public.dealers where slug in ('iso-test-a','iso-test-b');
      delete from auth.users where id in
        ('00000000-0000-0000-0000-000000aaaaaa'::uuid,
         '00000000-0000-0000-0000-000000bbbbbb'::uuid);
    exception when others then
      null;
    end;
    raise;
end $$;
