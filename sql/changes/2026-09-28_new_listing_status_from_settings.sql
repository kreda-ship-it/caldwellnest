-- New listings and books: the database sets review status from the approval switch
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY (second audit, S5 / first audit H2)
-- The admin "Require approval" switch (platform_settings.requireApproval) is read by the browser,
-- which then sends status 'pending' or 'approved' with the new listing. The database accepted
-- whatever status it was sent. Now it ignores the status a student sends and sets it itself:
--   switch ON  (or missing)  -> 'pending'   — waits for an admin
--   switch OFF               -> 'approved'  — live at once
-- For the same reason it fills in, from the poster's own profile, the fields that describe who
-- posted (name, initials, colour, school), never features a new post (pinned = false), and stores
-- no email (the Official marker is only ever set by an admin).
--
-- WHO IT SKIPS
--   admins (user_is_admin())       — official posts come from an admin in student preview
--   the SQL editor / server key    — no JWT role, like the other guards in this folder
--
-- Nothing in the app changes: it already sends the same status, read from the same switch.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

create or replace function public.set_new_listing_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_require boolean;
  p         public.profiles%rowtype;
begin
  if v_role = '' or v_role = 'service_role' then return new; end if;   -- SQL editor / server
  if public.user_is_admin() then return new; end if;                    -- admins, incl. official posts

  select coalesce((s.value #>> '{}')::boolean, true) into v_require
  from public.platform_settings s where s.key = 'requireApproval';
  v_require := coalesce(v_require, true);                               -- no setting -> require review

  new.status           := case when v_require then 'pending' else 'approved' end;
  new.rejection_reason := null;

  if tg_table_name = 'listings' then
    select * into p from public.profiles where id = new.poster_id;
    new.pinned          := false;
    new.poster_email    := null;
    new.poster_name     := coalesce(nullif(btrim(p.display_name), ''), btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')));
    new.poster_initials := p.initials;
    new.poster_color    := p.color;
    new.school          := p.school;
  elsif tg_table_name = 'book_listings' then
    new.approved := (new.status = 'approved');
  end if;
  return new;
end;
$function$;

drop trigger if exists listings_set_new_fields on public.listings;
create trigger listings_set_new_fields
  before insert on public.listings
  for each row execute function public.set_new_listing_fields();

drop trigger if exists book_listings_set_new_fields on public.book_listings;
create trigger book_listings_set_new_fields
  before insert on public.book_listings
  for each row execute function public.set_new_listing_fields();

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as a real student, rolls everything back.
-- THE ERROR MESSAGE IS THE REPORT, and the error is also what discards the test rows.
-- Each test row is sent with the OPPOSITE status of the one the switch calls for, so a status test
-- can only pass if the database overwrote it. (The first version sent 'approved' whatever the
-- switch said — with the switch OFF it would have passed even with no trigger at all.)
-- ============================================================================

DO $verify$
DECLARE
  v_student uuid;
  v_require boolean;
  v_want    text;
  v_sent    text;   -- the OPPOSITE of v_want, so a status only passes if the database changed it
  v_school  text;
  v_name    text;
  l         public.listings%rowtype;
  b         public.book_listings%rowtype;
  r         text := E'\n';
  ok        boolean := true;
BEGIN
  SELECT p.id, p.school,
         coalesce(nullif(btrim(p.display_name), ''), btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')))
    INTO v_student, v_school, v_name
  FROM public.profiles p
  WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
  ORDER BY p.created_at LIMIT 1;
  IF v_student IS NULL THEN RAISE EXCEPTION 'Needs at least one active non-admin student to test with.'; END IF;

  SELECT coalesce((value #>> '{}')::boolean, true) INTO v_require FROM public.platform_settings WHERE key = 'requireApproval';
  v_require := coalesce(v_require, true);
  v_want := CASE WHEN v_require THEN 'pending' ELSE 'approved' END;
  v_sent := CASE WHEN v_require THEN 'approved' ELSE 'pending' END;
  r := r || format(E'Approval switch is %s, so new posts should be ''%s''. The test sends ''%s'' on purpose.\n\n',
                   CASE WHEN v_require THEN 'ON' ELSE 'OFF' END, v_want, v_sent);

  -- become that student
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_student), true);

  INSERT INTO public.listings (title, category, poster_id, status, pinned, poster_name, poster_email, school)
  VALUES ('verify', 'other', v_student, v_sent, true, 'Nestrel Housing Office', 'official@caldwellnest.com', NULL)
  RETURNING * INTO l;

  IF l.status = v_want THEN r := r || format(E'TEST 1  listing status set by the database ......... PASS (%s)\n', l.status);
  ELSE r := r || format(E'TEST 1  listing status set by the database ......... *** FAIL — saved as %s ***\n', l.status); ok := false; END IF;
  IF l.pinned = false THEN r := r || E'TEST 2  a new listing is never Featured ............ PASS\n';
  ELSE r := r || E'TEST 2  a new listing is never Featured ............ *** FAIL — saved pinned ***\n'; ok := false; END IF;
  IF l.poster_email IS NULL AND l.poster_name = v_name THEN r := r || E'TEST 3  poster name from the profile, no email ...... PASS\n';
  ELSE r := r || format(E'TEST 3  poster name from the profile, no email ...... *** FAIL — %s / %s ***\n', l.poster_name, l.poster_email); ok := false; END IF;
  IF l.school IS NOT DISTINCT FROM v_school THEN r := r || E'TEST 4  school from the profile .................... PASS\n';
  ELSE r := r || format(E'TEST 4  school from the profile .................... *** FAIL — %s ***\n', l.school); ok := false; END IF;

  INSERT INTO public.book_listings (book_type, title, price, condition, poster_id, status)
  VALUES ('other', 'verify', 0, 'Good', v_student, v_sent)
  RETURNING * INTO b;
  IF b.status = v_want THEN r := r || format(E'TEST 5  book status set by the database ............ PASS (%s)\n', b.status);
  ELSE r := r || format(E'TEST 5  book status set by the database ............ *** FAIL — saved as %s ***\n', b.status); ok := false; END IF;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — this message rolled the test rows back.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
