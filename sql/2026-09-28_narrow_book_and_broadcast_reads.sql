-- Book listings and broadcasts: students read only what the app shows them
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run: every policy is dropped and recreated inside one transaction.
--
-- WHY (second audit, S7)
-- book_listings_read_all let every signed-in student read every book listing — pending, rejected
-- and removed ones included, with the rejection reason. "Read active broadcasts" returned
-- broadcasts still 'scheduled', before their send time.
--
-- BOOKS — what the app actually reads:
--   approved books (the feed, and someone's profile)       status = 'approved'
--   your own books in any status (My listings, detail)      poster_id = auth.uid()
--   admins: everything (approval queue, drawers)            user_is_admin()
-- Writes are unchanged (book_listings_insert_own, _update_own, _admin_update stay).
--
-- BROADCASTS — the Home query is: status sent or scheduled, and scheduled_at null or already past,
-- and not expired. The policy now enforces the "already past" part itself. Expiry stays in the app
-- (an expired broadcast was public when it went out). Admins keep "Admins can manage broadcasts".


begin;

drop policy if exists book_listings_read_all on public.book_listings;
drop policy if exists book_listings_read     on public.book_listings;
create policy book_listings_read on public.book_listings
  as permissive for select to authenticated
  using (status = 'approved' or poster_id = auth.uid() or public.user_is_admin());

drop policy if exists "Read active broadcasts"                  on public.broadcasts;
drop policy if exists "All auth users can read sent broadcasts" on public.broadcasts;
drop policy if exists broadcasts_read_once_sent                 on public.broadcasts;
create policy broadcasts_read_once_sent on public.broadcasts
  as permissive for select to authenticated
  using (status = 'sent' or (status = 'scheduled' and (scheduled_at is null or scheduled_at <= now())));

commit;

notify pgrst, 'reload schema';


-- VERIFY — expected SELECT policies:
--   book_listings  book_listings_read
--   broadcasts     broadcasts_read_once_sent, plus "Admins can manage broadcasts" (ALL)
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and tablename in ('book_listings', 'broadcasts') and cmd in ('SELECT', 'ALL')
order by tablename, policyname;
