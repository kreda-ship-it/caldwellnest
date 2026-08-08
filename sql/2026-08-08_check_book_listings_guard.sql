-- ============================================================================
-- book_listings owner guard — CHECKED 2026-08-08. NOT AFFECTED. No fix needed.
-- Table: public.book_listings
-- ============================================================================
--
-- THE QUESTION
--   Books go through the same change_listing_status() RPC as marketplace
--   listings, and that function writes status_changed_at on book_listings too.
--   On `listings`, a guard trigger that omitted status_changed_at from its
--   allowlist blocked every owner action (see fix_owner_lifecycle_guard.sql).
--   Did book_listings carry the same bug?
--
-- THE ANSWER
--   No. Its guard already allows status_changed_at — and sold_at, which the
--   books flow uses. Book status changes were never broken by this. The repair
--   on 2026-08-08 was correctly scoped to one table.
--
-- Below is the live definition as read out of the database on 2026-08-08,
-- recorded verbatim so this folder holds the real current rule. Nothing here
-- needs to be run — it is already what the database contains.
-- ============================================================================

CREATE TRIGGER trg_guard_owner_book_update
  BEFORE UPDATE ON public.book_listings
  FOR EACH ROW
  EXECUTE FUNCTION fn_guard_owner_book_update();

CREATE OR REPLACE FUNCTION public.fn_guard_owner_book_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_is_admin boolean;
  changed_forbidden boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;  -- SQL editor / service role
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

-- ============================================================================
-- ⚠️ THE TWO GUARDS DISAGREE — decision still open, see ROADMAP 2026-08-08
--
-- This one and fn_guard_owner_listing_update() were written to do the same job
-- and differ in a way that matters, in BOTH directions:
--
--   1. This one starts with `IF auth.uid() IS NULL THEN RETURN NEW`.
--      auth.uid() is NULL in the Supabase SQL editor — but it is ALSO NULL for
--      any unauthenticated API request. So this line does not only wave through
--      the SQL editor; it disables the guard for anonymous callers, leaving RLS
--      and table GRANTs as the only thing standing there. That is probably fine
--      (anon should hold no UPDATE grant on book_listings — worth confirming),
--      but it is one lock instead of two.
--
--   2. fn_guard_owner_listing_update() has no such line, so it is stricter —
--      and as a consequence, editing a row of `listings` by hand in the Supabase
--      SQL editor or Table Editor FAILS with "Owners may only change lifecycle
--      fields". auth.uid() is NULL there, so the function reads the editor as
--      "not an admin" and blocks it.
--
-- ⚠️ A first attempt at fixing this suggested:
--
--       IF current_user IN ('postgres', 'service_role') THEN RETURN NEW; END IF;
--
--    DO NOT USE IT. Both functions are SECURITY DEFINER, so current_user is the
--    function's OWNER (postgres), never the caller — the test is true for
--    everyone and disables the guard completely while looking like it tightens
--    it. session_user fails too: PostgREST SET ROLEs from one connection role,
--    so anon and authenticated requests share a session_user.
--
--    The working version tests the JWT role claim instead. See
--    sql/2026-08-08_align_owner_guards.sql.
-- ============================================================================
