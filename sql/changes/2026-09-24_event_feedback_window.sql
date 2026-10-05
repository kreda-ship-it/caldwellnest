-- Event feedback: officers choose whether to ask, and until when
-- 2026-09-24
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
-- Run AFTER 2026-09-07_events_schema.sql, 2026-09-07_events_rpcs.sql and the view chain ending in
-- 2026-09-07_checkin_window.sql (event_effective_end() must exist).
--
-- WHAT THIS ADDS
--   events.feedback_enabled     officers can turn the rating off for an event (default: on)
--   events.feedback_closes_at   officers can set the deadline; NULL means the default, 7 days after
--                               the event ends — exactly the rule that existed before this file
--   event_feedback_closes()     the one definition of "when does feedback close"
--   event_feedback_windows      a small read-only view: for each event, is feedback open and until when
--   event_feedback_insert       the INSERT policy, now reading the officer's choice
--   get_event_feedback()        adds the rating distribution — still only at 5+ responses
--
-- WHY A SEPARATE VIEW INSTEAD OF ADDING COLUMNS TO visible_events
-- visible_events is `select e.*, ...`, and Postgres expands `e.*` when the view is CREATED, so new
-- columns on events never appear in it until the view is dropped and rebuilt. Rebuilding it here
-- would mean restating its whole definition from the files — and if the live view differs from the
-- files in any way, the rebuild would silently change it. A new, separate view touches nothing that
-- already works.
--
-- WHAT DOES NOT CHANGE
--   * Who may rate: a check-in row (checked_in or walk_in), after the event ends. Registering and
--     not coming still earns no opinion.
--   * One rating per person per event (the unique key), and no UPDATE or DELETE — an editable
--     rating is one an officer can pressure somebody to change. So the comment is sent WITH the
--     rating, in the same insert. (The app used to ask for it afterwards and save it with an
--     UPDATE, which this table has never allowed. Those comments were refused and never arrived.)
--   * Officers never read event_feedback. They read get_event_feedback(), which returns no user id
--     and no average below 5 responses.

begin;

-- ============================================================================
-- 1. The two columns
-- ============================================================================
alter table public.events add column if not exists feedback_enabled   boolean not null default true;
alter table public.events add column if not exists feedback_closes_at timestamptz;

-- A deadline before the event even starts is a typo, not a choice.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_feedback_closes_after_start') then
    alter table public.events
      add constraint events_feedback_closes_after_start
      check (feedback_closes_at is null or feedback_closes_at > starts_at);
  end if;
end $$;


-- ============================================================================
-- 2. When feedback closes — one definition
-- ============================================================================
-- The officer's date, or 7 days after the event's effective end. Immutable: it depends only on
-- its arguments, so it can be used freely in the policy and the view.
create or replace function public.event_feedback_closes(
  p_starts_at timestamptz, p_ends_at timestamptz, p_closes_at timestamptz)
returns timestamptz
language sql
immutable
set search_path to 'public'
as $function$
  select coalesce(p_closes_at, public.event_effective_end(p_starts_at, p_ends_at) + interval '7 days');
$function$;

revoke all on function public.event_feedback_closes(timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.event_feedback_closes(timestamptz, timestamptz, timestamptz) to authenticated;


-- ============================================================================
-- 3. The INSERT policy, now reading the officer's choice
-- ============================================================================
-- Was: checked in, ended, and ended within 7 days. Now: checked in, ended, feedback turned on, and
-- before the deadline (which defaults to the same 7 days).
drop policy if exists event_feedback_insert on public.event_feedback;
create policy event_feedback_insert on public.event_feedback
  as permissive for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.event_registrations r
      join public.events e on e.id = r.event_id
      where r.event_id = event_feedback.event_id
        and r.user_id  = auth.uid()
        and r.status in ('checked_in', 'walk_in')
        and e.feedback_enabled
        and public.event_effective_end(e.starts_at, e.ends_at) <= now()
        and now() < public.event_feedback_closes(e.starts_at, e.ends_at, e.feedback_closes_at)
    )
  );


-- ============================================================================
-- 4. event_feedback_windows — what the app reads to decide whether to ASK
-- ============================================================================
-- security_invoker, so the events RLS applies: a student sees the window only for events they can
-- already see. The policy above still decides what is ACCEPTED; this only decides what is offered.
create or replace view public.event_feedback_windows with (security_invoker = true) as
  select e.id as event_id,
         e.feedback_enabled,
         public.event_feedback_closes(e.starts_at, e.ends_at, e.feedback_closes_at) as feedback_closes_at,
         (e.feedback_enabled
          and e.status = 'published'
          and public.event_effective_end(e.starts_at, e.ends_at) <= now()
          and now() < public.event_feedback_closes(e.starts_at, e.ends_at, e.feedback_closes_at)) as feedback_open
  from public.events e;

grant select on public.event_feedback_windows to authenticated;
revoke truncate, references, trigger on public.event_feedback_windows from authenticated;
revoke all on public.event_feedback_windows from anon;


-- ============================================================================
-- 5. get_event_feedback() — same rules, plus how the ratings are spread
-- ============================================================================
-- The distribution (how many 1s, 2s … 5s) follows the SAME suppression as the average: nothing
-- below 5 responses. With three ratings, "one 2-star" points at a person.
create or replace function public.get_event_feedback(p_event_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_event  public.events%rowtype;
  v_count  integer;
  v_avg    numeric;
  v_notes  jsonb;
  v_dist   jsonb;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if not public.can_act('view_analytics', v_event.org_id) then
    raise exception 'Not authorized to view feedback for this event';
  end if;

  select count(*), round(avg(rating), 2) into v_count, v_avg
    from public.event_feedback where event_id = p_event_id;

  -- Ordered by rating, NOT by time, so the order cannot be lined up against the order people
  -- walked through the door.
  select coalesce(jsonb_agg(c.comment order by c.rating, c.id), '[]'::jsonb) into v_notes
    from public.event_feedback c
   where c.event_id = p_event_id
     and coalesce(trim(c.comment), '') <> '';

  select jsonb_agg((select count(*) from public.event_feedback f
                     where f.event_id = p_event_id and f.rating = s.n) order by s.n)
    into v_dist
    from generate_series(1, 5) as s(n);

  return jsonb_build_object(
    'count',       v_count,
    'avg',         case when v_count >= 5 then v_avg  else null end,
    'dist',        case when v_count >= 5 then v_dist else null end,
    'comments',    v_notes,
    'suppressed',  v_count < 5,
    'enabled',     v_event.feedback_enabled,
    'closes_at',   public.event_feedback_closes(v_event.starts_at, v_event.ends_at, v_event.feedback_closes_at)
  );
end;
$function$;

revoke all on function public.get_event_feedback(bigint) from public, anon;
grant execute on function public.get_event_feedback(bigint) to authenticated;

commit;

-- Supabase's API caches the schema. Without this it rejects the new columns with an error that
-- looks exactly like "the column does not exist".
notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: two rows — feedback_closes_at (timestamp with time zone), feedback_enabled (boolean).
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'events'
  and column_name in ('feedback_enabled', 'feedback_closes_at')
order by column_name;

-- Expected: NO ROWS. Nothing anonymous reaches the new view.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'event_feedback_windows'
  and grantee in ('anon', 'public');

-- Expected: only SELECT for authenticated (no TRUNCATE, REFERENCES or TRIGGER).
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'event_feedback_windows'
order by grantee, privilege_type;

-- Expected: one row; the WITH CHECK text mentions feedback_enabled and event_feedback_closes.
select policyname, with_check
from pg_policies
where schemaname = 'public' and tablename = 'event_feedback' and cmd = 'INSERT';

-- ============================================================================
-- ALSO CHECK, while you are here: has 2026-09-15_org_analytics_and_event_views.sql been run?
-- The console's new Analytics tab reads get_org_analytics(), and events now record views through
-- record_event_view(). Expected: three rows. If any is missing, run that file too.
-- ============================================================================
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('get_org_analytics', 'record_event_view', 'purge_event_views')
order by proname;
