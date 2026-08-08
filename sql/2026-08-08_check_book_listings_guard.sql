-- ============================================================================
-- DIAGNOSTIC: does book_listings carry the same broken guard as listings?
-- Table: public.book_listings                        Opened: 2026-08-08
-- ============================================================================
--
-- WHY THIS EXISTS
--   Books go through the same change_listing_status() RPC as marketplace
--   listings, with p_table = 'book_listings'. That function writes
--   status_changed_at on book_listings too.
--
--   On `listings`, a BEFORE UPDATE trigger allowed owners to change only
--   lifecycle_status and expires_at — so writing status_changed_at made every
--   owner action fail. That was repaired on 2026-08-08.
--
--   If book_listings carries its own copy of that guard, then "mark pending
--   sale" and "relist" on a book are broken in exactly the same way, and the
--   repair did NOT reach them: it replaced one function, on one table.
--
--   This has not been checked. Do not assume either answer.
--
-- ============================================================================
-- STEP 1 — RUN THIS ALONE. Read the output before going further.
-- ============================================================================

SELECT t.tgname                      AS trigger_name,
       pg_get_triggerdef(t.oid)      AS trigger_definition,
       pg_get_functiondef(t.tgfoid)  AS trigger_function
FROM pg_trigger t
WHERE t.tgrelid = 'public.book_listings'::regclass
  AND NOT t.tgisinternal;


-- ============================================================================
-- HOW TO READ THE RESULT
--
--   NO ROWS
--       There is no guard on this table. Nothing to fix here — but that is
--       worth a second thought rather than a celebration: it means an owner's
--       writes to book_listings are held back by RLS and table grants alone.
--       Confirm that students really have no direct UPDATE grant on it:
--
--         SELECT grantee, privilege_type
--         FROM information_schema.role_table_grants
--         WHERE table_name = 'book_listings';
--
--   A ROW WHOSE FUNCTION SUBTRACTS ONLY SOME COLUMNS
--       e.g.  (to_jsonb(NEW) - 'lifecycle_status' - 'expires_at')
--       Same bug. It needs status_changed_at added to the allowlist, in the
--       same shape as the listings fix. Template below.
--
--   ANYTHING ELSE
--       Some other rule that has never been read. Do not overwrite it. Paste it
--       into the session and have it explained before changing a line — the
--       whole reason this folder exists is that guessing at unread database
--       rules is what caused the original bug.
-- ============================================================================


-- ============================================================================
-- STEP 2 — TEMPLATE ONLY. DO NOT RUN AS-IS.
--
-- Deliberately left as a comment. Filling it in requires the real function name
-- and the real body from STEP 1 — this file must never overwrite a guard nobody
-- has read. Note there is no renew_count in the book branch of the RPC, so it is
-- not in this allowlist.
-- ============================================================================
--
-- CREATE OR REPLACE FUNCTION public.<REAL_FUNCTION_NAME_FROM_STEP_1>()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SECURITY DEFINER
-- AS $function$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
--     RETURN NEW;
--   END IF;
--   IF (to_jsonb(NEW) - 'lifecycle_status' - 'expires_at' - 'status_changed_at')
--      IS DISTINCT FROM
--      (to_jsonb(OLD) - 'lifecycle_status' - 'expires_at' - 'status_changed_at') THEN
--     RAISE EXCEPTION 'Owners may only change lifecycle fields';
--   END IF;
--   RETURN NEW;
-- END;
-- $function$;
--
-- NOTIFY pgrst, 'reload schema';
