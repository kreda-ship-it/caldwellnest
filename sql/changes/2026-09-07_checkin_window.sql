-- The check-in window, in one place, as a column
-- 2026-09-07  ·  Session E5 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
-- Run AFTER 2026-09-07_event_going_count.sql.
--
--
-- WHY THIS IS NOT A JAVASCRIPT `if`
-- The student's "I'm here" button appears only while the door is open. That is a comparison
-- against now(), and sql/README.md now carries the rule this file is obeying: a view's WHERE
-- is a permission statement, presentation belongs in computed columns, and no calling surface
-- writes its own comparison.
--
-- Writing it in the browser instead would put the window rule in THREE places — the view, the
-- RPC that enforces it, and the button that offers it — and the browser's copy would be the
-- one running on a phone whose clock is wrong. The RPC would refuse and the student would see
-- a button that does nothing, which is the worst of the three failures because it looks like
-- the app is broken rather than like the door is shut.
--
-- The defaults are the same ones self_report_arrival() already used: open an hour before the
-- start, shut an hour after the EFFECTIVE end. Effective, not ends_at — an event with no end
-- time would otherwise have a door that closed an hour after it began.


begin;

create or replace function public.event_checkin_open(
  p_starts_at        timestamptz,
  p_ends_at          timestamptz,
  p_checkin_opens_at timestamptz,
  p_checkin_closes_at timestamptz)
returns boolean
language sql
stable
parallel safe
as $function$
  select now() >= coalesce(p_checkin_opens_at, p_starts_at - interval '1 hour')
     and now() <= coalesce(p_checkin_closes_at,
                           public.event_effective_end(p_starts_at, p_ends_at) + interval '1 hour');
$function$;

revoke all on function public.event_checkin_open(timestamptz, timestamptz, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.event_checkin_open(timestamptz, timestamptz, timestamptz, timestamptz)
  to authenticated;


-- ============================================================================
-- visible_events gains checkin_is_open
-- ============================================================================
-- Recreated whole, for the reason every version of this view gives: it is stored as one
-- definition and a half-remembered patch is how two of them end up in sql/.
--
-- The column ANDs in `status = 'published'`, because a draft or a cancelled event has no door
-- however favourably its clock reads.
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
              else greatest(0, e.capacity - public.event_going_count(e.id)) end as seats_left,
         (e.status = 'published'
          and public.event_checkin_open(e.starts_at, e.ends_at,
                                        e.checkin_opens_at, e.checkin_closes_at)) as checkin_is_open
  from public.events e
  join public.organizations o on o.id = e.org_id
  where o.is_active = true;

comment on view public.visible_events is
  'Events visible to the caller under RLS. WHERE carries publication facts only; pastness, browsability, the attendance aggregate and the check-in window are computed columns so no caller writes its own comparison. See sql/2026-09-07_events_visibility_rule.sql.';

grant select on public.visible_events to authenticated;
revoke truncate, references, trigger on public.visible_events from authenticated;
revoke all on public.visible_events from anon;


-- ============================================================================
-- self_report_arrival() uses the same function
-- ============================================================================
-- Reproduced whole rather than patched. Only the window check changes: it was two coalesce
-- expressions written inline, which is the second copy the column above exists to retire.
create or replace function public.self_report_arrival(p_event_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event  public.events%rowtype;
  v_status text;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if v_event.status <> 'published' then raise exception 'This event is not open'; end if;

  if not public.event_checkin_open(v_event.starts_at, v_event.ends_at,
                                   v_event.checkin_opens_at, v_event.checkin_closes_at) then
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

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- Expect all six computed columns.
select (select string_agg(column_name, ', ' order by ordinal_position)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'visible_events'
          and column_name in ('effective_ends_at','has_ended','is_browsable',
                              'going_count','seats_left','checkin_is_open')) as computed_columns,
       array_to_string(c.reloptions, ',') as view_options
from pg_class c
where c.relname = 'visible_events' and c.relnamespace = 'public'::regnamespace;

-- Every event and whether its door is open right now.
select id, title, status, starts_at, is_browsable, checkin_is_open
from public.visible_events order by starts_at desc;
