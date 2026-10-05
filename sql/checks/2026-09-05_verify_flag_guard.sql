-- Verify guard_org_membership_flags() — the trigger that stops permissions being minted
-- 2026-09-05
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Reports by raising an exception. THE ERROR MESSAGE IS THE REPORT, and the raise is also
-- what discards every row this file creates. Nothing here is left behind.
--
--
-- WHY THIS FILE EXISTS
-- On 2026-09-04 a privilege escalation was found and closed: guard_org_membership_flags()
-- was BEFORE UPDATE only, so an officer holding can_manage_members could not raise an
-- existing member's permissions but could INSERT a brand-new membership row carrying every
-- flag — handing full authority to an accomplice, or to a second account of their own.
--
-- The fix was applied and the status page recorded it as "closed and re-checked". The file
-- re-run was 2026-09-04_verify_can_act.sql, and that file cannot see this trigger at all.
-- It tests can_act(), seven ways, and every membership row it inserts during setup is
-- inserted with no JWT set — which lands in the guard's break-glass branch and returns
-- immediately. It walks past the trigger rather than through it.
--
-- So until this file, the most security-critical object in the org system had no test.
--
--
-- HOW THE BREAK-GLASS SHAPES THIS FILE
-- The guard's first branch returns unconditionally when there is no JWT role claim, because
-- the SQL editor sends none and without that branch the database could not bootstrap its own
-- first administrator. Every assertion below therefore sets request.jwt.claims to a real
-- 'authenticated' claim first. An assertion that forgets is not a lenient test — it is not a
-- test at all, and it passes.
--
--
-- WHAT THIS FILE DOES NOT TEST, STATED PLAINLY
-- The SQL editor connects as a role that BYPASSES row level security. So this proves the
-- TRIGGER refuses what it should and permits what it should. It does not exercise the
-- org_memberships_insert POLICY sitting in front of it.
--
-- That is deliberate and it is a real limit. The two layers answer different questions —
-- the policy asks "may you write a row here at all", the trigger asks "may that row grant
-- authority" — and only the second one has never been checked. The policy is exercised
-- every time the admin officer panel adds someone. Do not read a pass here as proof that
-- both layers hold.
--
--
-- THE TEST THAT MATTERS MOST IS TEST 1
-- A guard that refuses every write would pass tests 2 through 7 perfectly. Test 1 and test 6
-- are the only ones that can tell "correct" apart from "broken shut", and a permission guard
-- broken shut looks exactly like a permission system working right up until an officer tries
-- to add a member and cannot say why it failed.
--
-- Tests 9 and 10 are the ones that catch the specific mistake this week's migration could
-- make: adding a flag to the table and forgetting to add it to the guard's two lists. A flag
-- missing from those lists can be set freely by anyone who can insert a membership row.


DO $verify$
DECLARE
  v_school     text;
  v_school_org bigint;
  v_club_org   bigint;
  v_other_club bigint;
  v_users      uuid[];
  v_admin      uuid;      -- school-level officer, HOLDS can_manage_admins
  v_officer    uuid;      -- club-level officer, holds can_manage_members and NOT manage_admins
  v_target     uuid;      -- the person being added or edited (may be null)
  v_mem_id     bigint;
  r            text := '';
  pass_all     boolean := true;
BEGIN

  -- ---------- find usable students ----------
  -- Anyone holding a user_roles row is excluded: is_super_admin() short-circuits both
  -- can_act() and the guard itself, so an admin as the officer would turn every REFUSED
  -- test below into a meaningless pass.
  SELECT array_agg(id) INTO v_users
  FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at
    LIMIT 3
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 2 THEN
    RAISE EXCEPTION E'\nNot enough non-admin profiles to test with (found %). This needs at least 2, and 3 for full coverage.\nSee sql/2026-09-05_seed_dev_org.sql for how to create them.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_admin   := v_users[1];
  v_officer := v_users[2];
  v_target  := CASE WHEN array_length(v_users, 1) >= 3 THEN v_users[3] ELSE NULL END;

  r := r || format(E'\nSchool admin (has manage_admins): %s\nClub officer (has manage_members only): %s\nTarget student: %s\n\n',
                   v_admin, v_officer,
                   coalesce(v_target::text, 'none — TESTS 1, 5, 6, 7, 8 and 10 will be SKIPPED'));

  -- ---------- a throwaway school ----------
  -- organizations.school is a foreign key to schools(slug) as of
  -- 2026-09-04_school_foreign_keys.sql, so a test hierarchy needs a real school row. It
  -- cannot be a placeholder like '__verify__' either: schools.slug carries a format check
  -- (2026-09-04_slug_format.sql) that permits only lowercase letters, digits and single
  -- hyphens. Hence a legal-looking slug on a reserved .invalid domain.
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Guard School', 'verify-guard', 'verify-guard.invalid')
  RETURNING slug INTO v_school;

  -- ---------- a two-level hierarchy, plus a sibling club ----------
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Guard School', 'vg-school')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'club', 'Verify Guard Club', 'vg-club')
  RETURNING id INTO v_club_org;

  -- A second club under the same school, so test 7 has somewhere to try to move a row TO.
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'club', 'Verify Guard Other', 'vg-other')
  RETURNING id INTO v_other_club;

  -- Setup rows are inserted with NO jwt claim, so the guard's break-glass lets them through.
  -- That is the only way to create the first officer, and it is exactly why every assertion
  -- below has to set the claim explicitly.
  PERFORM set_config('request.jwt.claims', '', true);

  -- School admin: holds can_manage_admins at the ROOT, so authority reaches both clubs.
  INSERT INTO public.org_memberships (
    org_id, user_id, role, title, status, can_manage_members, can_manage_admins)
  VALUES (v_school_org, v_admin, 'officer', 'Administrator', 'active', true, true);

  -- Club officer: can manage the roster, and deliberately CANNOT grant permissions.
  -- This is the president in decision A of the build document, and the whole point of the
  -- distinction: they run their club, they do not mint authority.
  INSERT INTO public.org_memberships (
    org_id, user_id, role, title, status, can_manage_members, can_manage_admins)
  VALUES (v_club_org, v_officer, 'officer', 'President', 'active', true, false);


  -- ======================================================================
  -- TEST 1 — the officer adds a plain member. Must be ALLOWED.
  -- ======================================================================
  -- READ THE HEADER. This is the test that separates a working guard from one that refuses
  -- everything. Tests 2 through 7 all pass against a guard that is simply broken shut.
  --
  -- It also creates the row that tests 5, 6, 7 and 10 operate on. Those four are gated on
  -- v_mem_id rather than on v_target, so that if this test is refused they report SKIPPED
  -- rather than inventing four more failures — an UPDATE matching zero rows fires no
  -- trigger, raises nothing, and would otherwise read as "the guard allowed it".
  IF v_target IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_officer), true);
    BEGIN
      INSERT INTO public.org_memberships (org_id, user_id, role, status)
      VALUES (v_club_org, v_target, 'member', 'active')
      RETURNING id INTO v_mem_id;
      r := r || E'TEST 1  officer adds a plain member ............... PASS (allowed)\n';
    EXCEPTION WHEN others THEN
      r := r || format(E'TEST 1  officer adds a plain member ............... *** FAIL — REFUSED: %s ***\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 1  officer adds a plain member ............... SKIPPED (needs a third student)\n';
  END IF;


  -- ======================================================================
  -- TEST 2 — the officer inserts a row carrying can_post. Must be REFUSED.
  -- ======================================================================
  -- Granting any flag is granting authority, and this officer holds can_manage_members only.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, status, can_post)
    VALUES (v_club_org, v_admin, 'member', 'active', true);
    r := r || E'TEST 2  officer inserts a row with can_post ........ *** FAIL — ALLOWED, FLAGS CAN BE MINTED ***\n';
    pass_all := false;
    -- Remove it, or the next test that inserts this same (org, user) pair fails on
    -- the unique constraint and reports a confusing error instead of its own verdict.
    DELETE FROM public.org_memberships WHERE org_id = v_club_org AND user_id = v_admin;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 2  officer inserts a row with can_post ........ PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 2  officer inserts a row with can_post ........ FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;


  -- ======================================================================
  -- TEST 3 — the officer inserts a row carrying can_manage_admins. Must be REFUSED.
  -- ======================================================================
  -- THE ORIGINAL HOLE, in one statement. Before 2026-09-04_fix_membership_insert_guard.sql
  -- this succeeded. It is the accomplice attack: the officer cannot raise their own row, so
  -- they create somebody else's holding everything, and that somebody raises theirs.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  BEGIN
    INSERT INTO public.org_memberships (
      org_id, user_id, role, status, can_manage_admins)
    VALUES (v_club_org, v_admin, 'member', 'active', true);
    r := r || E'TEST 3  officer mints can_manage_admins ............ *** FAIL — THE 2026-09-04 HOLE IS OPEN ***\n';
    pass_all := false;
    -- Remove it, or the next test that inserts this same (org, user) pair fails on
    -- the unique constraint and reports a confusing error instead of its own verdict.
    DELETE FROM public.org_memberships WHERE org_id = v_club_org AND user_id = v_admin;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  officer mints can_manage_admins ............ PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 3  officer mints can_manage_admins ............ FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;


  -- ======================================================================
  -- TEST 4 — the officer inserts an officer with no flags at all. Must be REFUSED.
  -- ======================================================================
  -- Officer STANDING is authority even with every flag false: it is what the console reads
  -- to decide someone is staff, and it is the row a later grant would be attached to.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, status)
    VALUES (v_club_org, v_admin, 'officer', 'active');
    r := r || E'TEST 4  officer creates another officer ............ *** FAIL — ALLOWED ***\n';
    pass_all := false;
    -- Remove it, or the next test that inserts this same (org, user) pair fails on
    -- the unique constraint and reports a confusing error instead of its own verdict.
    DELETE FROM public.org_memberships WHERE org_id = v_club_org AND user_id = v_admin;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 4  officer creates another officer ............ PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 4  officer creates another officer ............ FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;


  -- ======================================================================
  -- TEST 5 — the officer raises an existing member's can_post. Must be REFUSED.
  -- ======================================================================
  -- The UPDATE branch, which is the part that was correct all along. Kept because a
  -- migration that rewrites this function can break either branch, and this file is now the
  -- only thing standing between such a migration and a silent regression.
  IF v_mem_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_officer), true);
    BEGIN
      UPDATE public.org_memberships SET can_post = true WHERE id = v_mem_id;
      r := r || E'TEST 5  officer raises a member''s can_post ........ *** FAIL — ALLOWED ***\n';
      pass_all := false;
    EXCEPTION WHEN insufficient_privilege THEN
      r := r || E'TEST 5  officer raises a member''s can_post ........ PASS (refused)\n';
    WHEN others THEN
      r := r || format(E'TEST 5  officer raises a member''s can_post ........ FAIL — wrong error: %s\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 5  officer raises a member''s can_post ........ SKIPPED (no member row — see TEST 1)\n';
  END IF;


  -- ======================================================================
  -- TEST 6 — the officer edits a member's title. Must be ALLOWED.
  -- ======================================================================
  -- The UPDATE-side companion to test 1. Roster management must keep working; the guard is
  -- meant to be a fence around the flag columns, not around the row.
  IF v_mem_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_officer), true);
    BEGIN
      UPDATE public.org_memberships SET title = 'Treasurer' WHERE id = v_mem_id;
      r := r || E'TEST 6  officer edits a member''s title ............ PASS (allowed)\n';
    EXCEPTION WHEN others THEN
      r := r || format(E'TEST 6  officer edits a member''s title ............ *** FAIL — REFUSED: %s ***\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 6  officer edits a member''s title ............ SKIPPED (no member row — see TEST 1)\n';
  END IF;


  -- ======================================================================
  -- TEST 7 — the officer moves a membership to another org. Must be REFUSED.
  -- ======================================================================
  -- Without this branch, someone with can_manage_members on a club they run could take a
  -- row and move it to a club they do not.
  IF v_mem_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_officer), true);
    BEGIN
      UPDATE public.org_memberships SET org_id = v_other_club WHERE id = v_mem_id;
      r := r || E'TEST 7  officer moves a row between orgs .......... *** FAIL — ALLOWED ***\n';
      pass_all := false;
    EXCEPTION WHEN insufficient_privilege THEN
      r := r || E'TEST 7  officer moves a row between orgs .......... PASS (refused)\n';
    WHEN others THEN
      r := r || format(E'TEST 7  officer moves a row between orgs .......... FAIL — wrong error: %s\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 7  officer moves a row between orgs .......... SKIPPED (no member row — see TEST 1)\n';
  END IF;


  -- ======================================================================
  -- TEST 8 — the SCHOOL ADMIN grants can_post on the club below. Must be ALLOWED.
  -- ======================================================================
  -- Proves two things at once: the guard permits a legitimate grant, and can_act() inside
  -- the guard walks parent_id upward — the admin's authority is held on the school row, two
  -- levels above the membership being created.
  IF v_target IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_admin), true);
    BEGIN
      INSERT INTO public.org_memberships (
        org_id, user_id, role, title, status, can_post)
      VALUES (v_other_club, v_target, 'officer', 'President', 'active', true);
      r := r || E'TEST 8  school admin grants can_post downward ..... PASS (allowed)\n';
    EXCEPTION WHEN others THEN
      r := r || format(E'TEST 8  school admin grants can_post downward ..... *** FAIL — REFUSED: %s ***\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 8  school admin grants can_post downward ..... SKIPPED (needs a third student)\n';
  END IF;


  -- ======================================================================
  -- TEST 9 — the officer inserts a row carrying can_check_in. Must be REFUSED.
  -- ======================================================================
  -- The new-flag test, INSERT side. A flag present on the table but absent from the guard's
  -- INSERT list can be set by anyone who may insert a membership row at all — and nothing
  -- else in the database would notice. This is the exact mistake 2026-09-05_flag_set.sql
  -- was in a position to make, and the reason these two tests exist.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, status, can_check_in)
    VALUES (v_club_org, v_admin, 'member', 'active', true);
    r := r || E'TEST 9  officer mints can_check_in (new flag) ...... *** FAIL — FLAG MISSING FROM THE GUARD ***\n';
    pass_all := false;
    -- Remove it, or the next test that inserts this same (org, user) pair fails on
    -- the unique constraint and reports a confusing error instead of its own verdict.
    DELETE FROM public.org_memberships WHERE org_id = v_club_org AND user_id = v_admin;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 9  officer mints can_check_in (new flag) ...... PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 9  officer mints can_check_in (new flag) ...... FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;


  -- ======================================================================
  -- TEST 10 — the officer raises a member's can_manage_events. Must be REFUSED.
  -- ======================================================================
  -- The new-flag test, UPDATE side. The guard keeps two separate lists of the flag set and
  -- a flag can be forgotten from either one independently, so both need a test.
  IF v_mem_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_officer), true);
    BEGIN
      UPDATE public.org_memberships SET can_manage_events = true WHERE id = v_mem_id;
      r := r || E'TEST 10 officer raises can_manage_events (new) .... *** FAIL — FLAG MISSING FROM THE GUARD ***\n';
      pass_all := false;
    EXCEPTION WHEN insufficient_privilege THEN
      r := r || E'TEST 10 officer raises can_manage_events (new) .... PASS (refused)\n';
    WHEN others THEN
      r := r || format(E'TEST 10 officer raises can_manage_events (new) .... FAIL — wrong error: %s\n', SQLERRM);
      pass_all := false;
    END;
  ELSE
    r := r || E'TEST 10 officer raises can_manage_events (new) .... SKIPPED (no member row — see TEST 1)\n';
  END IF;


  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. The flag guard discriminates rather than merely refusing.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  r := r || E'\n\nThis proves the TRIGGER only. RLS is bypassed in the SQL editor, so the'
         || E'\norg_memberships_insert policy in front of it was not exercised here.';

  r := r || E'\n\nNote: the id sequences advanced for the throwaway rows and do not roll back.'
         || E'\nThat is normal and harmless.';

  -- Raising is how this reports AND how it discards every row created above, including the
  -- throwaway school.
  RAISE EXCEPTION E'%\n', r;
END
$verify$;
