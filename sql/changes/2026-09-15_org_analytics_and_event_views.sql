-- Organization analytics, and event view tracking under Kal's privacy rules
-- 2026-09-15
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
-- Run AFTER 2026-09-07_events_rpcs.sql and 2026-09-06_org_public_views.sql.
-- Then run 2026-09-15_verify_org_analytics.sql, which proves the privacy rules as real students.
--
--
-- WHAT THIS ADDS
--   event_views            one row per (event, student), written the first time a student opens it
--   event_view_totals      what survives of those rows once the retention window passes: a number
--   record_event_view()    the ONLY way a view is ever written, and where the rules are enforced
--   purge_event_views()    turns rows past the window into totals; run nightly by pg_cron
--   get_org_analytics()    every number the console Analytics tab shows, as counts and nothing else
--   org_follower_counts()  follower totals for the admin Organizations page, suspended clubs included
--
--
-- THE PRIVACY RULES. Decided by Kal on 2026-09-14, enforced HERE and not in the app, because the
-- app runs in a browser the student controls and anything decided there can be undone there.
--
--   1. A view is a student OPENING an event. A card scrolling past a feed is not a view.
--
--   2. A view is linked to the student only so that one student is counted once per event.
--      Nobody can read that link: event_views has row level security on and NO policies, no role
--      the app uses holds any grant on it, and every function here returns numbers — none takes
--      or returns a user id.
--
--   3. The club's own officers are not counted. They open their own events constantly while
--      managing them, and those opens would inflate the number they are trying to learn from.
--
--   4. 30 days after an event ends, the link between students and that event is erased and only
--      the total is kept. purge_event_views() does it, scheduled nightly at the bottom of this
--      file. A consequence worth knowing: once individual rows are gone, "how many DIFFERENT
--      students did this club reach all semester" cannot be rebuilt, so the Analytics tab shows
--      views per event and never a semester-wide reach figure.
--
--      Views that arrive more than 30 days after an event ended are not recorded at all. By then
--      the students who viewed it earlier have been erased, so a new row could not be checked
--      against them and a returning student would be counted twice.
--
--
-- WHY get_org_analytics() COUNTS ATTENDANCE ITSELF RATHER THAN LETTING THE APP READ ROWS
-- event_registrations is readable by officers who hold manage_events or check_in, but Analytics is
-- gated on view_analytics, and those are different people: a treasurer may be allowed to see how the
-- club is doing without being able to read a list of who registered. So the function reads the rows
-- and returns counts, the same shape as event_going_count() and get_event_feedback().
--
--
-- WHAT "CAME" MEANS, AND THE WALK-IN TRAP
-- event_registrations.status is one of registered, self_reported, checked_in, walk_in, cancelled.
--
--   checked_in     confirmed arrival (officer tap, or self check-in on an event that trusts it)
--   self_reported  the student tapped "I'm here" on an event that does NOT trust self check-in.
--                  Unconfirmed. Returned as its own count, so it is never silently called
--                  attendance and never silently called a no-show.
--   walk_in        NOT always "came without an RSVP". add_walk_in() looks the person up by email,
--                  and when they had already registered it puts walk_in on THEIR EXISTING ROW.
--
-- The two kinds of walk_in are told apart by time. A genuinely new walk-in row is inserted and
-- checked in by one statement, so created_at = checked_in_at exactly (now() is fixed for the
-- transaction). A registrant who arrived through the walk-in flow registered earlier, so
-- created_at < checked_in_at. Counting every walk_in as a walk-in would turn real RSVPs who showed
-- up into no-shows.
--
-- Known edge, accepted: a student who registered, CANCELLED, then arrived via the walk-in flow
-- lands on their old row and is counted as an RSVP who came. Nothing on the row records that the
-- cancellation came first.


begin;

-- ============================================================================
-- 1. Storage
-- ============================================================================
create table if not exists public.event_views (
  event_id        bigint      not null references public.events(id)   on delete cascade,
  user_id         uuid        not null references public.profiles(id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  -- One row per student per event. A second open is a no-op, not a second view.
  primary key (event_id, user_id)
);

create table if not exists public.event_view_totals (
  event_id   bigint      primary key references public.events(id) on delete cascade,
  views      integer     not null default 0 check (views >= 0),
  updated_at timestamptz not null default now()
);

-- RLS on, and deliberately NO policies. With RLS on and nothing allowing a read, every read and
-- write by an app role is refused. The functions below are SECURITY DEFINER and are the only door.
alter table public.event_views       enable row level security;
alter table public.event_view_totals enable row level security;


-- ============================================================================
-- 2. Recording a view
-- ============================================================================
-- Returns nothing, in every case, on purpose. A function that answered "recorded" or "not
-- recorded" would let a student probe which events exist and whether they count as an officer.
create or replace function public.record_event_view(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event public.events%rowtype;
begin
  if auth.uid() is null then return; end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then return; end if;

  -- Only an event the student could legitimately be looking at.
  if v_event.status not in ('published', 'completed') then return; end if;
  if v_event.members_only and not public.is_org_member(v_event.org_id) then return; end if;

  -- Rule 3: the club's own officers. can_act() covers anyone who manages this club's events,
  -- including from a department or school above it; the membership check covers an officer of
  -- this club who holds no events flag, a treasurer say.
  if public.can_act('manage_events', v_event.org_id)
     or exists (select 1 from public.org_memberships m
                where m.org_id = v_event.org_id and m.user_id = auth.uid()
                  and m.role = 'officer' and m.status = 'active') then
    return;
  end if;

  -- Rule 4: past the retention window nothing new is recorded. See the header.
  if public.event_effective_end(v_event.starts_at, v_event.ends_at) < now() - interval '30 days' then
    return;
  end if;

  insert into public.event_views (event_id, user_id)
  values (p_event_id, auth.uid())
  on conflict (event_id, user_id) do nothing;
end;
$function$;


-- ============================================================================
-- 3. Erasing, 30 days after an event ends
-- ============================================================================
-- The delete and the move into totals are ONE statement, so there is no moment where a view has
-- been erased but not yet counted. Returns how many events had views folded into their total.
create or replace function public.purge_event_views()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_events integer;
begin
  with gone as (
    delete from public.event_views v
    using public.events e
    where e.id = v.event_id
      and public.event_effective_end(e.starts_at, e.ends_at) < now() - interval '30 days'
    returning v.event_id
  ), counted as (
    select event_id, count(*)::int as n from gone group by event_id
  )
  insert into public.event_view_totals as t (event_id, views, updated_at)
  select event_id, n, now() from counted
  on conflict (event_id) do update
    set views = t.views + excluded.views, updated_at = now();

  get diagnostics v_events = row_count;
  return v_events;
end;
$function$;


-- ============================================================================
-- 4. Everything the Analytics tab shows
-- ============================================================================
-- p_since: the start of the period. NULL means all time. The app passes the start of the
-- semester, or now() - 30 days.
--
-- Returns
--   followers  { total, new, by_week: [{ week, new }] }   every week in the period, zeros included,
--                                                         capped at 52 weeks back for all time
--   events     [{ id, title, starts_at, location, capacity, status, has_ended, views, saves,
--                 rsvps, came, self_reported, walk_ins, cancelled, rating_count, rating_avg }]
--   polls      [{ id, title, created_at, closes_at, status, total_votes, options: [{ label, votes }] }]
--
-- New follows only: an unfollow deletes its org_follows row, so growth is knowable and net change
-- is not. The app says so on the page.
create or replace function public.get_org_analytics(p_org_id bigint, p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_followers integer;
  v_new       integer;
  v_weeks     jsonb;
  v_events    jsonb;
  v_polls     jsonb;
begin
  if not public.can_act('view_analytics', p_org_id) then
    raise exception 'Not authorized to view analytics for this organization';
  end if;

  select count(*)::int into v_followers
    from public.org_follows where org_id = p_org_id;
  select count(*)::int into v_new
    from public.org_follows where org_id = p_org_id and (p_since is null or created_at >= p_since);

  select coalesce(jsonb_agg(jsonb_build_object('week', w.week, 'new', coalesce(c.n, 0)) order by w.week), '[]'::jsonb)
    into v_weeks
  from generate_series(
         date_trunc('week', greatest(coalesce(p_since, now() - interval '52 weeks'), now() - interval '52 weeks')),
         date_trunc('week', now()),
         interval '1 week') as w(week)
  left join (
    select date_trunc('week', created_at) as week, count(*)::int as n
    from public.org_follows
    where org_id = p_org_id
    group by 1
  ) c on c.week = w.week;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at desc), '[]'::jsonb)
    into v_events
  from (
    select e.id, e.title, e.starts_at, e.location, e.capacity, e.status,
           public.event_effective_end(e.starts_at, e.ends_at) <= now()              as has_ended,
           coalesce(t.views, 0)
             + (select count(*) from public.event_views v where v.event_id = e.id)::int as views,
           (select count(*) from public.favorites f
             where f.item_type = 'event' and f.item_id = e.id)::int                   as saves,
           r.rsvps, r.came, r.self_reported, r.walk_ins, r.cancelled,
           fb.n                                                                     as rating_count,
           -- The same rule as get_event_feedback(): no average until 5 people have rated, so no
           -- officer can work out one person's score. If that rule ever changes, change both.
           case when fb.n >= 5 then fb.avg end                                      as rating_avg
    from public.events e
    left join public.event_view_totals t on t.event_id = e.id
    cross join lateral (
      select
        count(*) filter (where rg.status in ('registered', 'self_reported', 'checked_in')
                            or (rg.status = 'walk_in' and rg.created_at < rg.checked_in_at))::int  as rsvps,
        count(*) filter (where rg.status = 'checked_in'
                            or (rg.status = 'walk_in' and rg.created_at < rg.checked_in_at))::int  as came,
        count(*) filter (where rg.status = 'self_reported')::int                                  as self_reported,
        count(*) filter (where rg.status = 'walk_in'
                            and (rg.checked_in_at is null or rg.created_at >= rg.checked_in_at))::int as walk_ins,
        count(*) filter (where rg.status = 'cancelled')::int                                      as cancelled
      from public.event_registrations rg
      where rg.event_id = e.id
    ) r
    cross join lateral (
      select count(*)::int as n, round(avg(ef.rating), 2) as avg
      from public.event_feedback ef
      where ef.event_id = e.id
    ) fb
    where e.org_id = p_org_id
      and e.status <> 'draft'
      and (p_since is null or e.starts_at >= p_since)
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',          p.id,
           'title',       p.title,
           'created_at',  p.created_at,
           'closes_at',   p.poll_closes_at,
           'status',      p.status,
           'total_votes', (select count(*) from public.poll_votes pv where pv.post_id = p.id),
           'options',     (select coalesce(jsonb_agg(jsonb_build_object(
                                     'label', o.label,
                                     'votes', (select count(*) from public.poll_votes pv where pv.option_id = o.id))
                                   order by o.position, o.id), '[]'::jsonb)
                           from public.poll_options o where o.post_id = p.id)
         ) order by p.created_at desc), '[]'::jsonb)
    into v_polls
  from public.org_posts p
  where p.org_id = p_org_id
    and p.type = 'poll'
    and p.status <> 'draft'
    and (p_since is null or p.created_at >= p_since);

  return jsonb_build_object(
    'generated_at', now(),
    'since',        p_since,
    'followers',    jsonb_build_object('total', v_followers, 'new', v_new, 'by_week', v_weeks),
    'events',       v_events,
    'polls',        v_polls
  );
end;
$function$;


-- ============================================================================
-- 5. Follower counts for the admin Organizations page
-- ============================================================================
-- org_directory already publishes follower_count, but only for ACTIVE organizations, so the admin
-- page shows "—" for a suspended club. This returns the count for every active organization (the
-- same public number) and for suspended ones the caller has authority over. Counts only.
create or replace function public.org_follower_counts()
returns table (org_id bigint, followers integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.id, (select count(*)::int from public.org_follows f where f.org_id = o.id)
  from public.organizations o
  where o.is_active or public.can_act('manage_members', o.id);
$function$;


-- ============================================================================
-- 6. Grants
-- ============================================================================
-- Postgres gives EXECUTE on a new function to PUBLIC, which includes anon, and Supabase's default
-- privileges add more. Revoke first, then grant exactly what the app needs.
revoke all on function public.record_event_view(bigint)               from public, anon;
revoke all on function public.get_org_analytics(bigint, timestamptz)   from public, anon;
revoke all on function public.org_follower_counts()                    from public, anon;
revoke all on function public.purge_event_views()                      from public, anon, authenticated;

grant execute on function public.record_event_view(bigint)             to authenticated;
grant execute on function public.get_org_analytics(bigint, timestamptz) to authenticated;
grant execute on function public.org_follower_counts()                  to authenticated;
-- purge_event_views() is granted to nobody. Only pg_cron, running as the database owner, calls it.

-- No app role may touch the two tables directly — not read, not write, and above all not TRUNCATE,
-- which row level security does not apply to.
revoke all on public.event_views       from anon, authenticated;
revoke all on public.event_view_totals from anon, authenticated;
-- The two lines every new object in this project ends with (CLAUDE.md). Covered by the lines above,
-- stated anyway, because the rule exists precisely because it keeps being forgotten.
revoke truncate, references, trigger on public.event_views       from authenticated;
revoke all                           on public.event_views       from anon;
revoke truncate, references, trigger on public.event_view_totals from authenticated;
revoke all                           on public.event_view_totals from anon;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- 7. The nightly erase
-- ============================================================================
-- Outside the transaction above on purpose: if pg_cron cannot be enabled, the tables and functions
-- must still exist. Views are still recorded and counted without it, but NOTHING ERASES THEM, which
-- would break rule 4 — so a failure here says so loudly rather than passing quietly.
do $cron$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise warning E'\n\npg_cron could not be enabled (%).\nViews will be recorded and counted, but NOTHING ERASES THEM until it is — rule 4 is not in force.\nEnable it: Supabase Dashboard -> Database -> Extensions -> pg_cron. Then run this file again.\n', sqlerrm;
    return;
  end;

  -- Unschedule first, so re-running this file never leaves two copies of the job.
  perform cron.unschedule(jobid) from cron.job where jobname = 'nestrel-purge-event-views';
  perform cron.schedule('nestrel-purge-event-views', '17 3 * * *', 'select public.purge_event_views()');
end
$cron$;


-- ============================================================================
-- VERIFY (read-only). The privacy rules themselves are proven by 2026-09-15_verify_org_analytics.sql.
-- ============================================================================
-- 1. Both tables: RLS on, zero policies. Expect rls_on = true and policies = 0 on both rows.
select c.relname as table_name, c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relname in ('event_views', 'event_view_totals');

-- 2. No privilege at all for the app roles on either table. Expect ZERO rows.
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('event_views', 'event_view_totals')
  and grantee in ('anon', 'authenticated', 'PUBLIC');

-- 3. Who may run each function. Expect authenticated on the three app functions, and nobody but
--    the owner on purge_event_views.
select p.proname as function_name,
       array_to_string(p.proacl, ', ') as execute_granted_to
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('record_event_view', 'purge_event_views', 'get_org_analytics', 'org_follower_counts')
order by 1;

-- 4. The nightly job. Expect one row, active. If THIS query errors with "relation cron.job does not
--    exist", pg_cron is not enabled and rule 4 is not in force — see the warning above.
select jobname, schedule, command, active from cron.job where jobname = 'nestrel-purge-event-views';
