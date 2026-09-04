-- STEP 2 of 2 — actually close F2. This is the one that can break things.
-- 2026-09-04
--
-- DO NOT RUN THIS UNTIL:
--   1. sql/2026-09-04_public_profiles_view.sql has been run, AND
--   2. the app has been reloaded (HARD refresh) and tested with the migrated code, AND
--   3. the feed, a public profile page, messages and the books list all still show names.
--
-- Step 1 was additive and protected nothing. This step removes the policy that lets any
-- signed-in student read every column of every profile. If a read path was missed in the
-- migration, this is when it starts returning nothing — so the checklist at the bottom is
-- the point of the file, not an afterthought.
--
-- WHAT CHANGES
-- "Authenticated users can read profiles" (`using (true)`) is replaced by two narrower
-- policies:
--   * you can read your own row, whole
--   * an admin can read rows in their own school; a super admin can read all of them
--
-- Everyone else reads people through public.public_profiles, which has no email,
-- no suspension_reason and no consent columns to leak.
--
-- WHY THE ADMIN POLICY IS SHAPED LIKE THIS
-- It copies admin_school_scoped_profiles, the UPDATE policy already on this table, so read
-- and write scope match. An admin who can edit a student should be able to see them, and an
-- admin who cannot should not. Divergence between the two is how you get a dashboard that
-- lists someone it then refuses to act on.

begin;

-- The permissive one. Everything below is pointless while this exists, because permissive
-- policies OR together: one policy saying `true` grants the whole table no matter what any
-- other policy says.
drop policy if exists "Authenticated users can read profiles" on public.profiles;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  as permissive for select to authenticated
  using (auth.uid() = id);

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  as permissive for select to authenticated
  using (
    public.is_super_admin()
    or (public.user_is_admin() and school = public.get_admin_school())
  );

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: exactly two SELECT policies, profiles_select_own and profiles_select_admin.
-- If "Authenticated users can read profiles" is still listed, nothing has been protected.
select policyname, cmd, qual as using_expr
from pg_policies
where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'
order by policyname;

-- Expected: a number greater than 1 — this reads the VIEW, which is the whole point.
-- If it returns 1, the view is not bypassing RLS and something is wrong with step 1.
select count(*) as visible_through_view from public.public_profiles;


-- ============================================================================
-- TEST IN THE APP — as a STUDENT, not as an admin
-- ============================================================================
-- An admin passes profiles_select_admin and will see everything working whether or not this
-- is correct. Only a student session actually tests the change.
--
--   [ ] The listings feed shows poster names and initials, not blanks.
--   [ ] A public profile page opens and shows the person's details.
--   [ ] The messages list shows the other person's name in each conversation.
--   [ ] The books list shows poster names.
--   [ ] Your own profile page still shows your email.
--   [ ] The student count on the feed is the real number, not 1.
--
-- A blank name anywhere means a read path still points at `profiles` instead of
-- `public_profiles`. The browser console will show a permission error naming the query.
--
-- TO ROLL BACK, if something is badly wrong and you need the app working immediately:
--   create policy "Authenticated users can read profiles" on public.profiles
--     as permissive for select to authenticated using (true);
-- That reopens the hole, so treat it as a way to buy an hour, not as a fix.


-- ============================================================================
-- WHAT THIS DOES NOT FIX
-- ============================================================================
-- orgs.js looks a student up by email (`from('profiles').select('id').eq('email', email)`)
-- when adding an officer. After this change only an admin can do that, which is fine today
-- because org management lives in the admin page — but workstream 2 puts it in the org
-- console, where a club officer who is not an admin will need it.
--
-- Do NOT solve that by widening this policy. The answer is a SECURITY DEFINER function that
-- takes an email and returns at most a user id, so an officer can invite someone without
-- being able to enumerate the student body. Same reasoning as the view: hand back the one
-- fact needed, not the row it came from.
