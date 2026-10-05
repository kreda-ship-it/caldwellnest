-- Two views a student can read: the org directory, and who runs each organization
-- 2026-09-06
--
-- Phase 1 of docs/nestrel-engagement-build.md — the student-facing organization layer.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
--
-- WHY THIS FILE EXISTS AT ALL
-- The build document says Phase 1 needs no new schema, because org_follows already exists.
-- That is true of the FOLLOW and false of the two numbers next to it. Checked against the
-- live policies rather than the plan:
--
--   FOLLOWER COUNT. org_follows SELECT is `using (user_id = auth.uid())` — own rows only.
--   A student running count(*) gets 1 or 0: their own follow, or nothing. Not the count.
--   sql/2026-09-04_org_hierarchy.sql says so in a comment and defers it to "the analytics
--   workstream"; the directory needs it a workstream early.
--
--   THE OFFICER LIST. org_memberships SELECT is own-row or can_act('manage_members'). A
--   plain student browsing an organization sees ZERO rows, so "officers, name and title
--   only" renders empty.
--
-- Both are the same problem: a fact about a group that must not be assembled from rows the
-- viewer is not allowed to see. And the project already has the answer, one file over.
--
--
-- ON "SECURITY DEFINER VIEW" — THE SAME NOTE AS public_profiles, AND STILL THE POINT
-- A Postgres view runs with its OWNER's permissions unless created with
-- security_invoker = true. Neither view below sets it, deliberately: that is what lets them
-- read past the caller's RLS and count follows the caller cannot see row by row.
--
-- Supabase's linter flags this. It is the mechanism, not an oversight.
--
-- THE SAFETY DOES NOT COME FROM RESTRICTING THE VIEW. It comes from the view having nothing
-- sensitive to leak. Both list their columns explicitly, so a column added to the underlying
-- table later is private by default and has to be added here on purpose. That is the right
-- direction for a mistake to fall — and it is why neither view selects *.


begin;


-- ============================================================================
-- 0. An index the follower count needs
-- ============================================================================
-- org_follows is `primary key (user_id, org_id)`, so its only index is ordered by user_id
-- first. That answers "what do I follow" perfectly and "who follows this org" not at all —
-- counting by org_id cannot use a composite index whose leading column is something else, so
-- every count below would be a sequential scan of the whole table.
--
-- Invisible today with a handful of rows. The directory runs one count per organization on
-- every page load, so it is the query most likely to be the first thing that hurts.

create index if not exists org_follows_org_idx on public.org_follows (org_id);


-- ============================================================================
-- 1. org_directory — the searchable list, with its counts and its breadcrumb
-- ============================================================================
-- ACTIVE ORGANIZATIONS ONLY, and that filter lives here rather than in the caller. The view
-- bypasses RLS, so `is_active` is not enforced by any policy behind it — if this WHERE
-- clause goes, deactivated clubs appear in the directory and nothing else stops them.
--
-- The breadcrumb (Caldwell University > Student Life > Chess Club) is two left joins rather
-- than a recursive walk. The hierarchy is school -> department -> club, so two levels up
-- reaches the root from anywhere in it. If a fourth level is ever added, this is one of the
-- places that has to know.
--
-- `school` is exposed and NOT filtered here. Every feed in this project scopes by school in
-- the client (`l.school === eu.school`, plan §12 C1), and organizations_select does the same
-- — any signed-in student may read any active organization row. Filtering here would make
-- this view the one place in the app with a different rule, which is worse than consistent.

create or replace view public.org_directory as
select
  o.id,
  o.school,
  o.parent_id,
  o.type,
  o.name,
  o.slug,
  o.description,
  o.logo_url,
  o.is_verified,
  -- Contact details an organization publishes about itself. Not personal data: these are
  -- the club's own address and handles, the same things it would print on a poster.
  o.contact_email,
  o.website,
  o.instagram,
  -- The breadcrumb. Null at the root, one level for a department, two for a club.
  parent.name      as parent_name,
  grandparent.name as grandparent_name,
  (select count(*) from public.org_follows f where f.org_id = o.id) as follower_count
from public.organizations o
left join public.organizations parent      on parent.id      = o.parent_id
left join public.organizations grandparent on grandparent.id = parent.parent_id
where o.is_active = true;

-- DELIBERATELY ABSENT: phone, office_location, handshake_url, created_by, created_at.
-- None is needed by the directory or the profile page, and `created_by` in particular names
-- a person. Add one when a surface actually asks for it, not in advance.


-- ============================================================================
-- 2. org_public_officers — who runs this club, and nothing else about them
-- ============================================================================
-- "Officers (name and title only)" is the build document's wording and this follows it
-- literally.
--
-- NO user_id. That omission is the whole design. With it, anyone could read this view for
-- every organization and assemble a map of which student is involved in what — exactly the
-- cross-org profile §6.1 says belongs to the student and to nobody else. Without it, you can
-- see that Chess Club's president is Ana Whitfield and you cannot join that up with anything.
--
-- NO avatar_url either, for the same reason and one step milder: a face is more identifying
-- than a name and the specification did not ask for one.
--
-- Officers only, active only, and only for organizations that are themselves active — a
-- deactivated club must not keep publishing its roster through a view.

create or replace view public.org_public_officers as
select
  m.org_id,
  m.role,
  m.title,
  pr.first_name,
  pr.last_name
from public.org_memberships m
join public.profiles       pr on pr.id = m.user_id
join public.organizations  o  on o.id  = m.org_id
where m.status = 'active'
  and m.role   = 'officer'
  and o.is_active = true;


commit;


-- ============================================================================
-- 3. GRANTS — and the revokes this project forgets every single time
-- ============================================================================
-- CLAUDE.md records this as hard-learned and then records it being missed twice anyway,
-- most recently on public_profiles. Supabase attaches DEFAULT PRIVILEGES to every new object
-- in `public` — TABLES AND VIEWS ALIKE — before any grant of ours runs, so a brand-new view
-- arrives already carrying REFERENCES, TRIGGER and TRUNCATE for both anon and authenticated.
-- A grant only ever ADDS. The extras have to be taken back by name.
--
-- On a view none of the three is reachable, so this is consistency rather than a hole. The
-- reason to do it anyway is that "reachable" is a property of today's schema: the habit is
-- what protects the next table, where TRUNCATE ignores every policy above it.

grant select on public.org_directory        to authenticated;
grant select on public.org_public_officers  to authenticated;

revoke truncate, references, trigger on public.org_directory       from authenticated;
revoke truncate, references, trigger on public.org_public_officers from authenticated;

revoke all on public.org_directory       from anon;
revoke all on public.org_public_officers from anon;


notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only — run after the file)
-- ============================================================================

-- 1. Expected: both views exist, and neither reports security_invoker = on.
--    If either says 'on', it will inherit the caller's RLS and return nothing useful.
select c.relname as view_name,
       coalesce(
         (select option_value from pg_options_to_table(c.reloptions)
           where option_name = 'security_invoker'), 'off (default — correct)') as security_invoker
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('org_directory', 'org_public_officers');

-- 2. Expected: no rows. Nothing anonymous reaches either view, and `authenticated` holds
--    SELECT and nothing else.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('org_directory', 'org_public_officers')
  and grantee in ('anon', 'public', 'authenticated')
  and (grantee in ('anon', 'public') or privilege_type <> 'SELECT');

-- 3. Expected: no row named email, user_id, avatar_url or phone anywhere in either view.
--    This is the leak check, and it is worth re-running after any change to either.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name in ('org_directory', 'org_public_officers')
  and column_name in ('email', 'user_id', 'avatar_url', 'phone', 'created_by',
                      'pending_email', 'suspension_reason');

-- 4. Expected: your organizations, each with a follower_count. Run it as yourself; the
--    numbers are the point, and they are counts you could not have assembled by hand.
select id, type, name, parent_name, grandparent_name, follower_count
from public.org_directory
order by grandparent_name nulls first, parent_name nulls first, name;


-- Then run sql/2026-09-06_verify_org_visibility.sql, which impersonates a real non-member
-- and checks what they can and cannot read.
