-- Clear the poster emails stored on older listings
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor. Run the three steps ONE AT A TIME — the editor
-- only shows the result of the last statement.
--
-- WHY
-- Until 2026-09-28 every new listing stored a copy of its poster's school email in
-- listings.poster_email, and every signed-in student can read that column. Since commit 7f83fe4
-- the app stores no email on new listings, and admin screens read the email from `profiles`
-- instead (admins only). This clears the copies already stored on older listings.
--
-- WHAT IT KEEPS
-- Official Nestrel posts keep 'official@caldwellnest.com' — that marker is how the Official
-- badge is recognised (isOfficialRow in js/data.js). Nothing else reads this column for students.
--
-- RUN IT AFTER 7f83fe4 IS LIVE, or a listing posted in between would store an email again.
-- Not a schema change: no NOTIFY needed. Safe to re-run — the second run changes 0 rows.


-- STEP 1 — look first. How many listings still carry a real email?
select count(*) as listings_with_a_stored_email
from public.listings
where poster_email is not null
  and poster_email <> 'official@caldwellnest.com';


-- STEP 2 — clear them. Expect "N rows affected", where N is the number from step 1.
update public.listings
set poster_email = null
where poster_email is not null
  and poster_email <> 'official@caldwellnest.com';


-- STEP 3 — confirm. Run step 1 again: expected 0.
