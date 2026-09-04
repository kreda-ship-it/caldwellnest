-- ============================================================================
-- Verify can_act() — the permission rule the whole engagement system rests on
-- Self-contained: builds its own hierarchy, nothing left behind.
-- ============================================================================
--
-- HOW TO RUN
--   Paste this whole file into the Supabase SQL editor and Run. Do not edit it.
--
--   ⚠️ IT ENDS BY REPORTING AN ERROR. That is intentional and is not a failure.
--   Raising an exception is how the results get displayed and how every test
--   write is discarded — the error message IS the report. Read it.
--
--   Modelled on 2026-08-08_verify_owner_guards.sql, which established this
--   pattern in this project.
--
-- WHY THIS EXISTS
--   can_act() begins `select public.is_super_admin() or exists (...)`. Every
--   time it has been called so far, it was called by a super admin — so it
--   returned true on the first branch and stopped. The membership lookup and
--   the recursive parent walk, which are the entire design, had never once
--   executed. Six workstreams are planned on top of a function nobody has run.
--
--   These tests impersonate ordinary students, for whom is_super_admin() is
--   false, so the second branch actually runs.
--
-- WHAT IT CHECKS
--   A three-level hierarchy is built inside the transaction:
--
--       Verify School   (school)
--         └─ Verify Dept   (department)
--              └─ Verify Club  (club)
--
--     TEST 1  club officer  -> post on their own club   -> must be TRUE
--     TEST 2  school admin  -> post on the club below   -> must be TRUE   (the walk up)
--     TEST 3  club officer  -> post on the dept above   -> must be FALSE  (flows down only)
--     TEST 4  plain member  -> post on their own club   -> must be FALSE  (needs 3 students)
--     TEST 5  club officer  -> manage_admins on club    -> must be FALSE  (flag not held)
--     TEST 6  pending member-> post on their own club   -> must be FALSE  (status must be active)
--     TEST 7  a parent_id cycle                         -> must RETURN, not hang
--
--   TEST 3 is the one that matters most. It is the only test that can catch the
--   walk running the wrong way — a rule that searched DOWNWARD instead of up
--   would pass tests 1 and 2 cheerfully and hand every club officer authority
--   over the whole university.
--
--   TEST 6 guards the "request to join" path. A pending membership must grant
--   nothing, or asking to join a club is a way to gain its permissions.
--
-- REQUIREMENTS
--   At least two profiles that are NOT admins. Admin accounts are unusable here:
--   is_super_admin() would return true for them and every test would pass for
--   the wrong reason. The file says so plainly if it cannot find enough.
-- ============================================================================

DO $verify$
DECLARE
  v_school_org bigint;
  v_dept_org   bigint;
  v_club_org   bigint;
  v_users      uuid[];
  v_admin      uuid;      -- school-level officer
  v_officer    uuid;      -- club-level officer
  v_member     uuid;      -- plain club member (may be null)
  v_cycle_a    bigint;
  v_cycle_b    bigint;
  v_got        boolean;
  r            text := '';
  pass_all     boolean := true;
BEGIN
  -- Impersonation works by setting the JWT claims for the transaction: auth.uid()
  -- reads the `sub` claim, and role 'authenticated' is what a signed-in browser
  -- session actually sends. Same technique as 2026-08-08_verify_owner_guards.sql.
  -- ---------- find usable students ----------
  -- Anyone holding a user_roles row is excluded: is_super_admin() short-circuits
  -- can_act() to true for them, which would turn every test below into a
  -- meaningless pass.
  SELECT array_agg(id) INTO v_users
  FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at
    LIMIT 3
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 2 THEN
    RAISE EXCEPTION E'\nNot enough non-admin profiles to test with (found %). This needs at least 2.\nSign up two test student accounts, then run this again.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_admin   := v_users[1];
  v_officer := v_users[2];
  v_member  := CASE WHEN array_length(v_users, 1) >= 3 THEN v_users[3] ELSE NULL END;

  r := r || format(E'\nSchool admin: %s\nClub officer: %s\nPlain member: %s\n\n',
                   v_admin, v_officer, coalesce(v_member::text, 'none — TEST 4 will be skipped'));

  -- ---------- build a throwaway hierarchy ----------
  -- school = '__verify__' so it can never collide with 'caldwell'. Everything
  -- here is discarded by the RAISE at the end.
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('__verify__', NULL, 'school', 'Verify School', 'vschool')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('__verify__', v_school_org, 'department', 'Verify Dept', 'vdept')
  RETURNING id INTO v_dept_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('__verify__', v_dept_org, 'club', 'Verify Club', 'vclub')
  RETURNING id INTO v_club_org;

  -- School admin: can_post on the ROOT. Tests 2 depends on this reaching the club.
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_post, can_manage_admins)
  VALUES (v_school_org, v_admin, 'officer', 'Administrator', 'active', true, true);

  -- Club officer: can_post on the CLUB only, and deliberately NOT can_manage_admins.
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_post, can_manage_admins)
  VALUES (v_club_org, v_officer, 'officer', 'President', 'active', true, false);

  IF v_member IS NOT NULL THEN
    INSERT INTO public.org_memberships (org_id, user_id, role, status)
    VALUES (v_club_org, v_member, 'member', 'active');
  END IF;

  -- ---------- TEST 1 — officer on their own club. Must be TRUE. ----------
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  v_got := public.can_act('post', v_club_org);
  IF v_got THEN
    r := r || E'TEST 1  officer posts in own club ............... PASS (allowed)\n';
  ELSE
    r := r || E'TEST 1  officer posts in own club ............... *** FAIL — REFUSED ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 2 — school admin two levels down. Must be TRUE. ----------
  -- This is the walk: club -> dept -> school, finding the membership at the top.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_admin), true);
  v_got := public.can_act('post', v_club_org);
  IF v_got THEN
    r := r || E'TEST 2  school admin posts in a club ............ PASS (allowed, walked up 2 levels)\n';
  ELSE
    r := r || E'TEST 2  school admin posts in a club ............ *** FAIL — REFUSED, WALK IS BROKEN ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 3 — officer reaching UPWARD. Must be FALSE. ----------
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  v_got := public.can_act('post', v_dept_org);
  IF v_got THEN
    r := r || E'TEST 3  club officer posts in parent dept ....... *** FAIL — ALLOWED, AUTHORITY FLOWS UP ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 3  club officer posts in parent dept ....... PASS (refused)\n';
  END IF;

  -- ---------- TEST 4 — plain member. Must be FALSE. ----------
  IF v_member IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_member), true);
    v_got := public.can_act('post', v_club_org);
    IF v_got THEN
      r := r || E'TEST 4  plain member posts in own club .......... *** FAIL — ALLOWED, FLAGS IGNORED ***\n';
      pass_all := false;
    ELSE
      r := r || E'TEST 4  plain member posts in own club .......... PASS (refused)\n';
    END IF;
  ELSE
    r := r || E'TEST 4  plain member posts in own club .......... SKIPPED (needs a third student)\n';
  END IF;

  -- ---------- TEST 5 — officer without the flag. Must be FALSE. ----------
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  v_got := public.can_act('manage_admins', v_club_org);
  IF v_got THEN
    r := r || E'TEST 5  officer grants permissions ............... *** FAIL — ALLOWED WITHOUT THE FLAG ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 5  officer grants permissions ............... PASS (refused)\n';
  END IF;

  -- ---------- TEST 6 — pending membership. Must be FALSE. ----------
  -- The join-request path inserts status='pending'. If pending granted anything,
  -- asking to join a club would be a way to gain its permissions.
  UPDATE public.org_memberships SET status = 'pending'
   WHERE org_id = v_club_org AND user_id = v_officer;

  v_got := public.can_act('post', v_club_org);
  IF v_got THEN
    r := r || E'TEST 6  pending member posts in club ............. *** FAIL — ALLOWED WHILE PENDING ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 6  pending member posts in club ............. PASS (refused)\n';
  END IF;

  UPDATE public.org_memberships SET status = 'active'
   WHERE org_id = v_club_org AND user_id = v_officer;

  -- ---------- TEST 7 — a parent_id cycle must terminate. ----------
  -- can_act() walks parent_id with `with recursive`. A cycle (A is a child of B,
  -- B is a child of A) would loop forever without the depth cap, holding a
  -- database connection open until it timed out. Supabase has a small connection
  -- pool, so one bad row could take the whole app down.
  --
  -- If this test never returns and the editor times out, THAT IS THE RESULT:
  -- the depth cap is broken. Everything above is rolled back either way.
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('__verify__', NULL, 'club', 'Cycle A', 'vcyca') RETURNING id INTO v_cycle_a;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('__verify__', v_cycle_a, 'club', 'Cycle B', 'vcycb') RETURNING id INTO v_cycle_b;
  UPDATE public.organizations SET parent_id = v_cycle_b WHERE id = v_cycle_a;

  BEGIN
    v_got := public.can_act('post', v_cycle_a);
    r := r || format(E'TEST 7  parent_id cycle terminates ............... PASS (returned %s, did not hang)\n', v_got);
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 7  parent_id cycle terminates ............... FAIL — errored: %s\n', SQLERRM);
    pass_all := false;
  END;

  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. can_act() works. Every row created above was rolled back.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  r := r || E'\n\nNote: the id sequences advanced for the throwaway rows and do not roll back.\nYour first real organization will not have id 1. That is normal and harmless.';

  -- Raising is how this reports AND how it discards every test row.
  RAISE EXCEPTION E'%\n', r;
END
$verify$;
