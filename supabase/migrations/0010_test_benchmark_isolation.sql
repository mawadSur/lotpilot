-- LotPilot v0.7 regression test for `dealer_zip_benchmarks` (sibling
-- to 0006). v0.6 enforces the 3-dealer privacy floor in TWO places:
-- the SQL HAVING clause inside the view, and the post-migration
-- RAISE EXCEPTION in 0008. This file is the runtime regression test:
-- seed two zip3 groups (one below floor, one above), exercise the
-- live view, RAISE EXCEPTION if any row from the below-floor group
-- surfaces — and a POSITIVE CONTROL that asserts the above-floor
-- group DOES surface (catches the "view returns nothing for anyone"
-- false-negative).
--
-- Layout follows the 0006 pattern: top-level DO with hoisted
-- declares; exception handler does best-effort cleanup then re-raises.
-- Separate file from 0009 so v0.6's test-isolation discipline (each
-- regression test in its own migration) carries forward.
--
-- Test data shape:
--   - 6 ephemeral users + 6 dealers
--   - 2 dealers zip='10001' → zip3='100' (BELOW floor of 3)
--   - 4 dealers zip='20001' → zip3='200' (ABOVE floor)
--   - 1 conversation + 1 buyer msg + 1 ai msg per dealer; ai msg is
--     dated 30s after conversation create so the view's median
--     (percentile_cont over m.created_at - c.created_at) has a non-zero
--     answer to compute.
--
-- Idempotent: ON CONFLICT DO NOTHING on auth.users + cleanup on the
-- exception path purges any leftover ephemerals if a previous run
-- raised mid-flight.

do $$
declare
  base_id      constant uuid := '00000000-0000-0000-0000-0000000c0010';
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; u5 uuid; u6 uuid;
  d1 uuid; d2 uuid; d3 uuid; d4 uuid; d5 uuid; d6 uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid;
  leak_count int;
  positive_count int;
  conv_ts timestamptz := now() - interval '1 hour';
  msg_ts  timestamptz := now() - interval '1 hour' + interval '30 seconds';
begin
  -- Seed UUIDs deterministically from base_id so a partial re-run can
  -- find/clean its own rows. Cast the int as 12-hex with leading zeros.
  u1 := '00000000-0000-0000-0000-0000000c0011'; u2 := '00000000-0000-0000-0000-0000000c0012';
  u3 := '00000000-0000-0000-0000-0000000c0013'; u4 := '00000000-0000-0000-0000-0000000c0014';
  u5 := '00000000-0000-0000-0000-0000000c0015'; u6 := '00000000-0000-0000-0000-0000000c0016';

  -- auth.users stubs.
  insert into auth.users (id, email, instance_id, aud, role) values
    (u1, 'bench-test-1@example.invalid', base_id, 'authenticated', 'authenticated'),
    (u2, 'bench-test-2@example.invalid', base_id, 'authenticated', 'authenticated'),
    (u3, 'bench-test-3@example.invalid', base_id, 'authenticated', 'authenticated'),
    (u4, 'bench-test-4@example.invalid', base_id, 'authenticated', 'authenticated'),
    (u5, 'bench-test-5@example.invalid', base_id, 'authenticated', 'authenticated'),
    (u6, 'bench-test-6@example.invalid', base_id, 'authenticated', 'authenticated')
  on conflict (id) do nothing;

  -- BELOW-floor cluster: 2 dealers in zip3='100'.
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u1, 'bench-100-a', 'Bench 100 A', '10001') returning id into d1;
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u2, 'bench-100-b', 'Bench 100 B', '10001') returning id into d2;

  -- ABOVE-floor cluster: 4 dealers in zip3='200'.
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u3, 'bench-200-a', 'Bench 200 A', '20001') returning id into d3;
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u4, 'bench-200-b', 'Bench 200 B', '20001') returning id into d4;
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u5, 'bench-200-c', 'Bench 200 C', '20001') returning id into d5;
  insert into public.dealers (owner_user_id, slug, name, zip)
       values (u6, 'bench-200-d', 'Bench 200 D', '20001') returning id into d6;

  -- One conversation + buyer msg + ai msg per dealer. conv created 1h
  -- ago; ai msg dated +30s so the view's percentile_cont has actual
  -- response-time data to chew on (non-null, non-zero).
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d1, 'bench-100-a-session-aaaaaaaaaaaaaa', 'en', 'web', 'sold', conv_ts) returning id into c1;
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d2, 'bench-100-b-session-bbbbbbbbbbbbbb', 'en', 'web', 'sold', conv_ts) returning id into c2;
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d3, 'bench-200-a-session-cccccccccccccc', 'en', 'web', 'sold', conv_ts) returning id into c3;
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d4, 'bench-200-b-session-dddddddddddddd', 'en', 'web', 'sold', conv_ts) returning id into c4;
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d5, 'bench-200-c-session-eeeeeeeeeeeeee', 'en', 'web', 'sold', conv_ts) returning id into c5;
  insert into public.conversations (dealer_id, buyer_session, language, channel, lead_status, created_at)
       values (d6, 'bench-200-d-session-ffffffffffffff', 'en', 'web', 'sold', conv_ts) returning id into c6;

  insert into public.messages (conversation_id, role, body, approval_status, created_at) values
    (c1, 'buyer', 'bench inbound 1', 'auto', conv_ts),
    (c1, 'ai',    'bench reply 1',   'auto', msg_ts),
    (c2, 'buyer', 'bench inbound 2', 'auto', conv_ts),
    (c2, 'ai',    'bench reply 2',   'auto', msg_ts),
    (c3, 'buyer', 'bench inbound 3', 'auto', conv_ts),
    (c3, 'ai',    'bench reply 3',   'auto', msg_ts),
    (c4, 'buyer', 'bench inbound 4', 'auto', conv_ts),
    (c4, 'ai',    'bench reply 4',   'auto', msg_ts),
    (c5, 'buyer', 'bench inbound 5', 'auto', conv_ts),
    (c5, 'ai',    'bench reply 5',   'auto', msg_ts),
    (c6, 'buyer', 'bench inbound 6', 'auto', conv_ts),
    (c6, 'ai',    'bench reply 6',   'auto', msg_ts);

  -- ASSERTION 1: zip3='100' (below floor) must NOT appear in the view.
  select count(*) into leak_count
    from public.dealer_zip_benchmarks
   where zip3 = '100';

  if leak_count > 0 then
    raise exception
      'v0.7 bench-iso FAIL: dealer_zip_benchmarks leaked % row(s) for zip3=100 (only 2 dealers). '
      'The HAVING count(*) >= 3 clause is missing or wrong in the view definition.',
      leak_count;
  end if;

  -- POSITIVE CONTROL: zip3='200' (above floor) MUST appear. Without
  -- this, a future refactor that returns nothing for everyone would
  -- pass the leak check silently.
  select count(*) into positive_count
    from public.dealer_zip_benchmarks
   where zip3 = '200';

  if positive_count = 0 then
    raise exception
      'v0.7 bench-iso FAIL (positive control): dealer_zip_benchmarks returned 0 rows for zip3=200 '
      '(4 dealers, all above the 3-dealer floor). The view is too restrictive — '
      'the leak check above is meaningless until non-floor dealers can be seen.';
  end if;

  -- Cleanup happy path. delete cascades through conversations + messages
  -- via the on-delete-cascade FKs.
  delete from public.conversations where id in (c1, c2, c3, c4, c5, c6);
  delete from public.dealers where id in (d1, d2, d3, d4, d5, d6);
  delete from auth.users where id in (u1, u2, u3, u4, u5, u6);

exception
  -- Best-effort cleanup on unexpected SQLSTATEs. Re-raise so a failed
  -- migration still fails loudly.
  when others then
    begin
      delete from public.conversations where buyer_session in (
        'bench-100-a-session-aaaaaaaaaaaaaa',
        'bench-100-b-session-bbbbbbbbbbbbbb',
        'bench-200-a-session-cccccccccccccc',
        'bench-200-b-session-dddddddddddddd',
        'bench-200-c-session-eeeeeeeeeeeeee',
        'bench-200-d-session-ffffffffffffff'
      );
      delete from public.dealers where slug in (
        'bench-100-a','bench-100-b',
        'bench-200-a','bench-200-b','bench-200-c','bench-200-d'
      );
      delete from auth.users where id in (
        '00000000-0000-0000-0000-0000000c0011'::uuid,
        '00000000-0000-0000-0000-0000000c0012'::uuid,
        '00000000-0000-0000-0000-0000000c0013'::uuid,
        '00000000-0000-0000-0000-0000000c0014'::uuid,
        '00000000-0000-0000-0000-0000000c0015'::uuid,
        '00000000-0000-0000-0000-0000000c0016'::uuid
      );
    exception when others then
      null;
    end;
    raise;
end $$;
