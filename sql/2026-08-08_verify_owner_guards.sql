-- ============================================================================
-- Verify the owner guards on listings + book_listings
-- Self-contained: no ids to fill in, nothing left behind.
-- ============================================================================
--
-- HOW TO RUN
--   Paste this whole file into the Supabase SQL editor and Run. Do not edit it.
--
--   ⚠️ IT ENDS BY REPORTING AN ERROR. That is intentional and is not a failure.
--   Raising an exception is how the results get displayed and how every test
--   write is discarded — the error message IS the report. Read it.
--
-- WHAT IT CHECKS
--   Each test impersonates a different kind of caller by setting the JWT role
--   claim for the transaction, then attempts a write and records what happened.
--
--     TEST 1  SQL editor (no JWT)         edits a title      -> must SUCCEED
--     TEST 2  signed-in non-admin         edits a title      -> must be REFUSED
--     TEST 3  anonymous                   edits a title      -> must be REFUSED
--     TEST 4  anonymous                   edits a book title -> must be REFUSED
--     TEST 5  owner, lifecycle columns    status change      -> must SUCCEED
--
--   Tests 2, 3 and 4 are the ones that matter. They are the only ones that can
--   catch a guard that has been switched off — a disabled guard passes every
--   "must succeed" test cheerfully.
--
--   TEST 5 proves the guard is discriminating rather than simply refusing
--   everything: it writes exactly the columns change_listing_status() writes.
-- ============================================================================

-- Part A — hardening, safe and required before the tests are meaningful.
--
-- The deployed version reads:
--     current_setting('request.jwt.claims', true)::jsonb ->> 'role'
-- which returns NULL when the setting is absent (the SQL editor) — fine. But if
-- anything ever sets it to an EMPTY STRING instead of leaving it unset, ''::jsonb
-- raises "invalid input syntax for type json" and every UPDATE on the table fails.
-- nullif() collapses both cases to the same safe NULL. This cannot weaken the
-- guard: it only changes which of two "no JWT present" spellings is tolerated.

CREATE OR REPLACE FUNCTION public.fn_guard_owner_listing_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_role text;
BEGIN
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  IF v_role = '' OR v_role = 'service_role' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count') THEN
    RAISE EXCEPTION 'Owners may only change lifecycle fields';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_owner_book_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_role text;
  changed_forbidden boolean;
BEGIN
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  IF v_role = '' OR v_role = 'service_role' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RETURN NEW;
  END IF;

  changed_forbidden :=
    (to_jsonb(NEW) - 'lifecycle_status' - 'sold_at' - 'status_changed_at' - 'expires_at')
    IS DISTINCT FROM
    (to_jsonb(OLD) - 'lifecycle_status' - 'sold_at' - 'status_changed_at' - 'expires_at');

  IF changed_forbidden THEN
    RAISE EXCEPTION 'Only lifecycle fields can be changed on your own book listing';
  END IF;
  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';


-- Part B — the tests.
DO $verify$
DECLARE
  v_listing  bigint;
  v_poster   uuid;
  v_book     bigint;
  r          text := '';
  pass_all   boolean := true;
BEGIN
  SELECT id, poster_id INTO v_listing, v_poster
  FROM listings WHERE poster_id IS NOT NULL ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_book FROM book_listings ORDER BY id DESC LIMIT 1;

  IF v_listing IS NULL THEN
    RAISE EXCEPTION 'No listing with a poster_id exists — cannot test. Post one first.';
  END IF;

  r := r || format(E'\nUsing listing id %s (poster %s), book id %s\n', v_listing, v_poster, coalesce(v_book::text,'none'));

  -- TEST 1 — no JWT (the SQL editor). Must SUCCEED.
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE listings SET title = title || '·' WHERE id = v_listing;
    r := r || E'TEST 1  SQL editor edits a listing .............. PASS (allowed)\n';
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 1  SQL editor edits a listing .............. FAIL — refused: %s\n', SQLERRM);
    pass_all := false;
  END;

  -- TEST 2 — signed-in, not the owner, not an admin. Must be REFUSED.
  BEGIN
    PERFORM set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
    UPDATE listings SET title = title || '·' WHERE id = v_listing;
    r := r || E'TEST 2  signed-in user edits a title ............ *** FAIL — ALLOWED, GUARD IS OFF ***\n';
    pass_all := false;
  EXCEPTION WHEN others THEN
    r := r || E'TEST 2  signed-in user edits a title ............ PASS (refused)\n';
  END;

  -- TEST 3 — anonymous. Must be REFUSED.
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    UPDATE listings SET title = title || '·' WHERE id = v_listing;
    r := r || E'TEST 3  anonymous edits a listing title ......... *** FAIL — ALLOWED, GUARD IS OFF ***\n';
    pass_all := false;
  EXCEPTION WHEN others THEN
    r := r || E'TEST 3  anonymous edits a listing title ......... PASS (refused)\n';
  END;

  -- TEST 4 — anonymous, books. Must be REFUSED. (This is the hole that existed
  -- before 2026-08-08: the old books guard waved through every NULL auth.uid().)
  IF v_book IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      UPDATE book_listings SET title = title || '·' WHERE id = v_book;
      r := r || E'TEST 4  anonymous edits a book title ............ *** FAIL — ALLOWED, GUARD IS OFF ***\n';
      pass_all := false;
    EXCEPTION WHEN others THEN
      r := r || E'TEST 4  anonymous edits a book title ............ PASS (refused)\n';
    END;
  ELSE
    r := r || E'TEST 4  anonymous edits a book title ............ SKIPPED (no book listings)\n';
  END IF;

  -- TEST 5 — the owner making a real lifecycle change. Must SUCCEED. These are
  -- exactly the columns change_listing_status() writes.
  BEGIN
    PERFORM set_config('request.jwt.claims',
      format('{"role":"authenticated","sub":"%s"}', v_poster), true);
    UPDATE listings
       SET lifecycle_status = lifecycle_status, status_changed_at = now()
     WHERE id = v_listing;
    r := r || E'TEST 5  owner changes lifecycle columns ......... PASS (allowed)\n';
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 5  owner changes lifecycle columns ......... FAIL — refused: %s\n', SQLERRM);
    pass_all := false;
  END;

  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. Guards are working. Every write above was rolled back.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  -- Raising is how this reports AND how it discards every test write.
  RAISE EXCEPTION E'%\n', r;
END
$verify$;
