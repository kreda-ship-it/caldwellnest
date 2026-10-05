-- Derive `school` on the events tables instead of trusting the client
-- 2026-09-07  ·  Session E2 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
-- Run AFTER 2026-09-07_events_schema.sql.
--
--
-- WHY
-- E2 step 1 read ocCreatePost() and found it sending `school` with the comment "overwritten
-- by the trigger". The trigger is real — org_posts_set_school, BEFORE INSERT OR UPDATE OF
-- org_id — and the events tables have nothing equivalent. So `school` on events would be
-- whatever the browser happened to send.
--
-- That matters more than it looks, because of a fact recorded in
-- 2026-09-04_capture_table_definitions.sql (observation 7): **there is no foreign key
-- anywhere on `school`.** organizations.school, listings.school, profiles.school and the
-- rest are all free text against a schools.slug that is UNIQUE and never referenced. Nothing
-- in the database stops a typo creating rows in a school that does not exist.
--
-- Combined, those two facts mean a browser sending school='Caldwell' instead of 'caldwell'
-- would write a row that every feed filter silently skips. Not an error — an event that
-- posts successfully and appears nowhere, which is the hardest kind of bug to report.
--
-- Deriving it removes the whole class. The org_id is a real foreign key, so the school
-- reached through it is real by construction.
--
--
-- WHY THREE FUNCTIONS AND NOT ONE
-- events derives from org_id. event_media and event_feedback have no org_id — they hang off
-- event_id — so they derive through the event. Same idea, different join, and a single
-- function trying to serve both would have to guess which column it was looking at.


begin;

-- ---------- events: school comes from the organization ----------
create or replace function public.set_event_school()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  select o.school into new.school from public.organizations o where o.id = new.org_id;
  return new;
end;
$function$;

drop trigger if exists events_set_school on public.events;
create trigger events_set_school
  before insert or update of org_id on public.events
  for each row execute function public.set_event_school();


-- ---------- event_media and event_feedback: school comes from the event ----------
create or replace function public.set_event_child_school()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  select e.school into new.school from public.events e where e.id = new.event_id;
  return new;
end;
$function$;

drop trigger if exists event_media_set_school on public.event_media;
create trigger event_media_set_school
  before insert or update of event_id on public.event_media
  for each row execute function public.set_event_child_school();

drop trigger if exists event_feedback_set_school on public.event_feedback;
create trigger event_feedback_set_school
  before insert or update of event_id on public.event_feedback
  for each row execute function public.set_event_child_school();


-- ---------- repair anything already written ----------
-- Only the verification file has ever inserted into these tables, and it rolls back, so this
-- should touch zero rows. It is here because "should" is not "did", and a wrong school is
-- invisible rather than loud.
update public.events e
   set school = o.school
  from public.organizations o
 where o.id = e.org_id and e.school is distinct from o.school;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- Expected: three triggers, one per table.
select c.relname as table_name, t.tgname
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relname in ('events','event_media','event_feedback')
  and not t.tgisinternal
order by c.relname, t.tgname;

-- Expected: zero rows. Any row here is an event whose school disagrees with its own
-- organization, which means it is invisible in the feed of the school it belongs to.
select e.id, e.title, e.school as event_school, o.school as org_school
from public.events e join public.organizations o on o.id = e.org_id
where e.school is distinct from o.school;
