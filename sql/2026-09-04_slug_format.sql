-- Give slugs a shape
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- WHY
-- 2026-09-04_school_foreign_keys.sql made `school` point at a real row in `schools`. That
-- closes "this school does not exist" but not "this school exists under a name nothing in the
-- app will match". A school added as 'Rutgers' with a capital R would be a perfectly valid
-- foreign-key target and would still break every comparison in the project, because they are
-- all exact: `school = get_admin_school()` in the RLS policies, `l.school === eu.school` and
-- `s.slug === eu.school` in the browser.
--
-- A foreign key answers "does this refer to something real". A check constraint answers "is
-- this the right shape". They are different questions and the first one does not cover the
-- second — which is exactly how `profiles.school DEFAULT 'Caldwell'` sat unnoticed.
--
-- THE RULE, matching what the code already produces:
--   lowercase letters, digits, and single hyphens between them
--   no leading hyphen, no trailing hyphen, no double hyphen, never empty
-- `orgCreateChild()` in js/orgs.js derives exactly this from a typed name:
--   name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
-- So this constraint writes down a rule the app was already following by convention, and
-- makes it true for rows the app did not create — a hand-typed INSERT in the SQL editor, most
-- likely, which is how every school will actually be added for a while.

-- ---------- Pre-check ----------
-- If either ALTER below fails, run this first: it names the offending rows. Adding a check
-- constraint validates every existing row, so one bad slug refuses the whole statement.
select 'schools' as tbl, id::text as id, slug from public.schools
where slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
union all
select 'organizations', id::text, slug from public.organizations
where slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$';
-- Expected: no rows.


begin;

alter table public.schools
  add constraint schools_slug_format
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- organizations.slug gets the same rule, for the same reason and one step closer to the user.
-- It is half of `unique (school, slug)`, so 'Chess-Club' and 'chess-club' would be two
-- different organizations that read as one. js/orgs.js already lowercases what it generates;
-- this is what stops a slug that arrives some other way from being subtly different.
alter table public.organizations
  add constraint organizations_slug_format
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: two rows, schools_slug_format and organizations_slug_format.
select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
  and conname in ('schools_slug_format', 'organizations_slug_format')
order by conrelid::regclass::text;

-- Expected: ERROR, check constraint violated. The point of the change, in one line.
--   insert into public.schools (name, slug, email_domain)
--   values ('Test University', 'Test-U', 'test.edu');


-- ============================================================================
-- WHAT THIS DOES NOT DO
-- ============================================================================
-- It does not stop a slug being wrong in a way that is still well-formed: 'caldwel' passes.
-- Shape rules catch typos of form, never of fact. The check on fact is that a real person
-- reads the row after adding a school, and the fact worth reading is that
-- schools.slug matches the domain in school_domains and the value the app was built around.
--
-- It also does not apply to the two domain columns, and there are two worth keeping straight:
--   school_domains.domain  -- what validateSchoolEmail() actually looks up (js/profile.js)
--   schools.email_domain   -- UNIQUE, but not the column the gate reads
-- Neither has a format rule. validateSchoolEmail() lowercases the address before querying, so
-- a row stored as 'Caldwell.EDU' would never match and every student at that school would be
-- told their domain is unrecognized — while the row sits there looking correct. Same class of
-- bug as the capitalised slug, one table over. A natural next line, left out here so this
-- file makes exactly one claim.
