-- Give the root administrator the permissions the bootstrap intended
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
-- WHAT THE FIRST VERSION OF THIS FILE GOT WRONG
-- It targeted officers holding can_manage_admins, on the reasoning that they could already
-- grant themselves anything. It updated ZERO rows, and the reason matters more than the fix:
--
--     organization        type    title    manage_members  manage_admins  events  check_in
--     Caldwell University school  Officer  true            FALSE          false   false
--
-- The root administrator does not hold can_manage_admins. That is not a small gap. The flag
-- guard refuses every flag change from someone without it, so that account cannot make anyone
-- an officer who can DO anything — it can add plain members and nothing else. The person
-- administering the university could not have handed out the events flag even after this file
-- granted it to them.
--
-- The row was not created by the bootstrap in 2026-09-04_org_hierarchy.sql, which grants the
-- full set, nor by orgAddSelf(), which grants the same full set with the title
-- 'Administrator'. It has title 'Officer' and one flag, which is the shape orgAddOfficer()
-- produces — the ordinary "add somebody to a club" path, used on the root organization.
--
-- Nor is the account a super admin: orgCanAct() returns true immediately for one, so the
-- Events tab would have appeared regardless. It is exactly what the self-removal guard's
-- header describes — an ordinary student who happens to administer the university.
--
--
-- WHO GETS THEM NOW
-- Every active officer of a ROOT organization: type 'school', no parent. That is the
-- administrator by construction, because can_act() walks parent_id upward and a root row is
-- the one that reaches everything below it. On this database it is one person.
--
-- They receive the full set the bootstrap always intended, not just the two events flags.
-- Granting can_manage_admins is the substantive part and it should be read deliberately:
-- afterwards that account can grant any permission to anyone, including making a club
-- president able to create events. That is the design — §2.9 accepts it as the definition of
-- an administrator — and without it the org system has no working way to delegate anything.
--
-- Club officers are still deliberately excluded. Whether the president of the Investment Club
-- may create events is a decision for whoever administers the school, made one club at a time
-- in the console's Members panel. A migration granting it to every officer would make that
-- decision for them, silently, for every club at once.
--
-- `title` is left alone. The bootstrap would have written 'Administrator'; changing what
-- somebody is called is a different act from changing what they may do, and only the second
-- one is this file's business.
--
--
-- THE FLAG GUARD LETS THIS THROUGH, AND THAT IS DELIBERATE
-- guard_org_membership_flags() refuses a flag change from anyone without can_manage_admins.
-- Run from the SQL editor there is no JWT, so the guard's break-glass branch returns
-- immediately. That branch exists precisely so the database can set up its own first
-- administrator, and this is that situation: the bootstrap that should have created this row
-- correctly never ran.


begin;

update public.org_memberships m
   set can_post              = true,
       can_manage_members    = true,
       can_view_analytics    = true,
       can_message           = true,
       can_create_child_orgs = true,
       can_manage_admins     = true,
       can_manage_events     = true,
       can_check_in          = true
  from public.organizations o
 where o.id = m.org_id
   and o.parent_id is null
   and o.type = 'school'
   and m.status = 'active'
   and m.role = 'officer';

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
