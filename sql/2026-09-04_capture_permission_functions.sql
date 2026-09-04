-- Capture the two functions the whole permission system rests on
-- 2026-09-04
--
-- CAPTURE ONLY, NO CHANGE. These are reproduced exactly as the database returned them from
-- pg_get_functiondef() on 2026-09-03. Running this file re-creates them identically, so it
-- is safe to run and safe to re-run — but it is here to be READ and to make sql/ able to
-- rebuild the database, not because anything needs fixing.
--
-- WHY THESE TWO FIRST
-- Every admin permission in the database routes through one of them, and neither had ever
-- been written down. is_super_admin() is also the first branch of can_act() in
-- docs/nestrel-campus-engagement-plan.md §2.6 — the entire campus engagement system is
-- planned on top of a function whose definition existed only inside the hosted database.
--
-- They also settle two corrections the plan audit made from indirect evidence (§12 C1, C2).
-- Both are now confirmed from the source:
--   - super-admin is role_id = 'super_admin' on user_roles. It is NOT a column on profiles,
--     and no such column should ever be added (see §2.9).
--   - get_admin_school() returns TEXT — the school slug, e.g. 'caldwell'. That is why every
--     new table in the engagement plan is scoped by `school text`, not `school_id uuid`.


-- ============================================================================
-- is_super_admin()
-- ============================================================================
-- Used by: RLS policies on listings, profiles, role_permissions and user_roles.
-- Called from the app indirectly through those policies; js/auth.js reads user_roles
-- directly to decide what admin UI to show.

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role_id = 'super_admin'
  );
$function$;


-- ============================================================================
-- get_admin_school()
-- ============================================================================
-- Returns the school slug an admin is scoped to, or NULL. Paired with is_super_admin() in
-- every school-scoped policy: super admins see everything, school admins see their own
-- school. LIMIT 1 means an admin holding two role rows gets an arbitrary one of them —
-- fine today because nobody does, worth knowing before anyone can.

CREATE OR REPLACE FUNCTION public.get_admin_school()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT school FROM public.user_roles
  WHERE user_id = auth.uid()
  LIMIT 1;
$function$;


notify pgrst, 'reload schema';


-- ============================================================================
-- TWO THINGS TO KNOW ABOUT THESE, NEITHER FIXED HERE
-- ============================================================================
--
-- 1. THERE ARE THREE ADMIN CHECKS AND THEY DO NOT AGREE.
--
--      is_super_admin()                              role_id = 'super_admin'  (narrow)
--      user_is_admin()                               ??? — not captured yet   (unknown)
--      exists (select 1 from user_roles
--              where user_id = auth.uid())           ANY role row             (broad)
--
--    The inline form is the one used by most policies, and it treats every role row as
--    equal: a school admin passes a check that reads as "is an admin" in a policy on a
--    table that may not be theirs. is_super_admin() is stricter. user_is_admin() gates
--    SELECT and UPDATE on admin_activity_log and its body is still unknown.
--
--    This is precisely the drift can_act() is meant to end (§2.6). Do not add a fourth.
--    Capturing user_is_admin() and deciding which of the three wins is the next step.
--
-- 2. NEITHER FUNCTION PINS ITS search_path.
--
--    Both are SECURITY DEFINER, meaning they run with their owner's permissions rather
--    than the caller's. A SECURITY DEFINER function that does not `SET search_path` can in
--    principle be pointed at a different table of the same name, if the caller is able to
--    create one somewhere earlier in the search path.
--
--    In this database that is not currently reachable: `authenticated` cannot create
--    schemas or tables. So this is hardening, not an open hole — but it is the item
--    Supabase's own linter flags as "Function Search Path Mutable", and the two functions
--    at the root of the permission system are the wrong ones to leave unpinned.
--
--    The fix is one line added to each, matching what guard_profile_privileged_columns()
--    and enforce_school_email() already do:
--
--      SET search_path TO 'public'
--
--    Not applied here because it changes behaviour on the two most load-bearing functions
--    in the database, and this file is a capture. It belongs in its own change, with the
--    admin login and the listings feed tested after it.
