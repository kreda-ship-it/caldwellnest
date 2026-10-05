-- Sub-admins, step B1: every admin rule asks for a specific permission, not just "is an admin"
-- 2026-10-01
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- On 2026-10-01 the live database had 31 rules deciding "is this person an admin?", and nearly all
-- of them meant ANY admin. So every admin was a full admin whatever their role said: hiding a
-- button in the app changes nothing, because a browser can call the database directly. Before
-- anyone else is given admin access, each rule has to ask for the switch it actually needs.
-- The switches already existed (role_permissions, 10 keys on school_admin) but nothing read them.
--
-- WHAT CHANGES
--   1. has_admin_permission('key'): true for the super admin; for anyone else, true only when one
--      of their roles has that key switched on in role_permissions.
--   2. Roles. school_admin is relabelled "Moderator" (its id stays) and gains view_activity_log (on)
--      and export_data (off). New: content_editor and viewer. A switch that already exists is
--      never overwritten, so re-running this cannot undo a change made on the Team page.
--   3. These rules now require a switch (they all said "any admin" before):
--        approve_listings OR remove_listings  listings + books (change), listing_status_history,
--                                             change_listing_status() for other people's listings
--        remove_listings                      listings (delete) — a NEW rule, see 4
--        remove_listings OR suspend_students  deleting files in listing-photos (listing, book and
--                                             profile photos share that bucket)
--        view_reports / action_reports       reports (read / change)
--        manage_appeals                       appeals, appeal_audit_log
--        suspend_students                     profiles (change), suspension_history (add)
--        view_messages                        reading other people's messages
--        send_broadcasts                      broadcasts
--        edit_site                            platform_settings, courses
--        view_activity_log                    admin_activity_log (read, and Undo)
--      Listings and profiles keep their school scope: a non-super admin acts on their own school.
--   4. Listings get the admin DELETE rule they never had. "Delete forever" deleted 0 rows, every
--      time, and reported success (fixed in the app the same day).
--   5. Activity-log entries: only undone_at may be changed (it was every column — first audit L11),
--      so nobody can quietly rewrite what they did.
--   6. Five functions are edited IN PLACE from their live text: the file replaces one exact line in
--      each and refuses to run (changing nothing at all) if any of those lines is not there.
--        change_listing_status()         "any admin" -> approve_listings OR remove_listings
--        fn_guard_owner_listing_update() "any admin" -> approve_listings OR remove_listings
--        fn_guard_owner_book_update()    "any admin" -> approve_listings OR remove_listings
--        guard_profile_privileged_columns() "any admin" -> suspend_students
--        set_new_listing_fields()        "any admin" -> super admin only
--      The three guards stop a student changing protected fields (status, pinned, email...) on their
--      OWN listing or profile; exempting any admin would let a Viewer approve and pin their own post.
--      set_new_listing_fields' exemption skips every student rule for a new post, including the
--      poster name taken from the profile — so any other admin could post as "Nestrel". Official
--      posts are yours; everyone else posts like a student.
--   7. can_moderate_profile(): a sub-admin can never change another ADMIN's profile. Your profile
--      is a Caldwell profile too, so without this a Moderator could suspend you — and a suspended
--      account can write nothing. Only you change admin accounts.
--
-- WHAT YOU WILL NOTICE: nothing. is_super_admin() passes every check, and you are the only admin.
--
-- LEFT AS "ANY ADMIN OF THAT SCHOOL", on purpose: reading profiles, listings, books and suspension
--   history; sending notifications; reading photo-bucket rows. Every admin page needs these.
-- LEFT SUPER ADMIN ONLY: user_roles, role_permissions (the Team page), organizations, can_act().
-- REVIEWED, LEFT ALONE: enforce_school_email()'s admin exemption. It only lets an admin account keep
--   a non-.edu address on its own profile, and grants nothing over anyone else.
-- APP-ONLY (no database rule can say it): view_analytics and export_data hide pages, and an export
--   can only ever contain what that person could already read. Approve vs remove vs pin is one
--   "may change listings" rule here; the app's buttons split it.
--
-- UNDO: the rules as they were are recorded in sql/snapshots/2026-09-04_capture_rls_policies.sql (unchanged
-- since, confirmed against the live database on 2026-10-01). Ask Claude for an undo file.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- 1. The check ---------------------------------------------------------------------------------
-- EXECUTE stays at the default (everyone). A visitor is simply answered false; taking EXECUTE away
-- would turn "sees nothing" into an error wherever a rule calls it (see 2026-09-28_revoke_anon_checkers.sql).
create or replace function public.has_admin_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_super_admin()
      or exists (
           select 1
           from public.user_roles ur
           join public.role_permissions rp on rp.role_id = ur.role_id
           where ur.user_id = auth.uid()
             and rp.permission_key = p_key
             and rp.enabled
         );
$function$;

-- Whether the signed-in admin may change this profile: you always; a sub-admin only with
-- suspend_students, only in their own school, and NEVER another admin's account. It reads user_roles
-- as its owner, so it sees every admin; anyone without suspend_students is always answered false,
-- so it tells an ordinary student nothing about who the admins are.
create or replace function public.can_moderate_profile(p_id uuid, p_school text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_super_admin()
      or (public.has_admin_permission('suspend_students')
          and p_school = public.get_admin_school()
          and not exists (select 1 from public.user_roles where user_id = p_id));
$function$;


-- 2. Roles and switches --------------------------------------------------------------------------
insert into public.admin_roles (id, label, description) values
  ('content_editor', 'Content Editor', 'Home & announcements and the site editor. No moderation, no student records.'),
  ('viewer',         'Viewer',         'Analytics only. Can look; cannot change anything.')
on conflict (id) do nothing;

update public.admin_roles
set label = 'Moderator',
    description = 'Listings, books, reports, appeals and suspensions, for one school.'
where id = 'school_admin';

-- Every role gets a row for every switch, so the Team page can show the full grid. ON CONFLICT DO
-- NOTHING keeps any switch that already exists exactly as it is.
insert into public.role_permissions (role_id, permission_key, enabled)
select r.role_id, k.permission_key,
       (r.role_id, k.permission_key) in (
         ('school_admin',   'view_activity_log'),
         ('content_editor', 'send_broadcasts'),
         ('content_editor', 'edit_site'),
         ('viewer',         'view_analytics'))
from unnest(array['school_admin', 'content_editor', 'viewer']) as r(role_id)
cross join unnest(array[
  'approve_listings', 'remove_listings', 'view_reports', 'action_reports', 'manage_appeals',
  'suspend_students', 'view_messages', 'send_broadcasts', 'edit_site', 'view_analytics',
  'view_activity_log', 'export_data']) as k(permission_key)
on conflict (role_id, permission_key) do nothing;


-- 3. The rules ----------------------------------------------------------------------------------
-- Same names as before, so this file reads as a diff of each one. All are now `to authenticated`:
-- two were `to public`, which only meant a visitor was asked too, and always answered no.

-- admin_activity_log
drop policy if exists "Admins can read activity log" on public.admin_activity_log;
create policy "Admins can read activity log" on public.admin_activity_log
  as permissive for select to authenticated
  using (public.has_admin_permission('view_activity_log'));

drop policy if exists "Admins can mark entries as undone" on public.admin_activity_log;
create policy "Admins can mark entries as undone" on public.admin_activity_log
  as permissive for update to authenticated
  using (public.has_admin_permission('view_activity_log'))
  with check (public.has_admin_permission('view_activity_log'));

-- appeal_audit_log, appeals
drop policy if exists "Admins insert appeal log" on public.appeal_audit_log;
create policy "Admins insert appeal log" on public.appeal_audit_log
  as permissive for insert to authenticated
  with check (public.has_admin_permission('manage_appeals'));

drop policy if exists "Admins view appeal log" on public.appeal_audit_log;
create policy "Admins view appeal log" on public.appeal_audit_log
  as permissive for select to authenticated
  using (public.has_admin_permission('manage_appeals'));

drop policy if exists "Admins update appeals" on public.appeals;
create policy "Admins update appeals" on public.appeals
  as permissive for update to authenticated
  using (public.has_admin_permission('manage_appeals'));

drop policy if exists "Admins view all appeals" on public.appeals;
create policy "Admins view all appeals" on public.appeals
  as permissive for select to authenticated
  using (public.has_admin_permission('manage_appeals'));

-- book_listings (reading stays as it was: approved, your own, or any admin)
drop policy if exists book_listings_admin_update on public.book_listings;
create policy book_listings_admin_update on public.book_listings
  as permissive for update to authenticated
  using (public.has_admin_permission('approve_listings') or public.has_admin_permission('remove_listings'));

-- broadcasts (students read through their own "sent, or due" rule — untouched)
drop policy if exists "Admins can manage broadcasts" on public.broadcasts;
create policy "Admins can manage broadcasts" on public.broadcasts
  as permissive for all to authenticated
  using (public.has_admin_permission('send_broadcasts'))
  with check (public.has_admin_permission('send_broadcasts'));

-- courses
drop policy if exists courses_admin_write on public.courses;
create policy courses_admin_write on public.courses
  as permissive for all to authenticated
  using (public.has_admin_permission('edit_site'))
  with check (public.has_admin_permission('edit_site'));

-- listing_status_history
drop policy if exists "Admins can insert status history" on public.listing_status_history;
create policy "Admins can insert status history" on public.listing_status_history
  as permissive for insert to authenticated
  with check (public.has_admin_permission('approve_listings') or public.has_admin_permission('remove_listings'));

drop policy if exists "Admins can view status history" on public.listing_status_history;
create policy "Admins can view status history" on public.listing_status_history
  as permissive for select to authenticated
  using (public.has_admin_permission('approve_listings') or public.has_admin_permission('remove_listings'));

-- listings: change (school-scoped as before), and the delete rule that never existed
drop policy if exists listings_update on public.listings;
create policy listings_update on public.listings
  as permissive for update to authenticated
  using (public.is_super_admin()
         or ((public.has_admin_permission('approve_listings') or public.has_admin_permission('remove_listings'))
             and school = public.get_admin_school()))
  with check (public.is_super_admin()
         or ((public.has_admin_permission('approve_listings') or public.has_admin_permission('remove_listings'))
             and school = public.get_admin_school()));

drop policy if exists listings_admin_delete on public.listings;
create policy listings_admin_delete on public.listings
  as permissive for delete to authenticated
  using (public.is_super_admin()
         or (public.has_admin_permission('remove_listings') and school = public.get_admin_school()));

-- Normally already granted by Supabase's defaults; stated so the rule above can never be silently
-- useless. Only the rule above lets anyone delete: there is no other DELETE rule on listings.
grant delete on public.listings to authenticated;

-- messages (each student's own-conversation rules are untouched)
drop policy if exists admins_read_all_messages on public.messages;
create policy admins_read_all_messages on public.messages
  as permissive for select to authenticated
  using (public.has_admin_permission('view_messages'));

-- platform_settings
drop policy if exists "Admins insert settings" on public.platform_settings;
create policy "Admins insert settings" on public.platform_settings
  as permissive for insert to authenticated
  with check (public.has_admin_permission('edit_site'));

drop policy if exists "Admins update settings" on public.platform_settings;
create policy "Admins update settings" on public.platform_settings
  as permissive for update to authenticated
  using (public.has_admin_permission('edit_site'))
  with check (public.has_admin_permission('edit_site'));

-- profiles: change — school-scoped as before, and never another admin's profile (see 7 above).
-- Everyone's own-profile rule is separate and untouched. Reading stays any admin of that school.
drop policy if exists admin_school_scoped_profiles on public.profiles;
create policy admin_school_scoped_profiles on public.profiles
  as permissive for update to authenticated
  using (public.can_moderate_profile(id, school))
  with check (public.can_moderate_profile(id, school));

-- reports
drop policy if exists "Admins update reports" on public.reports;
create policy "Admins update reports" on public.reports
  as permissive for update to authenticated
  using (public.has_admin_permission('action_reports'));

drop policy if exists "Admins view all reports" on public.reports;
create policy "Admins view all reports" on public.reports
  as permissive for select to authenticated
  using (public.has_admin_permission('view_reports'));

-- suspension_history (reading stays any admin: the student record shows it)
drop policy if exists "Admins insert suspension history" on public.suspension_history;
create policy "Admins insert suspension history" on public.suspension_history
  as permissive for insert to authenticated
  with check (public.has_admin_permission('suspend_students'));

-- storage: deleting photo files (from 2026-09-30_admin_photo_delete.sql, which said "any admin for now")
drop policy if exists "Admins delete listing photos" on storage.objects;
create policy "Admins delete listing photos" on storage.objects
  as permissive for delete to authenticated
  using (bucket_id = 'listing-photos'
         and (public.has_admin_permission('remove_listings') or public.has_admin_permission('suspend_students')));


-- 5. Activity log: only undone_at can change (the one column Undo writes, js/admin.js) ------------
revoke update on public.admin_activity_log from anon, authenticated;
grant update (undone_at) on public.admin_activity_log to authenticated;


-- 6. The five functions, edited in place --------------------------------------------------------
-- A line that is not found raises an error, and an error inside begin...commit undoes ALL of PART 1 —
-- the rules above included. So it is all of this file or none of it, never half.
do $$
declare
  f      record;
  v_oid  oid;
  v_def  text;
begin
  for f in
    select * from (values
      ('change_listing_status',
       'v_is_admin := EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid());',
       'v_is_admin := public.has_admin_permission(''approve_listings'') OR public.has_admin_permission(''remove_listings'');'),
      ('fn_guard_owner_listing_update',
       'IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN',
       'IF public.has_admin_permission(''approve_listings'') OR public.has_admin_permission(''remove_listings'') THEN'),
      ('fn_guard_owner_book_update',
       'v_is_admin := EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid());',
       'v_is_admin := public.has_admin_permission(''approve_listings'') OR public.has_admin_permission(''remove_listings'');'),
      ('guard_profile_privileged_columns',
       'if exists (select 1 from public.user_roles where user_id = auth.uid()) then',
       'if public.has_admin_permission(''suspend_students'') then'),
      ('set_new_listing_fields',
       'if public.user_is_admin() then return new; end if;',
       'if public.is_super_admin() then return new; end if;')
    ) as t(fname, old_line, new_line)
  loop
    -- STRICT: exactly one function of that name, or stop (two would mean an overload nobody expected)
    select p.oid into strict v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.fname;

    v_def := pg_get_functiondef(v_oid);
    if position(f.new_line in v_def) > 0 then
      raise notice '%: already updated', f.fname;
    elsif position(f.old_line in v_def) = 0 then
      raise exception '%() does not contain the line this file expects, so NOTHING in PART 1 was applied. Run  select pg_get_functiondef(''public.%''::regproc);  and send Claude the result.', f.fname, f.fname;
    else
      execute replace(v_def, f.old_line, f.new_line);
    end if;
  end loop;
end
$$;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as two real students made admins for the length of
-- the test — a Moderator and a Viewer — then as you. THE ERROR MESSAGE IS THE REPORT, and the
-- error is also what discards everything: the two roles, the test post and the listing it deletes.
-- ============================================================================

DO $verify$
DECLARE
  v_mod     uuid;    -- a real student, made a Moderator (school_admin) during the test
  v_view    uuid;    -- a real student, made a Viewer during the test
  v_super   uuid;
  v_school  text;
  v_stu     uuid;    -- an ordinary student in the Moderator's school, the control for profile changes
  v_listing bigint;  -- someone else's listing in the Moderator's school, with no chats about it
  v_chatted bigint;  -- a listing people have messaged about (for the INFO line)
  v_new     bigint;  -- the Viewer's own test post
  v_log     bigint;
  v_msgs    int;
  v_logs    int;
  v_sets    int;
  v_n       int;
  v_b       boolean;
  r         text := E'\n';
  ok        boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  SELECT (array_agg(p.id ORDER BY p.created_at))[1], (array_agg(p.id ORDER BY p.created_at))[2]
    INTO v_mod, v_view
  FROM public.profiles p
  WHERE p.status = 'active' AND p.school IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id);
  IF v_mod IS NULL OR v_view IS NULL OR v_super IS NULL THEN
    RAISE EXCEPTION 'Needs two active non-admin students and the super admin to test with.';
  END IF;
  SELECT school INTO v_school FROM public.profiles WHERE id = v_mod;

  -- What there is to test against, counted before any rule applies.
  SELECT p.id INTO v_stu FROM public.profiles p
   WHERE p.status = 'active' AND p.school = v_school AND p.id NOT IN (v_mod, v_view)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
   ORDER BY p.created_at LIMIT 1;
  SELECT l.id INTO v_listing FROM public.listings l
   WHERE l.school = v_school AND l.poster_id <> v_mod AND l.poster_id <> v_view
     AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.listing_id = l.id)
   ORDER BY l.id LIMIT 1;
  SELECT l.id INTO v_chatted FROM public.listings l
   WHERE EXISTS (SELECT 1 FROM public.messages m WHERE m.listing_id = l.id) ORDER BY l.id LIMIT 1;
  SELECT id INTO v_log FROM public.admin_activity_log ORDER BY id LIMIT 1;
  SELECT count(*) INTO v_msgs FROM public.messages WHERE sender_id <> v_mod AND receiver_id <> v_mod;
  SELECT count(*) INTO v_logs FROM public.admin_activity_log WHERE actor_id <> v_view;
  SELECT count(*) INTO v_sets FROM public.platform_settings;

  INSERT INTO public.user_roles (user_id, role_id, school)
  VALUES (v_mod, 'school_admin', v_school), (v_view, 'viewer', v_school);

  -- From here every rule applies. First, the Moderator.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_mod), true);

  IF public.has_admin_permission('approve_listings') AND public.has_admin_permission('view_activity_log')
     AND NOT public.has_admin_permission('view_messages') AND NOT public.has_admin_permission('edit_site')
     AND NOT public.has_admin_permission('export_data') THEN
    r := r || E'TEST 1  Moderator has the Moderator switches, no others ..... PASS\n';
  ELSE r := r || E'TEST 1  Moderator has the Moderator switches, no others ..... *** FAIL ***\n'; ok := false; END IF;

  IF v_msgs = 0 THEN r := r || E'TEST 2  Moderator cannot read others'' messages ......... SKIPPED (no messages to test with)\n';
  ELSE
    SELECT count(*) INTO v_n FROM public.messages WHERE sender_id <> v_mod AND receiver_id <> v_mod;
    IF v_n = 0 THEN r := r || format(E'TEST 2  Moderator cannot read others'' messages ......... PASS (0 of %s)\n', v_msgs);
    ELSE r := r || format(E'TEST 2  Moderator cannot read others'' messages ......... *** FAIL — READ %s ***\n', v_n); ok := false; END IF;
  END IF;

  IF v_sets = 0 THEN r := r || E'TEST 3  Moderator cannot change settings ............... SKIPPED (no settings rows)\n';
  ELSE
    UPDATE public.platform_settings SET value = value;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN r := r || E'TEST 3  Moderator cannot change settings ............... PASS (0 rows changed)\n';
    ELSE r := r || E'TEST 3  Moderator cannot change settings ............... *** FAIL — SETTINGS CHANGED ***\n'; ok := false; END IF;
  END IF;

  IF v_log IS NULL THEN r := r || E'TEST 4  activity log: read yes, rewrite no ............. SKIPPED (empty log)\n';
  ELSE
    SELECT count(*) INTO v_n FROM public.admin_activity_log;
    IF v_n > 0 THEN r := r || E'TEST 4a Moderator can read the activity log .............. PASS\n';
    ELSE r := r || E'TEST 4a Moderator can read the activity log .............. *** FAIL — sees nothing ***\n'; ok := false; END IF;
    BEGIN
      UPDATE public.admin_activity_log SET reason = reason WHERE id = v_log;
      r := r || E'TEST 4b nobody can rewrite a log entry .................... *** FAIL — REWRITTEN ***\n'; ok := false;
    EXCEPTION WHEN insufficient_privilege THEN
      r := r || E'TEST 4b nobody can rewrite a log entry .................... PASS (refused)\n';
    END;
    UPDATE public.admin_activity_log SET undone_at = undone_at WHERE id = v_log;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN r := r || E'TEST 4c Undo can still mark an entry ...................... PASS\n';
    ELSE r := r || E'TEST 4c Undo can still mark an entry ...................... *** FAIL — Undo would break ***\n'; ok := false; END IF;
  END IF;

  IF v_listing IS NULL THEN r := r || E'TEST 5  Moderator can change a listing ................. SKIPPED (no listing to test with)\n';
  ELSE
    UPDATE public.listings SET title = title WHERE id = v_listing;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN r := r || E'TEST 5  Moderator can change a listing in their school .. PASS\n';
    ELSE r := r || E'TEST 5  Moderator can change a listing in their school .. *** FAIL — refused ***\n'; ok := false; END IF;
  END IF;

  UPDATE public.profiles SET status = 'suspended' WHERE id = v_super;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 5b Moderator cannot suspend YOU ................... PASS (0 rows)\n';
  ELSE r := r || E'TEST 5b Moderator cannot suspend YOU ................... *** FAIL — SUSPENDED THE SUPER ADMIN ***\n'; ok := false; END IF;

  UPDATE public.profiles SET status = status WHERE id = v_view;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 5c Moderator cannot change another admin''s profile  PASS (0 rows)\n';
  ELSE r := r || E'TEST 5c Moderator cannot change another admin''s profile  *** FAIL — CHANGED ***\n'; ok := false; END IF;

  IF v_stu IS NULL THEN r := r || E'TEST 5d Moderator can moderate a student .............. SKIPPED (no third student in that school)\n';
  ELSE
    UPDATE public.profiles SET status = status WHERE id = v_stu;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN r := r || E'TEST 5d Moderator can moderate a student in their school  PASS\n';
    ELSE r := r || E'TEST 5d Moderator can moderate a student in their school  *** FAIL — refused ***\n'; ok := false; END IF;
  END IF;

  -- Now the Viewer.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_view), true);

  IF public.has_admin_permission('view_analytics') AND NOT public.has_admin_permission('approve_listings')
     AND NOT public.has_admin_permission('view_activity_log') THEN
    r := r || E'TEST 6  Viewer has analytics only ....................... PASS\n';
  ELSE r := r || E'TEST 6  Viewer has analytics only ....................... *** FAIL ***\n'; ok := false; END IF;

  IF v_listing IS NOT NULL THEN
    UPDATE public.listings SET title = title WHERE id = v_listing;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN r := r || E'TEST 7  Viewer cannot change a listing ................... PASS (0 rows)\n';
    ELSE r := r || E'TEST 7  Viewer cannot change a listing ................... *** FAIL — CHANGED ***\n'; ok := false; END IF;

    DELETE FROM public.listings WHERE id = v_listing;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN r := r || E'TEST 8  Viewer cannot delete a listing ................... PASS (0 rows)\n';
    ELSE r := r || E'TEST 8  Viewer cannot delete a listing ................... *** FAIL — DELETED ***\n'; ok := false; END IF;

    BEGIN
      PERFORM public.change_listing_status(v_listing, 'withdrawn');
      r := r || E'TEST 9  Viewer cannot use the sold/withdrawn function ..... *** FAIL — STATUS CHANGED ***\n'; ok := false;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%Not authorized%' THEN r := r || E'TEST 9  Viewer cannot use the sold/withdrawn function ..... PASS (refused)\n';
      ELSE r := r || format(E'TEST 9  Viewer cannot use the sold/withdrawn function ..... ?? refused for another reason: %s\n', SQLERRM); ok := false; END IF;
    END;
  END IF;

  IF v_logs > 0 THEN
    SELECT count(*) INTO v_n FROM public.admin_activity_log WHERE actor_id <> v_view;
    IF v_n = 0 THEN r := r || E'TEST 10 Viewer cannot read the activity log ............ PASS\n';
    ELSE r := r || format(E'TEST 10 Viewer cannot read the activity log ............ *** FAIL — READ %s ***\n', v_n); ok := false; END IF;
  END IF;

  BEGIN
    INSERT INTO public.listings (title, category, poster_id, pinned, poster_name)
    VALUES ('verify', 'other', v_view, true, 'Nestrel') RETURNING id, pinned INTO v_new, v_b;
    IF NOT v_b THEN r := r || E'TEST 11 Viewer''s own post follows the student rules .... PASS (not pinned)\n';
    ELSE r := r || E'TEST 11 Viewer''s own post follows the student rules .... *** FAIL — POSTED PINNED ***\n'; ok := false; END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 11 Viewer''s own post follows the student rules .... ?? could not post: %s\n', SQLERRM); ok := false;
  END;

  IF v_new IS NOT NULL THEN
    BEGIN
      UPDATE public.listings SET pinned = true WHERE id = v_new;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN r := r || E'TEST 11b Viewer cannot pin their own post afterwards ... PASS (0 rows)\n';
      ELSE r := r || E'TEST 11b Viewer cannot pin their own post afterwards ... *** FAIL — PINNED ***\n'; ok := false; END IF;
    EXCEPTION WHEN OTHERS THEN
      r := r || E'TEST 11b Viewer cannot pin their own post afterwards ... PASS (refused)\n';
    END;
  END IF;

  -- The Moderator again: the delete rule that never existed.
  IF v_listing IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_mod), true);
    BEGIN
      DELETE FROM public.listings WHERE id = v_listing;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN r := r || E'TEST 12 Moderator can delete a listing ("Delete forever")  PASS\n';
      ELSE r := r || E'TEST 12 Moderator can delete a listing ("Delete forever")  *** FAIL — refused ***\n'; ok := false; END IF;
    EXCEPTION WHEN OTHERS THEN
      r := r || format(E'TEST 12 Moderator can delete a listing ("Delete forever")  ?? %s\n', SQLERRM); ok := false;
    END;
  END IF;

  -- And you.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  IF public.has_admin_permission('view_messages') AND public.has_admin_permission('export_data')
     AND public.has_admin_permission('edit_site') THEN
    r := r || E'TEST 13 super admin still has every switch ............... PASS\n';
  ELSE r := r || E'TEST 13 super admin still has every switch ............... *** FAIL ***\n'; ok := false; END IF;

  -- INFO, not a test: can a listing people have messaged about be deleted? Deleting clears
  -- messages.listing_id, and messages have their own guard trigger. Answered with real data.
  IF v_chatted IS NOT NULL THEN
    BEGIN
      DELETE FROM public.listings WHERE id = v_chatted;
      r := r || E'INFO    a listing with chats about it can be deleted ...... yes\n';
    EXCEPTION WHEN OTHERS THEN
      r := r || format(E'INFO    a listing with chats about it can be deleted ...... NO: %s\n', SQLERRM);
    END;
  END IF;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — no roles were given, nothing was posted or deleted.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL or ??. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
