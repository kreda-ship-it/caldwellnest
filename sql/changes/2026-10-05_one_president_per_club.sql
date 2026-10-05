-- One President and one Vice President per club
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- Officers became "E-board members" with a position (President, Vice President, Secretary,
-- Treasurer, Social Media Manager, Event Coordinator, or a title the admin types). Kal decided a
-- club has ONE President and ONE Vice President; every other position may be held by several
-- people. The admin page checks this before saving, but the page is not the rule — the database is.
--
-- WHAT CHANGES
--   A partial unique index on org_memberships: among a club's ACTIVE E-board rows (role 'officer'),
--   the title 'President' may appear once and 'Vice President' once. Capitals and spaces at the
--   ends do not matter ("president " counts). Removed members don't count, so a past President
--   stays on the record. Nothing else about titles is limited.
--   The database still calls E-board members "officer" (role = 'officer'). Only the words on the
--   screen changed; renaming the stored value would touch about 40 rules for no visible gain.
--
-- If PART 1 stops with "already has two ...", a club already breaks the rule: change one of those
-- titles on the admin Organizations page (E-board -> Edit), then run PART 1 again.
--
-- UNDO: drop index public.org_memberships_one_president_vp;


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

do $$
declare v_dupes text;
begin
  select string_agg(format('organization %s already has two "%s"', org_id, t), '; ') into v_dupes
  from (
    select org_id, lower(btrim(title)) as t
    from public.org_memberships
    where status = 'active' and role = 'officer'
      and lower(btrim(title)) in ('president', 'vice president')
    group by 1, 2
    having count(*) > 1
  ) d;
  if v_dupes is not null then
    raise exception 'Nothing was changed: %. Fix those titles first (see the top of this file).', v_dupes;
  end if;
end
$$;

create unique index if not exists org_memberships_one_president_vp
  on public.org_memberships (org_id, lower(btrim(title)))
  where status = 'active' and role = 'officer'
    and lower(btrim(title)) in ('president', 'vice president');

commit;

-- An index adds no column, so this is habit rather than need (CLAUDE.md: after any schema change).
notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Builds a throwaway school -> club, tries the positions,
-- and throws everything away. THE ERROR MESSAGE IS THE REPORT; nothing is saved.
-- Tests the index itself; the SQL editor skips row security, so who may add people is not tested here.
-- ============================================================================

DO $verify$
DECLARE
  v_users  uuid[];
  v_school bigint;
  v_club   bigint;
  v_tag    text := 'verify-' || substr(md5(random()::text), 1, 8);
  v_pres   bigint;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  IF to_regclass('public.org_memberships_one_president_vp') IS NULL THEN
    RAISE EXCEPTION 'The rule is not there yet — run PART 1 first.';
  END IF;

  SELECT array_agg(id) INTO v_users FROM (SELECT id FROM public.profiles ORDER BY created_at LIMIT 3) p;
  IF coalesce(array_length(v_users, 1), 0) < 3 THEN
    RAISE EXCEPTION 'Needs three accounts to test with.';
  END IF;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('caldwell', null, 'school', 'Self-test school', v_tag) RETURNING id INTO v_school;
  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES ('caldwell', v_school, 'club', 'Self-test club', v_tag || '-club') RETURNING id INTO v_club;

  -- TEST 1: a first President is fine.
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status)
  VALUES (v_club, v_users[1], 'officer', 'President', 'active') RETURNING id INTO v_pres;
  r := r || E'TEST 1  a club can have a President ........................ PASS\n';

  -- TEST 2: a second President is refused, even written differently.
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, title, status)
    VALUES (v_club, v_users[2], 'officer', ' president ', 'active');
    r := r || E'TEST 2  a second President is refused ...................... *** FAIL — it was saved ***\n'; ok := false;
  EXCEPTION WHEN unique_violation THEN
    r := r || E'TEST 2  a second President is refused ...................... PASS\n';
  END;

  -- TEST 3: one Vice President is fine; a second is refused.
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status)
  VALUES (v_club, v_users[2], 'officer', 'Vice President', 'active');
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, title, status)
    VALUES (v_club, v_users[3], 'officer', 'VICE PRESIDENT', 'active');
    r := r || E'TEST 3  one Vice President, and only one ................... *** FAIL — a second was saved ***\n'; ok := false;
  EXCEPTION WHEN unique_violation THEN
    r := r || E'TEST 3  one Vice President, and only one ................... PASS\n';
  END;

  -- TEST 4: other positions have no limit.
  BEGIN
    INSERT INTO public.org_memberships (org_id, user_id, role, title, status)
    VALUES (v_club, v_users[3], 'officer', 'Secretary', 'active');
    UPDATE public.org_memberships SET title = 'Secretary' WHERE org_id = v_club AND user_id = v_users[2];
    r := r || E'TEST 4  two Secretaries are allowed ........................ PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 4  two Secretaries are allowed ........................ *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  -- TEST 5: a removed President stays on the record and does not block the next one.
  BEGIN
    UPDATE public.org_memberships SET status = 'removed' WHERE id = v_pres;
    UPDATE public.org_memberships SET title = 'President' WHERE org_id = v_club AND user_id = v_users[3];
    r := r || E'TEST 5  a removed President makes room for a new one ........ PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 5  a removed President makes room for a new one ........ *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  -- TEST 6: restoring the old President while there is a new one is refused.
  BEGIN
    UPDATE public.org_memberships SET status = 'active' WHERE id = v_pres;
    r := r || E'TEST 6  restoring a second President is refused ............ *** FAIL — it was restored ***\n'; ok := false;
  EXCEPTION WHEN unique_violation THEN
    r := r || E'TEST 6  restoring a second President is refused ............ PASS\n';
  END;

  -- TEST 7: a plain member called "President" is not on the E-board, so it does not count.
  BEGIN
    UPDATE public.org_memberships SET status = 'active', role = 'member' WHERE id = v_pres;
    r := r || E'TEST 7  only E-board rows count ............................ PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 7  only E-board rows count ............................ *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — the test school and club are gone.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
