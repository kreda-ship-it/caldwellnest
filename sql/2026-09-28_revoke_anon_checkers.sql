-- The two "is this taken?" functions: not answerable by logged-out visitors
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run.
--
-- WHY (second audit, S3)
-- Probed 2026-09-28: a logged-out request to check_email_available and to check_username_available
-- is answered (HTTP 200). By its name, check_email_available tells anyone whether an email address
-- has a Nestrel account.
--
-- WHAT CHANGES
--   check_email_available     nothing in the app calls it -> no browser role may call it at all
--   check_username_available  the app calls it only when signed in (the Google finish screen and
--                             Edit profile) -> signed-in users only
-- Functions get EXECUTE for PUBLIC by default, and anon inherits from PUBLIC, so PUBLIC is revoked
-- too. Each function is found by name, so this works whatever its exact argument types are.
--
-- NOT CHANGED, on purpose: is_super_admin, user_is_admin, get_admin_school, can_act, has_voted and
-- is_org_member also answer strangers, but only ever with "no" about the caller. They are used inside
-- RLS policies, and taking EXECUTE away from anon could turn an anonymous request that should simply
-- see nothing into an error.


begin;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'check_email_available'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;

  for r in select p.oid::regprocedure as sig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'check_username_available'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end
$$;

commit;

notify pgrst, 'reload schema';


-- VERIFY — expected:
--   check_email_available     anon_can_run false, students_can_run false
--   check_username_available  anon_can_run false, students_can_run true
select p.proname,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as students_can_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('check_email_available', 'check_username_available')
order by p.proname;
