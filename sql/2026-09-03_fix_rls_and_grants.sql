-- Close the real holes found by the 2026-09-03 permission audit
-- 2026-09-03
--
-- Produced by running sql/2026-09-03_capture_rls_and_grants.sql against the live database.
-- That audit found nine things. This file fixes the three that matter (fix 3 was added after
-- running fixes 1 and 2 revealed it) and deliberately leaves the rest alone — they are listed at the bottom as follow-ups,
-- because changing nine things at once to a live database is how you lose the ability to
-- tell which change broke something.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run (every statement is idempotent).
--
-- TEST AFTER RUNNING — see the checklist at the bottom. Do not skip it: fix 1 turns on
-- enforcement that has never been on, so it is the first time these policies have ever
-- actually run.


-- ============================================================================
-- FIX 1 (CRITICAL) — admin_activity_log has RLS switched OFF
-- ============================================================================
-- The audit found rls_enabled = false on admin_activity_log, with 3 policies defined.
-- Policies are only consulted when RLS is ENABLED, so all three have been decoration.
-- Meanwhile `authenticated` holds SELECT, INSERT, UPDATE, DELETE and TRUNCATE on it.
--
-- What that means in practice: any signed-in student, using the public anon key that ships
-- in the browser, can read the entire admin audit log — including the before_state and
-- after_state blobs, which carry other students' data — and can edit or delete any row in
-- it. The table that exists to record what admins did is the least protected table in the
-- database.
--
-- It is also the table docs/nestrel-campus-engagement-plan.md A18 builds org, membership
-- and event logging on top of. Fixing it now is a prerequisite for that work.
--
-- Turning RLS on activates the three policies that already exist:
--   INSERT  {public}         with check (auth.uid() is not null and auth.uid() = actor_id)
--   SELECT  {public}         using user_is_admin()
--   UPDATE  {public}         using user_is_admin()
-- which is exactly what the app already does: logEvent() inserts with actor_id = the caller,
-- fetchActivityLog() reads as an admin, and the undo path updates as an admin.
--
-- There is deliberately NO delete policy. The log is append-only by design, and the app has
-- no delete path (checked: nothing in js/ deletes from this table).

alter table public.admin_activity_log enable row level security;

-- RLS filters rows; it does not apply to TRUNCATE, and it cannot un-grant DELETE. Both are
-- revoked outright. Neither is used by any code path in the app.
revoke delete, truncate on public.admin_activity_log from authenticated;
revoke truncate          on public.admin_activity_log from anon;


-- ============================================================================
-- FIX 2 (HIGH) — anon holds write grants on listings
-- ============================================================================
-- The audit found `anon` granted DELETE, INSERT, SELECT and UPDATE on public.listings.
-- `anon` is the unauthenticated public: anyone holding the anon key, which is published in
-- the browser bundle.
--
-- This is NOT currently exploitable. listings has RLS enabled, and all four of its policies
-- name the `authenticated` role, so an anonymous caller matches no policy and is refused.
-- The grant is a second lock left unlocked behind a locked one.
--
-- It is worth closing anyway, for two reasons. First, every other table in the database has
-- already had these revoked — listings is the one that was missed, so this is finishing an
-- earlier cleanup rather than starting a new policy. Second, several policies in this
-- database are written for the `{public}` role, and `{public}` in Postgres includes anon.
-- The day someone adds a permissive {public} policy to listings, this grant goes live with
-- no further mistake required.
--
-- NOTE ON WHAT IS *NOT* REVOKED HERE: anon keeps SELECT.
-- RLS already returns zero rows to an anonymous reader, so a logged-out visitor currently
-- sees an empty feed. Revoking the grant would turn that empty result into a permission
-- ERROR, and js/data.js:101 deliberately treats "query failed" differently from "no rows".
-- Removing the grant would change logged-out behaviour from an empty grid to an error path.
-- That is a UI decision, not a security one, so it is left alone.

revoke insert, update, delete on public.listings from anon;


-- ============================================================================
-- FIX 3 (HIGH) — anon holds an INSERT grant on reports
-- ============================================================================
-- Added 2026-09-03 after running fixes 1 and 2: the verification query still returned
-- three anon INSERT grants. Two of them are correct and must stay:
--
--   school_interest — policy "Anyone can submit school interest" ({anon,authenticated},
--                     with check true). The landing-page form for students at schools
--                     CaldwellNest has not launched at. They are not logged in by
--                     definition, so the grant is the feature.
--   appeals         — policy "Anon can file appeal" ({anon}, with check true). A suspended
--                     student may be locked out of their account and still needs a way to
--                     appeal. Same reasoning.
--
-- reports is different. All seven of its policies name `authenticated`; not one names anon.
-- So the grant lets an anonymous caller reach the table and RLS then refuses every row —
-- exactly the listings situation in fix 2. Dead grant, same reason to close it.

revoke insert on public.reports from anon;


-- ============================================================================
-- VERIFY (read-only — run this after the statements above)
-- ============================================================================
-- Expected:
--   row 1: admin_activity_log | true  | 3
--   row 2: listings           | true  | 4
select c.relname                      as table_name,
       c.relrowsecurity               as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('admin_activity_log', 'listings');

-- Expected: exactly two rows, both anon INSERT — `appeals` and `school_interest`. Those two
-- are intentional (see fix 3). Any OTHER row is a grant with no policy behind it, and should
-- be revoked the same way. `listings` and `reports` must not appear.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'public')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
order by table_name, privilege_type;


notify pgrst, 'reload schema';


-- ============================================================================
-- TEST CHECKLIST — do this in the app, not only in SQL
-- ============================================================================
-- Fix 1 enables enforcement that has never been active, so these three paths are running
-- against real policies for the first time. Check all three:
--
--   [ ] As an ADMIN: open the admin activity log. Entries still load and page.
--   [ ] As an ADMIN: perform any logged action (approve a listing), then confirm the new
--       entry appears — this exercises the INSERT policy via logEvent().
--   [ ] As an ADMIN: undo an entry — this exercises the UPDATE policy.
--   [ ] As a STUDENT: post a listing. It should succeed (logEvent runs as the student for
--       some actions, and the INSERT policy requires auth.uid() = actor_id).
--
-- If a student action starts failing with a permission error, the cause is the INSERT
-- policy's actor_id check, and the fix is in the policy — not in turning RLS back off.


-- ============================================================================
-- FOLLOW-UPS — found by the same audit, deliberately NOT changed here
-- ============================================================================
-- 3. visible_listings and visible_book_listings have no SELECT grant for `authenticated`,
--    so the app cannot read them. That is why the visibility rule was re-implemented by
--    hand as isListingLive() in js/data.js, and why the audit noted at js/profile.js:151
--    that the two had drifted apart. Granting SELECT is one line — but a Postgres view runs
--    with its OWNER's permissions by default, so granting it would bypass the RLS on
--    listings underneath. That needs a deliberate decision (and probably
--    `alter view ... set (security_invoker = true)`), not a quick GRANT.
--    This also blocks §4.6 of the campus engagement plan, which assumes every read path
--    can query visible_events.
--
-- 4. `user_roles` and `admin_roles` are both readable by anon (`{public}` role, `using true`).
--    Any anonymous visitor can list who the administrators are. Information disclosure, not
--    a write hole.
--
-- 5. Three different admin checks are in use across the policies: user_is_admin(),
--    is_super_admin(), and inline `exists (select 1 from user_roles where user_id = auth.uid())`.
--    They do not all mean the same thing — the inline form matches ANY role row, while
--    is_super_admin() requires role_id = 'super_admin'. This is the drift that can_act() is
--    meant to end (§2.6 of the engagement plan).
--
-- 6. Roughly nine duplicated policy pairs exist — e.g. appeals has both "Anon can file
--    appeal" and "anon can insert appeals", identical in effect. Harmless (permissive
--    policies OR together) but confusing, and they make the policy list hard to audit.
--
-- 7. `saved_listings` appears to be a dead predecessor of `favorites`: it has one policy but
--    no DML grants at all, so nothing can read or write it. Confirm, then drop.
--
-- 8. TRUNCATE, REFERENCES and TRIGGER are granted to anon and authenticated on nearly every
--    table — the signature of an early `grant all`. Not reachable through PostgREST, so not
--    exploitable, but worth a sweep.
--
-- 9. `appeals` allows anon INSERT with `with check (true)`. That is intended — a suspended
--    student must be able to appeal without logging in — but it is an unrated spam vector
--    with no rate limit in front of it.
