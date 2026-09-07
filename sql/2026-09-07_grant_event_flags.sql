-- Hand the events flags to the people who already administer the school
-- 2026-09-07  ·  Session E2 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
--
--
-- WHY THIS IS NEEDED, AND WHY IT WAS EASY TO MISS
-- 2026-09-05_flag_set.sql added the columns like this:
--
--     add column if not exists can_manage_events boolean not null default false;
--
-- `default false` is right — a new permission must not appear in existing hands by accident.
-- But it means EVERY membership written before that date holds false, including the root
-- administrator created by the bootstrap on 2026-09-04.
--
-- So the console's Events tab, gated on can_act('manage_events', org_id), was correctly
-- hidden from the only person who could have used it. The feature worked; nobody held the key.
--
-- The plan says "can_manage_events and can_check_in are frozen into the flag set and reach
-- nothing yet", which reads as "no code reads them". It is also true in a second sense that
-- was not noticed: nobody HOLDS them. Freezing a flag into the schema and granting it to
-- somebody are two separate acts, and only the first one had happened.
--
--
-- WHO GETS THEM HERE, AND WHY ONLY THEM
-- Only active officers who ALREADY hold can_manage_admins — that is, the people who can
-- already grant any permission to anyone, so this hands out nothing they could not have
-- handed themselves. On this database that is the single root administrator.
--
-- Club officers are deliberately NOT included. Whether the president of the Investment Club
-- may create events is a decision for whoever administers the school, made one club at a
-- time in the console's Members panel. A migration that granted it to every officer would be
-- making that decision for them, silently, for every club at once.
--
--
-- THE FLAG GUARD LETS THIS THROUGH, AND THAT IS DELIBERATE
-- guard_org_membership_flags() refuses a flag change from anyone without can_manage_admins.
-- Run from the SQL editor there is no JWT, so the guard's break-glass branch returns
-- immediately. That branch exists precisely so the database can set up its own first
-- administrator; this is the same situation.


begin;

update public.org_memberships
   set can_manage_events = true,
       can_check_in      = true
 where status = 'active'
   and role = 'officer'
   and can_manage_admins = true
   and (can_manage_events = false or can_check_in = false);

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- Every active officer and what they now hold. Expect the root administrator to show true
-- for both events columns, and any club officer to show false until you grant them.
select o.name        as organization,
       o.type,
       m.title,
       m.can_manage_members,
       m.can_manage_admins,
       m.can_manage_events,
       m.can_check_in
from public.org_memberships m
join public.organizations o on o.id = m.org_id
where m.status = 'active' and m.role = 'officer'
order by o.type, o.name;
