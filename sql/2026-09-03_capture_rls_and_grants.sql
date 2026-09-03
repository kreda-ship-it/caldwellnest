-- Capture the database's real permission rules
-- 2026-09-03
--
-- READ ONLY. Every statement in this file is a SELECT against Postgres's own catalog
-- tables. It creates nothing, changes nothing, and drops nothing. You can run it on the
-- live database with no risk, and run it again any time you want to re-check.
--
-- WHY THIS EXISTS
-- Three launch blockers are really one job:
--   - "RLS still unverified" (open since 2026-08-05)
--   - "appeals table + RLS unconfirmed"
--   - "confirm anon holds no UPDATE grant on book_listings"
-- All three say the same thing: nobody has ever read back what permissions this database
-- actually enforces. sql/README.md's "Still missing" list says it a fourth time. This file
-- is how that gets answered.
--
-- It is also stage 0 of the campus engagement build. can_act() and its RLS policies get
-- layered on top of whatever is already here, so "whatever is already here" has to be
-- known first. See §12 of docs/nestrel-campus-engagement-plan.md.
--
-- HOW TO RUN
-- Supabase Dashboard -> SQL Editor. Run ONE numbered query at a time and paste each result
-- back. The editor only shows the result of the last statement when you run several at
-- once, which is why these are numbered rather than one long script.
--
-- NO `NOTIFY pgrst, 'reload schema';` AT THE END
-- Every other file in this folder ends with that line because they change the schema and
-- Supabase caches it. This file changes nothing, so there is nothing to reload. Running
-- NOTIFY anyway would be harmless but meaningless.


-- ============================================================================
-- 1. Is RLS actually switched on?
-- ============================================================================
-- The single most important query here. A table can have beautifully written policies and
-- still be wide open, because policies are only consulted when RLS is ENABLED on the table.
-- Policies on a table with rls_enabled = false are decoration.
--
-- Sorted so that any table with RLS off appears FIRST.
--
-- WHAT A BAD ANSWER LOOKS LIKE: any row with rls_enabled = false that holds real data.

select c.relname                        as table_name,
       c.relrowsecurity                 as rls_enabled,
       c.relforcerowsecurity            as rls_forced,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'                   -- ordinary tables only
order by c.relrowsecurity asc, c.relname;


-- ============================================================================
-- 2. Every RLS policy, in full
-- ============================================================================
-- `using_expr` decides which existing rows a caller may see or act on.
-- `with_check_expr` decides what a caller is allowed to write.
--
-- Read the gap between those two columns carefully. On an UPDATE policy, a NULL
-- with_check_expr does NOT mean "no check" — Postgres reuses the USING expression as the
-- check. That is exactly what `Users update own profile` does, and it is why the
-- profiles_guard_privileged trigger has to exist. See §2.9 of the engagement plan.
--
-- WHAT A BAD ANSWER LOOKS LIKE: a policy whose using_expr is `true`; an INSERT or UPDATE
-- policy with a with_check_expr that does not tie the row to auth.uid(); any policy naming
-- the `anon` or `public` role on a table holding student data.

select tablename,
       policyname,
       cmd                              as command,
       roles::text                      as applies_to_roles,
       permissive,
       coalesce(qual,       '(none)')   as using_expr,
       coalesce(with_check, '(none)')   as with_check_expr
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- ============================================================================
-- 3. Table-level GRANTs
-- ============================================================================
-- RLS filters ROWS. GRANT decides whether a role may touch the TABLE at all. They are two
-- separate gates and both have to be right — a missing GRANT produces a confusing
-- permission error even when RLS would have allowed the row.
--
-- `anon` is the unauthenticated public. Anyone on the internet with your project URL and
-- the public anon key is `anon`.
--
-- WHAT A BAD ANSWER LOOKS LIKE: `anon` holding anything beyond SELECT.

select table_name,
       grantee,
       string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'public')
group by table_name, grantee
order by table_name,
         case grantee when 'anon' then 1 when 'public' then 2 else 3 end;


-- ============================================================================
-- 4. The book_listings blocker, asked directly
-- ============================================================================
-- fn_guard_owner_listing_update() waves through any caller whose auth.uid() is NULL, and an
-- unauthenticated API request has a NULL auth.uid(). So for book_listings the GRANT is the
-- only thing standing in front of that guard. This query asks whether it is standing.
--
-- EXPECTED RESULT: zero rows.
-- ANY ROW RETURNED IS A FINDING, and a row naming book_listings is the open blocker.

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'public')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name, privilege_type;


-- ============================================================================
-- 5. Views — does visible_listings exist, and what does it say?
-- ============================================================================
-- js/data.js:40 says isListingLive() "mirrors the visible_listings SQL view", and
-- js/profile.js:151 records that an audit already caught those two drifting apart. No file
-- in sql/ defines the view, so its real text has never been read.
--
-- §4.6 of the engagement plan copies this pattern for visible_events, so the original needs
-- to be known before it is imitated.

select viewname, definition
from pg_views
where schemaname = 'public'
order by viewname;


-- ============================================================================
-- 6a. Every function, listed compactly
-- ============================================================================
-- SECURITY DEFINER means the function runs with its OWNER's permissions, not the caller's.
-- That is deliberate and necessary for the guard functions, but it also means such a
-- function must never trust `current_user` — inside SECURITY DEFINER, current_user is the
-- owner, so a check against it exempts everybody. sql/2026-08-08_check_book_listings_guard.sql
-- records learning that the hard way. These functions use auth.uid() instead.

select p.proname                                        as function_name,
       pg_get_function_identity_arguments(p.oid)        as arguments,
       case when p.prosecdef then 'SECURITY DEFINER'
            else 'security invoker' end                 as runs_as,
       pg_get_function_result(p.oid)                    as returns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.prosecdef desc, p.proname;


-- ============================================================================
-- 6b. Full text of the load-bearing functions
-- ============================================================================
-- These four are the ones the engagement plan depends on directly:
--   is_super_admin()                    -- can_act()'s first branch calls it (§2.6)
--   get_admin_school()                  -- school scoping for admins
--   guard_profile_privileged_columns()  -- the real defense on profiles (§2.9)
--   enforce_school_email()              -- the .edu gate (A12)
-- Adjust the name list if 6a shows they are named differently.

select p.proname as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'is_super_admin',
    'get_admin_school',
    'guard_profile_privileged_columns',
    'enforce_school_email',
    'fn_guard_owner_listing_update',
    'change_listing_status',
    'handle_new_user'
  )
order by p.proname;


-- ============================================================================
-- 7. Every trigger
-- ============================================================================
-- sql/README.md lists one of these as still missing: the real CREATE TRIGGER statement for
-- trg_guard_owner_listing_update. Only the function it calls was ever written down, so
-- nobody knows which events or which columns fire it. pg_get_triggerdef returns the exact
-- statement needed to recreate it.

select c.relname                as table_name,
       t.tgname                 as trigger_name,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c     on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and not t.tgisinternal        -- hide the ones Postgres makes for foreign keys
order by c.relname, t.tgname;


-- ============================================================================
-- 8. Column definitions for the tables that were never captured
-- ============================================================================
-- sql/README.md: "Table definitions: listings, book_listings, profiles, messages, appeals,
-- user_roles, schools, activity_log." This answers all of them at once.
--
-- Two things to look for specifically:
--   - the real shape of user_roles, which is_super_admin() and every admin exemption reads
--   - any column on `profiles` that guard_profile_privileged_columns() does NOT list but
--     probably should, since the student UPDATE policy lets an owner write anything else

select table_name,
       ordinal_position as pos,
       column_name,
       data_type,
       is_nullable,
       column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'listings', 'book_listings', 'profiles', 'messages', 'appeals',
    'user_roles', 'role_permissions', 'schools', 'school_domains',
    'admin_activity_log', 'reports', 'favorites'
  )
order by table_name, ordinal_position;


-- ============================================================================
-- 9. Has the favorites table been applied yet?
-- ============================================================================
-- sql/2026-09-01_saved_items.sql is written and uncommitted, and nothing in js/ references
-- `favorites`, so it may or may not have been run. This settles it.
--
-- If it returns zero rows, the file has not been applied — which is the good case, because
-- 'event' still needs adding to the item_type check constraint before it runs. See §12 C6
-- of the engagement plan.

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'favorites';
