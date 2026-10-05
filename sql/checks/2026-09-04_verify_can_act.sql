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
--   Added 2026-09-05 with the frozen flag set (sql/2026-09-05_flag_set.sql):
--     TEST 8  club officer  -> manage_events on own club -> must be TRUE
--     TEST 9  club officer  -> check_in on own club      -> must be FALSE (flag not held)
--     TEST 10 school admin  -> check_in on the club below-> must be TRUE   (the walk up)
--     TEST 11 anyone        -> the DROPPED flag          -> must be FALSE, not an error
--
--   Tests 8 and 9 are a pair on purpose. A positive alone would pass against a can_act()
--   whose CASE fell through to something permissive; a negative alone would pass against
--   one that had never heard of the flag. Neither proves the branch on its own.
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
  v_school     text;
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
  -- Everything here is discarded by the RAISE at the end.
  --
  -- REPAIRED 2026-09-05. This file originally used school = '__verify__' as a value that
  -- could never collide with 'caldwell'. Later the same day
  -- 2026-09-04_school_foreign_keys.sql constrained organizations.school to schools(slug),
  -- and from that moment this file could not run at all: the first INSERT below failed on
  -- the foreign key before a single test executed. The status page went on describing
  -- can_act() as proven seven ways by a file that errored on its first statement.
  --
  -- Nor can the old placeholder simply be registered as a school. 2026-09-04_slug_format.sql
  -- gives schools.slug a check constraint permitting only lowercase letters, digits and
  -- single hyphens, so '__verify__' is now unrepresentable there too. Hence a legal-looking
  -- slug on a reserved .invalid domain, inserted and rolled back with everything else.
  --
  -- The lesson is worth more than the fix: a verification file is code, and a constraint
  -- added elsewhere can break it as easily as it breaks the app. Re-running every prior
  -- verification after a schema change is §6.4 of the build document, and this is what it
  -- is for.
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify School', 'verify-canact', 'verify-canact.invalid')
  RETURNING slug INTO v_school;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify School', 'vschool')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'department', 'Verify Dept', 'vdept')
  RETURNING id INTO v_dept_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_dept_org, 'club', 'Verify Club', 'vclub')
  RETURNING id INTO v_club_org;

  -- School admin: can_post on the ROOT. Test 2 depends on this reaching the club.
  -- can_check_in is held HERE and nowhere else, so test 10 can only pass by walking upward.
  INSERT INTO public.org_memberships (
    org_id, user_id, role, title, status, can_post, can_manage_admins, can_check_in)
  VALUES (v_school_org, v_admin, 'officer', 'Administrator', 'active', true, true, true);

  -- Club officer: can_post and can_manage_events on the CLUB only. Deliberately NOT
  -- can_manage_admins (test 5) and deliberately NOT can_check_in (test 9) — the two new
  -- flags are split across the two people so that each one's test can only be satisfied
  -- one way.
  INSERT INTO public.org_memberships (
    org_id, user_id, role, title, status, can_post, can_manage_admins, can_manage_events)
  VALUES (v_club_org, v_officer, 'officer', 'President', 'active', true, false, true);

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
  VALUES (v_school, NULL, 'club', 'Cycle A', 'vcyca') RETURNING id INTO v_cycle_a;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_cycle_a, 'club', 'Cycle B', 'vcycb') RETURNING id INTO v_cycle_b;
  UPDATE public.organizations SET parent_id = v_cycle_b WHERE id = v_cycle_a;

  BEGIN
    v_got := public.can_act('post', v_cycle_a);
    r := r || format(E'TEST 7  parent_id cycle terminates ............... PASS (returned %s, did not hang)\n', v_got);
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 7  parent_id cycle terminates ............... FAIL — errored: %s\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 8 — the officer holds can_manage_events. Must be TRUE. ----------
  -- The positive half of the new-flag pair. Read by Phase 3, where creating, editing,
  -- publishing and cancelling an event all route through this one answer.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  v_got := public.can_act('manage_events', v_club_org);
  IF v_got THEN
    r := r || E'TEST 8  officer manages events in own club ....... PASS (allowed)\n';
  ELSE
    r := r || E'TEST 8  officer manages events in own club ....... *** FAIL — REFUSED, FLAG NOT WIRED ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 9 — the officer does NOT hold can_check_in. Must be FALSE. ----------
  -- The negative half. This is the test that would catch a CASE branch mapping check_in to
  -- the wrong column, or to a column that is true for this officer for some other reason.
  v_got := public.can_act('check_in', v_club_org);
  IF v_got THEN
    r := r || E'TEST 9  officer checks in without the flag ....... *** FAIL — ALLOWED WITHOUT THE FLAG ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 9  officer checks in without the flag ....... PASS (refused)\n';
  END IF;

  -- ---------- TEST 10 — the school admin's can_check_in reaches the club. Must be TRUE. ----------
  -- Same shape as test 2, on a new flag. It matters separately because the walk is written
  -- once but the CASE is written per flag: a flag can be present in the column and absent
  -- from the CASE, and then it works for nobody at any level.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_admin), true);
  v_got := public.can_act('check_in', v_club_org);
  IF v_got THEN
    r := r || E'TEST 10 school admin checks in two levels down ... PASS (allowed)\n';
  ELSE
    r := r || E'TEST 10 school admin checks in two levels down ... *** FAIL — REFUSED ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 11 — the dropped flag is inert, not an error. Must be FALSE. ----------
  -- can_moderate was removed by 2026-09-05_flag_set.sql. The CASE ends in `else false`, so a
  -- request for a flag that no longer exists is REFUSED rather than raising — which is the
  -- right direction for a permission function, and is also why a misspelled action name
  -- fails silently rather than loudly. Asserted here so the behaviour is a decision on the
  -- record rather than an accident nobody checked.
  --
  -- The school admin is the caller deliberately: they hold the most authority available, so
  -- if anything could make a dead flag answer true, it would be them.
  BEGIN
    v_got := public.can_act('moderate', v_club_org);
    IF v_got THEN
      r := r || E'TEST 11 the dropped flag stays refused .......... *** FAIL — ALLOWED ***\n';
      pass_all := false;
    ELSE
      r := r || E'TEST 11 the dropped flag stays refused .......... PASS (refused, no error)\n';
    END IF;
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 11 the dropped flag stays refused .......... FAIL — raised instead: %s\n', SQLERRM);
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
