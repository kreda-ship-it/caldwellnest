-- Verify what a student who belongs to nothing can and cannot see
-- 2026-09-06
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Reports by raising an exception. THE ERROR MESSAGE IS THE REPORT, and the raise is also
-- what discards every row this file creates. Nothing is left behind.
--
-- Needs THREE non-admin student accounts. It uses all three as different people.
--
--
-- THIS FILE IS DIFFERENT FROM THE OTHER TWO, AND THE DIFFERENCE IS THE POINT
-- verify_can_act.sql tests a function. verify_flag_guard.sql tests a trigger. Both can do
-- that from the SQL editor, because a function called from anywhere is still that function.
--
-- ROW LEVEL SECURITY IS NOT LIKE THAT. The SQL editor connects as a role that BYPASSES RLS
-- entirely, so every "can the outsider read this row" question asked from a normal editor
-- session comes back yes — not because the policy allows it, but because the policy was
-- never consulted. A file written that way would report a perfect pass while proving
-- nothing, which is the exact failure §6.4 of the build document describes.
--
-- So this one does `set local role authenticated` and then speaks as three different students
-- in turn. That has a consequence worth stating: ONCE THE ROLE IS SWITCHED, NOTHING MORE CAN
-- BE SET UP. Everything the tests need is built first, at the top, and the fixtures include
-- one deliberately deactivated club because an ordinary student cannot deactivate one.
--
-- The role reverts on its own — `set local` lasts for the transaction, and the transaction
-- ends in the RAISE below.


DO $verify$
DECLARE
  v_school      text;
  v_school_org  bigint;
  v_club        bigint;
  v_gone        bigint;   -- a club that is deactivated before anyone looks
  v_users       uuid[];
  v_officer     uuid;
  v_member      uuid;
  v_outsider    uuid;
  v_post_public bigint;
  v_post_secret bigint;
  v_n           bigint;
  v_txt         text;
  v_got         boolean;
  r             text := '';
  pass_all      boolean := true;
BEGIN

  -- ---------- three students, none of them an admin ----------
  -- is_super_admin() short-circuits can_act(), and an admin also satisfies the
  -- school-scoped branch of the profiles read policy. Either would turn a refusal into a
  -- pass without anything being wrong with the policy.
  SELECT array_agg(id) INTO v_users
  FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at
    LIMIT 3
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 3 THEN
    RAISE EXCEPTION E'\nThis file needs THREE non-admin student accounts and found %.\nAn officer, a member and an outsider are three different people — there is no way to\nshorten it, because the whole question is what the third one cannot see.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_officer  := v_users[1];
  v_member   := v_users[2];
  v_outsider := v_users[3];

  r := r || format(E'\nOfficer:  %s\nMember:   %s\nOutsider: %s\n\n', v_officer, v_member, v_outsider);


  -- ======================================================================
  -- FIXTURES — all of it, before the role switch
  -- ======================================================================
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Visibility School', 'verify-vis', 'verify-vis.invalid')
  RETURNING slug INTO v_school;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Vis School', 'vv-school')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug, description)
  VALUES (v_school, v_school_org, 'club', 'Verify Vis Club', 'vv-club', 'A club for testing.')
  RETURNING id INTO v_club;

  -- Deactivated at birth. An ordinary student cannot flip is_active, so if this is not set
  -- up here it cannot be tested at all after the role switch.
  INSERT INTO public.organizations (school, parent_id, type, name, slug, is_active)
  VALUES (v_school, v_school_org, 'club', 'Verify Vis Gone', 'vv-gone', false)
  RETURNING id INTO v_gone;

  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_post)
  VALUES (v_club, v_officer, 'officer', 'President', 'active', true);

  INSERT INTO public.org_memberships (org_id, user_id, role, status)
  VALUES (v_club, v_member, 'member', 'active');

  -- v_outsider gets no membership. That absence is the fixture.

  INSERT INTO public.org_posts (org_id, type, title, body, members_only, status, created_by)
  VALUES (v_club, 'announcement', 'Open to campus', 'Anyone signed in may read this.',
          false, 'published', v_officer)
  RETURNING id INTO v_post_public;

  INSERT INTO public.org_posts (org_id, type, title, body, members_only, status, created_by)
  VALUES (v_club, 'announcement', 'Members only', 'If an outsider reads this row, RLS is not holding.',
          true, 'published', v_officer)
  RETURNING id INTO v_post_secret;

  -- One follower on the live club, so follower_count has something to be right about.
  INSERT INTO public.org_follows (user_id, org_id) VALUES (v_member, v_club);
  -- And the outsider follows the club that is already gone, so its follow row can be shown
  -- to survive while the organization drops out of the directory.
  INSERT INTO public.org_follows (user_id, org_id) VALUES (v_outsider, v_gone);


  -- ======================================================================
  -- STRUCTURAL — before the role switch, because it needs no impersonation
  -- ======================================================================

  -- ---------- TEST 1 — neither view exposes a person-identifying column ----------
  -- The leak check. org_public_officers deliberately omits user_id: with it, anyone could
  -- read the view for every organization and assemble which student is involved in what,
  -- which §6.1 says belongs to the student alone.
  SELECT string_agg(table_name || '.' || column_name, ', ')
    INTO v_txt
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('org_directory', 'org_public_officers')
    AND column_name IN ('email', 'user_id', 'avatar_url', 'phone', 'created_by',
                        'pending_email', 'suspension_reason');
  IF v_txt IS NULL THEN
    r := r || E'TEST 1  views expose no identifying column ....... PASS\n';
  ELSE
    r := r || format(E'TEST 1  views expose no identifying column ....... *** FAIL — %s ***\n', v_txt);
    pass_all := false;
  END IF;


  -- ======================================================================
  -- BECOME AN ORDINARY STUDENT. Nothing can be created past this line.
  -- ======================================================================
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_outsider), true);


  -- ---------- TEST 2 — the outsider reads the public post ----------
  -- The control. Without it, every refusal below is equally satisfied by a policy that
  -- refuses everything, and a students' feed that shows nothing is not a working gate.
  SELECT EXISTS (SELECT 1 FROM public.org_posts WHERE id = v_post_public) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 2  outsider reads the public post .......... PASS (visible)\n';
  ELSE
    r := r || E'TEST 2  outsider reads the public post .......... *** FAIL — HIDDEN, THE FEED IS EMPTY FOR EVERYONE ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 3 — the members-only post is NOT READABLE ----------
  -- The bar is not "the interface declines to draw it". A filter in JavaScript is not a
  -- permission — anyone can open the network tab. The ROW must not come back.
  SELECT EXISTS (SELECT 1 FROM public.org_posts WHERE id = v_post_secret) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 3  members-only post hidden from outsider .. *** FAIL — THE ROW IS READABLE ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 3  members-only post hidden from outsider .. PASS (row not returned)\n';
  END IF;

  -- ---------- TEST 4 — the roster is private ----------
  -- org_memberships SELECT is own-row or can_act('manage_members'). An outsider holds
  -- neither, so the count must be zero rather than "the rows minus the secret ones".
  SELECT count(*) INTO v_n FROM public.org_memberships WHERE org_id = v_club;
  IF v_n = 0 THEN
    r := r || E'TEST 4  roster invisible to an outsider ......... PASS (0 rows)\n';
  ELSE
    r := r || format(E'TEST 4  roster invisible to an outsider ......... *** FAIL — %s ROWS READABLE ***\n', v_n);
    pass_all := false;
  END IF;

  -- ---------- TEST 5 — but the officers ARE visible, by name and title ----------
  -- The other half of test 4, and the reason org_public_officers exists. "The roster is
  -- private" and "you can see who runs the club" have to both be true at once.
  SELECT count(*) INTO v_n FROM public.org_public_officers WHERE org_id = v_club;
  IF v_n = 1 THEN
    r := r || E'TEST 5  officers visible through the view ....... PASS (1 officer)\n';
  ELSE
    r := r || format(E'TEST 5  officers visible through the view ....... *** FAIL — expected 1, got %s ***\n', v_n);
    pass_all := false;
  END IF;

  -- ---------- TEST 6 — the follower count is right ----------
  -- The count the outsider could not have assembled: org_follows is own-rows-only, so
  -- reading the table directly they would see nothing for this club at all.
  SELECT follower_count INTO v_n FROM public.org_directory WHERE id = v_club;
  IF v_n = 1 THEN
    r := r || E'TEST 6  follower count readable and correct ..... PASS (1)\n';
  ELSE
    r := r || format(E'TEST 6  follower count readable and correct ..... *** FAIL — expected 1, got %s ***\n', coalesce(v_n::text, 'null'));
    pass_all := false;
  END IF;

  -- ---------- TEST 7 — and the rows behind it stay hidden ----------
  -- The count must not be a way to reach the followers. The outsider follows the gone club
  -- and nothing else, so one row is exactly right: their own.
  SELECT count(*) INTO v_n FROM public.org_follows;
  IF v_n = 1 THEN
    r := r || E'TEST 7  follow ROWS still own-only ............... PASS (1, their own)\n';
  ELSE
    r := r || format(E'TEST 7  follow ROWS still own-only ............... *** FAIL — %s rows readable ***\n', v_n);
    pass_all := false;
  END IF;

  -- ---------- TEST 8 — following works, and following twice is refused ----------
  -- org_follows is `primary key (user_id, org_id)`, so the second insert raises. Idempotence
  -- is therefore the CLIENT's job — an unguarded double tap surfaces a duplicate-key error
  -- to a student who merely pressed the button twice.
  BEGIN
    INSERT INTO public.org_follows (user_id, org_id) VALUES (v_outsider, v_club);
    BEGIN
      INSERT INTO public.org_follows (user_id, org_id) VALUES (v_outsider, v_club);
      r := r || E'TEST 8  follow once, refuse twice ............... *** FAIL — DUPLICATE ACCEPTED ***\n';
      pass_all := false;
    EXCEPTION WHEN unique_violation THEN
      r := r || E'TEST 8  follow once, refuse twice ............... PASS (second refused)\n';
    END;
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 8  follow once, refuse twice ............... *** FAIL — could not follow at all: %s ***\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 9 — a deactivated club leaves the directory, not the database ----------
  -- Soft state, seen from the student's side. The organization must vanish from anything
  -- that browses, while the follow row survives — so reactivating it restores the follower
  -- rather than requiring everyone to find it again.
  SELECT EXISTS (SELECT 1 FROM public.org_directory WHERE id = v_gone) INTO v_got;
  SELECT count(*) INTO v_n FROM public.org_follows WHERE org_id = v_gone;
  IF v_got THEN
    r := r || E'TEST 9  deactivated club gone from directory .... *** FAIL — STILL LISTED ***\n';
    pass_all := false;
  ELSIF v_n <> 1 THEN
    r := r || format(E'TEST 9  deactivated club gone from directory .... *** FAIL — follow row was destroyed (%s) ***\n', v_n);
    pass_all := false;
  ELSE
    r := r || E'TEST 9  deactivated club gone from directory .... PASS (hidden, follow row intact)\n';
  END IF;


  -- ======================================================================
  -- BECOME THE MEMBER. Same role, different person.
  -- ======================================================================
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_member), true);

  -- ---------- TEST 10 — the member CAN read the members-only post ----------
  -- Test 3's necessary partner. A policy that hides the post from everybody would pass
  -- test 3 and be completely broken, and this is the only test that can tell the difference.
  SELECT EXISTS (SELECT 1 FROM public.org_posts WHERE id = v_post_secret) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 10 member reads the members-only post ...... PASS (visible)\n';
  ELSE
    r := r || E'TEST 10 member reads the members-only post ...... *** FAIL — HIDDEN FROM ITS OWN MEMBERS ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 11 — the member sees their own roster row and no more ----------
  -- A plain member is not an officer: they may see that they belong, and not who else does.
  SELECT count(*) INTO v_n FROM public.org_memberships WHERE org_id = v_club;
  IF v_n = 1 THEN
    r := r || E'TEST 11 member sees own roster row only ......... PASS (1 row)\n';
  ELSE
    r := r || format(E'TEST 11 member sees own roster row only ......... *** FAIL — expected 1, got %s ***\n', v_n);
    pass_all := false;
  END IF;


  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. A student who belongs to nothing can browse, follow and read'
            || E'\nwhat is public — and cannot reach a members-only row, a roster, or a follower list.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  r := r || E'\n\nThis one ran as role `authenticated`, so RLS was genuinely consulted.'
         || E'\nTests 2, 5, 6, 8 and 10 are the ones that prove the gates are gates rather than walls.';

  r := r || E'\n\nNote: the id sequences advanced for the throwaway rows and do not roll back.'
         || E'\nThat is normal and harmless.';

  RAISE EXCEPTION E'%\n', r;
END
$verify$;
