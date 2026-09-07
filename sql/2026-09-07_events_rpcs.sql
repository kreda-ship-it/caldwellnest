-- The events RPCs: registration, the door, cancellation, feedback
-- 2026-09-07  ·  Session E1 of docs/nestrel-events-door-feedback-plan.md
--
-- Run AFTER sql/2026-09-07_events_schema.sql. Safe to re-run.
--
-- ############################################################################
-- WHY THESE EXIST AT ALL
-- ############################################################################
-- The RLS policies in the schema file are the floor: they decide which ROWS a
-- student may touch. Three things cannot be expressed as a policy and live here:
--
--   1. CAPACITY. A policy cannot count rows safely against a concurrent insert.
--      Two students tapping the last seat is a real race and a client-side count
--      always loses it. register_for_event() locks the event row, counts, and
--      inserts in one transaction.
--   2. ATTENDANCE. A student must never write their own checked_in status. The
--      policy forbids it; these SECURITY DEFINER functions are the only path that
--      can, and they check can_act() before they do.
--   3. THE AUDIT TRAIL. See the note below.
--
-- ############################################################################
-- A DECISION ABOUT LOGGING, MADE DELIBERATELY AND WORTH OVERRULING IF YOU DISAGREE
-- ############################################################################
-- The house pattern is: the RPC writes the data, and JavaScript calls logEvent()
-- afterwards (js/listings.js:986 after change_listing_status). The events plan
-- claimed change_listing_status logs internally and used that as precedent. It does
-- not — the plan was wrong, and the pattern is the other way around.
--
-- These functions SPLIT the difference rather than following either rule blindly:
--
--   * The DOOR functions log inside the transaction — check_in_attendee(),
--     undo_check_in(), add_walk_in(), cancel_event(). For these the log IS the
--     product: "how much of our attendance is officer-verified" is the question an
--     advisor asks, and an answer that depends on the browser having stayed open
--     long enough to fire a second request is not an answer. A check-in that
--     succeeds while its log write is lost leaves no trace that it happened.
--
--   * REGISTRATION follows the house pattern — register_for_event() and
--     cancel_registration() write no log row. A student registering is not an
--     administrative action, and admin_activity_log is the admin log.
--
-- Every log row here uses target_type = 'event'. The table is admin_activity_log
-- and the column is target_type — NOT activity_log / entity_type, which is what the
-- plan said and what §12 C3 of the campus engagement plan already corrected once.


-- ============================================================================
-- 1. register_for_event
-- ============================================================================
-- The lock is the whole point. `for update` on the events row serialises every
-- concurrent registration for THAT event and nothing else, so two students racing
-- for the last seat queue instead of both winning. Without it the count and the
-- insert are two statements with a gap between them, and the gap is the bug.
create or replace function public.register_for_event(p_event_id bigint)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event   public.events%rowtype;
  v_taken   integer;
  v_name    text;
  v_email   text;
  v_id      bigint;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Event not found'; end if;

  if v_event.status <> 'published' then
    raise exception 'This event is not open for registration';
  end if;
  if not v_event.registration_open then
    raise exception 'Registration is closed for this event';
  end if;

  select coalesce(first_name || ' ' || last_name, display_name, 'Student'), email
    into v_name, v_email
    from public.profiles where id = auth.uid();
  -- first_name and last_name are NOT NULL on profiles, so a null v_name here means no
  -- profile row at all, not a half-filled one. profiles.email IS nullable, though, while
  -- email_at_signup is NOT NULL — hence the coalesce below. Without it a student with no
  -- email on their profile gets a raw constraint error instead of a registration.
  if v_name is null then raise exception 'No profile for this account'; end if;

  -- A previously cancelled registration is REVIVED rather than duplicated: the
  -- unique (event_id, user_id) pair would reject a second insert, and a student who
  -- changes their mind twice is not an error.
  update public.event_registrations
     set status = 'registered', created_at = now()
   where event_id = p_event_id and user_id = auth.uid() and status = 'cancelled'
   returning id into v_id;
  if v_id is not null then return v_id; end if;

  if v_event.capacity is not null then
    select count(*) into v_taken
      from public.event_registrations
     where event_id = p_event_id
       and status in ('registered','self_reported','checked_in','walk_in');
    if v_taken >= v_event.capacity then
      raise exception 'This event is full';
    end if;
  end if;

  insert into public.event_registrations
         (event_id, user_id, name_at_signup, email_at_signup, status)
  values (p_event_id, auth.uid(), v_name, coalesce(v_email, ''), 'registered')
  returning id into v_id;

  return v_id;
end;
$function$;


-- ============================================================================
-- 2. cancel_registration
-- ============================================================================
-- The row is kept, not deleted. The seat is freed because the capacity count above
-- ignores 'cancelled', and the history survives — an officer looking at a
-- half-empty room can see that twelve people signed up and cancelled.
create or replace function public.cancel_registration(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.event_registrations
     set status = 'cancelled'
   where event_id = p_event_id
     and user_id = auth.uid()
     and status in ('registered','self_reported');
  if not found then raise exception 'No active registration to cancel'; end if;
end;
$function$;


-- ============================================================================
-- 3. self_report_arrival  —  the student taps "I'm here"
-- ============================================================================
-- Three outcomes in one function, because from the student's side it is one tap:
--   trusted event  -> checked_in immediately, method 'self_auto'
--   normal event   -> self_reported, waiting for an officer, method stays NULL
--   not registered -> registers first, then either of the above
--
-- The check-in window defaults are computed here rather than stored, so an officer
-- who never opens the advanced fields still gets a sensible door: open an hour
-- before, close an hour after the effective end.
create or replace function public.self_report_arrival(p_event_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event  public.events%rowtype;
  v_opens  timestamptz;
  v_closes timestamptz;
  v_status text;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if v_event.status <> 'published' then raise exception 'This event is not open'; end if;

  v_opens  := coalesce(v_event.checkin_opens_at,  v_event.starts_at - interval '1 hour');
  v_closes := coalesce(v_event.checkin_closes_at,
                       coalesce(v_event.ends_at, v_event.starts_at + interval '3 hours')
                       + interval '1 hour');
  if now() < v_opens or now() > v_closes then
    raise exception 'Check-in is not open for this event';
  end if;

  select status into v_status
    from public.event_registrations
   where event_id = p_event_id and user_id = auth.uid();

  if v_status is null or v_status = 'cancelled' then
    perform public.register_for_event(p_event_id);   -- raises if full or closed
  elsif v_status in ('checked_in','walk_in') then
    return 'checked_in';                             -- already in, tapping again is harmless
  end if;

  if v_event.trust_self_checkin then
    update public.event_registrations
       set status = 'checked_in', check_in_method = 'self_auto',
           self_reported_at = now(), checked_in_at = now()
     where event_id = p_event_id and user_id = auth.uid();
    return 'checked_in';
  else
    update public.event_registrations
       set status = 'self_reported', self_reported_at = now()
     where event_id = p_event_id and user_id = auth.uid();
    return 'self_reported';
  end if;
end;
$function$;


-- ============================================================================
-- 4. check_in_attendee  —  the officer taps
-- ============================================================================
-- Gated on 'check_in', NOT 'manage_events'. A first-year working one door for one
-- evening holds this flag and nothing else, and that separation is the entire
-- reason the flag was frozen narrow.
--
-- p_method is NOT a free parameter: it is validated against the two values an
-- officer action can legitimately produce. 'self_auto' and 'walk_in' are written by
-- their own functions, never passed in from a client.
create or replace function public.check_in_attendee(p_registration_id bigint, p_method text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reg   public.event_registrations%rowtype;
  v_event public.events%rowtype;
begin
  if p_method not in ('officer','self_confirmed') then
    raise exception 'Invalid check-in method: %', p_method;
  end if;

  select * into v_reg from public.event_registrations where id = p_registration_id for update;
  if not found then raise exception 'Registration not found'; end if;

  select * into v_event from public.events where id = v_reg.event_id;
  if not public.can_act('check_in', v_event.org_id) then
    raise exception 'Not authorized to check in for this event';
  end if;

  -- Two officers tapping the same student at the same moment must not double-count.
  -- The row lock above serialises them and this makes the second one a no-op rather
  -- than an error: the officer sees the student checked in, which is the truth.
  if v_reg.status in ('checked_in','walk_in') then return; end if;

  update public.event_registrations
     set status = 'checked_in', check_in_method = p_method,
         checked_in_at = now(), checked_in_by = auth.uid()
   where id = p_registration_id;

  insert into public.admin_activity_log
         (actor_id, action_type, target_type, target_id, target_label, school, metadata)
  values (auth.uid(), 'event_check_in', 'event', v_event.id::text, v_event.title,
          v_event.school,
          jsonb_build_object('registration_id', p_registration_id,
                             'check_in_method', p_method,
                             'attendee', v_reg.name_at_signup));
end;
$function$;


-- ============================================================================
-- 5. undo_check_in
-- ============================================================================
-- §5 of the plan: a five-second Undo, not a confirmation dialog. Confirmations at a
-- door slow a line that is already forming, so the mistake is made cheap to reverse
-- instead of being made hard to make.
create or replace function public.undo_check_in(p_registration_id bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reg   public.event_registrations%rowtype;
  v_event public.events%rowtype;
begin
  select * into v_reg from public.event_registrations where id = p_registration_id for update;
  if not found then raise exception 'Registration not found'; end if;

  select * into v_event from public.events where id = v_reg.event_id;
  if not public.can_act('check_in', v_event.org_id) then
    raise exception 'Not authorized';
  end if;

  -- A walk-in has no earlier state to return to — the row exists only because
  -- somebody walked in — so undoing one removes it. A registered student returns to
  -- 'registered' and can be found by name again.
  if v_reg.status = 'walk_in' then
    delete from public.event_registrations where id = p_registration_id;
  else
    update public.event_registrations
       set status = 'registered', check_in_method = null,
           checked_in_at = null, checked_in_by = null
     where id = p_registration_id;
  end if;

  insert into public.admin_activity_log
         (actor_id, action_type, target_type, target_id, target_label, school, metadata)
  values (auth.uid(), 'event_check_in_undone', 'event', v_event.id::text, v_event.title,
          v_event.school,
          jsonb_build_object('registration_id', p_registration_id,
                             'attendee', v_reg.name_at_signup,
                             'was_method', v_reg.check_in_method));
end;
$function$;


-- ============================================================================
-- 6. add_walk_in
-- ============================================================================
-- The row stands on its own with a NULL user_id when the email matches no profile.
-- That nullability is the reason this file exists in the shape it does, and it is
-- the thing most likely to be "tidied" by a future session into NOT NULL — which
-- would break the door for exactly the people it is meant to serve.
create or replace function public.add_walk_in(p_event_id bigint, p_name text, p_email text)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event public.events%rowtype;
  v_user  uuid;
  v_id    bigint;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'A name is required'; end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if not public.can_act('check_in', v_event.org_id) then
    raise exception 'Not authorized to check in for this event';
  end if;

  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));

  -- A walk-in whose email matches someone who ALREADY registered is not a new row:
  -- it is that person arriving. Checking them in on their existing row keeps the
  -- unique pair intact and stops the same human being counted twice.
  if v_user is not null then
    update public.event_registrations
       set status = 'walk_in', check_in_method = 'walk_in',
           checked_in_at = now(), checked_in_by = auth.uid()
     where event_id = p_event_id and user_id = v_user
     returning id into v_id;
  end if;

  if v_id is null then
    insert into public.event_registrations
           (event_id, user_id, name_at_signup, email_at_signup, status,
            check_in_method, checked_in_at, checked_in_by)
    values (p_event_id, v_user, trim(p_name), coalesce(trim(p_email), ''), 'walk_in',
            'walk_in', now(), auth.uid())
    returning id into v_id;
  end if;

  insert into public.admin_activity_log
         (actor_id, action_type, target_type, target_id, target_label, school, metadata)
  values (auth.uid(), 'event_walk_in', 'event', v_event.id::text, v_event.title,
          v_event.school,
          jsonb_build_object('registration_id', v_id, 'attendee', trim(p_name),
                             'matched_profile', v_user is not null));
  return v_id;
end;
$function$;


-- ============================================================================
-- 7. cancel_event
-- ============================================================================
-- The reason is required by a check constraint on the table as well as by this
-- function. Two enforcements of the same rule is deliberate: §6 makes the reason the
-- ENTIRE mitigation for having no notification layer, because it is the only thing
-- a registrant who opens the app will read.
create or replace function public.cancel_event(p_event_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event public.events%rowtype;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A cancellation reason is required';
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if not public.can_act('manage_events', v_event.org_id) then
    raise exception 'Not authorized to cancel this event';
  end if;

  update public.events
     set status = 'cancelled', cancelled_reason = trim(p_reason), updated_at = now()
   where id = p_event_id;

  insert into public.admin_activity_log
         (actor_id, action_type, target_type, target_id, target_label, school,
          reason, before_state, after_state)
  values (auth.uid(), 'event_cancelled', 'event', p_event_id::text, v_event.title,
          v_event.school, trim(p_reason),
          jsonb_build_object('status', v_event.status),
          jsonb_build_object('status', 'cancelled'));
end;
$function$;


-- ============================================================================
-- 8. get_event_feedback
-- ============================================================================
-- THE SUPPRESSION LIVES HERE, NOT IN THE UI. A suppression rule enforced only in
-- JavaScript is not a suppression rule — anyone can open the network tab.
--
-- Below five responses the average is NULL and the officer sees "3 responses — not
-- enough to summarise yet". The comments are still returned, because they are the
-- useful part and they carry no identity. No user_id is returned at any count.
--
-- Comments are ordered by rating, NOT by time, precisely so the order cannot be
-- lined up against the order people walked through the door.
create or replace function public.get_event_feedback(p_event_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_event  public.events%rowtype;
  v_count  integer;
  v_avg    numeric;
  v_notes  jsonb;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Event not found'; end if;
  if not public.can_act('view_analytics', v_event.org_id) then
    raise exception 'Not authorized to view feedback for this event';
  end if;

  select count(*), round(avg(rating), 2) into v_count, v_avg
    from public.event_feedback where event_id = p_event_id;

  select coalesce(jsonb_agg(c.comment order by c.rating, c.id), '[]'::jsonb) into v_notes
    from public.event_feedback c
   where c.event_id = p_event_id
     and coalesce(trim(c.comment), '') <> '';

  return jsonb_build_object(
    'count',    v_count,
    'avg',      case when v_count >= 5 then v_avg else null end,
    'comments', v_notes,
    'suppressed', v_count < 5
  );
end;
$function$;


-- ============================================================================
-- 9. Execute grants
-- ============================================================================
-- Postgres grants EXECUTE on new functions to PUBLIC by default, which includes
-- anon. Every function here is SECURITY DEFINER, so an anon caller would run as the
-- owner — revoke first, then grant to authenticated only. This is the function
-- equivalent of the table revoke block, and it is missed even more often.
revoke all on function public.register_for_event(bigint)              from public, anon;
revoke all on function public.cancel_registration(bigint)             from public, anon;
revoke all on function public.self_report_arrival(bigint)             from public, anon;
revoke all on function public.check_in_attendee(bigint, text)         from public, anon;
revoke all on function public.undo_check_in(bigint)                   from public, anon;
revoke all on function public.add_walk_in(bigint, text, text)         from public, anon;
revoke all on function public.cancel_event(bigint, text)              from public, anon;
revoke all on function public.get_event_feedback(bigint)              from public, anon;

grant execute on function public.register_for_event(bigint)      to authenticated;
grant execute on function public.cancel_registration(bigint)     to authenticated;
grant execute on function public.self_report_arrival(bigint)     to authenticated;
grant execute on function public.check_in_attendee(bigint, text) to authenticated;
grant execute on function public.undo_check_in(bigint)           to authenticated;
grant execute on function public.add_walk_in(bigint, text, text) to authenticated;
grant execute on function public.cancel_event(bigint, text)      to authenticated;
grant execute on function public.get_event_feedback(bigint)      to authenticated;

notify pgrst, 'reload schema';
