-- Take back the default privileges Supabase attached to public_profiles
-- 2026-09-04
--
-- Read only in effect: nothing that works stops working. Safe to re-run.
--
-- The verification in 2026-09-04_public_profiles_view.sql expected one row —
-- authenticated / SELECT. It returned four, because `authenticated` also held TRUNCATE,
-- REFERENCES and TRIGGER. Supabase's project-wide DEFAULT PRIVILEGES attach those to every
-- new object in the public schema BEFORE any grant of ours runs, so a `grant` only ever adds.
--
-- The `revoke all ... from anon` in that file was written for exactly this reason and worked
-- — there is no anon row. `authenticated` was simply not given the same treatment.
--
-- HOW MUCH THIS MATTERS: very little, and it is worth being accurate rather than alarming.
-- On a VIEW none of the three is reachable. TRUNCATE errors with "cannot truncate a view".
-- REFERENCES cannot point a foreign key at a view. TRIGGER would allow an INSTEAD OF trigger,
-- but creating one also needs the ability to create a function, which `authenticated` does
-- not have. This is consistency, not a hole.
--
-- It is worth doing anyway, because "every object grants exactly what it needs" is a rule you
-- can check at a glance, and "every object grants what it needs plus three harmless extras"
-- is a rule nobody can audit.

revoke truncate, references, trigger on public.public_profiles from authenticated;
revoke all on public.public_profiles from anon;

notify pgrst, 'reload schema';

-- Expected now: exactly one row — authenticated / SELECT.
-- (postgres and service_role rows are Supabase's own and are not ours to change.)
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'public_profiles'
  and grantee in ('anon', 'authenticated');
