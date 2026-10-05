-- How many people are going, without showing who
-- 2026-09-07  ·  Session E3 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
-- Run AFTER 2026-09-07_events_visibility_rule.sql.
--
--
-- THE PROBLEM THIS SOLVES
-- §4.1 puts one social-proof line on every event card: "42 going · 18 spots left". A student
-- cannot produce that number, and should not be able to.
--
-- event_reg_select lets a student read their OWN registration and nothing else. That is
-- right: the list of who is going to what, across a campus, is exactly the kind of thing
-- nobody should be able to assemble by reading rows. So a client-side count returns 1 — their
-- own — or 0, and "1 going" on a full club fair is worse than no number at all.
--
-- The answer is not to loosen the policy. It is to expose the AGGREGATE without the rows,
-- which is the same shape as get_event_feedback(): a SECURITY DEFINER function that reads
-- what the caller cannot and returns a number carrying no identity.
--
-- WHY THIS ONE IS NOT GUARDED BY can_act()
-- get_event_feedback() is guarded, because comments are the org's private business. A count
-- of attendees is not: it is printed on the poster, it is the thing the event is advertising,
-- and every student is being shown it deliberately. Guarding it would mean no student could
-- see the line §4.1 is written around.
--
-- What it must never do is leak WHO. It returns integer. There is no parameter that could
-- make it return a row, and no version of it that takes a user id.


begin;

create or replace function public.event_going_count(p_event_id bigint)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- 'cancelled' is excluded, so a student who changes their mind frees the seat they took.
  -- Everything else counts: someone who has already walked through the door is still going.
  select count(*)::int
  from public.event_registrations r
  where r.event_id = p_event_id
    and r.status in ('registered','self_reported','checked_in','walk_in');
$function$;

revoke all on function public.event_going_count(bigint) from public, anon;
grant execute on function public.event_going_count(bigint) to authenticated;


-- ============================================================================
-- visible_events gains the two numbers a card shows
-- ============================================================================
-- Recreated whole rather than patched, for the reason the last version gives: a view is
-- stored as one definition and a half-remembered patch is how two of them end up in sql/.
--
-- seats_left is null when capacity is null, which is what "unlimited" means. A card must
-- therefore check for null rather than treating 0 and null alike — one means full and the
-- other means there is no limit, and they are opposites.
drop view if exists public.visible_events;

create view public.visible_events
with (security_invoker = true) as
  select e.*,
         public.event_effective_end(e.starts_at, e.ends_at) as effective_ends_at,
         public.event_effective_end(e.starts_at, e.ends_at) <= now() as has_ended,
         (e.status = 'published'
          and public.event_effective_end(e.starts_at, e.ends_at) > now()) as is_browsable,
         public.event_going_count(e.id) as going_count,
         case when e.capacity is null then null
              else greatest(0, e.capacity - public.event_going_count(e.id)) end as seats_left
  from public.events e
  join public.organizations o on o.id = e.org_id
  where o.is_active = true;

comment on view public.visible_events is
  'Events visible to the caller under RLS. WHERE carries publication facts only; pastness, browsability and the attendance aggregate are computed columns so no caller writes its own comparison and no caller needs to read registration rows. See sql/2026-09-07_events_visibility_rule.sql.';

grant select on public.visible_events to authenticated;
revoke truncate, references, trigger on public.visible_events from authenticated;
revoke all on public.visible_events from anon;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- Expect the five computed columns, and security_invoker still on.
select array_to_string(c.reloptions, ',') as view_options,
       (select string_agg(column_name, ', ' order by ordinal_position)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'visible_events'
          and column_name in ('effective_ends_at','has_ended','is_browsable',
                              'going_count','seats_left')) as computed_columns
from pg_class c
where c.relname = 'visible_events' and c.relnamespace = 'public'::regnamespace;

-- Every event and its numbers. seats_left NULL means unlimited, not full.
select id, title, status, is_browsable, going_count, capacity, seats_left
from public.visible_events order by starts_at desc;
