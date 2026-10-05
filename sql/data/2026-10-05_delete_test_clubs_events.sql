-- Pre-launch cleanup: delete every test club, department and office, and every test event — keep the school
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor, in this order:
--   0. Back up first: nestrel-backups -> Actions -> Weekly database backup -> Run workflow.
--   1. PART 1 below on its own: a READ-ONLY preview of the organizations.
--   2. PART 2 below on its own: a READ-ONLY preview of the events.
--   3. PART 3 below on its own: the delete, then a count of what is left.
--   4. Storage -> event-media -> the "..." menu on the bucket -> Empty bucket. NOT "Delete bucket":
--      the bucket and its rules must stay for future event photos. It holds event photos only
--      (js/orgs.js is the only thing that writes there), so once every event is gone, all of it is unused.
--   5. Club logos and covers live in listing-photos, beside profile pictures: leave them to the
--      Left-over photos tool on Platform health once it is live. Never empty that bucket.
--
-- WHAT IT DELETES (Kal, 2026-10-05: events and clubs are tests, and "all departments were for test"):
-- every organization that is not a school — departments, offices and clubs — and every event,
-- created before 6 October 2026 (Eastern). The cutoff, not "everything", is what makes this file safe
-- to keep: anything made after it is never on the list, so running it again later deletes nothing new.
--
-- WHAT IT KEEPS: the school row (Caldwell University) and its memberships. "Add a department" in the
-- admin dashboard needs a school to put it under (js/orgs.js, _aoPaintAdd), and only hand-written
-- SQL can make a school again (the BOOTSTRAP in sql/changes/2026-09-04_org_hierarchy.sql).
-- Accounts are NOT deleted here, and demo@caldwell.edu stays (Kal, 2026-10-05).
--
-- GOES WITH THEM AUTOMATICALLY (on delete cascade): memberships and officer roles, followers, club
-- posts, poll options and votes, event sign-ups and check-ins, event photo rows, feedback, view counts.
-- BY HAND BELOW: saved events. favorites.item_id is not a foreign key, so nothing cleans those up.
--
-- WHY THIS ORDER
-- Events go before organizations: events.org_id has no ON DELETE, so a club that still has events
-- refuses to go. All organizations go in ONE statement: organizations.parent_id is NO ACTION, which
-- is checked at the end of the statement, so a department and its clubs can leave together. (The
-- teardown in sql/data/2026-09-05_seed_dev_org.sql deletes one at a time, which is why it needs
-- the club first.) The membership guard (guard_org_self_removal) lets the SQL Editor through.
--
-- IF PART 3 STOPS WITH AN ERROR, nothing was deleted: begin ... commit is all or nothing.


-- ============================================================================
-- PART 1 — preview the organizations (read-only)
-- ============================================================================

select case when o.type <> 'school' and o.created_at < timestamptz '2026-10-06 00:00:00-04'
            then 'WILL BE DELETED' else 'stays' end                             as what_happens,
       o.id, o.type, o.name, p.name                                             as belongs_to,
       (select count(*) from public.org_memberships m where m.org_id = o.id)    as members,
       (select count(*) from public.org_follows f     where f.org_id = o.id)    as followers,
       (select count(*) from public.org_posts op      where op.org_id = o.id)   as posts,
       (select count(*) from public.events e          where e.org_id = o.id)    as events
from public.organizations o
left join public.organizations p on p.id = o.parent_id
order by what_happens desc,
         case o.type when 'school' then 1 when 'department' then 2 when 'office' then 3 else 4 end,
         o.name;


-- ============================================================================
-- PART 2 — preview the events (read-only)
-- ============================================================================

select case when e.created_at < timestamptz '2026-10-06 00:00:00-04'
              or e.org_id in (select id from public.organizations
                              where type <> 'school' and created_at < timestamptz '2026-10-06 00:00:00-04')
            then 'WILL BE DELETED' else 'stays' end                                     as what_happens,
       e.id, e.title, o.name                                                            as club,
       e.starts_at::date                                                                as event_date,
       e.status,
       (select count(*) from public.event_registrations r where r.event_id = e.id)       as signups,
       (select count(*) from public.event_media m        where m.event_id = e.id)       as photos,
       (select count(*) from public.favorites s where s.item_type = 'event' and s.item_id = e.id) as saves
from public.events e
join public.organizations o on o.id = e.org_id
order by what_happens desc, e.starts_at;


-- ============================================================================
-- PART 3 — the delete (run on its own, after looking at PARTS 1 and 2)
-- ============================================================================

begin;

delete from public.events
where created_at < timestamptz '2026-10-06 00:00:00-04'
   or org_id in (select id from public.organizations
                 where type <> 'school' and created_at < timestamptz '2026-10-06 00:00:00-04');

-- Saved events that now point at nothing (and any left from events deleted before today).
delete from public.favorites f
where f.item_type = 'event'
  and not exists (select 1 from public.events e where e.id = f.item_id);

delete from public.organizations
where type <> 'school' and created_at < timestamptz '2026-10-06 00:00:00-04';

commit;

-- What is left. The first three should be 0. The last two show what remains: the school, and
-- anything made after the cutoff.
select
  (select count(*) from public.organizations
    where type <> 'school' and created_at < timestamptz '2026-10-06 00:00:00-04')            as test_orgs_left,
  (select count(*) from public.events
    where created_at < timestamptz '2026-10-06 00:00:00-04')                                 as test_events_left,
  (select count(*) from public.favorites f
    where f.item_type = 'event' and not exists (select 1 from public.events e where e.id = f.item_id)) as saved_events_pointing_nowhere,
  (select string_agg(type || ': ' || name, ', ' order by type) from public.organizations)    as organizations_left,
  (select count(*) from public.events)                                                       as events_left_in_total;
