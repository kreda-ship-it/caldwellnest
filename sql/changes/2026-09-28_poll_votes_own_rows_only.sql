-- Vote rows: your own only (plus officers with analytics, as the Privacy Policy says)
-- 2026-09-28
--
-- STEP 2 OF 2. RUN ONLY AFTER THE APP CODE THAT CALLS poll_totals() IS LIVE — and after
-- 2026-09-28_poll_totals.sql has run. Run early, and the site still live would count only
-- your own vote in every poll until the new code arrived.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run: the policy is dropped and recreated inside one transaction.
--
-- WHAT CHANGES
-- poll_votes_select used to be: your own row, OR every row of a poll you have voted in, OR
-- view_analytics on its club. The middle branch let anyone who voted read who voted for what.
-- Totals now come from poll_totals(), so that branch goes:
--
--   your own row                         — the app reads it to show "you picked …"
--   OR view_analytics on the poll's club — the Privacy Policy: "Officers with analytics access
--                                          can see how individual members voted in that club's polls"
--
-- has_voted() stays: poll_totals() uses it.


begin;

drop policy if exists poll_votes_select on public.poll_votes;
create policy poll_votes_select on public.poll_votes
  as permissive for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.org_posts p
               where p.id = post_id and public.can_act('view_analytics', p.org_id))
  );

commit;

notify pgrst, 'reload schema';


-- VERIFY — expected: exactly one SELECT policy on poll_votes, and its text no longer
-- mentions has_voted.
select policyname, cmd, qual as using_expr
from pg_policies
where schemaname = 'public' and tablename = 'poll_votes' and cmd = 'SELECT';
