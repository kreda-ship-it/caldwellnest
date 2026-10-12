-- Feedback questions you can edit: the question builder behind the 2-minute evaluation
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run. Needs 2026-10-05_student_feedback.sql to have run first.
--
-- WHY (Kal, 2026-10-05)
-- The evaluation's questions were written into js/feedback.js, so changing one took a code change and a
-- publish. Kal asked to add, edit, reorder and retire them from Admin → Feedback, and decided:
--   - ONE survey (the evaluation). The four quick notes stay fixed.
--   - Once a question has answers, it can be REWORDED only: its type and choices are locked. To change
--     those, retire it and add a new question, so old answers are never filed under a question they were
--     not answering.
--   - Three CORE questions stay: the 1–5 rating, "What did you try?" and "Would you miss Nestrel?". The
--     overview cards and charts are built on them, so they cannot be retired, made optional or change type.
--     "Would you miss Nestrel?" cannot be reworded at all: the 40% benchmark needs its exact words.
--
-- WHAT CHANGES
--   1. feedback_questions          the evaluation's questions, in order. Kinds: rating, single (pick one),
--                                  multi (pick several), text, yesno. Seeded with the 6 questions the app
--                                  asked until now, word for word: students see no change until an admin
--                                  makes one.
--   2. feedback_question_versions  every wording each question has had. Each response records the version
--                                  of each question it answered (app_feedback.question_versions).
--   3. app_feedback gains          answers ({question id: answer}) for new questions. The six original
--                                  questions keep their own columns, so old answers, the overview cards and
--                                  the charts are untouched.
--   4. The rules live in a trigger (feedback_questions_guard), not in the page — so they hold whoever calls.
--   5. submit_app_feedback() now reads the live questions: required ones must be answered, and each answer is
--      checked against its question's type and choices. A page loaded before this file ran (it sends no
--      "answers") still works the old way.
--   6. admin_feedback_question_counts(): how many responses answered each question ("answered by N").
--   Reading: signed-in students read ACTIVE questions (the page needs them); admins with view_feedback read
--   all, and the history. Adding and changing need manage_feedback. Nobody deletes a question: retire it.
--
-- UNDO: drop the two triggers and their functions, admin_feedback_question_counts,
-- feedback_question_answered and _fq_shape_ok, the two tables, and app_feedback.answers /
-- question_versions; then re-run 2026-10-05_student_feedback.sql PART 1 to restore its
-- submit_app_feedback() and view. Or ask Claude.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- 1. The questions ----------------------------------------------------------------------------------
create table if not exists public.feedback_questions (
  id              bigint generated always as identity primary key,
  key             text not null unique check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  kind            text not null check (kind in ('rating', 'single', 'multi', 'text', 'yesno')),
  title           text not null check (char_length(btrim(title)) between 3 and 200),
  help            text check (char_length(help) <= 200),
  placeholder     text check (char_length(placeholder) <= 120),
  options         jsonb not null default '[]'::jsonb,   -- single / multi: [{"key","label","emoji"?}]
  scale_labels    jsonb not null default '{}'::jsonb,   -- rating: {"1": "Not great", "3": "Okay", "5": "Great"}
  required        boolean not null default false,
  position        integer not null default 0,
  core            boolean not null default false,
  locked_wording  boolean not null default false,
  status          text not null default 'active' check (status in ('active', 'retired')),
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null
);

create table if not exists public.feedback_question_versions (
  question_id   bigint not null references public.feedback_questions (id) on delete cascade,
  version       integer not null,
  title         text not null,
  help          text,
  placeholder   text,
  options       jsonb not null default '[]'::jsonb,
  scale_labels  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null,
  primary key (question_id, version)
);

-- 2. Answers to new questions, and which wording each answer saw ------------------------------------
alter table public.app_feedback add column if not exists answers jsonb not null default '{}'::jsonb;
alter table public.app_feedback add column if not exists question_versions jsonb not null default '{}'::jsonb;
do $$ begin
  alter table public.app_feedback add constraint app_feedback_answers_size
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) < 40000);
exception when duplicate_object then null; end $$;
create index if not exists app_feedback_answers_idx on public.app_feedback using gin (answers);


-- 3. The rules ---------------------------------------------------------------------------------------

-- Is this a well-formed question of this kind? Choices: 2 to 12, each a short key and a label (and an
-- optional emoji), keys unique. Rating labels: only for 1–5. Other kinds carry neither.
create or replace function public._fq_shape_ok(p_kind text, p_options jsonb, p_scale jsonb)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_n int;
begin
  if p_kind in ('single', 'multi') then
    if jsonb_typeof(p_options) <> 'array' then return 'Choices are missing.'; end if;
    v_n := jsonb_array_length(p_options);
    if v_n < 2 or v_n > 12 then return 'A choice question needs 2 to 12 choices.'; end if;
    if exists (select 1 from jsonb_array_elements(p_options) o
               where jsonb_typeof(o) <> 'object'
                  or coalesce(o ->> 'key', '') !~ '^[a-z0-9_]{1,30}$'
                  or char_length(btrim(coalesce(o ->> 'label', ''))) not between 1 and 80
                  or char_length(coalesce(o ->> 'emoji', '')) > 8) then
      return 'Each choice needs a label of 1 to 80 characters.';
    end if;
    if (select count(distinct o ->> 'key') from jsonb_array_elements(p_options) o) <> v_n then
      return 'Two choices have the same key.';
    end if;
  elsif p_options <> '[]'::jsonb then
    return 'Only choice questions have choices.';
  end if;
  if p_kind = 'rating' then
    if jsonb_typeof(p_scale) <> 'object'
       or exists (select 1 from jsonb_each(p_scale) e
                  where e.key not in ('1', '2', '3', '4', '5') or jsonb_typeof(e.value) <> 'string'
                     or char_length(e.value #>> '{}') > 30) then
      return 'Rating labels go on 1 to 5, up to 30 characters each.';
    end if;
  elsif p_scale <> '{}'::jsonb then
    return 'Only rating questions have rating labels.';
  end if;
  return null;
end;
$function$;
revoke all on function public._fq_shape_ok(text, jsonb, jsonb) from public, anon;
grant execute on function public._fq_shape_ok(text, jsonb, jsonb) to authenticated;

-- Has any response answered this question? The six original questions answer into their own columns.
-- Reads app_feedback as its owner and returns only yes or no.
create or replace function public.feedback_question_answered(p_id bigint, p_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case p_key
    when 'overall_rating'       then exists (select 1 from public.app_feedback where overall_rating is not null)
    when 'features_used'        then exists (select 1 from public.app_feedback where cardinality(features_used) > 0)
    when 'would_miss_nestrel'   then exists (select 1 from public.app_feedback where would_miss_nestrel is not null)
    when 'liked'                then exists (select 1 from public.app_feedback where liked is not null)
    when 'confusing_or_missing' then exists (select 1 from public.app_feedback where confusing_or_missing is not null)
    when 'one_thing_to_change'  then exists (select 1 from public.app_feedback where one_thing_to_change is not null)
    else exists (select 1 from public.app_feedback where answers ? p_id::text)
  end;
$function$;
revoke all on function public.feedback_question_answered(bigint, text) from public, anon;
grant execute on function public.feedback_question_answered(bigint, text) to authenticated;

-- Runs as whoever makes the change (not as the owner), so current_user tells this file's own seed
-- (postgres) from the app (authenticated). Only the seed may create a core or locked question.
create or replace function public.feedback_questions_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_bad     text;
  v_active  int;
  v_owner   boolean := current_user = 'postgres';
begin
  if tg_op = 'INSERT' then
    if not v_owner then
      new.core := false;
      new.locked_wording := false;
      new.key := 'q' || new.id;            -- the id is already assigned when this runs
    end if;
    new.version := 1;
    new.created_at := now();
    if new.status = 'active' then
      select count(*) into v_active from public.feedback_questions where status = 'active';
      if v_active >= 15 then
        raise exception 'The survey already has 15 questions. Retire one first — a long survey is a survey students quit.'
          using errcode = 'check_violation';
      end if;
    end if;
    if coalesce(new.position, 0) = 0 then
      select coalesce(max(position), 0) + 1 into new.position from public.feedback_questions;
    end if;
  else
    -- Never changes, whoever asks.
    new.key := old.key;
    new.core := old.core;
    new.locked_wording := old.locked_wording;
    new.created_at := old.created_at;
    new.version := old.version;

    if old.core then
      if new.status <> 'active' then
        raise exception 'This is a core question: the overview cards and charts need it, so it can’t be retired.'
          using errcode = 'check_violation';
      end if;
      if not new.required then
        raise exception 'Core questions are always required.' using errcode = 'check_violation';
      end if;
      if new.kind <> old.kind or new.options <> old.options then
        raise exception 'A core question’s type and choices can’t change.' using errcode = 'check_violation';
      end if;
    end if;
    if old.locked_wording and (new.title, new.help, new.placeholder, new.scale_labels)
                              is distinct from (old.title, old.help, old.placeholder, old.scale_labels) then
      raise exception 'The words of this question are fixed, so its answers stay comparable with the 40%% benchmark.'
        using errcode = 'check_violation';
    end if;
    if (new.kind <> old.kind or new.options <> old.options)
       and public.feedback_question_answered(old.id, old.key) then
      raise exception 'This question already has answers, so its type and choices are locked. To change them, retire it and add a new question.'
        using errcode = 'check_violation';
    end if;
    if new.status = 'active' and old.status = 'retired' then
      select count(*) into v_active from public.feedback_questions where status = 'active';
      if v_active >= 15 then
        raise exception 'The survey already has 15 questions. Retire one first.' using errcode = 'check_violation';
      end if;
    end if;
    -- A change of words is a new version; the old words stay in feedback_question_versions.
    if (new.kind, new.title, new.help, new.placeholder, new.options, new.scale_labels)
       is distinct from (old.kind, old.title, old.help, old.placeholder, old.options, old.scale_labels) then
      new.version := old.version + 1;
    end if;
  end if;
  new.title := btrim(new.title);
  new.help := nullif(btrim(coalesce(new.help, '')), '');
  new.placeholder := nullif(btrim(coalesce(new.placeholder, '')), '');
  v_bad := public._fq_shape_ok(new.kind, new.options, new.scale_labels);
  if v_bad is not null then
    raise exception '%', v_bad using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$function$;
revoke all on function public.feedback_questions_guard() from public, anon, authenticated;
drop trigger if exists feedback_questions_guard on public.feedback_questions;
create trigger feedback_questions_guard before insert or update on public.feedback_questions
  for each row execute function public.feedback_questions_guard();

-- Writes the history. Runs as the owner: nobody writes feedback_question_versions directly.
create or replace function public.feedback_questions_history()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' or new.version <> old.version then
    insert into public.feedback_question_versions (question_id, version, title, help, placeholder, options, scale_labels, created_by)
    values (new.id, new.version, new.title, new.help, new.placeholder, new.options, new.scale_labels, auth.uid())
    on conflict (question_id, version) do nothing;
  end if;
  return null;
end;
$function$;
revoke all on function public.feedback_questions_history() from public, anon, authenticated;
drop trigger if exists feedback_questions_history on public.feedback_questions;
create trigger feedback_questions_history after insert or update on public.feedback_questions
  for each row execute function public.feedback_questions_history();


-- 4. The six questions the app asked until now, word for word --------------------------------------
insert into public.feedback_questions (key, kind, title, help, placeholder, options, scale_labels, required, position, core, locked_wording)
values
  ('overall_rating', 'rating', 'How would you rate your experience with Nestrel?', null, null,
   '[]', '{"1": "Not great", "3": "Okay", "5": "Great"}', true, 1, true, false),
  ('features_used', 'multi', 'What did you try on Nestrel?', 'Choose all that apply.', null,
   '[{"key": "events", "label": "Events"}, {"key": "marketplace", "label": "Marketplace"},
     {"key": "housing", "label": "Housing"}, {"key": "textbooks", "label": "Textbooks"},
     {"key": "clubs", "label": "Clubs"}, {"key": "messaging", "label": "Messaging"},
     {"key": "announcements", "label": "Announcements"}, {"key": "search", "label": "Search / browsing"},
     {"key": "other", "label": "Other"}]', '{}', true, 2, true, false),
  ('liked', 'text', 'What did you like about Nestrel?', 'Optional. A few words is plenty.',
   'Tell us what worked well for you.', '[]', '{}', false, 3, false, false),
  ('confusing_or_missing', 'text', 'Was anything confusing, difficult, or missing?', 'Optional. A few words is plenty.',
   'Tell us what could be better.', '[]', '{}', false, 4, false, false),
  ('one_thing_to_change', 'text', 'If you could change ONE thing about Nestrel, what would it be?',
   'Optional, but this is the answer we learn the most from.', 'What’s the one thing you would improve?',
   '[]', '{}', false, 5, false, false),
  ('would_miss_nestrel', 'single', 'If Nestrel were no longer available, how would you feel?', null, null,
   '[{"key": "very_disappointed", "label": "Very disappointed", "emoji": "😢"},
     {"key": "somewhat_disappointed", "label": "Somewhat disappointed", "emoji": "😐"},
     {"key": "not_disappointed", "label": "Not disappointed", "emoji": "🙂"}]', '{}', true, 6, true, true)
on conflict (key) do nothing;


-- 5. Who may do what ---------------------------------------------------------------------------------
alter table public.feedback_questions enable row level security;
drop policy if exists "Students read the live questions" on public.feedback_questions;
create policy "Students read the live questions" on public.feedback_questions
  for select to authenticated using (status = 'active' or public.has_admin_permission('view_feedback'));
drop policy if exists "Feedback managers add questions" on public.feedback_questions;
create policy "Feedback managers add questions" on public.feedback_questions
  for insert to authenticated with check (public.has_admin_permission('manage_feedback'));
drop policy if exists "Feedback managers edit questions" on public.feedback_questions;
create policy "Feedback managers edit questions" on public.feedback_questions
  for update to authenticated using (public.has_admin_permission('manage_feedback'))
  with check (public.has_admin_permission('manage_feedback'));
revoke all on public.feedback_questions from anon;
revoke delete, truncate, references, trigger on public.feedback_questions from authenticated;
grant select, insert, update on public.feedback_questions to authenticated;

alter table public.feedback_question_versions enable row level security;
drop policy if exists "Feedback admins read question history" on public.feedback_question_versions;
create policy "Feedback admins read question history" on public.feedback_question_versions
  for select to authenticated using (public.has_admin_permission('view_feedback'));
revoke all on public.feedback_question_versions from anon, authenticated;
grant select on public.feedback_question_versions to authenticated;


-- 6. The admin view gains the two new columns (added at the end, which is all CREATE OR REPLACE allows) --
create or replace view public.app_feedback_admin as
select f.id, f.feedback_source, f.kind, f.overall_rating, f.features_used, f.liked,
       f.confusing_or_missing, f.one_thing_to_change, f.message, f.would_miss_nestrel,
       f.contact_allowed, f.page_context, f.device_type, f.browser, f.app_version,
       f.completion_seconds, f.course_ref, f.school, f.status, f.tags, f.admin_notes,
       f.created_at, f.updated_at,
       case when f.contact_allowed then f.user_id end                                   as user_id,
       case when f.contact_allowed then
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') end as student_name,
       case when f.contact_allowed then p.email end                                     as student_email,
       (f.contact_allowed and f.user_id is null)                                         as account_deleted,
       coalesce((select array_agg(l.change_id order by l.change_id)
                 from public.product_change_feedback l where l.feedback_id = f.id), '{}') as change_ids,
       f.answers, f.question_versions
from public.app_feedback f
left join public.profiles p on p.id = f.user_id
where public.has_admin_permission('view_feedback');
revoke all on public.app_feedback_admin from anon;
revoke insert, update, delete, truncate, references, trigger on public.app_feedback_admin from authenticated;
grant select on public.app_feedback_admin to authenticated;


-- 7. Sending feedback, now with the live questions ----------------------------------------------------
create or replace function public.submit_app_feedback(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid       uuid := auth.uid();
  v_prof      public.profiles%rowtype;
  v_source    text := coalesce(p ->> 'feedback_source', '');
  v_kind      text := nullif(p ->> 'kind', '');
  v_new       boolean := jsonb_typeof(p -> 'answers') = 'object';
  v_shown     jsonb := case when jsonb_typeof(p -> 'question_versions') = 'object' then p -> 'question_versions' else '{}'::jsonb end;
  v_rating    int;
  v_miss      text;
  v_feats     text[] := '{}';
  v_liked     text;
  v_conf      text;
  v_one       text;
  v_msg       text := nullif(btrim(left(p ->> 'message', 2000)), '');
  v_secs      int  := case when (p ->> 'completion_seconds') ~ '^\d{1,6}$'
                           then least((p ->> 'completion_seconds')::int, 86400) end;
  v_answers   jsonb := '{}'::jsonb;
  v_versions  jsonb := '{}'::jsonb;
  v_q         public.feedback_questions%rowtype;
  v_val       jsonb;
  v_norm      jsonb;
  v_seen      int;
  v_done      public.feedback_completions%rowtype;
  v_code      text;
  v_at        timestamptz;
begin
  if v_uid is null then
    raise exception 'Please log in to send feedback.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_prof from public.profiles where id = v_uid;
  if v_prof.id is null then
    raise exception 'This account has no Nestrel profile.' using errcode = 'insufficient_privilege';
  end if;
  if public.is_suspended() then
    raise exception 'This account is suspended.' using errcode = 'insufficient_privilege';
  end if;
  if v_source not in ('general', 'student_evaluation') then
    raise exception 'Unknown feedback type.' using errcode = 'check_violation';
  end if;

  if v_source = 'student_evaluation' and v_new then
    -- Every live question, plus any the student was shown that has since been retired.
    for v_q in select * from public.feedback_questions
               where status = 'active' or v_shown ? id::text
               order by position, id loop
      v_val := p -> 'answers' -> v_q.id::text;
      v_norm := null;
      if v_q.kind = 'rating' then
        if jsonb_typeof(v_val) = 'number' and (v_val #>> '{}') ~ '^[1-5]$' then v_norm := v_val; end if;
      elsif v_q.kind = 'single' then
        if jsonb_typeof(v_val) = 'string'
           and exists (select 1 from jsonb_array_elements(v_q.options) o where o ->> 'key' = v_val #>> '{}') then
          v_norm := v_val;
        end if;
      elsif v_q.kind = 'multi' then
        if jsonb_typeof(v_val) = 'array' then
          select jsonb_agg(k order by k) into v_norm
          from (select distinct x as k from jsonb_array_elements_text(v_val) as t(x)
                where exists (select 1 from jsonb_array_elements(v_q.options) o where o ->> 'key' = x)) s;
        end if;
      elsif v_q.kind = 'text' then
        if jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') <> '' then
          v_norm := to_jsonb(btrim(left(v_val #>> '{}', 2000)));
        end if;
      elsif v_q.kind = 'yesno' then
        if jsonb_typeof(v_val) = 'boolean' then v_norm := v_val; end if;
      end if;

      if v_norm is null then
        -- Required only if the student was shown it: a question added while they were answering is not
        -- their fault.
        if v_q.required and (v_shown ? v_q.id::text or v_shown = '{}'::jsonb) then
          raise exception 'Please answer: %', v_q.title using errcode = 'check_violation';
        end if;
        continue;
      end if;

      -- The wording they saw, if the page says so and that version is real; otherwise the current one.
      v_seen := case when (v_shown ->> v_q.id::text) ~ '^\d{1,6}$' then (v_shown ->> v_q.id::text)::int end;
      if v_seen is null or not exists (select 1 from public.feedback_question_versions
                                       where question_id = v_q.id and version = v_seen) then
        v_seen := v_q.version;
      end if;
      v_versions := v_versions || jsonb_build_object(v_q.id::text, v_seen);

      case v_q.key
        when 'overall_rating'       then v_rating := (v_norm #>> '{}')::int;
        when 'features_used'        then select coalesce(array_agg(x order by x), '{}') into v_feats from jsonb_array_elements_text(v_norm) as t(x);
        when 'would_miss_nestrel'   then v_miss := v_norm #>> '{}';
        when 'liked'                then v_liked := v_norm #>> '{}';
        when 'confusing_or_missing' then v_conf := v_norm #>> '{}';
        when 'one_thing_to_change'  then v_one := v_norm #>> '{}';
        else v_answers := v_answers || jsonb_build_object(v_q.id::text, v_norm);
      end case;
    end loop;
  elsif v_source = 'student_evaluation' then
    -- A page loaded before the question builder: the six fixed answers, checked as before.
    v_rating := case when (p ->> 'overall_rating') ~ '^[1-5]$' then (p ->> 'overall_rating')::int end;
    v_miss := nullif(p ->> 'would_miss_nestrel', '');
    select coalesce(array_agg(distinct x order by x), '{}') into v_feats
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'features_used') = 'array'
                                        then p -> 'features_used' else '[]'::jsonb end) as t(x)
    where x in ('events', 'marketplace', 'housing', 'textbooks', 'clubs', 'messaging', 'announcements',
                'search', 'other');
    v_liked := nullif(btrim(left(p ->> 'liked', 2000)), '');
    v_conf := nullif(btrim(left(p ->> 'confusing_or_missing', 2000)), '');
    v_one := nullif(btrim(left(p ->> 'one_thing_to_change', 2000)), '');
    if v_rating is null or v_miss is null
       or v_miss not in ('very_disappointed', 'somewhat_disappointed', 'not_disappointed')
       or cardinality(v_feats) = 0 then
      raise exception 'Please answer the rating, what you tried, and the last question.' using errcode = 'check_violation';
    end if;
  end if;

  if v_source = 'student_evaluation' then
    -- One evaluation a day. A second press, a retry after a dropped connection, or a second tab gets
    -- the confirmation it already has, and nothing is saved twice.
    select * into v_done from public.feedback_completions
    where user_id = v_uid and completed_at > now() - interval '24 hours'
    order by completed_at desc limit 1;
    if v_done.code is not null then
      return jsonb_build_object('code', v_done.code, 'completed_on', (v_done.completed_at at time zone 'America/New_York')::date,
                                'already', true, 'first_name', v_prof.first_name, 'last_name', v_prof.last_name,
                                'email', v_prof.email);
    end if;
  else
    if v_kind is null or v_kind not in ('bug', 'confusing', 'idea', 'praise') then
      raise exception 'Please choose what kind of feedback this is.' using errcode = 'check_violation';
    end if;
    -- The same note twice within 2 minutes is a double press: answer OK, save it once.
    if exists (select 1 from public.app_feedback
               where user_id = v_uid and feedback_source = 'general' and kind = v_kind
                 and message is not distinct from v_msg and created_at > now() - interval '2 minutes') then
      return jsonb_build_object('ok', true, 'already', true);
    end if;
    if (select count(*) from public.app_feedback
        where user_id = v_uid and feedback_source = 'general' and created_at > now() - interval '24 hours') >= 10 then
      raise exception 'You have sent 10 notes today. Thank you! Please try again tomorrow.' using errcode = 'check_violation';
    end if;
  end if;

  insert into public.app_feedback (
    user_id, feedback_source, kind, overall_rating, features_used, liked, confusing_or_missing,
    one_thing_to_change, message, would_miss_nestrel, contact_allowed, page_context, device_type,
    browser, app_version, completion_seconds, course_ref, school, answers, question_versions)
  values (
    v_uid, v_source,
    case when v_source = 'general' then v_kind end,
    case when v_source = 'student_evaluation' then v_rating end,
    case when v_source = 'student_evaluation' then v_feats else '{}' end,
    case when v_source = 'student_evaluation' then v_liked end,
    case when v_source = 'student_evaluation' then v_conf end,
    case when v_source = 'student_evaluation' then v_one end,
    case when v_source = 'general' then v_msg end,
    case when v_source = 'student_evaluation' then v_miss end,
    coalesce(p ->> 'contact_allowed', 'false') = 'true',
    nullif(left(regexp_replace(coalesce(p ->> 'page_context', ''), '[^a-z0-9_:/#-]', '', 'g'), 60), ''),
    case when p ->> 'device_type' in ('phone', 'tablet', 'desktop') then p ->> 'device_type' end,
    nullif(left(regexp_replace(coalesce(p ->> 'browser', ''), '[^A-Za-z0-9 ._-]', '', 'g'), 40), ''),
    nullif(left(regexp_replace(coalesce(p ->> 'app_version', ''), '[^A-Za-z0-9 ._-]', '', 'g'), 40), ''),
    v_secs,
    nullif(left(regexp_replace(coalesce(p ->> 'course_ref', ''), '[^A-Za-z0-9 ._-]', '', 'g'), 60), ''),
    v_prof.school,
    case when v_source = 'student_evaluation' then v_answers else '{}'::jsonb end,
    case when v_source = 'student_evaluation' then v_versions else '{}'::jsonb end);

  if v_source = 'general' then
    return jsonb_build_object('ok', true, 'already', false);
  end if;

  loop
    v_code := public._feedback_code();
    begin
      insert into public.feedback_completions (code, user_id, feedback_source, course_ref)
      values (v_code, v_uid, v_source,
              nullif(left(regexp_replace(coalesce(p ->> 'course_ref', ''), '[^A-Za-z0-9 ._-]', '', 'g'), 60), ''))
      returning completed_at into v_at;
      exit;
    exception when unique_violation then
      -- one chance in a trillion; draw another
    end;
  end loop;

  return jsonb_build_object('code', v_code, 'completed_on', (v_at at time zone 'America/New_York')::date,
                            'already', false, 'first_name', v_prof.first_name, 'last_name', v_prof.last_name,
                            'email', v_prof.email);
end;
$function$;
revoke all on function public.submit_app_feedback(jsonb) from public, anon;
grant execute on function public.submit_app_feedback(jsonb) to authenticated;


-- 8. "Answered by N" for each question ---------------------------------------------------------------
create or replace function public.admin_feedback_question_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_admin_permission('view_feedback') then
    raise exception 'Your role does not include feedback.' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_object_agg(q.id::text, case q.key
      when 'overall_rating'       then (select count(*) from public.app_feedback where overall_rating is not null)
      when 'features_used'        then (select count(*) from public.app_feedback where cardinality(features_used) > 0)
      when 'would_miss_nestrel'   then (select count(*) from public.app_feedback where would_miss_nestrel is not null)
      when 'liked'                then (select count(*) from public.app_feedback where liked is not null)
      when 'confusing_or_missing' then (select count(*) from public.app_feedback where confusing_or_missing is not null)
      when 'one_thing_to_change'  then (select count(*) from public.app_feedback where one_thing_to_change is not null)
      else (select count(*) from public.app_feedback where answers ? q.id::text) end)
    from public.feedback_questions q), '{}'::jsonb);
end;
$function$;
revoke all on function public.admin_feedback_question_counts() from public, anon;
grant execute on function public.admin_feedback_question_counts() to authenticated;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as two real students, then as you.
-- THE ERROR MESSAGE IS THE REPORT, and the error discards everything it made.
-- ============================================================================

DO $verify$
DECLARE
  v_s1     uuid;
  v_s2     uuid;
  v_super  uuid;
  v_rating bigint;
  v_feat   bigint;
  v_miss   bigint;
  v_new    bigint;
  v_q      record;
  v_n      int;
  v_res    jsonb;
  v_row    record;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  SELECT p.id INTO v_s1 FROM public.profiles p
   WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
   ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_s2 FROM public.profiles p
   WHERE p.status = 'active' AND p.id <> v_s1 AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id)
   ORDER BY p.created_at LIMIT 1;
  IF v_super IS NULL OR v_s1 IS NULL OR v_s2 IS NULL THEN
    RAISE EXCEPTION 'Needs the super admin and two active students.';
  END IF;
  SELECT id INTO v_rating FROM public.feedback_questions WHERE key = 'overall_rating';
  SELECT id INTO v_feat FROM public.feedback_questions WHERE key = 'features_used';
  SELECT id INTO v_miss FROM public.feedback_questions WHERE key = 'would_miss_nestrel';
  DELETE FROM public.feedback_completions WHERE user_id IN (v_s1, v_s2);

  PERFORM set_config('role', 'authenticated', true);

  -- A student reads the live questions and cannot change them ---------------------------------------
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s1), true);
  SELECT count(*) INTO v_n FROM public.feedback_questions;
  IF v_n >= 6 THEN r := r || format(E'TEST 1  a student reads the live questions (%s) ............. PASS\n', v_n);
  ELSE r := r || format(E'TEST 1  a student reads the live questions ................... *** FAIL — %s ***\n', v_n); ok := false; END IF;
  BEGIN
    INSERT INTO public.feedback_questions (kind, title) VALUES ('text', 'verify-student-question');
    r := r || E'TEST 2  a student cannot add a question ...................... *** FAIL — added ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 2  a student cannot add a question ...................... PASS\n'; END;
  UPDATE public.feedback_questions SET title = 'verify-hacked' WHERE id = v_rating;
  SELECT title INTO v_row FROM public.feedback_questions WHERE id = v_rating;
  IF v_row.title <> 'verify-hacked' THEN r := r || E'TEST 3  a student cannot reword a question ................... PASS\n';
  ELSE r := r || E'TEST 3  a student cannot reword a question ................... *** FAIL — reworded ***\n'; ok := false; END IF;

  -- You -----------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  INSERT INTO public.feedback_questions (key, kind, title, options, required, core, locked_wording)
  VALUES ('sneaky', 'single', 'Which campus are you on?',
          '[{"key":"main","label":"Main"},{"key":"online","label":"Online"}]', true, true, true)
  RETURNING id INTO v_new;
  SELECT * INTO v_q FROM public.feedback_questions WHERE id = v_new;
  IF v_q.key = 'q' || v_new AND NOT v_q.core AND NOT v_q.locked_wording AND v_q.version = 1
     AND EXISTS (SELECT 1 FROM public.feedback_question_versions WHERE question_id = v_new AND version = 1)
  THEN r := r || E'TEST 4  you add a question; the database names it, not core . PASS\n';
  ELSE r := r || format(E'TEST 4  you add a question ............................... *** FAIL — %s ***\n', row_to_json(v_q)); ok := false; END IF;

  BEGIN
    UPDATE public.feedback_questions SET status = 'retired' WHERE id = v_rating;
    r := r || E'TEST 5  a core question cannot be retired .................... *** FAIL — retired ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN r := r || E'TEST 5  a core question cannot be retired .................... PASS\n'; END;
  BEGIN
    UPDATE public.feedback_questions SET title = 'How sad would you be?' WHERE id = v_miss;
    r := r || E'TEST 6  "would you miss Nestrel" cannot be reworded ............ *** FAIL — reworded ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN r := r || E'TEST 6  "would you miss Nestrel" cannot be reworded ............ PASS\n'; END;

  UPDATE public.feedback_questions SET title = 'Overall, how is Nestrel for you so far?' WHERE id = v_rating;
  SELECT version INTO v_n FROM public.feedback_questions WHERE id = v_rating;
  IF v_n >= 2 AND EXISTS (SELECT 1 FROM public.feedback_question_versions WHERE question_id = v_rating AND version = v_n)
  THEN r := r || E'TEST 7  rewording a question adds a version ................... PASS\n';
  ELSE r := r || format(E'TEST 7  rewording a question adds a version ................... *** FAIL — v%s ***\n', v_n); ok := false; END IF;

  -- Student 1 answers everything, including the new question -------------------------------------------
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s1), true);
  v_res := public.submit_app_feedback(jsonb_build_object(
    'feedback_source', 'student_evaluation',
    'answers', jsonb_build_object(v_rating::text, 4, v_feat::text, jsonb_build_array('events', 'nonsense'),
                                  v_miss::text, 'somewhat_disappointed', v_new::text, 'online'),
    'question_versions', jsonb_build_object(v_rating::text, 1, v_feat::text, 1, v_miss::text, 1, v_new::text, 1)));

  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  SELECT overall_rating, features_used, would_miss_nestrel, answers, question_versions INTO v_row
  FROM public.app_feedback_admin WHERE answers ? v_new::text ORDER BY id DESC LIMIT 1;
  IF v_row.overall_rating = 4 AND v_row.features_used = '{events}' AND v_row.would_miss_nestrel = 'somewhat_disappointed'
     AND v_row.answers ->> v_new::text = 'online' AND (v_row.question_versions ->> v_rating::text)::int = 1
  THEN r := r || E'TEST 8  answers land in the right places, with the wording seen  PASS\n';
  ELSE r := r || format(E'TEST 8  answers land in the right places ..................... *** FAIL — %s ***\n', row_to_json(v_row)); ok := false; END IF;

  BEGIN
    UPDATE public.feedback_questions SET options = '[{"key":"main","label":"Main"},{"key":"other","label":"Other"}]' WHERE id = v_new;
    r := r || E'TEST 9  an answered question''s choices are locked ............. *** FAIL — changed ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN r := r || E'TEST 9  an answered question''s choices are locked ............. PASS\n'; END;
  UPDATE public.feedback_questions SET title = 'Which campus do you study on?' WHERE id = v_new;
  r := r || E'TEST 10 ...but it can still be reworded ........................ PASS\n';

  v_res := public.admin_feedback_question_counts();
  IF (v_res ->> v_new::text)::int = 1 THEN r := r || E'TEST 11 "answered by" counts the new question ................ PASS\n';
  ELSE r := r || format(E'TEST 11 "answered by" counts ............................... *** FAIL — %s ***\n', v_res ->> v_new::text); ok := false; END IF;

  -- Student 2: a required question they were SHOWN must be answered; one they were not shown need not --
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s2), true);
  BEGIN
    PERFORM public.submit_app_feedback(jsonb_build_object(
      'feedback_source', 'student_evaluation',
      'answers', jsonb_build_object(v_rating::text, 5, v_feat::text, jsonb_build_array('clubs'), v_miss::text, 'very_disappointed'),
      'question_versions', jsonb_build_object(v_rating::text, 2, v_feat::text, 1, v_miss::text, 1, v_new::text, 2)));
    r := r || E'TEST 12 a required question you saw must be answered ........ *** FAIL — accepted ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN r := r || E'TEST 12 a required question you saw must be answered ........ PASS\n'; END;
  v_res := public.submit_app_feedback(jsonb_build_object(
    'feedback_source', 'student_evaluation',
    'answers', jsonb_build_object(v_rating::text, 5, v_feat::text, jsonb_build_array('clubs'), v_miss::text, 'very_disappointed'),
    'question_versions', jsonb_build_object(v_rating::text, 2, v_feat::text, 1, v_miss::text, 1)));
  IF v_res ? 'code' THEN r := r || E'TEST 13 ...one added while you were answering need not be .. PASS\n';
  ELSE r := r || format(E'TEST 13 ...one added while you were answering ................ *** FAIL — %s ***\n', v_res); ok := false; END IF;

  -- A page loaded before this file (no "answers") still works ---------------------------------------
  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.feedback_completions WHERE user_id = v_s2;
  PERFORM set_config('role', 'authenticated', true);
  v_res := public.submit_app_feedback('{"feedback_source":"student_evaluation","overall_rating":3,
    "features_used":["other"],"would_miss_nestrel":"not_disappointed"}'::jsonb);
  IF v_res ? 'code' THEN r := r || E'TEST 14 a page from before the builder still submits ........ PASS\n';
  ELSE r := r || format(E'TEST 14 a page from before the builder still submits ........ *** FAIL — %s ***\n', v_res); ok := false; END IF;

  -- A visitor ------------------------------------------------------------------------------------------
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM count(*) FROM public.feedback_questions;
    r := r || E'TEST 15 a visitor cannot read the questions .................. *** FAIL — read them ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN r := r || E'TEST 15 a visitor cannot read the questions .................. PASS\n'; END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — no test question, wording, answer or code exists.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
