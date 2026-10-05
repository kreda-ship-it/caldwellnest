-- Pre-launch cleanup: delete the 27 test posts (23 listings, 4 books) — and only those
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor, in this order:
--   0. Back up first: nestrel-backups -> Actions -> Weekly database backup -> Run workflow.
--   1. sql/changes/2026-10-05_book_shares_set_null.sql (PART 1), or a book shared in a chat blocks this.
--   2. PART 1 below on its own: a READ-ONLY preview.
--   3. PART 2 below on its own: the delete.
--   4. Admin -> Platform health -> Left-over photos: removes the photo files these posts leave behind.
--
-- WHAT IT DELETES: exactly the posts Kal listed on 2026-10-05, by number — every one a test (Kal:
-- "every listing is a test"). Posts are named by id, never by "everything", so this file can never
-- delete a real student's post, and running it again later deletes nothing new.
--   listings: 4 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 27 28 29
--   books:    1 2 9 10
-- With them: favourites pointing at them (no link would clean those up on its own), and their status
-- history. Chats about them stay, with the listing or book card shown as no longer available; reports
-- and the activity log keep their text. Accounts are NOT deleted here — use Delete account on a
-- Student record for the ones you want gone (demo@caldwell.edu first: its password is public).
--
-- PHOTO FILES are not in the database. After PART 2 they are unused, and the Left-over photos tool on
-- the Platform health page removes them.


-- ============================================================================
-- PART 1 — preview (read-only). Shows what PART 2 would delete, and anything it would NOT touch.
-- ============================================================================

with ids as (
  select 'listing' as kind, unnest(array[4,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29]::bigint[]) as id
  union all
  select 'book', unnest(array[1,2,9,10]::bigint[])
), posts as (
  select 'listing' as kind, l.id, l.title, l.created_at::date as posted, coalesce(array_length(l.photo_urls, 1), 0) as photos from public.listings l
  union all
  select 'book', b.id, b.title, b.created_at::date, coalesce(array_length(b.photo_urls, 1), 0) from public.book_listings b
)
select case when i.id is not null then 'WILL BE DELETED' else 'stays (not on the list)' end as what_happens,
       p.kind, p.id, p.title, p.posted, p.photos
from posts p
left join ids i on i.kind = p.kind and i.id = p.id
order by what_happens desc, p.kind, p.id;


-- ============================================================================
-- PART 2 — the delete (run on its own, after looking at PART 1)
-- ============================================================================

begin;

delete from public.favorites
where (item_type = 'listing' and item_id in (4,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29))
   or (item_type = 'book'    and item_id in (1,2,9,10));

delete from public.book_listings
where id in (1,2,9,10);

delete from public.listings
where id in (4,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29);

commit;

-- What is left. The first three should be 0. The last is how many posts remain in total: 0 unless
-- someone has posted since the preview.
select
  (select count(*) from public.listings      where id in (4,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29)) as test_listings_left,
  (select count(*) from public.book_listings where id in (1,2,9,10))                                                       as test_books_left,
  (select count(*) from public.favorites where (item_type = 'listing' and item_id in (4,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29))
                                          or (item_type = 'book' and item_id in (1,2,9,10)))                             as favourites_left,
  (select count(*) from public.listings) + (select count(*) from public.book_listings)                                     as posts_left_in_total;
