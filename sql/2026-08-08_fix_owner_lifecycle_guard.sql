-- ============================================================================
-- Fix: owners could not change their own listing's status at all
-- Table: public.listings        Applied: 2026-08-08
-- ============================================================================
--
-- SYMPTOM
--   Every owner action in the "Manage this listing" panel — mark pending sale,
--   mark as sold/claimed, withdraw, set deadline, clear deadline, renew —
--   failed with:
--       400  Owners may only change lifecycle fields
--   The buttons had never worked, from the day they shipped.
--
-- CAUSE
--   Two pieces of the database disagreed about which columns a lifecycle change
--   touches.
--
--   This trigger allowed an owner's UPDATE to change only:
--       lifecycle_status, expires_at
--
--   But change_listing_status() — the ONLY way a student can write these fields,
--   since students hold no direct UPDATE grant on `listings` — also writes:
--       status_changed_at   (always, = now())
--       renew_count         (on a renewal)
--
--   So the guard rejected the very function it existed to permit. The app was
--   never at fault, which is why no amount of JavaScript debugging found it.
--
-- FIX
--   Add those two columns to the allowlist. Everything else stays locked exactly
--   as before: title, price, description, photos, the moderation `status`,
--   poster_id, school — an owner still cannot change any of them through this
--   path, and admins (anyone with a user_roles row) still bypass the check.
--
-- SAFE TO RE-RUN. CREATE OR REPLACE only swaps the function body; the existing
-- trigger keeps pointing at it, so no trigger needs dropping or recreating.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_owner_listing_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Admins (anyone with a user_roles row) can change anything
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Everyone else: the row minus the lifecycle-managed fields must be unchanged.
  --
  -- status_changed_at and renew_count are written by change_listing_status() on
  -- the owner's behalf. Leaving them out of this list is what blocked every
  -- owner action. If you ever add a column that the lifecycle RPC writes, it
  -- must be added here too, or that action starts failing the same silent way.
  IF (to_jsonb(NEW) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'lifecycle_status' - 'expires_at' - 'status_changed_at' - 'renew_count') THEN
    RAISE EXCEPTION 'Owners may only change lifecycle fields';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- NOTE — the trigger itself is NOT recreated here, on purpose.
--
-- Only the function above was ever read out of the live database. The
-- CREATE TRIGGER statement that binds it to `listings` (its timing, its events,
-- any WHEN clause) has never been captured, and writing one from memory could
-- quietly replace a rule nobody has read. The database is ground truth.
--
-- To capture the real one and finish this file, run:
--
--   SELECT pg_get_triggerdef(t.oid)
--   FROM pg_trigger t
--   WHERE t.tgrelid = 'public.listings'::regclass
--     AND NOT t.tgisinternal;
--
-- then paste the output below this comment.
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
