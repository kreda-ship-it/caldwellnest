-- Poll results as totals: poll_totals()
-- 2026-09-28
--
-- STEP 1 OF 2 — ADDITIVE, SAFE TO RUN ANY TIME. Creates a function; changes no existing rule.
-- Step 2 (2026-09-28_poll_votes_own_rows_only.sql) must wait until the app code that calls this
-- function is live.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run (CREATE OR REPLACE).
--
-- WHY
-- The Privacy Policy says students see poll results as totals. The app used to read the vote rows
-- themselves — who voted for what — and count them in the browser. This function returns only
-- the counts: one row per option, with how many votes it has.
--
-- WHO GETS AN ANSWER (the same gate the vote rows had, plus a visibility check):
--   - the poll must be one the caller can see — the org_posts_select policy, restated here because
--     a SECURITY DEFINER function reads past RLS. If that policy changes, change this too.
--   - and its results must be open to the caller: they have voted in it, or they hold
--     view_analytics for its club.
-- Anything else returns no rows, which the app shows as "results appear after you vote".
--
-- Only votes whose post matches their option are counted (v.post_id = o.post_id).


create or replace function public.poll_totals(p_post_ids bigint[])
returns table (post_id bigint, option_id bigint, votes bigint)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.post_id, o.id as option_id, count(v.user_id) as votes
  from public.poll_options o
  join public.org_posts p        on p.id = o.post_id
  join public.organizations org  on org.id = p.org_id
  left join public.poll_votes v  on v.option_id = o.id and v.post_id = o.post_id
  where o.post_id = any (p_post_ids)
    and p.type = 'poll'
    -- the caller can see the poll (mirrors org_posts_select)
    and (
      (p.status = 'published' and org.is_active and (p.members_only = false or public.is_org_member(p.org_id)))
      or public.can_act('post', p.org_id)
    )
    -- and its results are open to the caller
    and (public.has_voted(p.id) or public.can_act('view_analytics', p.org_id))
  group by o.post_id, o.id;
$function$;

revoke all on function public.poll_totals(bigint[]) from public, anon;
grant execute on function public.poll_totals(bigint[]) to authenticated;

notify pgrst, 'reload schema';


-- VERIFY — expected: one row, poll_totals, SECURITY DEFINER, search_path pinned,
-- executable by authenticated only.
select p.proname,
       case when p.prosecdef then 'SECURITY DEFINER' else 'invoker' end as runs_as,
       p.proconfig as settings,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as students_can_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'poll_totals';
