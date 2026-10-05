-- Verify guard_org_self_removal() — an officer cannot remove their own officer role
-- 2026-09-06
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Reports by raising an exception. THE ERROR MESSAGE IS THE REPORT, and the raise is also
-- what discards every row this file creates.
--
-- Needs THREE non-admin student accounts.
--
--
-- TESTS 4, 5 AND 6 ARE THE POINT OF THIS FILE
-- A guard that refused every removal would pass tests 1, 2 and 3 perfectly and be completely
-- broken — a club would be a room nobody could ever leave, and an officer who graduated would
-- stay an officer for ever.
--
-- So three of the six assert that a removal SUCCEEDS: a plain member leaving of their own
-- accord, an officer being removed by a different officer, and an officer editing their own
-- row in a way that takes nothing away. Those three are what separate "correct" from
-- "refuses everything", and the flag guard's own history is why they are written first in
-- this comment rather than last in the file.


DO $verify$
DECLARE
  v_school   text;
  v_root     bigint;
  v_club     bigint;
  v_users    uuid[];
  v_boss     uuid;    -- officer on the ROOT: the "somebody above you" escape hatch
  v_officer  uuid;    -- club officer, holds can_manage_members
  v_member   uuid;    -- plain member, holds nothing
  v_m_off    bigint;  -- the officer's membership id
  v_m_mem    bigint;  -- the member's membership id
  r          text := '';
  pass_all   boolean := true;
BEGIN

  SELECT array_agg(id) INTO v_users
  FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at LIMIT 3
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 3 THEN
    RAISE EXCEPTION E'\nThis file needs THREE non-admin student accounts and found %.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_boss := v_users[1]; v_officer := v_users[2]; v_member := v_users[3];
  r := r || format(E'\nRoot officer: %s\nClub officer: %s\nPlain member: %s\n\n', v_boss, v_officer, v_member);

  -- ---------- fixtures ----------
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Selfrm School', 'verify-selfrm', 'verify-selfrm.invalid')
  RETURNING slug INTO v_school;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Selfrm School', 'vs-school') RETURNING id INTO v_root;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_root, 'club', 'Verify Selfrm Club', 'vs-club') RETURNING id INTO v_club;

  PERFORM set_config('request.jwt.claims', '', true);   -- break-glass for setup

  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_manage_members, can_manage_admins)
  VALUES (v_root, v_boss, 'officer', 'Administrator', 'active', true, true);

  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_manage_members, can_manage_admins)
  VALUES (v_club, v_officer, 'officer', 'President', 'active', true, true)
  RETURNING id INTO v_m_off;

  INSERT INTO public.org_memberships (org_id, user_id, role, status)
  VALUES (v_club, v_member, 'member', 'active')
  RETURNING id INTO v_m_mem;


  -- ---------- TEST 1 — the officer deletes their own row. REFUSED. ----------
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  BEGIN
    DELETE FROM public.org_memberships WHERE id = v_m_off;
    r := r || E'TEST 1  officer deletes own row ................. *** FAIL — ALLOWED ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 1  officer deletes own row ................. PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 1  officer deletes own row ................. FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 2 — the officer marks their own row removed. REFUSED. ----------
  -- The path the interface actually takes, now that removal is a status change.
  BEGIN
    UPDATE public.org_memberships SET status = 'removed' WHERE id = v_m_off;
    r := r || E'TEST 2  officer removes own row by status ....... *** FAIL — ALLOWED ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 2  officer removes own row by status ....... PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 2  officer removes own row by status ....... FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 3 — the officer drops their own flag. REFUSED. ----------
  -- The two-step way round the rule: give up the flag, then leave. Same end state, so the
  -- guard has to cover it or the other two tests are theatre.
  BEGIN
    UPDATE public.org_memberships SET can_manage_members = false WHERE id = v_m_off;
    r := r || E'TEST 3  officer drops own manage_members ........ *** FAIL — THE RULE IS AVOIDABLE IN TWO STEPS ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  officer drops own manage_members ........ PASS (refused)\n';
  WHEN others THEN
    r := r || format(E'TEST 3  officer drops own manage_members ........ FAIL — wrong error: %s\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 4 — the officer edits their own title. ALLOWED. ----------
  -- Not every write to your own row is a removal. If this fails, the guard is too broad and
  -- an officer cannot maintain their own record at all.
  BEGIN
    UPDATE public.org_memberships SET title = 'Co-President' WHERE id = v_m_off;
    r := r || E'TEST 4  officer edits own title ................. PASS (allowed)\n';
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 4  officer edits own title ................. *** FAIL — REFUSED: %s ***\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 5 — the plain member leaves. ALLOWED. ----------
  -- "A student may always leave" is the principle the delete policy was written for, and it
  -- has to survive this guard intact. The member holds no flags, so the guard lets them past
  -- without ever reaching an exception.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_member), true);
  BEGIN
    DELETE FROM public.org_memberships WHERE id = v_m_mem;
    r := r || E'TEST 5  plain member leaves on their own ........ PASS (allowed)\n';
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 5  plain member leaves on their own ........ *** FAIL — REFUSED: %s ***\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 6 — somebody ABOVE removes the officer. ALLOWED. ----------
  -- The escape hatch, and the reason the rule in test 1 is not a trap. The root officer never
  -- touched the club, holds no membership on it, and reaches it because can_act() walks
  -- parent_id upward. If this fails, an officer who wants to step down has nobody to ask.
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_boss), true);
  BEGIN
    UPDATE public.org_memberships SET status = 'removed' WHERE id = v_m_off;
    r := r || E'TEST 6  officer above removes the officer ....... PASS (allowed, walked up)\n';
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 6  officer above removes the officer ....... *** FAIL — REFUSED: %s ***\n', SQLERRM);
    pass_all := false;
  END;


  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. An officer cannot strand an organization, a member can still'
            || E'\nleave, and there is always somebody above who can let an officer go.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  r := r || E'\n\nTests 4, 5 and 6 are the ones that matter. A guard refusing every removal'
         || E'\nwould pass 1, 2 and 3 and make a club a room nobody could leave.';

  RAISE EXCEPTION E'%\n', r;
END
$verify$;
