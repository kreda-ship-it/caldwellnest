-- First post reviewed: with the approval switch off, a student's FIRST listing or book still waits
-- for review once; after one approved post they post instantly.
-- 2026-10-01
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY (Kal, 2026-10-01, before opening to real students)
-- The "Require listing approval" switch was all or nothing: on, every post waits; off, every post is
-- live at once. Most bad posts come from new or throwaway accounts, so the middle way is the usual
-- one for marketplaces: review a student's first post, then trust them.
--
-- WHAT CHANGES — one line of set_new_listing_fields() (2026-09-28_new_listing_status_from_settings.sql),
-- the trigger that decides a new listing's or book's status. It now says: pending when the switch is
-- on, OR when this poster has no approved listing and no approved book yet; otherwise approved.
--   - Switch ON: unchanged — everything waits.
--   - Switch OFF: first post waits; after that, instant. A student whose only approved post was later
--     removed by a moderator is reviewed again next time — removal is a moderation decision.
--   - Students who already have an approved post (everyone who posted while the switch was off) are
--     trusted already. Admins are unaffected (the super admin's posts skip this trigger entirely).
-- The line is replaced in place from the live function: if it is not there, NOTHING is changed.
--
-- UNDO: run this file's PART 1 with old and new swapped, or ask Claude.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

do $$
declare
  v_oid  oid;
  v_def  text;
  v_old  constant text := ':= case when v_require then ''pending'' else ''approved'' end;';
  v_new  constant text := ':= case when v_require'
    || ' or (not exists (select 1 from public.listings l where l.poster_id = new.poster_id and l.status in (''approved'', ''pinned''))'
    || '     and not exists (select 1 from public.book_listings b where b.poster_id = new.poster_id and b.status = ''approved''))'
    || ' then ''pending'' else ''approved'' end;   -- first post reviewed (2026-10-01_first_post_review.sql)';
begin
  select p.oid into strict v_oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_new_listing_fields';

  v_def := pg_get_functiondef(v_oid);
  if position('first post reviewed' in v_def) > 0 then
    raise notice 'set_new_listing_fields: already updated';
  elsif position(v_old in v_def) = 0 then
    raise exception 'set_new_listing_fields() does not contain the line this file expects, so nothing was changed. Run  select pg_get_functiondef(''public.set_new_listing_fields''::regproc);  and send Claude the result.';
  else
    execute replace(v_def, v_old, v_new);
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as two real students, then as you. THE ERROR MESSAGE
-- IS THE REPORT, and the error discards everything it made, including the switch it flips.
-- ============================================================================

DO $verify$
DECLARE
  v_new_student uuid;   -- has no approved listing or book: their first post must wait
  v_trusted     uuid;   -- given one approved listing below: their next post goes live
  v_super       uuid;
  v_status      text;
  r             text := E'\n';
  ok            boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  SELECT p.id INTO v_new_student FROM public.profiles p
   WHERE p.status = 'active' AND p.school IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.listings l WHERE l.poster_id = p.id AND l.status IN ('approved', 'pinned'))
     AND NOT EXISTS (SELECT 1 FROM public.book_listings b WHERE b.poster_id = p.id AND b.status = 'approved')
   ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_trusted FROM public.profiles p
   WHERE p.status = 'active' AND p.school IS NOT NULL AND p.id <> v_new_student
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
   ORDER BY p.created_at LIMIT 1;
  IF v_super IS NULL OR v_new_student IS NULL OR v_trusted IS NULL THEN
    RAISE EXCEPTION 'Needs the super admin, one active student with no approved post, and one more active student.';
  END IF;

  -- Fixtures, as the editor (no student rules apply here): the switch off, and one approved post for v_trusted.
  INSERT INTO public.platform_settings (key, value) VALUES ('requireApproval', 'false'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb;
  INSERT INTO public.listings (title, category, poster_id, status) VALUES ('verify-approved', 'other', v_trusted, 'approved');

  PERFORM set_config('role', 'authenticated', true);

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_new_student), true);
  INSERT INTO public.listings (title, category, poster_id, status) VALUES ('verify-first', 'other', v_new_student, 'approved')
    RETURNING status INTO v_status;
  IF v_status = 'pending' THEN r := r || E'TEST 1  switch off: a first post waits for review ....... PASS (pending)\n';
  ELSE r := r || format(E'TEST 1  switch off: a first post waits for review ....... *** FAIL — %s ***\n', v_status); ok := false; END IF;

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_trusted), true);
  INSERT INTO public.listings (title, category, poster_id, status) VALUES ('verify-next', 'other', v_trusted, 'pending')
    RETURNING status INTO v_status;
  IF v_status = 'approved' THEN r := r || E'TEST 2  switch off: after one approval, posts go live .. PASS (approved)\n';
  ELSE r := r || format(E'TEST 2  switch off: after one approval, posts go live .. *** FAIL — %s ***\n', v_status); ok := false; END IF;

  -- You turn the switch on (through the normal rule: the edit_site switch).
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'requireApproval';

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_trusted), true);
  INSERT INTO public.listings (title, category, poster_id, status) VALUES ('verify-switch-on', 'other', v_trusted, 'approved')
    RETURNING status INTO v_status;
  IF v_status = 'pending' THEN r := r || E'TEST 3  switch on: even a trusted student waits ........ PASS (pending)\n';
  ELSE r := r || format(E'TEST 3  switch on: even a trusted student waits ........ *** FAIL — %s ***\n', v_status); ok := false; END IF;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — the switch is as it was, and no test listing exists.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
