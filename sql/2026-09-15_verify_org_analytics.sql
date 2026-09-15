-- Verify the analytics privacy rules, speaking as real students
-- 2026-09-15
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Run AFTER 2026-09-15_org_analytics_and_event_views.sql.
--
-- Reports by raising an exception. THE ERROR MESSAGE IS THE REPORT, and the raise is also what
-- discards every row this file creates. Nothing is left behind — not the school, the club, the
-- events, the registrations, the saves, the poll or the views.
--
-- Needs THREE non-admin student accounts.
--
--
-- WHY THIS SWITCHES ROLE (the same reason as 2026-09-06_verify_org_visibility.sql)
-- The SQL editor connects as a role that BYPASSES row level security. Asked from a normal editor
-- session, "can a student read event_views" comes back yes — not because anything allows it, but
-- because nothing was consulted. So after building its fixtures this file becomes
-- `authenticated` and speaks as each student in turn. Nothing can be created after that switch,
-- which is why the purge is tested first, while still the owner.
--
--
-- WHAT IT PROVES
--   As the owner, before the switch:
--     1   purge_event_views() erases views of an event that ended over 30 days ago, and moves
--         them into the total
--   As a student who belongs to nothing:
--     2   cannot read event_views
--     3   cannot insert into event_views directly
--     4   cannot run purge_event_views()
--     5   cannot run get_org_analytics() for a club they do not help run
--     6   opening the same event twice records ONE view
--     7   opening a draft, a members-only event they are not in, or an event past the window
--         records nothing
--     8   org_follower_counts() shows an active club and hides a suspended one
--   As a second student:
--     9   their open of the live event is recorded (the control: without it, test 6 is equally
--         satisfied by a function that records nothing at all)
--   As an officer of the club who holds view_analytics but NOT manage_events:
--     10  their own open is NOT counted
--     11  get_org_analytics() returns exactly the expected numbers, including the walk-in case
--     12  the whole result contains no user id of any of the three students


DO $verify$
DECLARE
  v_users      uuid[];
  v_officer    uuid;
  v_s1         uuid;
  v_s2         uuid;
  v_school     text;
  v_school_org bigint;
  v_club       bigint;
  v_gone       bigint;
  v_type       text;
  v_live       bigint;
  v_old        bigint;
  v_draft      bigint;
  v_members    bigint;
  v_post       bigint;
  v_opt_a      bigint;
  v_opt_b      bigint;
  v_json       jsonb;
  v_ev         jsonb;
  v_n          bigint;
  v_got        boolean;
  r            text := '';
  pass_all     boolean := true;
BEGIN

  -- ---------- three students, none of them an admin ----------
  -- An admin would short-circuit can_act() and is_org_member(), turning refusals into passes
  -- without anything being wrong with the rules.
  SELECT array_agg(id) INTO v_users
  FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at
    LIMIT 3
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 3 THEN
    RAISE EXCEPTION E'\nThis file needs THREE non-admin student accounts and found %.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_officer := v_users[1];
  v_s1      := v_users[2];
  v_s2      := v_users[3];
  r := r || format(E'\nOfficer:   %s\nStudent 1: %s\nStudent 2: %s\n\n', v_officer, v_s1, v_s2);


  -- ======================================================================
  -- FIXTURES — all of it, before the role switch
  -- ======================================================================
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Analytics School', 'verify-ana', 'verify-ana.invalid')
  RETURNING slug INTO v_school;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Ana School', 'va-school')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'club', 'Verify Ana Club', 'va-club')
  RETURNING id INTO v_club;

  INSERT INTO public.organizations (school, parent_id, type, name, slug, is_active)
  VALUES (v_school, v_school_org, 'club', 'Verify Ana Gone', 'va-gone', false)
  RETURNING id INTO v_gone;

  -- An officer who may READ analytics but may not manage events: the case can_act('manage_events')
  -- alone would miss, which is why record_event_view() also checks the membership.
  INSERT INTO public.org_memberships (org_id, user_id, role, title, status, can_view_analytics)
  VALUES (v_club, v_officer, 'officer', 'Treasurer', 'active', true);

  -- event_type is constrained; borrow the first value the constraint allows rather than guess one.
  SELECT (regexp_match(pg_get_constraintdef(c.oid), '''([^'']+)'''))[1] INTO v_type
  FROM pg_constraint c
  WHERE c.conrelid = 'public.events'::regclass AND pg_get_constraintdef(c.oid) ILIKE '%event_type%'
  LIMIT 1;
  v_type := coalesce(v_type, 'social');

  INSERT INTO public.events (school, org_id, created_by, title, event_type, starts_at, location, status, registration_open)
  VALUES (v_school, v_club, v_officer, 'VA live', v_type, now() - interval '1 hour', 'Quad', 'published', true)
  RETURNING id INTO v_live;

  INSERT INTO public.events (school, org_id, created_by, title, event_type, starts_at, location, status)
  VALUES (v_school, v_club, v_officer, 'VA old', v_type, now() - interval '40 days', 'Quad', 'published')
  RETURNING id INTO v_old;

  INSERT INTO public.events (school, org_id, created_by, title, event_type, starts_at, location, status)
  VALUES (v_school, v_club, v_officer, 'VA draft', v_type, now() + interval '5 days', 'Quad', 'draft')
  RETURNING id INTO v_draft;

  INSERT INTO public.events (school, org_id, created_by, title, event_type, starts_at, location, status, members_only)
  VALUES (v_school, v_club, v_officer, 'VA members', v_type, now() + interval '5 days', 'Quad', 'published', true)
  RETURNING id INTO v_members;

  -- Attendance on the live event, chosen to exercise every branch of the count:
  --   student 1  registered two days ago, then arrived through the WALK-IN flow  -> an RSVP who came
  --   student 2  registered and never arrived                                    -> an RSVP, no-show
  --   officer    tapped "I'm here" on an event that does not trust self check-in -> self_reported
  --   anonymous  a genuine walk-in, created and checked in by one statement       -> a walk-in
  --   anonymous  a cancellation                                                  -> cancelled
  INSERT INTO public.event_registrations (event_id, user_id, name_at_signup, email_at_signup, status, check_in_method, created_at, checked_in_at)
  VALUES (v_live, v_s1, 'S One', 's1@verify-ana.invalid', 'walk_in', 'walk_in', now() - interval '2 days', now());
  INSERT INTO public.event_registrations (event_id, user_id, name_at_signup, email_at_signup, status)
  VALUES (v_live, v_s2, 'S Two', 's2@verify-ana.invalid', 'registered');
  INSERT INTO public.event_registrations (event_id, user_id, name_at_signup, email_at_signup, status, self_reported_at)
  VALUES (v_live, v_officer, 'Officer', 'o@verify-ana.invalid', 'self_reported', now());
  INSERT INTO public.event_registrations (event_id, user_id, name_at_signup, email_at_signup, status, check_in_method, checked_in_at)
  VALUES (v_live, NULL, 'Walk In', 'w@verify-ana.invalid', 'walk_in', 'walk_in', now());
  INSERT INTO public.event_registrations (event_id, user_id, name_at_signup, email_at_signup, status)
  VALUES (v_live, NULL, 'Gave Up', 'g@verify-ana.invalid', 'cancelled');

  INSERT INTO public.favorites (user_id, item_type, item_id) VALUES (v_s1, 'event', v_live);
  INSERT INTO public.org_follows (user_id, org_id) VALUES (v_s1, v_club);
  INSERT INTO public.org_follows (user_id, org_id) VALUES (v_s2, v_gone);

  INSERT INTO public.org_posts (org_id, type, title, status, created_by)
  VALUES (v_club, 'poll', 'VA poll', 'published', v_officer)
  RETURNING id INTO v_post;
  INSERT INTO public.poll_options (post_id, label, position) VALUES (v_post, 'Yes', 0) RETURNING id INTO v_opt_a;
  INSERT INTO public.poll_options (post_id, label, position) VALUES (v_post, 'No', 1)  RETURNING id INTO v_opt_b;
  INSERT INTO public.poll_votes (post_id, option_id, user_id) VALUES (v_post, v_opt_a, v_s1);

  -- Two views of the OLD event, as they would have been recorded while it was still in the window.
  INSERT INTO public.event_views (event_id, user_id, first_viewed_at) VALUES (v_old, v_s1, now() - interval '41 days');
  INSERT INTO public.event_views (event_id, user_id, first_viewed_at) VALUES (v_old, v_s2, now() - interval '41 days');


  -- ---------- TEST 1 — the erase, while still the owner ----------
  PERFORM public.purge_event_views();
  SELECT count(*) INTO v_n FROM public.event_views WHERE event_id = v_old;
  SELECT (v_n = 0) AND coalesce((SELECT views FROM public.event_view_totals WHERE event_id = v_old), -1) = 2 INTO v_got;
  IF v_got THEN
    r := r || E'TEST 1  views past 30 days erased, total kept ...... PASS (0 rows left, total 2)\n';
  ELSE
    r := r || format(E'TEST 1  views past 30 days erased, total kept ...... *** FAIL — rows left %s, total %s ***\n',
                     v_n, coalesce((SELECT views FROM public.event_view_totals WHERE event_id = v_old)::text, 'none'));
    pass_all := false;
  END IF;


  -- ======================================================================
  -- BECOME STUDENT 1. Nothing can be created past this line.
  -- ======================================================================
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s1), true);

  -- ---------- TEST 2 — event_views is unreadable ----------
  BEGIN
    SELECT count(*) INTO v_n FROM public.event_views;
    r := r || format(E'TEST 2  student cannot read event_views ........... *** FAIL — READ %s ROWS ***\n', v_n);
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 2  student cannot read event_views ........... PASS (permission denied)\n';
  END;

  -- ---------- TEST 3 — no direct write ----------
  BEGIN
    INSERT INTO public.event_views (event_id, user_id) VALUES (v_draft, v_s1);
    r := r || E'TEST 3  student cannot write event_views directly .. *** FAIL — THE INSERT WORKED ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  student cannot write event_views directly .. PASS (permission denied)\n';
  END;

  -- ---------- TEST 4 — no running the erase ----------
  BEGIN
    PERFORM public.purge_event_views();
    r := r || E'TEST 4  student cannot run purge_event_views() ..... *** FAIL — IT RAN ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 4  student cannot run purge_event_views() ..... PASS (permission denied)\n';
  END;

  -- ---------- TEST 5 — no analytics for a club they do not run ----------
  BEGIN
    v_json := public.get_org_analytics(v_club, NULL);
    r := r || E'TEST 5  student refused get_org_analytics() ......... *** FAIL — IT RETURNED DATA ***\n';
    pass_all := false;
  EXCEPTION WHEN others THEN
    IF SQLERRM ILIKE '%not authorized%' THEN
      r := r || E'TEST 5  student refused get_org_analytics() ......... PASS (not authorized)\n';
    ELSE
      r := r || format(E'TEST 5  student refused get_org_analytics() ......... *** FAIL — WRONG ERROR: %s ***\n', SQLERRM);
      pass_all := false;
    END IF;
  END;

  -- ---------- TESTS 6 and 7 — what counts as a view ----------
  -- Recorded here, checked below by the officer, because only the officer may see the numbers.
  PERFORM public.record_event_view(v_live);
  PERFORM public.record_event_view(v_live);       -- the second open
  PERFORM public.record_event_view(v_draft);
  PERFORM public.record_event_view(v_members);    -- student 1 is not a member
  PERFORM public.record_event_view(v_old);        -- ended 40 days ago

  -- ---------- TEST 8 — follower counts ----------
  SELECT count(*) INTO v_n FROM public.org_follower_counts() c WHERE c.org_id = v_gone;
  SELECT (v_n = 0) AND coalesce((SELECT c.followers FROM public.org_follower_counts() c WHERE c.org_id = v_club), -1) = 1 INTO v_got;
  IF v_got THEN
    r := r || E'TEST 8  follower counts: active shown, suspended hidden PASS\n';
  ELSE
    r := r || E'TEST 8  follower counts: active shown, suspended hidden *** FAIL ***\n';
    pass_all := false;
  END IF;


  -- ======================================================================
  -- BECOME STUDENT 2
  -- ======================================================================
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s2), true);
  PERFORM public.record_event_view(v_live);       -- test 9, read back below


  -- ======================================================================
  -- BECOME THE OFFICER
  -- ======================================================================
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_officer), true);
  PERFORM public.record_event_view(v_live);       -- test 10: must NOT count

  BEGIN
    v_json := public.get_org_analytics(v_club, NULL);
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 11 officer can run get_org_analytics() ....... *** FAIL — %s ***\n', SQLERRM);
    pass_all := false;
    v_json := NULL;
  END;

  IF v_json IS NOT NULL THEN
    SELECT ev INTO v_ev FROM jsonb_array_elements(v_json->'events') ev WHERE (ev->>'id')::bigint = v_live;

    -- Views on the live event: student 1 (once, despite two opens) + student 2 = 2.
    -- Not 3, which is what counting the officer would give; not 1, which is what recording nothing
    -- for student 2 would give; not 4, which is what not de-duplicating would give.
    IF (v_ev->>'views')::int = 2 THEN
      r := r || E'TEST 6  two opens by one student = one view ......... PASS\n'
             || E'TEST 9  a second student''s open is recorded ......... PASS\n'
             || E'TEST 10 the officer''s own open is not counted ........ PASS (live event: 2 views)\n';
    ELSE
      r := r || format(E'TEST 6/9/10 views on the live event .................. *** FAIL — expected 2, got %s ***\n', v_ev->>'views');
      pass_all := false;
    END IF;

    -- Test 7: nothing for the draft (absent from the result), the members-only event, or the old one
    -- beyond the 2 that were already in its total.
    SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json->'events') ev WHERE (ev->>'id')::bigint = v_draft)
       AND (SELECT (ev->>'views')::int FROM jsonb_array_elements(v_json->'events') ev WHERE (ev->>'id')::bigint = v_members) = 0
       AND (SELECT (ev->>'views')::int FROM jsonb_array_elements(v_json->'events') ev WHERE (ev->>'id')::bigint = v_old) = 2
      INTO v_got;
    IF v_got THEN
      r := r || E'TEST 7  draft / members-only / past-window not counted PASS\n';
    ELSE
      r := r || E'TEST 7  draft / members-only / past-window not counted *** FAIL ***\n';
      pass_all := false;
    END IF;

    -- Test 11: every number. rsvps 3, came 1, self_reported 1, walk_ins 1, cancelled 1, saves 1,
    -- followers 1, one poll with one vote.
    SELECT (v_ev->>'rsvps')::int = 3 AND (v_ev->>'came')::int = 1 AND (v_ev->>'self_reported')::int = 1
       AND (v_ev->>'walk_ins')::int = 1 AND (v_ev->>'cancelled')::int = 1 AND (v_ev->>'saves')::int = 1
       AND (v_json->'followers'->>'total')::int = 1
       AND jsonb_array_length(v_json->'polls') = 1
       AND (v_json->'polls'->0->>'total_votes')::int = 1
      INTO v_got;
    IF v_got THEN
      r := r || E'TEST 11 every number, walk-in case included .......... PASS (rsvps 3, came 1, self-reported 1, walk-ins 1, cancelled 1)\n';
    ELSE
      r := r || format(E'TEST 11 every number, walk-in case included .......... *** FAIL — got %s ***\n', v_ev::text);
      pass_all := false;
    END IF;

    -- Test 12: the result is numbers. No id of any student appears anywhere in it.
    IF position(v_s1::text IN v_json::text) = 0 AND position(v_s2::text IN v_json::text) = 0
       AND position(v_officer::text IN v_json::text) = 0 THEN
      r := r || E'TEST 12 no student id anywhere in the result ......... PASS\n';
    ELSE
      r := r || E'TEST 12 no student id anywhere in the result ......... *** FAIL — A USER ID IS IN THE ANALYTICS ***\n';
      pass_all := false;
    END IF;
  END IF;


  r := r || E'\n' || CASE WHEN pass_all
       THEN 'ALL TESTS PASSED. Views are counted once per student, never for the club''s own officers,'
            || E'\nnever for drafts or events a student could not see; nobody but the analytics function can'
            || E'\nread them; and what comes back is numbers, with no student in it.'
       ELSE '*** SOME TESTS FAILED — read the lines marked FAIL above. ***' END;

  r := r || E'\n\nThis ran as role `authenticated`, so row level security was genuinely consulted.'
         || E'\nNothing it created remains: the raise below rolls all of it back.'
         || E'\nThe id sequences advanced and do not roll back. That is normal and harmless.';

  RAISE EXCEPTION E'%\n', r;
END
$verify$;
