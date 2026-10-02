-- Reported conversations: an admin reads a chat only when someone in it reported it
-- 2026-10-01
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- PUBLISH ORDER: run this together with the app change that ships the new Privacy Policy and Terms
-- (privacy.html / terms.html, "Last updated October 1, 2026"). Until that app change is live, the
-- admin Messages page keeps asking for the rule this file removes and shows nothing.
--
-- WHY
-- The Privacy Policy promised that admin screens show who messaged whom and when, not what was said.
-- The database did not keep that promise: "admins_read_all_messages" let ANY admin read the text of
-- EVERY message, and the data export downloaded all of it. Kal decided (2026-10-01) that a private
-- conversation is read only when someone in it reports it, and only up to the moment of the report.
--
-- WHAT CHANGES
--   1. reports can point at a CONVERSATION as well as a listing: kind, conversation_key,
--      reported_user_id. A conversation report needs a conversation_key and no listing.
--   2. Students' own insert rule ("students can file reports") now allows LISTING reports only. A
--      conversation report is filed only through report_conversation(), which checks the reporter is
--      in that conversation. Otherwise anyone could "report" a stranger's chat to open it.
--   3. Admins may change only status, resolution_note, resolved_by and resolved_at on a report.
--      Changing which conversation, or when, a report points at would open a different chat.
--   4. report_conversation(other, category, details) — for students; not while suspended.
--   5. read_reported_conversation(report_id) — for admins with the new read_reported_chats switch.
--      Returns that conversation's messages sent up to the moment of the report; works while the
--      report is open and for 30 days after it is closed; records every call in admin_activity_log
--      as conversation_opened.
--   6. admin_message_metadata(limit) and admin_message_count(user) — who messaged whom and when,
--      never the text, for admins with view_messages (the Messages page, dashboard and export).
--   7. "admins_read_all_messages" is DROPPED. From here no admin — the super admin included — can
--      read message text except through read_reported_conversation(). Students still read their own
--      conversations exactly as before ("Users can read own messages" is untouched).
--   8. read_reported_chats is added to every role, switched OFF. The super admin always has it.
--
-- RE-RUNNING: PART 1 is safe to run again — every step either checks first or replaces in place.
-- (It was re-run on 2026-10-01 after the reasons rule above was added.)
--
-- KNOWN SIDE EFFECT: live updates are filtered by the same rules, so the admin dashboard's message
-- count no longer refreshes by itself when two students chat; Refresh updates it.
--
-- OUTSIDE THE APP: a court order or a safety emergency is handled by the super admin directly in the
-- SQL editor, as the Privacy Policy's "Legal & safety" section describes — never by a button.
--
-- UNDO: ask Claude; the dropped rule was
--   create policy admins_read_all_messages on public.messages as permissive for select to authenticated
--     using (public.has_admin_permission('view_messages'));


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- 1. Reports can be about a conversation -----------------------------------------------------------
alter table public.reports add column if not exists kind text not null default 'listing';
alter table public.reports add column if not exists conversation_key text;
alter table public.reports add column if not exists reported_user_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reports_kind_check') then
    alter table public.reports add constraint reports_kind_check
      check (kind in ('listing', 'conversation'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reports_conversation_target_check') then
    alter table public.reports add constraint reports_conversation_target_check
      check (kind <> 'conversation' or (conversation_key is not null and listing_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reports_reported_user_id_fkey') then
    alter table public.reports add constraint reports_reported_user_id_fkey
      foreign key (reported_user_id) references public.profiles(id) on delete set null;
  end if;
end
$$;

create index if not exists reports_conversation_key_idx on public.reports (conversation_key)
  where conversation_key is not null;

-- The reasons a report may give: the listing reasons as captured on 2026-09-04
-- (2026-09-04_capture_table_definitions.sql), plus the two chat reasons report_conversation() accepts.
-- Missed in the first version of this file — the self-test caught it (2026-10-01). If the live table
-- holds a reason not on this list, adding the rule fails on that row and NOTHING in PART 1 is applied:
-- read the error rather than forcing it.
alter table public.reports drop constraint if exists reports_category_check;
alter table public.reports add constraint reports_category_check check (category = any (array[
  'scam_or_fraud', 'not_a_student', 'wrong_price', 'duplicate_listing', 'inappropriate_content',
  'suspicious', 'other', 'harassment', 'spam']));

-- 2. Students file listing reports directly; conversation reports only through the function below.
-- The live rule is "Students can file reports" — capital S. 2026-09-04_harden_policies.sql dropped
-- its lowercase twin and kept this one. The first run of this file (2026-10-01) replaced the
-- lowercase name instead, which created a new strict rule BESIDE the old loose one; rules of the same
-- kind add up, so the loose one still let a student file a conversation report directly. The self-test
-- caught it (TEST 1b). Postgres treats quoted names case by case, so both spellings are dropped here.
drop policy if exists "students can file reports" on public.reports;
drop policy if exists "Students can file reports" on public.reports;
create policy "Students can file reports" on public.reports
  as permissive for insert to authenticated
  with check (reporter_id = auth.uid() and kind = 'listing'
              and conversation_key is null and reported_user_id is null);

-- 3. Admins resolve reports; nobody re-points one.
revoke update on public.reports from anon, authenticated;
grant update (status, resolution_note, resolved_by, resolved_at) on public.reports to authenticated;


-- 4. Filing a conversation report ----------------------------------------------------------------
create or replace function public.report_conversation(p_other uuid, p_category text, p_details text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me  uuid := auth.uid();
  v_key text;
  v_id  uuid;
begin
  if v_me is null then
    raise exception 'Sign in to report a conversation' using errcode = 'insufficient_privilege';
  end if;
  -- This function runs as its owner, so the "not while suspended" rules on reports do not reach it.
  if public.is_suspended() then
    raise exception 'A suspended account cannot file reports' using errcode = 'insufficient_privilege';
  end if;
  if p_other is null or p_other = v_me then
    raise exception 'Choose the conversation to report' using errcode = 'check_violation';
  end if;
  if p_category is null or p_category not in ('harassment', 'scam_or_fraud', 'spam', 'inappropriate_content', 'other') then
    raise exception 'Unknown reason: %', p_category using errcode = 'check_violation';
  end if;
  -- 500 is the table's own limit (reports_details_check); checked here too, for a clear message.
  if char_length(coalesce(p_details, '')) > 500 then
    raise exception 'Details are limited to 500 characters' using errcode = 'check_violation';
  end if;

  -- Only a conversation you are in: there has to be a message between the two of you. The key is
  -- read from that message rather than rebuilt, so it is exactly the one messages carry.
  select m.conversation_key into v_key
  from public.messages m
  where (m.sender_id = v_me and m.receiver_id = p_other)
     or (m.sender_id = p_other and m.receiver_id = v_me)
  limit 1;
  if v_key is null then
    raise exception 'You can only report a conversation you are part of' using errcode = 'insufficient_privilege';
  end if;

  -- One open report per person per conversation: pressing Report again adds nothing.
  select r.id into v_id
  from public.reports r
  where r.kind = 'conversation' and r.conversation_key = v_key and r.reporter_id = v_me and r.status = 'open'
  limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.reports (kind, conversation_key, reported_user_id, reporter_id, category, details, status)
  values ('conversation', v_key, p_other, v_me, p_category, nullif(btrim(coalesce(p_details, '')), ''), 'open')
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.report_conversation(uuid, text, text) from public, anon;
grant execute on function public.report_conversation(uuid, text, text) to authenticated;


-- 5. Reading a reported conversation ---------------------------------------------------------------
create or replace function public.read_reported_conversation(p_report_id uuid)
returns table (id uuid, sender_id uuid, receiver_id uuid, content text, created_at timestamptz,
               listing_id bigint, book_id bigint, message_type text, reply_to uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  r public.reports%rowtype;
begin
  if not public.has_admin_permission('read_reported_chats') then
    raise exception 'Your role does not include reading reported conversations' using errcode = 'insufficient_privilege';
  end if;

  select * into r from public.reports rep where rep.id = p_report_id;
  if r.id is null or r.kind <> 'conversation' or r.conversation_key is null then
    raise exception 'That is not a reported conversation' using errcode = 'no_data_found';
  end if;
  if r.status <> 'open' and (r.resolved_at is null or r.resolved_at < now() - interval '30 days') then
    raise exception 'This conversation is locked again: its report closed more than 30 days ago' using errcode = 'insufficient_privilege';
  end if;

  -- Every opening is on the record: who, which report, when.
  insert into public.admin_activity_log (actor_id, actor_school, action_type, target_type, target_id, target_label, reason)
  values (auth.uid(), public.get_admin_school(), 'conversation_opened', 'report', r.id::text, 'Reported conversation', r.category);

  return query
    select m.id, m.sender_id, m.receiver_id, m.content, m.created_at, m.listing_id, m.book_id, m.message_type, m.reply_to
    from public.messages m
    where m.conversation_key = r.conversation_key
      and m.created_at <= r.created_at
    order by m.created_at;
end;
$function$;

revoke all on function public.read_reported_conversation(uuid) from public, anon;
grant execute on function public.read_reported_conversation(uuid) to authenticated;


-- 6. Who messaged whom, and when — never what was said ---------------------------------------------
create or replace function public.admin_message_metadata(p_limit int default 2000)
returns table (id uuid, conversation_key text, sender_id uuid, receiver_id uuid, listing_id bigint, created_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.id, m.conversation_key, m.sender_id, m.receiver_id, m.listing_id, m.created_at
  from public.messages m
  where public.has_admin_permission('view_messages')
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 2000), 1), 50000);
$function$;

-- NULL (not 0) when the caller may not know: a count of 0 would be a wrong answer, not no answer.
create or replace function public.admin_message_count(p_user uuid default null)
returns bigint
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when public.has_admin_permission('view_messages') then
    (select count(*) from public.messages m
     where p_user is null or m.sender_id = p_user or m.receiver_id = p_user)
  end;
$function$;

revoke all on function public.admin_message_metadata(int) from public, anon;
grant execute on function public.admin_message_metadata(int) to authenticated;
revoke all on function public.admin_message_count(uuid) from public, anon;
grant execute on function public.admin_message_count(uuid) to authenticated;


-- 7. No admin reads message text directly any more ---------------------------------------------------
drop policy if exists admins_read_all_messages on public.messages;


-- 8. The new switch, off for every role ---------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key, enabled)
select r.id, 'read_reported_chats', false
from public.admin_roles r
where r.id <> 'super_admin'
on conflict (role_id, permission_key) do nothing;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Two real students exchange two test messages, one reports the
-- conversation, and admins try to read it. THE ERROR MESSAGE IS THE REPORT, and the error discards
-- everything it made: the messages, the report, the roles and the log rows.
-- ============================================================================

DO $verify$
DECLARE
  v_a     uuid;   -- reports the conversation
  v_b     uuid;   -- the person reported
  v_c     uuid;   -- not in the conversation; also made a Moderator for part of the test
  v_super uuid;
  v_school text;
  v_rep   uuid;
  v_n     int;
  v_m     int;
  r       text := E'\n';
  r_rules text;
  ok      boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  SELECT (array_agg(p.id ORDER BY p.created_at))[1], (array_agg(p.id ORDER BY p.created_at))[2]
    INTO v_a, v_b
  FROM public.profiles p
  WHERE p.status = 'active' AND p.school IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id);
  -- C must never have messaged A, or TEST 2 ("cannot report a chat you are not in") would test
  -- nothing. So C is chosen for that, not simply as the next-oldest account.
  SELECT p.id INTO v_c
  FROM public.profiles p
  WHERE p.status = 'active' AND p.school IS NOT NULL AND p.id NOT IN (v_a, v_b)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.messages m
                    WHERE (m.sender_id = p.id AND m.receiver_id = v_a) OR (m.sender_id = v_a AND m.receiver_id = p.id))
  ORDER BY p.created_at
  LIMIT 1;
  IF v_super IS NULL OR v_a IS NULL OR v_b IS NULL OR v_c IS NULL THEN
    RAISE EXCEPTION 'Needs the super admin, two active non-admin students, and a third who has never messaged the first.';
  END IF;
  SELECT school INTO v_school FROM public.profiles WHERE id = v_c;
  INSERT INTO public.user_roles (user_id, role_id, school) VALUES (v_c, 'school_admin', v_school);

  PERFORM set_config('role', 'authenticated', true);

  -- A and B chat; one message lands after the report.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_a), true);
  INSERT INTO public.messages (sender_id, receiver_id, content, created_at) VALUES (v_a, v_b, 'verify-before-1', now() - interval '2 hours');
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_b), true);
  INSERT INTO public.messages (sender_id, receiver_id, content, created_at) VALUES (v_b, v_a, 'verify-before-2', now() - interval '1 hour');

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_a), true);
  BEGIN
    v_rep := public.report_conversation(v_b, 'harassment', 'self-test');
    r := r || E'TEST 1  a student can report a chat they are in ........ PASS\n';
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 1  a student can report a chat they are in ........ *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;
  -- Everything below reads this report. Without it the rest would only fail confusingly, so stop
  -- here and show why it was refused.
  IF v_rep IS NULL THEN
    RAISE EXCEPTION '%', r || E'\nSTOPPED: no report was created, so the remaining tests cannot run. Nothing was saved.';
  END IF;
  INSERT INTO public.messages (sender_id, receiver_id, content, created_at) VALUES (v_a, v_b, 'verify-after', now() + interval '1 minute');

  -- The key comes from A's own report (A may read it), so this cannot pass by inserting nothing.
  BEGIN
    INSERT INTO public.reports (kind, conversation_key, reported_user_id, reporter_id, category)
    SELECT 'conversation', rep.conversation_key, v_b, v_a, 'other' FROM public.reports rep WHERE rep.id = v_rep;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      r := r || E'TEST 1b a student cannot file one directly ............. ?? proved nothing (A could not read the report)\n'; ok := false;
    ELSE
      -- Name every rule that let it through, so the fix is obvious.
      SELECT string_agg(policyname || ' (' || permissive || ')', ', ') INTO r_rules
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports' AND cmd IN ('INSERT', 'ALL');
      r := r || format(E'TEST 1b a student cannot file one directly ............. *** FAIL — FILED. Insert rules: %s ***\n', r_rules); ok := false;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 1b a student cannot file one directly ............. PASS (refused)\n';
  END;

  BEGIN
    PERFORM public.read_reported_conversation(v_rep);
    r := r || E'TEST 1c a student cannot read reported chats ........... *** FAIL — READ ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 1c a student cannot read reported chats ........... PASS (refused)\n';
  END;

  -- C is not in that conversation.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_c), true);
  BEGIN
    PERFORM public.report_conversation(v_a, 'spam', 'self-test');
    r := r || E'TEST 2  nobody can report a chat they are not in ....... *** FAIL — FILED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 2  nobody can report a chat they are not in ....... PASS (refused)\n';
  END;

  -- C as a Moderator: read_reported_chats is off for that role.
  BEGIN
    PERFORM public.read_reported_conversation(v_rep);
    r := r || E'TEST 3  a Moderator without the switch cannot read it .. *** FAIL — READ ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  a Moderator without the switch cannot read it .. PASS (refused)\n';
  END;
  SELECT count(*) INTO v_n FROM public.messages WHERE content LIKE 'verify-%';
  IF v_n = 0 THEN r := r || E'TEST 4  admins can no longer read message text directly  PASS (0 rows)\n';
  ELSE r := r || format(E'TEST 4  admins can no longer read message text directly  *** FAIL — read %s ***\n', v_n); ok := false; END IF;
  IF public.admin_message_count() IS NULL THEN r := r || E'TEST 5  without view_messages, no counts either .......... PASS\n';
  ELSE r := r || E'TEST 5  without view_messages, no counts either .......... *** FAIL — counted ***\n'; ok := false; END IF;

  -- You.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  SELECT count(*) FILTER (WHERE content LIKE 'verify-before-%'), count(*) FILTER (WHERE content = 'verify-after')
    INTO v_n, v_m FROM public.read_reported_conversation(v_rep);
  IF v_n = 2 AND v_m = 0 THEN r := r || E'TEST 6  you read it up to the report, not after .......... PASS (2 before, 0 after)\n';
  ELSE r := r || format(E'TEST 6  you read it up to the report, not after .......... *** FAIL — %s before, %s after ***\n', v_n, v_m); ok := false; END IF;

  SELECT count(*) INTO v_n FROM public.admin_activity_log
   WHERE action_type = 'conversation_opened' AND target_id = v_rep::text AND actor_id = v_super;
  IF v_n = 1 THEN r := r || E'TEST 7  the opening is in the activity log .............. PASS\n';
  ELSE r := r || format(E'TEST 7  the opening is in the activity log .............. *** FAIL — %s rows ***\n', v_n); ok := false; END IF;

  SELECT count(*) INTO v_n FROM public.messages WHERE content LIKE 'verify-%';
  IF v_n = 0 THEN r := r || E'TEST 8  not even you read message text directly ......... PASS (0 rows)\n';
  ELSE r := r || format(E'TEST 8  not even you read message text directly ......... *** FAIL — read %s ***\n', v_n); ok := false; END IF;
  SELECT count(*) INTO v_n FROM public.admin_message_metadata(50000) WHERE sender_id IN (v_a, v_b) AND receiver_id IN (v_a, v_b);
  IF v_n >= 3 THEN r := r || E'TEST 9  who/when is still there for the Messages page ... PASS\n';
  ELSE r := r || format(E'TEST 9  who/when is still there for the Messages page ... *** FAIL — %s rows ***\n', v_n); ok := false; END IF;

  BEGIN
    UPDATE public.reports SET conversation_key = 'someone:else' WHERE id = v_rep;
    r := r || E'TEST 10 nobody can re-point a report at another chat ... *** FAIL — CHANGED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 10 nobody can re-point a report at another chat ... PASS (refused)\n';
  END;

  -- Close it 31 days ago: the conversation locks again.
  UPDATE public.reports SET status = 'dismissed', resolved_at = now() - interval '31 days' WHERE id = v_rep;
  BEGIN
    PERFORM public.read_reported_conversation(v_rep);
    r := r || E'TEST 11 it locks again 30 days after the report closes  *** FAIL — STILL READABLE ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 11 it locks again 30 days after the report closes  PASS (locked)\n';
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — no messages, report, roles or log rows.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
