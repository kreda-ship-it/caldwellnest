-- Drop saved_listings, the dead predecessor of favorites
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor.
--
-- ** THIS IS THE ONLY DESTRUCTIVE FILE IN sql/. ** Everything else here creates, alters or
-- reads. This drops a table, and a dropped table does not come back.
--
-- WHY IT IS SAFE
-- Four things were checked before writing this, not assumed:
--   1. It holds 0 rows.                          (counted 2026-09-04)
--   2. It has no DML grants at all — neither anon nor authenticated holds SELECT, INSERT,
--      UPDATE or DELETE — so nothing can read or write it even with a policy in place.
--   3. Nothing in js/ references it. `favorites` replaced it on 2026-09-01.
--   4. Nothing else references it: no foreign key points at saved_listings. It points AT
--      listings and profiles, which is the harmless direction.
--
-- It is not a half-finished table. It is a finished one — primary key, two foreign keys, a
-- unique pair — that was superseded and never removed. That is exactly why it should go:
-- a complete, plausible, empty table sitting next to the real one is how a future session
-- picks the wrong one and writes saves nobody can read.

-- ---------- Re-check before dropping ----------
-- Run this first. If it does not say 0, STOP and work out what wrote to it.
select count(*) as rows_in_saved_listings from public.saved_listings;

-- ---------- The drop ----------
drop table if exists public.saved_listings;

notify pgrst, 'reload schema';

-- Expected: no rows. saved_listings is gone and favorites is the only saved-items table.
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'saved_listings';
