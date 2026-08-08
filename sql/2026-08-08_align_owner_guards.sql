-- ============================================================================
-- Align the two owner guards: trust the caller's ROLE, not a NULL user id
-- Tables: public.listings, public.book_listings
-- STATUS: PROPOSED — not yet applied. Run it, then run the tests at the bottom.
-- ============================================================================
--
-- THE PROBLEM BEING FIXED
--   Two guards written for the same job disagreed, each wrong in one direction:
--
--   fn_guard_owner_book_update()     — too loose.
--     Opened with `IF auth.uid() IS NULL THEN RETURN NEW`, commented
--     "SQL editor / service role". But auth.uid() is NULL for ANY request
--     without a signed-in user — including anonymous API calls. So the guard
--     was off for anon, leaving RLS and GRANTs as the only protection.
--
--   fn_guard_owner_listing_update()  — too strict.
--     No such line, so editing a `listings` row by hand in the Supabase SQL
--     editor or Table Editor FAILS with "Owners may only change lifecycle
--     fields": auth.uid() is NULL there too, so the function reads the editor
--     as an ordinary non-admin and blocks it.
--
-- ⚠️ WHY NOT `current_user IN ('postgres','service_role')` — THE OBVIOUS FIX,
--    WHICH IS WRONG AND DANGEROUS
--
--   Both functions are SECURITY DEFINER. Inside such a function current_user is
--   the function's OWNER (postgres), never the caller — that is what SECURITY
--   DEFINER means. So that test is TRUE on every call from everyone, and the
--   guard returns NEW immediately. It would not tighten the rule; it would
--   silently delete it, while looking like a security improvement.
--
--   session_user does not work either: PostgREST connects as one role
--   (authenticator) and SET ROLEs to anon/authenticated/service_role. SET ROLE
--   changes current_user, not session_user — so anonymous and signed-in
--   requests are indistinguishable by session_user.
--
-- WHAT ACTUALLY WORKS
--   The JWT role claim, which travels with the request and is unaffected by
--   SECURITY DEFINER:
--
--     SQL editor / Table Editor  -> no claim at all (NULL)
--     anonymous API request      -> 'anon'
--     signed-in student          -> 'authenticated'
--     server-side key            -> 'service_role'
--
--   Read straight from the request setting rather than via auth.role(), which
--   is deprecated in newer Supabase. The `true` argument to current_setting is
--   "missing_ok": return NULL instead of raising when the setting is not set,
--   which is exactly the SQL-editor case.
-- ============================================================================


-- ── listings ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_owner_listing_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_role text;
BEGIN
  -- Trusted callers: the SQL editor (no JWT) and server-side keys.
  -- Note 'anon' deliberately does NOT match, so anonymous requests stay guarded.
  v_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  IF v_role = '' OR v_role = 'service_role' THEN RETURN NEW; END IF;

  -- Admins (anyone with a user_roles row) can change anything
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Everyone else: the row minus the lifecycle-managed fields must be unchanged.
  -- status_changed_at and renew_count are written by change_listing_status() on
  -- the owner's behalf; omitting them is what blocked every owner action until
  -- 2026-08-08. Any new column that RPC writes must be added here too.
  IF (to_jsonb(NEW) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count') THEN
    RAISE EXCEPTION 'Owners may only change lifecycle fields';
  END IF;

  RETURN NEW;
END;
$function$;


-- ── book_listings ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_owner_book_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_role text;
  v_is_admin boolean;
  changed_forbidden boolean;
BEGIN
  -- Replaces `IF auth.uid() IS NULL THEN RETURN NEW`, which also waved through
  -- every anonymous request. This keeps the SQL editor working while closing that.
  v_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  IF v_role = '' OR v_role = 'service_role' THEN RETURN NEW; END IF;

  v_is_admin := EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid());
  IF v_is_admin THEN RETURN NEW; END IF;

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


-- ============================================================================
-- TESTS — run all four. This changes security rules on tables holding student
-- data, so "it didn't error" is not evidence that it works.
--
--   1. In the app, as a student, on your OWN listing:
--      withdraw it, mark it sold, set a deadline. All must still succeed.
--
--   2. In the app, as a student, on a book you posted:
--      mark pending sale, then back to active. Both must still succeed.
--
--   3. In the SQL editor (this is the behavior being ADDED — it fails today):
--        UPDATE listings SET title = title WHERE id = <some id>;
--      Must now succeed instead of raising "Owners may only change lifecycle fields".
--
--   4. The guard must still BITE. Confirm it did not quietly turn itself off —
--      this is the failure mode the current_user version would have caused:
--        SELECT proname, prosrc FROM pg_proc
--        WHERE proname IN ('fn_guard_owner_listing_update','fn_guard_owner_book_update');
--      and read the bodies back. Better still, have a student account attempt a
--      direct title change through the API and confirm it is refused.
--
-- If test 1 or 2 fails, revert by re-running:
--   sql/2026-08-08_fix_owner_lifecycle_guard.sql             (listings)
--   sql/2026-08-08_check_book_listings_guard.sql             (books — its
--     recorded body is the pre-change version; run just the CREATE OR REPLACE)
-- ============================================================================
