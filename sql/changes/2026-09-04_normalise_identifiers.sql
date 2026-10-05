-- Lowercase the identifiers on the way in, so case can never split one thing into two
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- THE POINT
-- `Caldwell.EDU` and `caldwell.edu` are the SAME domain. That is not a preference — domain
-- names are case-insensitive by specification (RFC 4343). So storing them as two different
-- values is wrong, and rejecting one of them for its capitals is also wrong. The right answer
-- is to accept whatever a human types and store one canonical form.
--
-- The app already does this at every entry point: js/auth.js lowercases the email at signup
-- (250), login (353) and password reset (115); js/profile.js does it in the waitlist (124)
-- and in validateSchoolEmail (157); js/orgs.js does it before looking up an officer. Nothing
-- in the DATABASE enforced it, so the guarantee held only for values the app wrote. A domain
-- typed by hand in the SQL editor — which is how every school will actually be added — had no
-- such protection, and would have silently failed to match forever.
--
-- ============================================================================
-- WHAT IS NOT NORMALISED, AND WHY
-- ============================================================================
-- This applies to IDENTIFIERS, never to NAMES.
--
--   identifier   email, domain, slug, username     case carries no meaning     -> lowercase it
--   name         first_name, schools.name,         case IS the content         -> leave alone
--                organizations.name, listing title
--
-- 'Caldwell University' must stay exactly as typed. 'McKenna' must keep its capital K, and
-- 'de Souza' must keep its lowercase d. Lowercasing a person's name to make matching easier
-- destroys information that belongs to them; lowercasing a domain destroys nothing, because
-- the two spellings were never different to begin with.
--
-- If a name ever needs case-insensitive SEARCH, that is a query concern — `ilike`, or an
-- index on lower(name) — and not a reason to change what is stored.

begin;

-- Three trivial functions rather than one clever one. A first draft of this file used a
-- single function reading TG_ARGV and rewriting the row through jsonb — it worked, and it
-- round-tripped every column of the record through JSON to change one text field. Cleverness
-- that touches columns it has no business touching is not worth three saved lines.

create or replace function public.lowercase_school_domain()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  new.domain := lower(new.domain);
  return new;
end;
$function$;

create or replace function public.lowercase_schools_identifiers()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  new.slug         := lower(new.slug);
  new.email_domain := lower(new.email_domain);
  return new;
end;
$function$;

create or replace function public.lowercase_org_slug()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  new.slug := lower(new.slug);
  return new;
end;
$function$;

-- school_domains.domain is the important one: validateSchoolEmail() looks the domain up with
-- an exact match after lowercasing the address, so a row stored with capitals is invisible to
-- the gate and every student at that school is told their domain is unrecognized.
drop trigger if exists school_domains_lowercase on public.school_domains;
create trigger school_domains_lowercase
  before insert or update on public.school_domains
  for each row execute function public.lowercase_school_domain();

-- schools.slug is compared exactly everywhere; schools.email_domain is a domain like any other.
drop trigger if exists schools_lowercase on public.schools;
create trigger schools_lowercase
  before insert or update on public.schools
  for each row execute function public.lowercase_schools_identifiers();

-- organizations.slug is half of `unique (school, slug)`, so 'Chess-Club' and 'chess-club'
-- would be two organizations that read as one.
drop trigger if exists organizations_lowercase on public.organizations;
create trigger organizations_lowercase
  before insert or update on public.organizations
  for each row execute function public.lowercase_org_slug();

-- Repair anything already stored with capitals. Almost certainly a no-op — every value came
-- from the app, which lowercases — but a normalisation that does not fix existing rows leaves
-- exactly the problem it was written to prevent.
update public.school_domains set domain = lower(domain)             where domain <> lower(domain);
update public.schools          set slug = lower(slug)               where slug <> lower(slug);
update public.schools          set email_domain = lower(email_domain) where email_domain <> lower(email_domain);
update public.organizations    set slug = lower(slug)               where slug <> lower(slug);

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- HOW THIS SITS WITH THE CHECK CONSTRAINTS FROM 2026-09-04_slug_format.sql
-- ============================================================================
-- They are not redundant, they are layered, and the split is exact:
--
--   the trigger fixes what is MEANINGLESS      'Chess-Club' -> 'chess-club'
--   the check rejects what is genuinely WRONG  'Chess Club' -- a space is not a slug
--
-- Lowercasing 'Chess Club' gives 'chess club', which still fails the check and still should.
-- Case is noise; a space is a malformed identifier. Normalise the noise, refuse the error.
--
-- With the trigger in place the case half of those checks can never fire again. That is the
-- ideal end state for an assertion: it stays as proof the normalisation is working, and the
-- day it starts failing you have learned something real.


-- ============================================================================
-- DELIBERATELY NOT INCLUDED: profiles.email
-- ============================================================================
-- It is an identifier and the argument above applies to it — but it is already safe twice
-- over. It is written by handle_new_user() from auth.users.email, which Supabase has already
-- normalised, and every app path that reads it lowercases first. Adding a fourth trigger to
-- `profiles`, which already carries three, buys nothing here and adds a thing to reason about
-- when one of the other three misbehaves.
--
-- profiles.username needs nothing either: its username_format check already requires
-- ^[a-z0-9][a-z0-9_]{2,19}$, so an uppercase username was never storable.
--
-- courses.code is left alone ON PURPOSE and is the exception that proves the rule. It holds
-- values like 'CS101', where the capitals are how a course code is written. It is an
-- identifier whose canonical form is uppercase — so normalising it downward would be the same
-- mistake as lowercasing a surname.


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: three triggers.
select c.relname as table_name, t.tgname
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal and t.tgname like '%_lowercase'
order by c.relname;

-- Expected: it INSERTS, and comes back lowercase — accepted and corrected, not refused.
-- Then delete it.
--   insert into public.schools (name, slug, email_domain)
--   values ('Case Test University', 'CASE-TEST', 'Case-Test.EDU') returning slug, email_domain;
--   -- expect: case-test | case-test.edu
--   delete from public.schools where slug = 'case-test';
