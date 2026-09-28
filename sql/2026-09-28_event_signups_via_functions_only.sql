-- Event sign-ups: only through the database functions
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run.
--
-- WHY (second audit, S4)
-- A student could insert their own event_registrations row directly, choosing name_at_signup and
-- email_at_signup freely (officers see those, and "copy emails" gathers them), and skipping the
-- capacity check that register_for_event() does. The self-update policy likewise let a student mark
-- themselves 'self_reported' outside the check-in window that self_report_arrival() enforces.
--
-- WHY THIS IS SAFE
-- The app never writes this table directly — it only reads it. Every write goes through a
-- SECURITY DEFINER function, which runs as the table's owner and is unaffected by these grants:
--   register_for_event()   name and email from the profile; capacity checked
--   cancel_registration()  cancel your own
--   self_report_arrival()  "I'm here", only while check-in is open
--   check_in_attendee(), undo_check_in(), add_walk_in()   officers
-- Reading is unchanged (event_reg_select stays).


begin;

drop policy if exists event_reg_insert      on public.event_registrations;
drop policy if exists event_reg_update_self on public.event_registrations;

revoke insert, update on public.event_registrations from authenticated;

commit;

notify pgrst, 'reload schema';


-- VERIFY — expected: one policy left (event_reg_select, SELECT), and authenticated holding
-- SELECT only.
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'event_registrations'
order by policyname;

select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'event_registrations'
  and grantee in ('anon', 'authenticated')
group by grantee;
