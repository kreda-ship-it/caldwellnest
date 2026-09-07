-- One place that answers "has this ended", and a view whose WHERE is only about permission
-- 2026-09-07  ·  Session E2 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
-- Run AFTER 2026-09-07_events_schema.sql and 2026-09-07_events_rpcs.sql.
--
--
-- THE RULE THIS FILE ESTABLISHES
--   A view's WHERE clause carries only facts about PUBLICATION and PERMISSION.
--   Anything that is a presentation choice becomes a computed COLUMN, so that no
--   calling surface ever writes its own comparison.
--
-- The difference is not stylistic. A WHERE clause decides what a caller may not have; a
-- computed column decides what a caller does with what it has. Put a presentation choice in
-- the WHERE and every surface that needs the other case has to go around the view — which is
-- exactly how book_listings ended up bypassing visible_listings.
--
--
-- WHY EVENTS DIFFER FROM LISTINGS, WHICH IS THE WHOLE REASON THIS FILE EXISTS
-- visible_listings excludes expired listings, and that is right: a past listing is GONE. The
-- sofa sold. There is no surface anywhere that wants it.
--
-- A past event is not gone. It is a SURFACE. It holds the recap photos, it is what makes an
-- organization look alive to a student deciding whether to join, it is the row a rating hangs
-- off, and it is the attendance record an advisor asks about six months later. The Past chip
-- in §4.1 exists precisely to show it.
--
-- So the same view has to serve "what is coming up" and "what already happened", and the only
-- way to do that without a second query path is to answer the question as a column.
--
--
-- WHAT CHANGED FROM THE FIRST VERSION, AND WHY status IS NOT IN THE WHERE
-- The first visible_events read:
--     where status = 'published' and members_only = false
--
-- Both halves are now gone, for different reasons.
--
-- `status = 'published'` was restating a rule RLS already enforces. events_select says a
-- student may read a row only when it is published and not members-only, OR they can manage
-- its events, OR they are registered for it. The view runs WITH (security_invoker = true) —
-- confirmed on in the catalog, not assumed — so those policies reach the caller. Repeating
-- the status test in the WHERE created a second copy of a rule that already existed, in a
-- place where the two could drift apart.
--
-- Removing it also fixes something concrete: a cancelled event is now IN the view, so §6's
-- promise — "still reachable by its registrants, with the reason" — is kept by the view
-- rather than by a separate query that bypasses it. And an officer sees their own drafts
-- through the view, because RLS lets them and nothing else was stopping it. That is what
-- makes it possible for the console to stop computing pastness in JavaScript.
--
-- `members_only = false` goes for the same reason: RLS is where that belongs when the gating
-- is built. Today no members-only event exists and the policy already refuses one, so nothing
-- changes; when the gating lands there is one place to change rather than two.
--
-- What IS in the WHERE is organizations.is_active — a fact about whether the organization is
-- publishing at all, which is a publication fact and not a presentation choice.


begin;

-- ============================================================================
-- 1. The three-hour fallback, in ONE place
-- ============================================================================
-- It was written in three: this view, self_report_arrival(), and EVENT_ASSUMED_HOURS in
-- js/orgs.js. Three copies of a number is three chances to change two of them.
--
-- WHAT THE THREE HOURS IS, stated so nobody adjusts it thinking it is a default duration.
-- It is not a guess at how long events last, and it is not a suggestion made to the officer —
-- the form suggests nothing and leaves the field blank. It is a FORGIVING FALLBACK: when an
-- officer did not say when the event ends, the feed keeps showing it for three hours rather
-- than dropping it the moment it starts. Erring long is deliberate. An event that vanishes
-- from the feed while people are still walking into it is a worse failure than one that
-- lingers an hour past the end.
create or replace function public.event_effective_end(
  p_starts_at timestamptz, p_ends_at timestamptz)
returns timestamptz
language sql
immutable
parallel safe
as $function$
  select coalesce(p_ends_at, p_starts_at + interval '3 hours');
$function$;

revoke all on function public.event_effective_end(timestamptz, timestamptz) from public, anon;
grant execute on function public.event_effective_end(timestamptz, timestamptz) to authenticated;


-- ============================================================================
-- 2. visible_events
-- ============================================================================
-- Dropped and recreated rather than CREATE OR REPLACE: the FROM clause gains a join and the
-- column list gains two entries, and replace-in-place has rules about both that are easier to
-- fall foul of than to remember. Dropping loses the grants, so they are restated below.
drop view if exists public.visible_events;

create view public.visible_events
with (security_invoker = true) as
  select e.*,
         public.event_effective_end(e.starts_at, e.ends_at) as effective_ends_at,
         public.event_effective_end(e.starts_at, e.ends_at) <= now() as has_ended,
         (e.status = 'published'
          and public.event_effective_end(e.starts_at, e.ends_at) > now()) as is_browsable
  from public.events e
  join public.organizations o on o.id = e.org_id
  where o.is_active = true;

-- HOW THE THREE COLUMNS ARE MEANT TO BE USED, so that no surface invents a fourth way:
--   is_browsable  -> browse surfaces. The student feed, events search, an org page's
--                    "upcoming". Not status, not a time expression. Just this.
--   has_ended     -> past surfaces. The Past chip, the console's past split, an org page's
--                    history, the Going tab's past section.
--   status        -> detail, Recap, the door, registration. These are ALLOWED to show a
--                    cancelled event and must branch on it directly.
-- If a surface ever writes now() or compares to effective_ends_at itself, that is the thing
-- this file removed and it has grown back.

comment on view public.visible_events is
  'Events visible to the caller under RLS. WHERE carries publication facts only; pastness and browsability are computed columns so no caller writes its own comparison. See sql/2026-09-07_events_visibility_rule.sql.';

grant select on public.visible_events to authenticated;
revoke truncate, references, trigger on public.visible_events from authenticated;
revoke all on public.visible_events from anon;


-- ============================================================================
-- 3. self_report_arrival() uses the same function
-- ============================================================================
-- Only the two coalesce lines change. Reproduced whole rather than patched, because a
-- function is stored as one body and a half-remembered patch is how two versions of it end up
-- in the folder.
--
-- checkin_closes_at now derives from the effective end rather than from ends_at, so an event
-- with no end time still has a working door instead of one that closes an hour after it began.
create or replace function public.self_report_arrival(p_event_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event  public.events%rowtype;
  v_opens  timestamptz;
  v_closes timestamptz;
  v_status text;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if v_event.status <> 'published' then raise exception 'This event is not open'; end if;

  v_opens  := coalesce(v_event.checkin_opens_at,  v_event.starts_at - interval '1 hour');
  v_closes := coalesce(v_event.checkin_closes_at,
                       public.event_effective_end(v_event.starts_at, v_event.ends_at)
                       + interval '1 hour');
  if now() < v_opens or now() > v_closes then
    raise exception 'Check-in is not open for this event';
  end if;

  select status into v_status
    from public.event_registrations
   where event_id = p_event_id and user_id = auth.uid();

  if v_status is null or v_status = 'cancelled' then
    perform public.register_for_event(p_event_id);   -- raises if full or closed
  elsif v_status in ('checked_in','walk_in') then
    return 'checked_in';                             -- already in, tapping again is harmless
  end if;

  if v_event.trust_self_checkin then
    update public.event_registrations
       set status = 'checked_in', check_in_method = 'self_auto',
           self_reported_at = now(), checked_in_at = now()
     where event_id = p_event_id and user_id = auth.uid();
    return 'checked_in';
  else
    update public.event_registrations
       set status = 'self_reported', self_reported_at = now()
     where event_id = p_event_id and user_id = auth.uid();
    return 'self_reported';
  end if;
end;
$function$;

revoke all on function public.self_report_arrival(bigint) from public, anon;
grant execute on function public.self_report_arrival(bigint) to authenticated;


-- ============================================================================
-- 4. 'completed' is dropped from the status constraint
-- ============================================================================
-- Confirmed before running: `select count(*) from events where status = 'completed'` returned
-- 0, and the codebase contains zero reads and zero writes of the value. It has never been
-- anything but a permitted string.
--
-- The argument is the one change_listing_status already makes about 'expired': a stored
-- completion flag is a second, drift-prone source of truth for something the clock already
-- answers, and has_ended now answers it in one place. A row could otherwise claim to be
-- completed while its own timestamps disagreed.
--
-- This cannot break the deployed site. A check constraint is evaluated on write only, so
-- removing a permitted value affects nothing that reads, and nothing writes it. Dropped and
-- recreated inside this transaction, so there is no moment where status is unchecked.
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check
  check (status in ('draft','published','cancelled'));

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- 1. security_invoker still on, and the three columns present.
select array_to_string(c.reloptions, ',') as view_options,
       (select string_agg(column_name, ', ' order by ordinal_position)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'visible_events'
          and column_name in ('effective_ends_at','has_ended','is_browsable')) as computed_columns
from pg_class c
where c.relname = 'visible_events' and c.relnamespace = 'public'::regnamespace;

-- 2. The constraint no longer permits 'completed'.
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.events'::regclass and conname = 'events_status_check';

-- 3. Sanity: every event, and what the view now says about it. A draft should show
--    is_browsable = false; a cancelled event should be PRESENT with is_browsable = false.
select id, title, status, has_ended, is_browsable, effective_ends_at
from public.visible_events order by starts_at desc;
