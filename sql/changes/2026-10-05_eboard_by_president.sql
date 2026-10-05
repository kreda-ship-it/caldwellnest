-- A club's President runs its E-board; only an admin names the President
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- Kal, 2026-10-05: a club's President adds, edits and removes E-board members from the club
-- console; the club and its President are set by a Nestrel admin, and only an admin changes the
-- President. "The President" means whoever holds Manage E-board (can_manage_admins) — in a club only
-- the President starts with it, and an admin can give it to, say, a Vice President. The rule hangs
-- on the power, not on the word, so typing "President" into a title box grants nothing.
--
-- Until now the database only half-said this. guard_org_membership_flags already makes GIVING
-- powers (and making someone an officer) need Manage E-board. But anyone with "Members & club page"
-- (can_manage_members) could still, outside the app:
--   - change any E-board member's title, their own included — even to "President"
--   - take someone off the E-board by setting them 'removed', or delete the row outright
--   - remove the President
-- And anyone with Manage E-board could give a club membership "Add clubs", then create
-- organizations under their own club that wear the "Verified by the university" badge.
--
-- WHAT CHANGES — one new trigger, guard_eboard_changes(), BEFORE INSERT, UPDATE and DELETE:
--   1. A club membership can never be given "Add clubs" (can_create_child_orgs).
--   2. Naming, replacing or removing a President — any change that makes an active E-board row
--      start or stop being "President" — needs Manage E-board on the organization ABOVE (in
--      practice a Nestrel admin). A school-level President: super admin only.
--   3. Any other change to who is on the E-board, or to an E-board member's position, needs
--      Manage E-board on the organization: adding someone, removing them (status, role or delete),
--      and changing a title. Plain members are unaffected — approving and removing them still needs
--      only "Members & club page".
-- Skipped, like the other guards: the super admin, and the SQL editor / server key (no JWT role).
-- Leaving on your own (deleting your own row) is left to guard_org_self_removal, except that a
-- President cannot leave that way — an admin replaces them.
--
-- No new table or view, so no grants to revoke. UNDO: drop trigger org_memberships_guard_eboard
-- on public.org_memberships; drop function public.guard_eboard_changes();


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

create or replace function public.guard_eboard_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_org_id   bigint;
  v_type     text;
  v_parent   bigint;
  v_was_eb   boolean := false;
  v_is_eb    boolean := false;
  v_was_pres boolean := false;
  v_is_pres  boolean := false;
begin
  if v_role = '' or v_role = 'service_role' or public.is_super_admin() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then v_org_id := new.org_id; else v_org_id := old.org_id; end if;
  select o.type, o.parent_id into v_type, v_parent from public.organizations o where o.id = v_org_id;

  if tg_op <> 'INSERT' then
    v_was_eb   := old.role = 'officer' and old.status = 'active';
    v_was_pres := v_was_eb and lower(btrim(coalesce(old.title, ''))) = 'president';
  end if;
  if tg_op <> 'DELETE' then
    v_is_eb   := new.role = 'officer' and new.status = 'active';
    v_is_pres := v_is_eb and lower(btrim(coalesce(new.title, ''))) = 'president';

    -- 1. never "Add clubs" on a club
    if v_type = 'club' and new.can_create_child_orgs
       and (tg_op = 'INSERT' or not coalesce(old.can_create_child_orgs, false)) then
      raise exception 'A club''s E-board cannot be given "Add clubs"'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Leaving on your own is the self-removal guard's business — unless you are the President.
  if tg_op = 'DELETE' and old.user_id = auth.uid() and not v_was_pres then
    return old;
  end if;

  -- 2. the President is set from above
  if v_was_pres is distinct from v_is_pres
     and (v_parent is null or not public.can_act('manage_admins', v_parent)) then
    raise exception 'Only a Nestrel admin can name, replace or remove a President'
      using errcode = 'insufficient_privilege';
  end if;

  -- 3. everything else about the E-board needs Manage E-board here
  if (v_was_eb is distinct from v_is_eb
      or (tg_op = 'UPDATE' and v_is_eb and new.title is distinct from old.title))
     and not public.can_act('manage_admins', v_org_id) then
    raise exception 'Changing the E-board needs the Manage E-board power'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$function$;

drop trigger if exists org_memberships_guard_eboard on public.org_memberships;
create trigger org_memberships_guard_eboard
  before insert or update or delete on public.org_memberships
  for each row execute function public.guard_eboard_changes();

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Builds a throwaway school -> department -> club with a
-- President, a Secretary and a member, acts as each of them, and rolls everything back by raising
-- its report. Tests the triggers (the SQL editor skips row security), like the other guard tests.
-- ============================================================================

DO $verify$
DECLARE
  v_users  uuid[];
  v_pres   uuid;   -- the club's President: holds Manage E-board
  v_sec    uuid;   -- a Secretary: "Members & club page", but not Manage E-board
  v_mem    uuid;   -- a plain member, later also on the department's E-board
  v_school text;
  v_root   bigint;
  v_dept   bigint;
  v_club   bigint;
  v_got    text;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  IF to_regprocedure('public.guard_eboard_changes()') IS NULL THEN
    RAISE EXCEPTION 'The rule is not there yet — run PART 1 first.';
  END IF;

  SELECT array_agg(id) INTO v_users FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
      AND p.status IS DISTINCT FROM 'suspended'
    ORDER BY p.created_at LIMIT 3) t;
  IF v_users IS NULL OR array_length(v_users, 1) < 3 THEN
    RAISE EXCEPTION 'Needs three non-admin students who are not suspended to test with.';
  END IF;
  v_pres := v_users[1]; v_sec := v_users[2]; v_mem := v_users[3];

  -- fixtures, before any JWT (so every guard takes its SQL-editor branch)
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify E-board', 'verify-eboard', 'verify-eboard.invalid') RETURNING slug INTO v_school;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Root', 've-root') RETURNING id INTO v_root;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_root, 'department', 'Verify Dept', 've-dept') RETURNING id INTO v_dept;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_dept, 'club', 'Verify Club', 've-club') RETURNING id INTO v_club;
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_post, can_manage_members, can_view_analytics,
                                      can_message, can_manage_admins, can_manage_events, can_check_in)
  VALUES (v_club, v_pres, 'officer', 'President', 'active', true, true, true, true, true, true, true),
         (v_club, v_sec,  'officer', 'Secretary', 'active', true, true, true, true, false, true, true);
  INSERT INTO public.org_memberships (org_id, user_id, role, status) VALUES (v_club, v_mem, 'member', 'active');

  -- ---------- as the President
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_pres), true);

  BEGIN
    UPDATE public.org_memberships SET role = 'officer', title = 'Treasurer', can_post = true, can_manage_events = true
    WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 1  President adds a member to the E-board ........ PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 1  President adds a member to the E-board ........ *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET title = 'Event Coordinator', can_post = false WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 2  President changes a position and a power ...... PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 2  President changes a position and a power ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET title = 'President' WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 3  President names a second President ............ *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 3  President names a second President ............ PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 3  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET can_create_child_orgs = true WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 4  "Add clubs" given on a club ................... *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 4  "Add clubs" given on a club ................... PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 4  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships
    SET role = 'member', title = NULL, can_post = false, can_manage_members = false, can_view_analytics = false,
        can_message = false, can_manage_admins = false, can_manage_events = false, can_check_in = false
    WHERE org_id = v_club AND user_id = v_mem;
    SELECT role || ' / ' || status INTO v_got FROM public.org_memberships WHERE org_id = v_club AND user_id = v_mem;
    IF v_got = 'member / active' THEN
      r := r || E'TEST 5  President takes someone off the E-board ...... PASS (still a member)\n';
    ELSE
      r := r || format(E'TEST 5  President takes someone off the E-board ...... *** FAIL — now %s ***\n', v_got); ok := false;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 5  President takes someone off the E-board ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET title = 'Former President' WHERE org_id = v_club AND user_id = v_pres;
    r := r || E'TEST 6  President steps down on their own ............. *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 6  President steps down on their own ............. PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 6  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  -- ---------- as the Secretary: runs the member list, not the E-board
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_sec), true);

  BEGIN
    UPDATE public.org_memberships SET role = 'officer', title = 'Treasurer' WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 7  Secretary adds someone to the E-board ......... *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 7  Secretary adds someone to the E-board ......... PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 7  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET title = 'President' WHERE org_id = v_club AND user_id = v_sec;
    r := r || E'TEST 8  Secretary retitles themselves ................. *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 8  Secretary retitles themselves ................. PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 8  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET status = 'removed' WHERE org_id = v_club AND user_id = v_pres;
    r := r || E'TEST 9  Secretary removes the President ............... *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 9  Secretary removes the President ............... PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 9  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    DELETE FROM public.org_memberships WHERE org_id = v_club AND user_id = v_pres;
    r := r || E'TEST 10 Secretary deletes the President''s row ........ *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 10 Secretary deletes the President''s row ........ PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 10 ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.org_memberships SET status = 'removed' WHERE org_id = v_club AND user_id = v_mem;
    r := r || E'TEST 11 Secretary removes a plain member .............. PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 11 Secretary removes a plain member .............. *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  -- ---------- as someone on the department's E-board: authority above the club
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_manage_members, can_manage_admins)
  VALUES (v_dept, v_mem, 'officer', 'Director', 'active', true, true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_mem), true);

  BEGIN
    UPDATE public.org_memberships SET title = 'Vice President' WHERE org_id = v_club AND user_id = v_pres;
    UPDATE public.org_memberships SET title = 'President', can_manage_admins = true WHERE org_id = v_club AND user_id = v_sec;
    r := r || E'TEST 12 the organization above replaces the President  PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 12 the organization above replaces the President  *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — the test school, club and memberships are gone.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL or ??. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
