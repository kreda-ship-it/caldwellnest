-- STEP 1 of 2 — create a safe view of profiles. Changes nothing yet.
-- 2026-09-04
--
-- Run this now. It is purely additive: it creates a view and grants read on it. Nothing that
-- works today stops working, and nothing is protected yet either. The protection arrives in
-- step 2 (2026-09-04_restrict_profiles_select.sql), which must NOT be run until the app has
-- been changed to read from this view and tested.
--
-- THE PROBLEM (finding F2, from the 2026-09-04 policy capture)
-- The policy "Authenticated users can read profiles" is `using (true)`, and the app calls
-- select('*') on profiles in several places. So any signed-in student can read every column
-- of every profile: email, status, suspension_reason, terms_accepted_at, terms_version.
-- On a .edu-gated campus platform those are real identities, and suspension_reason is a
-- disciplinary note about a named person.
--
-- WHY A VIEW AND NOT A POLICY
-- **RLS filters rows, never columns.** There is no policy that says "you may read this row
-- but not that column of it" — that is simply not what the feature does. Tightening the USING
-- clause hides whole profiles, which breaks every public profile page in the app.
--
-- A view is the tool that does column selection. This one lists the safe columns explicitly,
-- so a column added to profiles later is private by default and has to be added here on
-- purpose. That is the right direction for a mistake to fall.
--
-- ON "SECURITY DEFINER VIEW"
-- Supabase's linter flags views like this one, and here it is the entire mechanism rather
-- than an oversight. A Postgres view runs with its OWNER's permissions unless created with
-- security_invoker = true. That is what lets this view read every profile row even after
-- step 2 restricts the table itself to own-row-plus-admin. With security_invoker the view
-- would inherit the caller's restriction and return only their own profile, which is exactly
-- what we do not want.
--
-- The safety does not come from the view being restricted. It comes from the view having no
-- sensitive columns to leak in the first place.

create or replace view public.public_profiles as
select
  id,
  first_name,
  last_name,
  display_name,
  username,
  initials,
  color,
  avatar_url,
  bio,
  pronouns,
  major,
  year,
  school,
  -- status is included deliberately, and it is the one judgement call here.
  -- loadListings() in js/data.js reads it to hide suspended posters' listings, so removing it
  -- would un-hide them. It reveals THAT someone is suspended, never WHY — suspension_reason
  -- stays out.
  --
  -- The better long-term answer is to stop doing this in the browser at all. visible_listings
  -- already filters `p.status <> 'suspended'` in SQL; the app re-implements that check client
  -- side only because the view has no SELECT grant (follow-up 3 from the 2026-09-03 audit).
  -- Grant that, point the feed at it, and this column can come out.
  status,
  created_at
from public.profiles;

-- DELIBERATELY ABSENT, and the whole point of the file:
--   email               — a real person's real address, on a .edu-gated platform
--   suspension_reason   — a disciplinary note about a named student
--   terms_accepted_at   — consent record
--   terms_version       — consent record

grant select on public.public_profiles to authenticated;

-- No anon grant. Logged-out visitors have no reason to enumerate students, and every new
-- object in this database now starts from "give anon nothing" after 2026-09-04 showed that
-- Supabase's DEFAULT PRIVILEGES hand things out before our own grants run.
revoke all on public.public_profiles from anon;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================
-- Expected: the fourteen safe columns above, and none of the four absent ones.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'public_profiles'
order by ordinal_position;

-- Expected: one row, authenticated / SELECT. No anon row.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'public_profiles';
