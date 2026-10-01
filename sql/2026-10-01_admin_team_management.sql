-- Sub-admins, step B2: the super admin manages roles from the Team page; super admin itself is SQL-only
-- 2026-10-01
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- The Team page (js/admin.js, "Admin team") lets the super admin add and remove admins, change their
-- role, switch a role's permissions on and off, and create a role for one person. Two of those needed
-- the database to change:
--   1. admin_roles could only be READ, so "New role" would have been refused.
--   2. user_roles let the super admin change ANY row, including super_admin rows. One mis-click on the
--      Team page could remove the only super admin — and nothing in the app could put it back — or
--      hand super admin to someone else.
--
-- WHAT CHANGES
--   admin_roles     the super admin may add, rename and delete roles — never the super_admin role.
--                   Deleting a role takes its switches with it (role_permissions cascades), and would
--                   take its holders too, so the Team page only offers Delete for a role nobody holds.
--   user_roles      split into: the super admin may READ every row (as before), and may add, change
--                   or remove only rows that are not super_admin, and may never create one.
--                   Everyone keeps reading their own row ("Users can read own roles", untouched).
--   role_permissions  unchanged: the super admin already manages it.
-- Super admin is now granted and removed only here, in the SQL editor, by someone who can already
-- see every table. That is deliberate: it is the one role a browser should never be able to touch.
--
-- WHAT YOU WILL NOTICE: nothing until the Team page ships.
--
-- UNDO:
--   drop policy "Super admin manages admin roles" on public.admin_roles;
--   drop policy "Super admin reads all roles" on public.user_roles;
--   drop policy "Super admin manages non-super roles" on public.user_roles;
--   create policy super_admin_manages_roles on public.user_roles as permissive for all
--     to authenticated using (public.is_super_admin()) with check (public.is_super_admin());


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- admin_roles: "Signed-in users read admin roles" (2026-09-04_harden_policies.sql) stays as it is.
drop policy if exists "Super admin manages admin roles" on public.admin_roles;
create policy "Super admin manages admin roles" on public.admin_roles
  as permissive for all to authenticated
  using (public.is_super_admin() and id <> 'super_admin')
  with check (public.is_super_admin() and id <> 'super_admin');

-- user_roles: the old all-in-one rule is split so super_admin rows are out of the browser's reach.
drop policy if exists super_admin_manages_roles on public.user_roles;

drop policy if exists "Super admin reads all roles" on public.user_roles;
create policy "Super admin reads all roles" on public.user_roles
  as permissive for select to authenticated
  using (public.is_super_admin());

drop policy if exists "Super admin manages non-super roles" on public.user_roles;
create policy "Super admin manages non-super roles" on public.user_roles
  as permissive for all to authenticated
  using (public.is_super_admin() and role_id <> 'super_admin')
  with check (public.is_super_admin() and role_id <> 'super_admin');

-- Normally already granted by Supabase's defaults; stated so the rules above can never be silently
-- useless. The rules decide who; these only make the doors exist. TRUNCATE is not granted.
grant select, insert, update, delete on public.admin_roles, public.user_roles, public.role_permissions to authenticated;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as you, then as a student made a Moderator for the
-- length of the test. THE ERROR MESSAGE IS THE REPORT, and the error discards everything it made.
-- ============================================================================

DO $verify$
DECLARE
  v_super uuid;
  v_mod   uuid;
  v_stu   uuid;
  v_n     int;
  r       text := E'\n';
  ok      boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  SELECT (array_agg(p.id ORDER BY p.created_at))[1], (array_agg(p.id ORDER BY p.created_at))[2]
    INTO v_mod, v_stu
  FROM public.profiles p
  WHERE p.status = 'active' AND p.school IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id);
  IF v_super IS NULL OR v_mod IS NULL OR v_stu IS NULL THEN
    RAISE EXCEPTION 'Needs the super admin and two active non-admin students to test with.';
  END IF;

  -- As you.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);

  BEGIN
    INSERT INTO public.admin_roles (id, label, description) VALUES ('verify_role', 'Verify', 'self-test');
    INSERT INTO public.role_permissions (role_id, permission_key, enabled) VALUES ('verify_role', 'view_analytics', true);
    r := r || E'TEST 1  you can create a role and set its switches ...... PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 1  you can create a role and set its switches ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    INSERT INTO public.user_roles (user_id, role_id, school, granted_by)
    SELECT v_mod, 'school_admin', school, v_super FROM public.profiles WHERE id = v_mod;
    UPDATE public.user_roles SET role_id = 'viewer' WHERE user_id = v_mod AND role_id = 'school_admin';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN r := r || E'TEST 2  you can add an admin and change their role ... PASS\n';
    ELSE r := r || E'TEST 2  you can add an admin and change their role ... *** FAIL — role not changed ***\n'; ok := false; END IF;
    UPDATE public.user_roles SET role_id = 'school_admin' WHERE user_id = v_mod;   -- back, for TEST 7
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 2  you can add an admin and change their role ... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  DELETE FROM public.user_roles WHERE user_id = v_super AND role_id = 'super_admin';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 3  you cannot remove your own super admin ....... PASS (0 rows)\n';
  ELSE r := r || E'TEST 3  you cannot remove your own super admin ....... *** FAIL — REMOVED ***\n'; ok := false; END IF;

  BEGIN
    INSERT INTO public.user_roles (user_id, role_id, school) VALUES (v_stu, 'super_admin', NULL);
    r := r || E'TEST 4  nobody can make a super admin from the app ... *** FAIL — CREATED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 4  nobody can make a super admin from the app ... PASS (refused)\n';
  END;

  DELETE FROM public.admin_roles WHERE id = 'super_admin';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 5  the super admin role cannot be deleted ...... PASS (0 rows)\n';
  ELSE r := r || E'TEST 5  the super admin role cannot be deleted ...... *** FAIL — DELETED ***\n'; ok := false; END IF;

  SELECT count(*) INTO v_n FROM public.user_roles WHERE role_id = 'super_admin';
  IF v_n >= 1 THEN r := r || E'TEST 6  you can still see your own super admin row .. PASS\n';
  ELSE r := r || E'TEST 6  you can still see your own super admin row .. *** FAIL — invisible (login would break) ***\n'; ok := false; END IF;

  -- As the Moderator: no team management at all.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_mod), true);
  BEGIN
    INSERT INTO public.user_roles (user_id, role_id, school) VALUES (v_stu, 'school_admin', 'caldwell');
    r := r || E'TEST 7  a Moderator cannot add admins ................ *** FAIL — ADDED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 7  a Moderator cannot add admins ................ PASS (refused)\n';
  END;

  UPDATE public.role_permissions SET enabled = true WHERE role_id = 'school_admin' AND permission_key = 'view_messages';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 8  a Moderator cannot switch on their own powers  PASS (0 rows)\n';
  ELSE r := r || E'TEST 8  a Moderator cannot switch on their own powers  *** FAIL — CHANGED ***\n'; ok := false; END IF;

  SELECT count(*) INTO v_n FROM public.user_roles;
  IF v_n = 1 THEN r := r || E'TEST 9  a Moderator sees only their own role row .... PASS\n';
  ELSE r := r || format(E'TEST 9  a Moderator sees only their own role row .... *** FAIL — sees %s rows ***\n', v_n); ok := false; END IF;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — no role was created and nobody was made an admin.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
