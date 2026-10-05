-- Close the four findings from the 2026-09-04 policy capture
-- 2026-09-04
--
-- Follows sql/2026-09-04_capture_rls_policies.sql, which recorded five findings. Four are
-- fixed here. The fifth (F2, profile columns) is NOT — it cannot be fixed with a policy, and
-- the reason is written out at the bottom so nobody wastes an afternoon trying.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run. Everything is inside one transaction, so it either all applies or none of
-- it does — the database is never left half-changed.
--
-- RUN THIS BEFORE the campus engagement schema. Both change permissions, and if you run them
-- together and something misbehaves, you cannot tell which one did it.


begin;


-- ============================================================================
-- FIX A — any student could write a notification into any other student's feed
-- ============================================================================
-- Both INSERT policies on notifications were:
--     to authenticated with check (true)
-- The names said "Admin". Nothing checked for one, and profile_id was never tied to
-- auth.uid(). So any signed-in student could insert a row addressed to anyone, with any
-- text — forging "Your listing was removed" or "Your appeal was rejected" into another
-- student's account. Reading was never affected; the SELECT policy is correctly own-rows.
--
-- Verified safe before changing: notifications are written by exactly one function,
-- aNotifyStudent() in js/auth.js, and its three call sites are all in js/admin.js —
-- listing removed (1003), appeal resolved (1536), appeal edited (3823). Every one is an
-- admin action. No student-triggered path writes a notification, so requiring an admin
-- takes nothing away.
--
-- Two identical policies are replaced by one correct policy.

drop policy if exists "Admin can insert"          on public.notifications;
drop policy if exists "Admin insert notifications" on public.notifications;

create policy "Admins insert notifications" on public.notifications
  as permissive for insert to authenticated
  with check (user_is_admin());


-- ============================================================================
-- FIX B — the admin roster was readable by anyone, logged in or not
-- ============================================================================
-- "User roles are public" was `to public using (true)`. `public` in Postgres includes anon,
-- so any anonymous visitor could list every administrator. Same for "Admin roles are public"
-- on admin_roles. That is not an access hole — nobody gains a permission by reading it — but
-- it hands an attacker the exact list of accounts worth attacking.
--
-- Verified safe before changing: user_roles is read in exactly two places (js/auth.js:20 and
-- js/boot.js:71) and BOTH filter to the caller's own row with .eq('user_id', ...). The
-- surviving "Users can read own roles" policy covers both, and super admins keep full access
-- through super_admin_manages_roles. admin_roles is not read anywhere in the app at all.
--
-- admin_roles keeps a read policy rather than losing one, scoped to signed-in users. Dropping
-- its only policy would make the table unreadable, and a lookup table that suddenly returns
-- nothing is a confusing way to discover you needed it.

drop policy if exists "User roles are public" on public.user_roles;

drop policy if exists "Admin roles are public" on public.admin_roles;
create policy "Signed-in users read admin roles" on public.admin_roles
  as permissive for select to authenticated
  using (true);


-- ============================================================================
-- FIX C — nine duplicate policies
-- ============================================================================
-- Each of these is an exact twin of another policy on the same table, differing only in
-- capitalisation of its name. Permissive policies OR together, so a duplicate grants nothing
-- extra and removing one changes nothing at runtime. What they cost is legibility: they made
-- the policy list a third longer than it needed to be, on the one list that has to be read
-- carefully to be trusted.
--
-- The survivor of each pair is named in the comment, so this is checkable rather than
-- something you have to take on faith.

drop policy if exists "admin can read appeals"   on public.appeals;   -- kept: "Admins view all appeals"
drop policy if exists "admin can update appeals" on public.appeals;   -- kept: "Admins update appeals"
drop policy if exists "anon can insert appeals"  on public.appeals;   -- kept: "Anon can file appeal"

drop policy if exists "Admins manage broadcasts" on public.broadcasts; -- kept: "Admins can manage broadcasts"

drop policy if exists "admins can read all reports" on public.reports; -- kept: "Admins view all reports"
drop policy if exists "admins can update reports"   on public.reports; -- kept: "Admins update reports"
drop policy if exists "students can file reports"   on public.reports; -- kept: "Students can file reports"

drop policy if exists "admins can insert suspension history" on public.suspension_history; -- kept: "Admins insert suspension history"
drop policy if exists "admins can read suspension history"   on public.suspension_history; -- kept: "Admins view suspension history"


-- ============================================================================
-- FIX D — pin search_path on the three permission functions
-- ============================================================================
-- All three are SECURITY DEFINER: they run with their owner's permissions, not the caller's.
-- A SECURITY DEFINER function that does not fix its search_path can in principle be pointed
-- at a different table of the same name, if the caller can create one earlier in the path.
--
-- Not reachable in this database today — `authenticated` cannot create tables or schemas —
-- but these three decide every admin permission in the app, and they are the wrong ones to
-- leave loose. It is also what Supabase's linter flags as "Function Search Path Mutable".
--
-- This CANNOT change behaviour here, which is why it is safe to do in the same pass: all
-- three already reference `public.user_roles` fully qualified, so pinning the path to public
-- changes nothing about what they resolve. auth.uid() stays qualified by its own schema.
-- guard_profile_privileged_columns() and enforce_school_email() already do exactly this.

create or replace function public.is_super_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role_id = 'super_admin'
  );
$function$;

create or replace function public.get_admin_school()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT school FROM public.user_roles
  WHERE user_id = auth.uid()
  LIMIT 1;
$function$;

create or replace function public.user_is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid());
$function$;

-- STABLE was added to is_super_admin() and get_admin_school() to match user_is_admin().
-- It tells the planner the answer cannot change within a single statement, so a policy that
-- calls one of these per row evaluates it once instead of once per row. Correctness is
-- unaffected — these read a table that no policy modifies mid-statement — and on the listings
-- feed, where is_super_admin() sits inside the SELECT policy, it is the difference between
-- one lookup and one lookup per listing.


commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only — run after the transaction above)
-- ============================================================================

-- 1. notifications should now have THREE policies, and the INSERT one must not be `true`.
--    Expected: "Admins insert notifications" | INSERT | with check (user_is_admin())
select policyname, cmd, coalesce(with_check, '(none)') as with_check_expr
from pg_policies
where schemaname = 'public' and tablename = 'notifications'
order by cmd, policyname;

-- 2. No policy anywhere should still be readable by anon via `to public using (true)`,
--    except platform_settings (deliberate — the landing page reads it logged out).
--    Expected: exactly one row, platform_settings.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and 'public' = any(roles)
  and qual = 'true'
order by tablename;

-- 3. Policy count should have dropped from 67 to 57 (9 duplicates + 1 net from notifications).
select count(*) as total_policies from pg_policies where schemaname = 'public';

-- 4. All three permission functions should now report a pinned search_path.
--    Expected: three rows, each showing {search_path=public}.
select p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_super_admin', 'get_admin_school', 'user_is_admin')
order by p.proname;


-- ============================================================================
-- TEST IN THE APP — these paths run through what changed
-- ============================================================================
--   [ ] Admin login still works.                      (fix B + D: reads user_roles)
--   [ ] Student login still works.                    (fix D)
--   [ ] The listings feed still loads for a student.  (fix D: is_super_admin in the policy)
--   [ ] Remove a listing as an admin, then check that student's notifications. (fix A)
--   [ ] File a report as a student.                   (fix C: one of the twins was dropped)
--   [ ] Suspend and reinstate a test student.         (fix C + A)
--
-- If admin login breaks, the cause is fix B. The recovery is one line:
--   create policy "Users can read own roles" on public.user_roles
--     as permissive for select to authenticated using ((auth.uid() = user_id));
-- (that policy is not touched by this file, so it should already be there — but if the login
-- screen says "This account does not have admin access", that is the policy to look at first)


-- ============================================================================
-- F2 — NOT FIXED HERE, AND NOT FIXABLE WITH A POLICY
-- ============================================================================
-- 'Authenticated users can read profiles' is `using (true)`, and the app calls select('*') on
-- profiles in eight places. Every signed-in student can therefore read every column of every
-- profile: email, status, suspension_reason, terms_accepted_at, terms_version.
--
-- The reason this is not a one-line fix: **RLS filters rows, not columns.** There is no
-- policy that says "you may read this row but not that column of it" — that is simply not
-- what the feature does. Tightening the USING clause would hide whole profiles, which breaks
-- every public profile page in the app.
--
-- Two real options, both requiring code changes:
--   (a) a `public_profiles` view exposing only the safe columns, with the eight select('*')
--       calls pointed at it, and select('*') on the table itself reserved for admins; or
--   (b) column-level GRANTs — revoke SELECT on the sensitive columns from authenticated and
--       grant the rest, which PostgREST respects.
--
-- (a) is the better fit here: it matches the visible_listings pattern the project already
-- uses, and it keeps the rule in one readable place. It is a session of work, not a line.
-- Worth doing before launch — student email addresses and suspension reasons are exactly the
-- data a campus platform should not hand to every other student who asks.
