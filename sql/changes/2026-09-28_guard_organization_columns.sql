-- Organizations: officers edit what the club says, not where it sits
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run. Safe to re-run.
--
-- WHY (first audit, M4)
-- organizations_update lets anyone with can_manage_members on a club update the WHOLE row. The app
-- only ever edits descriptive fields, but the database also accepted, from a club's own officer:
--   - parent_id  (move the club, or make it a root outside Student Life's oversight)
--   - type, school, slug, is_verified, created_by
--   - is_active  (reactivate their own club after the organization above suspended it)
--
-- THE RULE (BEFORE UPDATE, and a small BEFORE INSERT part)
--   free for officers      name, description, logo_url, cover_url, contact_email, office_location,
--                          phone, instagram, website, handshake_url — what the console edits
--   super admin only       id, parent_id, school, type, slug, is_verified, created_by, created_at
--   is_active              needs can_act('manage_members') on the PARENT — authority above the
--                          club, which is who suspends it (orgSetActive). A root: super admin only
--   on INSERT              school is taken from the parent, created_by from the signed-in account
-- Skipped: the super admin, and the SQL editor / server key (no JWT role), like the other guards.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

create or replace function public.guard_organization_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role = '' or v_role = 'service_role' then return new; end if;   -- SQL editor / server
  if public.is_super_admin() then return new; end if;

  if tg_op = 'INSERT' then
    if new.parent_id is not null then
      select o.school into new.school from public.organizations o where o.id = new.parent_id;
    end if;
    new.created_by := auth.uid();
    return new;
  end if;

  if new.id          is distinct from old.id
  or new.parent_id   is distinct from old.parent_id
  or new.school      is distinct from old.school
  or new.type        is distinct from old.type
  or new.slug        is distinct from old.slug
  or new.is_verified is distinct from old.is_verified
  or new.created_by  is distinct from old.created_by
  or new.created_at  is distinct from old.created_at then
    raise exception 'Only a super admin can change where an organization sits, its type, school, address or verification'
      using errcode = 'insufficient_privilege';
  end if;

  if new.is_active is distinct from old.is_active
     and (old.parent_id is null or not public.can_act('manage_members', old.parent_id)) then
    raise exception 'Suspending or reactivating an organization needs authority over the organization above it'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

drop trigger if exists organizations_guard_columns on public.organizations;
create trigger organizations_guard_columns
  before insert or update on public.organizations
  for each row execute function public.guard_organization_columns();

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Builds a throwaway school -> department -> club, speaks as
-- a department officer and a club officer, and rolls everything back by raising its report.
-- Tests the trigger (RLS is bypassed in the SQL editor), the way verify_flag_guard.sql does.
-- ============================================================================

DO $verify$
DECLARE
  v_users  uuid[];
  v_dept_officer uuid;
  v_club_officer uuid;
  v_school text;
  v_real   text;
  v_root   bigint;
  v_dept   bigint;
  v_club   bigint;
  v_new    bigint;
  v_got    text;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  SELECT array_agg(id) INTO v_users FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at LIMIT 2) t;
  IF v_users IS NULL OR array_length(v_users, 1) < 2 THEN
    RAISE EXCEPTION 'Needs two non-admin students to test with.';
  END IF;
  v_dept_officer := v_users[1];
  v_club_officer := v_users[2];
  SELECT slug INTO v_real FROM public.schools WHERE slug <> 'verify-orgguard' ORDER BY slug LIMIT 1;

  -- fixtures, before any JWT (so every guard takes its SQL-editor branch)
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Org Guard', 'verify-orgguard', 'verify-orgguard.invalid') RETURNING slug INTO v_school;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Root', 'vg-root') RETURNING id INTO v_root;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_root, 'department', 'Verify Dept', 'vg-dept') RETURNING id INTO v_dept;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_dept, 'club', 'Verify Club', 'vg-club') RETURNING id INTO v_club;
  INSERT INTO public.org_memberships (org_id, user_id, role, status, can_manage_members, can_create_child_orgs)
  VALUES (v_dept, v_dept_officer, 'officer', 'active', true, true);
  INSERT INTO public.org_memberships (org_id, user_id, role, status, can_manage_members)
  VALUES (v_club, v_club_officer, 'officer', 'active', true);

  -- the club's own officer
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_club_officer), true);

  BEGIN
    UPDATE public.organizations SET name = 'Verify Club Renamed', description = 'x' WHERE id = v_club;
    r := r || E'TEST 1  club officer edits name/description ...... PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 1  club officer edits name/description ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.organizations SET parent_id = NULL WHERE id = v_club;
    r := r || E'TEST 2  club officer moves the club .............. *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 2  club officer moves the club .............. PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 2  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.organizations SET type = 'office', is_verified = NOT is_verified WHERE id = v_club;
    r := r || E'TEST 3  club officer changes type / verified .... *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 3  club officer changes type / verified .... PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 3  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  BEGIN
    UPDATE public.organizations SET is_active = false WHERE id = v_club;
    r := r || E'TEST 4  club officer suspends/reactivates own club *** FAIL — ALLOWED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 4  club officer suspends/reactivates own club PASS (refused)\n';
  WHEN OTHERS THEN r := r || format(E'TEST 4  ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  -- the department's officer: authority over the club
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_dept_officer), true);

  BEGIN
    UPDATE public.organizations SET is_active = false WHERE id = v_club;
    r := r || E'TEST 5  department officer suspends the club ..... PASS (allowed)\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 5  department officer suspends the club ..... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  BEGIN
    INSERT INTO public.organizations (school, parent_id, type, name, slug, created_by)
    VALUES (coalesce(v_real, v_school), v_dept, 'club', 'Verify New Club', 'vg-new', v_club_officer)
    RETURNING id INTO v_new;
    SELECT school || ' / ' || coalesce(created_by::text, 'null') INTO v_got FROM public.organizations WHERE id = v_new;
    IF v_got = v_school || ' / ' || v_dept_officer::text THEN
      r := r || E'TEST 6  new club takes parent''s school and creator  PASS\n';
    ELSE
      r := r || format(E'TEST 6  new club takes parent''s school and creator  *** FAIL — saved %s ***\n', v_got); ok := false;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 6  ?? the insert failed: %s\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL or ??. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
