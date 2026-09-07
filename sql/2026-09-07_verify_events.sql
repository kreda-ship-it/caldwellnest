-- Verify the events schema, its policies and its RPCs
-- 2026-09-07  ·  Session E1 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Reports by raising an exception. THE ERROR MESSAGE IS THE REPORT, and the raise is also
-- what discards every row this file creates. Nothing is left behind.
--
-- Run it AFTER 2026-09-07_events_schema.sql and 2026-09-07_events_rpcs.sql.
--
--
-- HOW THIS FILE SPEAKS AS A STUDENT
-- The SQL editor connects as a role that BYPASSES row level security. A policy test written
-- without impersonation is not a lenient test — it is not a test at all, and it passes.
-- So every assertion past the role switch does
--     set_config('role','authenticated')  +  set_config('request.jwt.claims', …)
-- exactly as 2026-09-06_verify_org_visibility.sql does. Fixtures are created BEFORE the
-- switch, because after it nothing can be created.
--
--
-- THE CONTROL TESTS MATTER MORE THAN THE REFUSALS
-- A policy set that refuses everything passes every "cannot" below and ships an events
-- section where no officer can create an event and no student can register. TEST 2, TEST 5b
-- and TEST 10b are the controls. If a refusal passes and its control fails, the system is
-- broken shut, which looks exactly like security until someone tries to use it.
--
--
-- WHAT THIS FILE CANNOT TEST, STATED PLAINLY
-- 1. TEST 12 checks security_invoker structurally, from pg_class.reloptions, not
--    behaviourally. Today the view's own WHERE (published, not members_only) and the events
--    SELECT policy overlap almost exactly, so no student-visible row separates them. The
--    behavioural difference only becomes observable when members_only gating is built — which
--    is precisely when a missing security_invoker would start leaking. Structural now,
--    behavioural then; do not read this pass as covering that future case.
-- 2. TEST 9 needs FIVE students with check-in rows, because five is the suppression
--    threshold and a threshold cannot be tested from one side. If the database holds fewer
--    than five non-admin profiles the test reports SKIP rather than a false pass.
-- 3. The door's concurrency claim (two officers tapping the same student) is asserted here
--    as a single-session no-op, which is what the `if already checked in then return` guard
--    does. Genuine simultaneity needs two sessions and is an E5 manual test.


DO $verify$
DECLARE
  v_users      uuid[];
  v_officer_a  uuid;   -- officer of club A, holds manage_events + check_in
  v_officer_b  uuid;   -- officer of club B, holds manage_events on B only
  v_student    uuid;   -- no membership anywhere. The absence is the fixture.
  v_raters     uuid[];
  v_school     text;
  v_school_org bigint;
  v_club_a     bigint;
  v_club_b     bigint;
  v_ev         bigint;   -- club A, published, capacity 1
  v_ev_cancel  bigint;   -- club A, cancelled
  v_ev_old     bigint;   -- club A, ended 30 days ago — outside the feedback window
  v_ev_rate    bigint;   -- club A, ended yesterday — inside the window
  v_ev_b       bigint;   -- club B, for the cross-club refusal
  v_reg        bigint;
  v_got        boolean;
  v_n          integer;
  v_txt        text;
  v_fb         jsonb;
  r            text := E'\n\n================ VERIFY EVENTS (2026-09-07) ================\n';
  pass_all     boolean := true;
BEGIN

  -- ======================================================================
  -- CAST
  -- ======================================================================
  SELECT array_agg(id) INTO v_users FROM (
    SELECT p.id FROM public.profiles p
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    ORDER BY p.created_at
    LIMIT 8
  ) t;

  IF v_users IS NULL OR array_length(v_users, 1) < 3 THEN
    RAISE EXCEPTION E'\nThis file needs at least THREE non-admin student accounts and found %.\nTwo officers of DIFFERENT clubs and one outsider are three different people: the whole\nquestion is what each of them cannot do to the others.\n',
      coalesce(array_length(v_users, 1), 0);
  END IF;

  v_officer_a := v_users[1];
  v_officer_b := v_users[2];
  v_student   := v_users[3];

  r := r || format(E'\nOfficer A (club A):  %s\nOfficer B (club B):  %s\nOutsider:            %s\nProfiles available:  %s\n\n',
                   v_officer_a, v_officer_b, v_student, array_length(v_users, 1));


  -- ======================================================================
  -- FIXTURES — all of it, before the role switch
  -- ======================================================================
  INSERT INTO public.schools (name, slug, email_domain)
  VALUES ('Verify Events School', 'verify-ev', 'verify-ev.invalid')
  RETURNING slug INTO v_school;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, NULL, 'school', 'Verify Ev School', 've-school')
  RETURNING id INTO v_school_org;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'club', 'Verify Ev Club A', 've-club-a')
  RETURNING id INTO v_club_a;

  INSERT INTO public.organizations (school, parent_id, type, name, slug)
  VALUES (v_school, v_school_org, 'club', 'Verify Ev Club B', 've-club-b')
  RETURNING id INTO v_club_b;

  -- Officer A gets BOTH events flags. Officer B gets manage_events on club B only.
  -- Neither is a school admin: TEST 3 needs authority that flows DOWN from the school row,
  -- so officer B is promoted onto the school org later in its own test.
  -- can_view_analytics is here because get_event_feedback() requires it, NOT because a
  -- president needs every flag. The first run of this file failed on exactly this: the
  -- fixture gave officer A manage_events and check_in and the function refused them. That
  -- refusal was correct, and it exposed a contradiction in the plan — §3.2 put the feedback
  -- summary inside the Recap section and gave Recap to can_manage_events, while §2 guards
  -- the function with view_analytics. TEST 9c below now pins the resolution: the summary is
  -- analytics, the photos are not.
  INSERT INTO public.org_memberships
         (org_id, user_id, role, title, status, can_post, can_manage_events, can_check_in,
          can_view_analytics)
  VALUES (v_club_a, v_officer_a, 'officer', 'President', 'active', true, true, true, true);

  INSERT INTO public.org_memberships
         (org_id, user_id, role, title, status, can_post, can_manage_events)
  VALUES (v_club_b, v_officer_b, 'officer', 'President', 'active', true, true);

  -- v_student gets no membership anywhere.

  INSERT INTO public.events (school, org_id, created_by, title, event_type,
                             starts_at, ends_at, location, registration_open, capacity)
  VALUES (v_school, v_club_a, v_officer_a, 'Capacity Of One', 'social',
          now() + interval '2 days', now() + interval '2 days 3 hours',
          'Main Hall Lawn', true, 1)
  RETURNING id INTO v_ev;

  INSERT INTO public.events (school, org_id, created_by, title, event_type,
                             starts_at, ends_at, location, status, cancelled_reason)
  VALUES (v_school, v_club_a, v_officer_a, 'Called Off', 'social',
          now() + interval '3 days', now() + interval '3 days 2 hours',
          'Room 201', 'cancelled', 'Snow.')
  RETURNING id INTO v_ev_cancel;

  INSERT INTO public.events (school, org_id, created_by, title, event_type,
                             starts_at, ends_at, location)
  VALUES (v_school, v_club_a, v_officer_a, 'Long Over', 'social',
          now() - interval '31 days', now() - interval '30 days 22 hours', 'Gym')
  RETURNING id INTO v_ev_old;

  INSERT INTO public.events (school, org_id, created_by, title, event_type,
                             starts_at, ends_at, location)
  VALUES (v_school, v_club_a, v_officer_a, 'Just Finished', 'social',
          now() - interval '1 day 3 hours', now() - interval '1 day', 'Gym')
  RETURNING id INTO v_ev_rate;

  INSERT INTO public.events (school, org_id, created_by, title, event_type,
                             starts_at, ends_at, location)
  VALUES (v_school, v_club_b, v_officer_b, 'Club B Event', 'social',
          now() + interval '4 days', now() + interval '4 days 2 hours', 'Room 12')
  RETURNING id INTO v_ev_b;

  -- The outsider is a REGISTRANT of the cancelled event. TEST 10 turns on this row:
  -- §6 makes "still reachable by its registrants, with the reason" the entire mitigation
  -- for having no notification layer, and that promise lives in the SELECT policy.
  INSERT INTO public.event_registrations
         (event_id, user_id, name_at_signup, email_at_signup, status)
  VALUES (v_ev_cancel, v_student, 'Test Student', 'test@verify-ev.invalid', 'registered');

  -- Checked in at the just-finished event, so feedback has a leg to stand on.
  INSERT INTO public.event_registrations
         (event_id, user_id, name_at_signup, email_at_signup, status, check_in_method,
          checked_in_at, checked_in_by)
  VALUES (v_ev_rate, v_student, 'Test Student', 'test@verify-ev.invalid', 'checked_in',
          'officer', now() - interval '1 day 1 hour', v_officer_a);

  -- Checked in at the LONG OVER event too — so TEST 8 fails on the window and nothing else.
  INSERT INTO public.event_registrations
         (event_id, user_id, name_at_signup, email_at_signup, status, check_in_method,
          checked_in_at, checked_in_by)
  VALUES (v_ev_old, v_student, 'Test Student', 'test@verify-ev.invalid', 'checked_in',
          'officer', now() - interval '30 days 23 hours', v_officer_a);


  -- ======================================================================
  -- STRUCTURAL — no impersonation needed
  -- ======================================================================

  -- ---------- TEST 11 — anon holds nothing ----------
  -- Supabase attaches REFERENCES, TRIGGER and TRUNCATE to every new object in public before
  -- any GRANT runs, so a grant only ever ADDS. TRUNCATE is the one that matters: RLS does
  -- not apply to it, so one statement ignores every policy in the schema file.
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ')
    INTO v_txt
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee = 'anon'
    AND table_name IN ('events','event_registrations','event_media','event_feedback',
                       'visible_events');
  IF v_txt IS NULL THEN
    r := r || E'TEST 11 anon holds no privilege on the 5 objects  PASS\n';
  ELSE
    r := r || format(E'TEST 11 anon holds no privilege ................ *** FAIL — %s ***\n', v_txt);
    pass_all := false;
  END IF;

  -- ---------- TEST 11b — authenticated holds no TRUNCATE ----------
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ')
    INTO v_txt
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee = 'authenticated'
    AND privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER')
    AND table_name IN ('events','event_registrations','event_media','event_feedback',
                       'visible_events');
  IF v_txt IS NULL THEN
    r := r || E'TEST 11b authenticated has no TRUNCATE/REFS/TRIG  PASS\n';
  ELSE
    r := r || format(E'TEST 11b default privileges not revoked ........ *** FAIL — %s ***\n', v_txt);
    pass_all := false;
  END IF;

  -- ---------- TEST 12 — visible_events is security_invoker ----------
  -- Structural, and the header says why it cannot be behavioural yet. Without this the view
  -- runs as its OWNER and the SELECT policy never reaches the caller.
  SELECT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'visible_events'
      AND relnamespace = 'public'::regnamespace
      AND array_to_string(reloptions, ',') LIKE '%security_invoker=%'
  ) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 12 visible_events is security_invoker ...... PASS\n';
  ELSE
    r := r || E'TEST 12 visible_events is security_invoker ...... *** FAIL — RUNS AS OWNER, RLS BYPASSED ***\n';
    pass_all := false;
  END IF;


  -- ======================================================================
  -- BECOME AN ORDINARY STUDENT. Nothing can be created past this line.
  -- ======================================================================
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_student), true);


  -- ---------- TEST 1 — a non-officer cannot insert an event ----------
  BEGIN
    INSERT INTO public.events (school, org_id, created_by, title, event_type,
                               starts_at, location)
    VALUES (v_school, v_club_a, v_student, 'Not Allowed', 'social',
            now() + interval '1 day', 'Nowhere');
    r := r || E'TEST 1  outsider cannot create an event ......... *** FAIL — THE ROW WAS WRITTEN ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    r := r || E'TEST 1  outsider cannot create an event ......... PASS (refused)\n';
  END;

  -- ---------- TEST 10 — cancelled event: hidden from the feed, readable by its registrant ----------
  SELECT EXISTS (SELECT 1 FROM public.visible_events WHERE id = v_ev_cancel) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 10 cancelled event absent from the feed .... *** FAIL — STILL IN visible_events ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 10 cancelled event absent from the feed .... PASS\n';
  END IF;

  -- ---------- TEST 10b — CONTROL. The registrant can still reach it ----------
  -- Without this, TEST 10 is equally satisfied by a policy that hides cancelled events from
  -- everyone including the people who signed up — which is the failure §6 is written to stop.
  SELECT EXISTS (SELECT 1 FROM public.events WHERE id = v_ev_cancel) INTO v_got;
  IF v_got THEN
    r := r || E'TEST 10b registrant still reaches it (control) .. PASS\n';
  ELSE
    r := r || E'TEST 10b registrant still reaches it (control) .. *** FAIL — INVISIBLE TO ITS OWN REGISTRANT ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 6 — a student cannot write their own attendance ----------
  -- The escalation that makes the whole door theatre. The policy's WITH CHECK lists the
  -- statuses a student may leave the row in, and checked_in is not among them.
  SELECT id INTO v_reg FROM public.event_registrations
   WHERE event_id = v_ev_cancel AND user_id = v_student;
  BEGIN
    UPDATE public.event_registrations
       SET status = 'checked_in', check_in_method = 'officer', checked_in_at = now()
     WHERE id = v_reg;
    IF FOUND THEN
      r := r || E'TEST 6  student cannot self-check-in ............ *** FAIL — WROTE checked_in ***\n';
      pass_all := false;
    ELSE
      r := r || E'TEST 6  student cannot self-check-in ............ PASS (no row updated)\n';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    r := r || E'TEST 6  student cannot self-check-in ............ PASS (refused)\n';
  END;

  -- ---------- TEST 5b — CONTROL. Registration works at all ----------
  PERFORM public.register_for_event(v_ev);
  SELECT count(*) INTO v_n FROM public.event_registrations
   WHERE event_id = v_ev AND user_id = v_student AND status = 'registered';
  IF v_n = 1 THEN
    r := r || E'TEST 5b registration succeeds (control) ......... PASS\n';
  ELSE
    r := r || E'TEST 5b registration succeeds (control) ......... *** FAIL — NOBODY CAN REGISTER ***\n';
    pass_all := false;
  END IF;

  -- ---------- TEST 7 — feedback without a check-in row is refused ----------
  -- v_ev has a registration but NO check-in. Registering and not showing up earns no
  -- opinion: that is the whole of §1.6 and it is enforced in the policy, not the UI.
  BEGIN
    INSERT INTO public.event_feedback (school, event_id, user_id, rating, comment)
    VALUES (v_school, v_ev, v_student, 5, 'I did not go.');
    r := r || E'TEST 7  feedback needs a check-in row ........... *** FAIL — ACCEPTED ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    r := r || E'TEST 7  feedback needs a check-in row ........... PASS (refused)\n';
  END;

  -- ---------- TEST 8 — feedback outside the 7-day window is refused ----------
  -- v_ev_old HAS a check-in row, so only the window can be refusing this one.
  BEGIN
    INSERT INTO public.event_feedback (school, event_id, user_id, rating)
    VALUES (v_school, v_ev_old, v_student, 5);
    r := r || E'TEST 8  feedback outside the 7-day window ....... *** FAIL — ACCEPTED ***\n';
    pass_all := false;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    r := r || E'TEST 8  feedback outside the 7-day window ....... PASS (refused)\n';
  END;

  -- ---------- TEST 8b — CONTROL. Inside the window it is accepted ----------
  BEGIN
    INSERT INTO public.event_feedback (school, event_id, user_id, rating, comment)
    VALUES (v_school, v_ev_rate, v_student, 4, 'Good, a bit cold.');
    r := r || E'TEST 8b feedback inside the window (control) .... PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 8b feedback inside the window (control) .... *** FAIL — %s ***\n', SQLERRM);
    pass_all := false;
  END;


  -- ======================================================================
  -- BECOME OFFICER A
  -- ======================================================================
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer_a), true);

  -- ---------- TEST 2 — CONTROL. An officer can create an event for their own club ----------
  BEGIN
    INSERT INTO public.events (school, org_id, created_by, title, event_type,
                               starts_at, location)
    VALUES (v_school, v_club_a, v_officer_a, 'Officer Made This', 'social',
            now() + interval '5 days', 'Room 3');
    r := r || E'TEST 2  officer creates own club event (control)  PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 2  officer creates own club event .......... *** FAIL — %s ***\n', SQLERRM);
    pass_all := false;
  END;

  -- ---------- TEST 4 — a club officer cannot edit ANOTHER club's event ----------
  -- can_act() walks UP from the event's org, so officer A on club A never reaches club B.
  UPDATE public.events SET title = 'Hijacked' WHERE id = v_ev_b;
  IF FOUND THEN
    r := r || E'TEST 4  officer A cannot edit club B''s event .... *** FAIL — EDITED IT ***\n';
    pass_all := false;
  ELSE
    r := r || E'TEST 4  officer A cannot edit club B''s event .... PASS (no row updated)\n';
  END IF;

  -- ---------- TEST 5 — the last seat cannot be oversold ----------
  -- v_ev has capacity 1 and the outsider already took it in TEST 5b.
  BEGIN
    PERFORM public.register_for_event(v_ev);
    r := r || E'TEST 5  registering past capacity fails ......... *** FAIL — SOLD SEAT TWO ***\n';
    pass_all := false;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%full%' THEN
      r := r || E'TEST 5  registering past capacity fails ......... PASS (refused: full)\n';
    ELSE
      r := r || format(E'TEST 5  registering past capacity fails ......... *** FAIL — WRONG ERROR: %s ***\n', SQLERRM);
      pass_all := false;
    END IF;
  END;

  -- ---------- TEST 9 — get_event_feedback suppresses below five ----------
  SELECT public.get_event_feedback(v_ev_rate) INTO v_fb;
  IF (v_fb->>'count')::int < 5 AND v_fb->>'avg' IS NULL AND (v_fb->>'suppressed')::boolean THEN
    r := r || format(E'TEST 9  average suppressed at %s responses ....... PASS\n', v_fb->>'count');
  ELSE
    r := r || format(E'TEST 9  average suppressed below five ........... *** FAIL — %s ***\n', v_fb::text);
    pass_all := false;
  END IF;

  -- ---------- TEST 9b — and returns a number at five ----------
  -- Needs five DIFFERENT people, because five is the threshold and a threshold cannot be
  -- tested from one side. Written as the owner rather than through the policy: this test is
  -- about the FUNCTION's suppression, and tests 7 and 8 already cover the policy.
  IF array_length(v_users, 1) >= 5 THEN
    PERFORM set_config('role', 'postgres', true);
    FOR v_n IN 4..array_length(v_users, 1) LOOP
      EXIT WHEN (SELECT count(*) FROM public.event_feedback WHERE event_id = v_ev_rate) >= 5;
      INSERT INTO public.event_registrations
             (event_id, user_id, name_at_signup, email_at_signup, status, check_in_method,
              checked_in_at, checked_in_by)
      VALUES (v_ev_rate, v_users[v_n], 'Rater', 'r@verify-ev.invalid', 'checked_in',
              'officer', now() - interval '1 day', v_officer_a)
      ON CONFLICT DO NOTHING;
      INSERT INTO public.event_feedback (school, event_id, user_id, rating)
      VALUES (v_school, v_ev_rate, v_users[v_n], 5)
      ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM set_config('role', 'authenticated', true);

    SELECT public.get_event_feedback(v_ev_rate) INTO v_fb;
    IF (v_fb->>'count')::int >= 5 AND v_fb->>'avg' IS NOT NULL THEN
      r := r || format(E'TEST 9b average returned at %s responses ........ PASS (avg %s)\n',
                       v_fb->>'count', v_fb->>'avg');
    ELSE
      r := r || format(E'TEST 9b average returned at five ............... *** FAIL — %s ***\n', v_fb::text);
      pass_all := false;
    END IF;
  ELSE
    r := r || format(E'TEST 9b average returned at five ............... SKIP (needs 5 students, found %s)\n',
                     array_length(v_users, 1));
  END IF;


  -- ======================================================================
  -- TEST 3 — authority flows DOWN: a school admin edits a club's event
  -- ======================================================================
  -- Officer B is promoted onto the SCHOOL organization, then edits club A's event. can_act()
  -- walks up from club A, reaches the school row, and finds them. This is the direction that
  -- must work; TEST 4 is the direction that must not.
  PERFORM set_config('role', 'postgres', true);
  INSERT INTO public.org_memberships
         (org_id, user_id, role, title, status, can_post, can_manage_events)
  VALUES (v_school_org, v_officer_b, 'officer', 'Dean', 'active', true, true);

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    format('{"role":"authenticated","sub":"%s"}', v_officer_b), true);

  UPDATE public.events SET title = 'Edited By The School' WHERE id = v_ev;
  IF FOUND THEN
    r := r || E'TEST 3  school admin edits a club event ......... PASS (authority flows down)\n';
  ELSE
    r := r || E'TEST 3  school admin edits a club event ......... *** FAIL — REFUSED ***\n';
    pass_all := false;
  END IF;


  -- ---------- TEST 9c — manage_events is NOT enough to read feedback ----------
  -- Officer B now holds can_manage_events on the SCHOOL organization, so TEST 3 proved they
  -- can edit club A's event. They hold no can_view_analytics anywhere. If authority flowing
  -- down also handed them the comments, "private to the org" would mean "private to whoever
  -- can edit anything above you", which is not what a student is told when they leave one.
  BEGIN
    PERFORM public.get_event_feedback(v_ev_rate);
    r := r || E'TEST 9c manage_events alone cannot read feedback *** FAIL — RETURNED IT ***\n';
    pass_all := false;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%Not authorized%' THEN
      r := r || E'TEST 9c manage_events alone cannot read feedback PASS (refused)\n';
    ELSE
      r := r || format(E'TEST 9c manage_events alone cannot read feedback *** FAIL — WRONG ERROR: %s ***\n', SQLERRM);
      pass_all := false;
    END IF;
  END;


  -- ======================================================================
  -- REPORT — and the raise is what rolls all of this back
  -- ======================================================================
  r := r || E'\n============================================================\n';
  IF pass_all THEN
    r := r || E'RESULT: ALL PASS. Every fixture above has been rolled back.\n';
  ELSE
    r := r || E'RESULT: *** FAILURES ABOVE — DO NOT BUILD ON THIS SCHEMA ***\n';
  END IF;
  r := r || E'============================================================\n';

  RAISE EXCEPTION '%', r;
END
$verify$;
