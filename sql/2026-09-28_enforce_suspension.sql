-- Suspension, enforced by the database
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY (first audit, H4)
-- Suspending a student only signed them out in the browser. No database rule read profiles.status,
-- so the account itself could still write — messages, listings, reports, club and event actions.
--
-- WHAT CHANGES
--   1. is_suspended()  — true when the signed-in account's profile is suspended.
--   2. One RESTRICTIVE policy per write (INSERT, UPDATE, DELETE) on every table the app writes,
--      and on storage uploads: "not suspended" must ALSO pass, on top of the existing rules.
--      Reading is untouched — the app reads the student's own profile and suspension history to
--      show the suspension screen and the appeal form.
--   3. can_act() gains "and not suspended", so a suspended club officer loses every officer power
--      at once — including inside the functions that check it (check-in, walk-ins, cancelling
--      events, analytics). Its text is otherwise exactly 2026-09-05_flag_set.sql's.
--
-- NOT AFFECTED
--   - appeals: the appeal form runs after sign-out, as a visitor, through its own policy
--   - admins (never suspended), the SQL editor, and SECURITY DEFINER functions (they run as owner)
--   - admin_activity_log: left out on purpose — its insert rules are a separate, open item
-- Still able to act when suspended (low harm, all their own and hidden): register_for_event,
-- cancel_registration, self_report_arrival, record_event_view, change_listing_status and
-- update_own_poster_name — SECURITY DEFINER functions that do not go through can_act().


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

create or replace function public.is_suspended()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'suspended');
$function$;

revoke all on function public.is_suspended() from public, anon;
grant execute on function public.is_suspended() to authenticated;

do $$
declare
  t text;
  c text;
begin
  foreach t in array array[
    'listings', 'book_listings', 'messages', 'reports', 'profiles', 'favorites', 'notifications',
    'activity_state', 'poll_votes', 'poll_options', 'org_posts', 'org_follows', 'org_memberships',
    'organizations', 'events', 'event_media', 'event_feedback'
  ] loop
    foreach c in array array['insert', 'update', 'delete'] loop
      execute format('drop policy if exists %I on public.%I', 'no_' || c || '_while_suspended', t);
      if c = 'insert' then
        execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (not public.is_suspended())',
                       'no_insert_while_suspended', t);
      else
        execute format('create policy %I on public.%I as restrictive for %s to authenticated using (not public.is_suspended())',
                       'no_' || c || '_while_suspended', t, c);
      end if;
    end loop;
  end loop;
end
$$;

drop policy if exists "No uploads while suspended" on storage.objects;
create policy "No uploads while suspended" on storage.objects
  as restrictive for insert to authenticated with check (not public.is_suspended());
drop policy if exists "No file changes while suspended" on storage.objects;
create policy "No file changes while suspended" on storage.objects
  as restrictive for update to authenticated using (not public.is_suspended());
drop policy if exists "No file removals while suspended" on storage.objects;
create policy "No file removals while suspended" on storage.objects
  as restrictive for delete to authenticated using (not public.is_suspended());

create or replace function public.can_act(p_action text, p_org_id bigint)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_super_admin() or (not public.is_suspended() and exists (
    with recursive chain(id, parent_id, depth) as (
      select o.id, o.parent_id, 0
      from public.organizations o
      where o.id = p_org_id
      union all
      select o.id, o.parent_id, c.depth + 1
      from public.organizations o
      join chain c on o.id = c.parent_id
      where c.depth < 10
    )
    select 1
    from public.org_memberships m
    join chain c on c.id = m.org_id
    where m.user_id = auth.uid()
      and m.status = 'active'
      and case p_action
            when 'post'              then m.can_post
            when 'manage_members'    then m.can_manage_members
            when 'view_analytics'    then m.can_view_analytics
            when 'message'           then m.can_message
            when 'create_child_orgs' then m.can_create_child_orgs
            when 'manage_admins'     then m.can_manage_admins
            when 'manage_events'     then m.can_manage_events
            when 'check_in'          then m.can_check_in
            else false
          end
  ));
$function$;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as real students, rolls everything back.
-- THE ERROR MESSAGE IS THE REPORT, and the error is also what discards everything it made —
-- including the suspension it applies to a test student for the length of the test.
-- ============================================================================

DO $verify$
DECLARE
  v_a      uuid;   -- the student who is suspended during the test
  v_b      uuid;   -- an ordinary student, the control
  v_admin  uuid;
  v_school text;
  v_org    bigint;
  v_n      int;
  v_got    boolean;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  SELECT (array_agg(p.id ORDER BY p.created_at))[1], (array_agg(p.id ORDER BY p.created_at))[2]
    INTO v_a, v_b
  FROM public.profiles p
  WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id);
  SELECT user_id INTO v_admin FROM public.user_roles LIMIT 1;
  IF v_a IS NULL OR v_b IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'Needs two active non-admin students and one admin to test with.';
  END IF;

  -- a throwaway organization with student A as an officer (no JWT yet: fixture set-up)
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Suspension', 'verify-suspend', 'verify-suspend.invalid') RETURNING slug INTO v_school;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Suspension', 'vsuspend') RETURNING id INTO v_org;
  INSERT INTO public.org_memberships (org_id, user_id, role, status, can_post)
  VALUES (v_org, v_a, 'officer', 'active', true);

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_a), true);
  v_got := public.can_act('post', v_org);
  IF v_got THEN r := r || E'TEST 1  active officer can post (control) ........ PASS\n';
  ELSE r := r || E'TEST 1  active officer can post (control) ........ *** FAIL — refused before suspension ***\n'; ok := false; END IF;

  -- suspend A, speaking as the admin (the profile guard only lets an admin change status)
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_admin), true);
  UPDATE public.profiles SET status = 'suspended' WHERE id = v_a;

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_a), true);
  v_got := public.can_act('post', v_org);
  IF NOT v_got THEN r := r || E'TEST 2  suspended officer loses can_act ........ PASS\n';
  ELSE r := r || E'TEST 2  suspended officer loses can_act ........ *** FAIL — still allowed ***\n'; ok := false; END IF;

  -- from here RLS applies: speak as the ordinary signed-in role
  PERFORM set_config('role', 'authenticated', true);

  BEGIN
    INSERT INTO public.messages (sender_id, receiver_id, content) VALUES (v_a, v_b, 'verify');
    r := r || E'TEST 3  suspended student cannot message ......... *** FAIL — MESSAGE SENT ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  suspended student cannot message ......... PASS (refused)\n';
  WHEN OTHERS THEN
    r := r || format(E'TEST 3  suspended student cannot message ......... ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    INSERT INTO public.listings (title, category, poster_id) VALUES ('verify', 'other', v_a);
    r := r || E'TEST 4  suspended student cannot post a listing .. *** FAIL — LISTING SAVED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 4  suspended student cannot post a listing .. PASS (refused)\n';
  WHEN OTHERS THEN
    r := r || format(E'TEST 4  suspended student cannot post a listing .. ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  UPDATE public.profiles SET bio = bio WHERE id = v_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN r := r || E'TEST 5  suspended student cannot edit profile .. PASS (0 rows changed)\n';
  ELSE r := r || E'TEST 5  suspended student cannot edit profile .. *** FAIL — PROFILE CHANGED ***\n'; ok := false; END IF;

  SELECT count(*) INTO v_n FROM public.profiles WHERE id = v_a;
  IF v_n = 1 THEN r := r || E'TEST 6  suspended student can still read own profile  PASS (suspension screen works)\n';
  ELSE r := r || E'TEST 6  suspended student can still read own profile  *** FAIL — CANNOT READ IT ***\n'; ok := false; END IF;

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_b), true);
  BEGIN
    INSERT INTO public.messages (sender_id, receiver_id, content) VALUES (v_b, v_a, 'verify');
    r := r || E'TEST 7  an active student can still message (control)  PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 7  an active student can still message (control)  *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — the test student is not suspended.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL or ??. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
