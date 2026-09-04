-- Constrain `school` to a real school
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- WHY
-- The 2026-09-04 constraint capture found that nothing anywhere constrains `school`. Six
-- tables carry it as free text while `schools.slug` is UNIQUE and available as a foreign key
-- that was simply never added. Nothing in the database prevented a typo creating a listing in
-- a school that does not exist.
--
-- That is also what made `profiles.school DEFAULT 'Caldwell'` — capital C — dangerous rather
-- than merely untidy. Every comparison in the project is exact: `school = get_admin_school()`
-- in the RLS policies, `l.school === eu.school` in the browser. A row carrying 'Caldwell'
-- would silently fail all of them, and nothing would raise an error. **A foreign key would
-- have rejected it on the first insert.**
--
-- CHECKED BEFORE WRITING THIS
-- Every non-null value in all six tables is 'caldwell', matching the one row in `schools`.
-- Nulls exist in listings/user_roles/broadcasts/suspension_history and are fine — a foreign
-- key permits null, it only constrains values that are present. Nothing needs repairing
-- first, which is not luck: it is why the audit ran before the constraint was written.

begin;


-- ============================================================================
-- 1. Fix the default that started this
-- ============================================================================
-- DROP rather than correct to 'caldwell'. A default only applies when a column is omitted,
-- and `profiles.school` is NOT NULL — so with no default, an insert that forgets the school
-- FAILS LOUDLY instead of quietly deciding the student attends Caldwell.
--
-- That is the right trade for a platform meant to serve more than one school. Every current
-- write names the column (handle_new_user, and the signup upsert in js/auth.js), so nothing
-- relies on the default today.

alter table public.profiles alter column school drop default;


-- ============================================================================
-- 2. The foreign keys
-- ============================================================================
-- All reference schools(slug) rather than schools(id), because that is what these columns
-- actually hold — a slug like 'caldwell'. Referencing the uuid would mean changing every
-- column, every policy and every browser-side comparison in the app. The slug is UNIQUE,
-- which is all a foreign key requires.
--
-- ON UPDATE CASCADE is deliberate. A slug is a natural key: it is human-readable and could
-- reasonably be renamed one day. Cascading means a rename updates every referencing row in
-- one statement instead of orphaning all of them.
--
-- ON DELETE is left at the default (RESTRICT), which refuses to delete a school while
-- anything still points at it. For a school with listings, profiles and organizations under
-- it, refusing is the correct answer.

alter table public.organizations
  add constraint organizations_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;

alter table public.listings
  add constraint listings_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;

alter table public.profiles
  add constraint profiles_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;

-- user_roles.school NULL means super admin — authority over every school rather than one.
-- A foreign key permits null, so that meaning survives untouched. See js/config.js:102.
alter table public.user_roles
  add constraint user_roles_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;

alter table public.suspension_history
  add constraint suspension_history_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;

alter table public.broadcasts
  add constraint broadcasts_school_fkey
  foreign key (school) references public.schools(slug) on update cascade;


commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- DELIBERATELY NOT CONSTRAINED: admin_activity_log
-- ============================================================================
-- admin_activity_log.school and .actor_school hold slugs too, and both are clean. They are
-- still left alone, on purpose.
--
-- An audit log records what was true at the time. Its job is to stay readable years later,
-- including after the thing it describes has changed or gone. A foreign key would make the
-- log's correctness depend on current reference data:
--   * ON UPDATE CASCADE would silently REWRITE history when a slug is renamed, so a log entry
--     would claim an action happened in a school that did not have that name yet.
--   * ON DELETE RESTRICT would block ever removing a school because the log remembers it.
-- Neither is what an append-only record should do. The same reasoning is why the log stores
-- target_label and before_state as text snapshots instead of joining live rows.
--
-- This is a real distinction rather than a dodge: constrain the tables that describe what IS,
-- leave the tables that describe what HAPPENED.


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: six rows, one per table above. admin_activity_log must NOT appear.
select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
  and contype = 'f'
  and conname like '%_school_fkey'
order by conrelid::regclass::text;

-- Expected: one row, column_default empty.
select column_name, is_nullable, coalesce(column_default, '(none)') as column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'school';

-- Expected: ERROR — foreign key violation. This is the whole point of the change: the value
-- that could have been written silently yesterday is now refused. Run it and read the error,
-- then move on; it changes nothing.
--   insert into public.listings (title, category, school) values ('fk test', 'other', 'Caldwell');


-- ============================================================================
-- TEST IN THE APP
-- ============================================================================
--   [ ] A student can still post a listing.        (listings.school)
--   [ ] A new student can still sign up.           (profiles.school, and the dropped default)
--   [ ] Admin login still works.                   (user_roles.school)
--   [ ] The Organizations tab still creates orgs.  (organizations.school)
--
-- Signup is the one to actually try. It is the only path that inserts a profile, and it is
-- the path whose default was just removed.


-- ============================================================================
-- WORTH DOING LATER, NOT HERE
-- ============================================================================
-- `schools.slug` itself has no format constraint, so nothing stops a future school being
-- added as 'Rutgers' with a capital R — which would then be a perfectly valid foreign key
-- target that still breaks every lowercase comparison in the app. One line closes it:
--
--   alter table public.schools add constraint schools_slug_lowercase
--     check (slug = lower(slug) and slug ~ '^[a-z0-9-]+$');
--
-- Left out of this file because it is a different claim -- "slugs have a shape" rather than
-- "school values are real schools" -- and mixing them would make one failure look like the
-- other. Worth adding before a second school is ever created.
