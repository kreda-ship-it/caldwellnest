-- DEV ONLY — seed a test club, three memberships and the posts needed to check visibility
-- 2026-09-05
--
-- Phase 0 of docs/nestrel-engagement-build.md, the half that makes the two "Untested" rows
-- on the status page testable by a human being.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run:
-- every insert is guarded, so a second run changes nothing and reports the same summary.
--
-- THIS FILE CREATES REAL ROWS IN THE REAL DATABASE. It is the only file in sql/ that does,
-- other than the bootstrap. Everything it makes is named 'Dev …' and there is a teardown at
-- the bottom. Do not run it against a database with real students in it.
--
--
-- ============================================================================
-- STEP 1 — CREATE THE THREE ACCOUNTS FIRST. THIS FILE CANNOT DO IT.
-- ============================================================================
-- Supabase auth accounts cannot honestly be created from SQL. Inserting into `auth.users`
-- by hand means hashing the password yourself and skipping the triggers a real signup fires
-- — you would end up testing a path no student ever takes, which is worse than not testing.
-- So the accounts are made through the real signup form, and this file only wires up the
-- organization rows around them.
--
--   1. Supabase Dashboard -> Authentication -> Providers -> Email
--      Turn OFF "Confirm email". (You are turning it back on in step 4.)
--
--   2. Open the app and sign up three times, logging out between each:
--
--        officer@caldwell.edu    — will run the club
--        member@caldwell.edu     — plain member, no permissions
--        outsider@caldwell.edu   — verified student, in no organization at all
--
--      Use any password you will remember; they are all going to be typed again.
--      The .edu gate is real, so these must be a domain in `school_domains`. If your
--      school is not Caldwell, change both these addresses and v_school below.
--
--   3. Run this file.
--
--   4. Supabase Dashboard -> Authentication -> Providers -> Email
--      Turn "Confirm email" back ON. Do not skip this. An unconfirmed-signup setting left
--      on in a live project means anybody can create an account on any address they do not
--      own — including one that looks like staff.
--
--
-- ============================================================================
-- STEP 2 — WHAT TO LOOK AT ONCE IT HAS RUN
-- ============================================================================
-- These two checks are the entire reason the accounts exist. Both have been listed as
-- Untested since the org system shipped, because testing either one needs a second person.
--
--   A. POLL RESULTS ARE HIDDEN UNTIL YOU VOTE.
--      Log in as member@. Open the Dev Chess Club poll. You must see the options and NO
--      counts. Vote. The counts appear.
--      Then log in as officer@ — they hold can_view_analytics, so they see counts either
--      way. That is correct, and it is exactly why the officer account cannot test this.
--
--   B. A MEMBERS-ONLY POST IS INVISIBLE TO A NON-MEMBER.
--      Log in as outsider@. They must not see "Dev members-only notice" anywhere.
--      The bar is not "the app hides it" — it is that the ROW does not come back. Open the
--      browser console on that page and run:
--
--        await supabaseClient.from('org_posts').select('id,title,members_only')
--
--      The members-only row must be absent from what returns. If it comes back and the
--      interface merely declines to draw it, the gate is decoration and RLS is not holding.
--      That distinction is the whole point of the check; a filter in JavaScript is not a
--      permission.
--
--      Then log in as member@ and run the same line. It must be present.


DO $seed$
DECLARE
  -- ---------- change these if your school is not Caldwell ----------
  v_school        text := 'caldwell';
  v_email_officer text := 'officer@caldwell.edu';
  v_email_member  text := 'member@caldwell.edu';
  v_email_outside text := 'outsider@caldwell.edu';
  -- -----------------------------------------------------------------

  v_officer  uuid;
  v_member   uuid;
  v_outsider uuid;
  v_root     bigint;
  v_dept     bigint;
  v_club     bigint;
  v_poll     bigint;
  r          text := '';
BEGIN

  -- ---------- resolve the three accounts ----------
  -- Emails are compared lowercased: profiles.email is written by signup from what the
  -- student typed, and validateSchoolEmail() lowercases before it ever reaches the database,
  -- but a row created some other way may not have been.
  SELECT id INTO v_officer  FROM public.profiles WHERE lower(email) = lower(v_email_officer);
  SELECT id INTO v_member   FROM public.profiles WHERE lower(email) = lower(v_email_member);
  SELECT id INTO v_outsider FROM public.profiles WHERE lower(email) = lower(v_email_outside);

  IF v_officer IS NULL OR v_member IS NULL OR v_outsider IS NULL THEN
    -- RAISE's placeholder is %, not %s. format() uses %s. They are different functions with
    -- different rules, and mixing them prints a stray letter rather than failing.
    RAISE EXCEPTION E'\nOne or more dev accounts do not exist yet. Nothing was changed.\n\n  %  -> %\n  %  -> %\n  %  -> %\n\nCreate the missing ones through the signup form first — see STEP 1 at the top of this file.\n',
      v_email_officer, coalesce(v_officer::text,  'MISSING'),
      v_email_member,  coalesce(v_member::text,   'MISSING'),
      v_email_outside, coalesce(v_outsider::text, 'MISSING');
  END IF;

  -- A super admin would make every check below meaningless: is_super_admin() short-circuits
  -- can_act(), so an admin as the "plain member" would see poll results whatever the gate says.
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id IN (v_officer, v_member, v_outsider)) THEN
    RAISE EXCEPTION E'\nOne of the three dev accounts holds a user_roles row, which makes it a platform admin.\nis_super_admin() short-circuits every permission check, so nothing below would prove anything.\nUse three ordinary student accounts.\n';
  END IF;

  -- ---------- find the school organization ----------
  SELECT id INTO v_root
  FROM public.organizations
  WHERE school = v_school AND parent_id IS NULL AND type = 'school'
  ORDER BY id LIMIT 1;

  IF v_root IS NULL THEN
    RAISE EXCEPTION E'\nNo root organization for school "%". Run the BOOTSTRAP section at the bottom of\nsql/2026-09-04_org_hierarchy.sql first — it is the one manual step, and everything\nelse in the hierarchy hangs off it.\n', v_school;
  END IF;

  -- ---------- a department, then a club under it ----------
  -- Two levels rather than one, deliberately. It makes the parent breadcrumb on the Phase 1
  -- directory card real ("Caldwell University > Dev Student Life > Dev Chess Club") and it
  -- means the officer's upward refusal can be seen by hand: they run the club and must find
  -- nothing when they reach for the department.
  INSERT INTO public.organizations (school, parent_id, type, name, slug, description, created_by)
  VALUES (v_school, v_root, 'department', 'Dev Student Life', 'dev-student-life',
          'Development fixture. Safe to delete.', v_officer)
  ON CONFLICT (school, slug) DO NOTHING;

  SELECT id INTO v_dept FROM public.organizations
  WHERE school = v_school AND slug = 'dev-student-life';

  INSERT INTO public.organizations (school, parent_id, type, name, slug, description, created_by)
  VALUES (v_school, v_dept, 'club', 'Dev Chess Club', 'dev-chess-club',
          'Development fixture for testing visibility. Safe to delete.', v_officer)
  ON CONFLICT (school, slug) DO NOTHING;

  SELECT id INTO v_club FROM public.organizations
  WHERE school = v_school AND slug = 'dev-chess-club';

  -- ---------- memberships ----------
  -- These inserts pass the flag guard only because the SQL editor sends no JWT and the
  -- guard's break-glass branch returns early. From the browser, an officer holding
  -- can_manage_members could not create the officer row below — granting permissions needs
  -- can_manage_admins. That is the rule 2026-09-05_verify_flag_guard.sql tests.
  --
  -- The officer deliberately does NOT hold can_manage_admins. Two reasons: it matches what
  -- a club president actually gets today, and Phase 2 is the session that changes it, so
  -- leaving it false keeps the before-state visible.
  INSERT INTO public.org_memberships (
    org_id, user_id, role, title, status,
    can_post, can_manage_members, can_view_analytics, can_message,
    can_create_child_orgs, can_manage_admins, can_manage_events, can_check_in, added_by)
  VALUES (v_club, v_officer, 'officer', 'President', 'active',
          true, true, true, true,
          false, false, true, true, v_officer)
  ON CONFLICT (org_id, user_id) DO NOTHING;

  -- Plain member: every flag false. This is the account that proves the poll gate, because
  -- without can_view_analytics it must not see results until it has voted.
  INSERT INTO public.org_memberships (org_id, user_id, role, status, added_by)
  VALUES (v_club, v_member, 'member', 'active', v_officer)
  ON CONFLICT (org_id, user_id) DO NOTHING;

  -- v_outsider gets NO ROW. That absence is the fixture — it is what makes them an outsider,
  -- and it is why the account has to exist rather than being simulated by logging out.
  -- A logged-out browser is `anon`, which every one of these tables refuses outright; that
  -- would prove the grant, not the policy.

  -- ---------- posts ----------
  -- org_posts has no natural unique key, so idempotency is a `where not exists` on the
  -- title. Re-running adds nothing.
  INSERT INTO public.org_posts (org_id, type, title, body, members_only, status, created_by)
  SELECT v_club, 'announcement', 'Dev public notice',
         'Everyone with an account can see this one. It is the control.',
         false, 'published', v_officer
  WHERE NOT EXISTS (
    SELECT 1 FROM public.org_posts WHERE org_id = v_club AND title = 'Dev public notice');

  INSERT INTO public.org_posts (org_id, type, title, body, members_only, status, created_by)
  SELECT v_club, 'announcement', 'Dev members-only notice',
         'If outsider@ can read this row, RLS is not holding and check B has failed.',
         true, 'published', v_officer
  WHERE NOT EXISTS (
    SELECT 1 FROM public.org_posts WHERE org_id = v_club AND title = 'Dev members-only notice');

  -- The poll is deliberately NOT members-only: check A is about the results gate, and mixing
  -- it with the membership gate would mean a failure could not be attributed to either.
  INSERT INTO public.org_posts (org_id, type, title, body, members_only, status, created_by)
  SELECT v_club, 'poll', 'Dev poll — when should we meet?',
         'Results must stay hidden until you have voted.',
         false, 'published', v_officer
  WHERE NOT EXISTS (
    SELECT 1 FROM public.org_posts WHERE org_id = v_club AND type = 'poll');

  SELECT id INTO v_poll FROM public.org_posts
  WHERE org_id = v_club AND type = 'poll' ORDER BY id LIMIT 1;

  INSERT INTO public.poll_options (post_id, label, position)
  SELECT v_poll, x.label, x.pos
  FROM (VALUES ('Tuesday evening', 0), ('Thursday evening', 1), ('Saturday afternoon', 2))
       AS x(label, pos)
  WHERE NOT EXISTS (SELECT 1 FROM public.poll_options WHERE post_id = v_poll);

  -- ---------- report ----------
  r := format(E'\nDev fixtures ready.\n\n  Department  Dev Student Life   id %s\n  Club        Dev Chess Club     id %s\n\n  officer@   %s   officer, can_post + manage_members + view_analytics + manage_events + check_in\n  member@    %s   plain member, every flag false\n  outsider@  %s   no membership row at all\n\nNow do the two checks in STEP 2 at the top of this file. They are the point.\n',
              v_dept, v_club, v_officer, v_member, v_outsider);
  -- The Supabase SQL editor does not reliably surface NOTICE output. This is a convenience
  -- if you are running via psql; the query at the bottom of this file is the summary that
  -- always displays.
  RAISE NOTICE '%', r;
END
$seed$;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================

-- Expected: three organizations in the chain, and two membership rows on the club.
select o.id, o.type, o.name, o.slug, o.parent_id,
       (select count(*) from public.org_memberships m where m.org_id = o.id) as members
from public.organizations o
where o.slug in ('dev-student-life','dev-chess-club')
   or (o.parent_id is null and o.type = 'school')
order by o.id;

-- Expected: three posts — one public announcement, one members-only, one poll with 3 options.
select p.id, p.type, p.title, p.members_only, p.status,
       (select count(*) from public.poll_options po where po.post_id = p.id) as options
from public.org_posts p
join public.organizations o on o.id = p.org_id
where o.slug = 'dev-chess-club'
order by p.id;

-- The summary. The Supabase editor shows the LAST result set, so this is the one you will
-- see if you run the whole file in one go.
--
-- Expected: THREE rows. officer@ as officer, member@ as member, and outsider@ with every
-- column after the email null — a student with an account and no organization. That null
-- row is the fixture for check B, so its absence here means check B cannot be run.
select p.email,
       m.role, m.title, m.status,
       m.can_post, m.can_manage_members, m.can_view_analytics,
       m.can_manage_events, m.can_check_in, m.can_manage_admins
from public.profiles p
left join public.org_memberships m
  on m.user_id = p.id
 and m.org_id = (select id from public.organizations
                  where school = 'caldwell' and slug = 'dev-chess-club')
where lower(p.email) in ('officer@caldwell.edu','member@caldwell.edu','outsider@caldwell.edu')
order by p.email;


-- ============================================================================
-- TEARDOWN — uncomment and run to remove everything this file created
-- ============================================================================
-- The org rows cascade: deleting the department removes the club, its memberships, its
-- posts, the poll options and any votes. The three auth accounts are NOT touched — delete
-- those in Dashboard -> Authentication -> Users if you want them gone, and note that
-- deleting a user there also removes their profiles row.
--
--   delete from public.organizations where school = 'caldwell' and slug = 'dev-chess-club';
--   delete from public.organizations where school = 'caldwell' and slug = 'dev-student-life';
--
-- Run the club line FIRST. organizations.parent_id has no ON DELETE clause, so it defaults
-- to NO ACTION and the department refuses to go while a child points at it. That refusal is
-- correct — it is what stops a mis-click orphaning a live club — but it does mean the order
-- matters here.
