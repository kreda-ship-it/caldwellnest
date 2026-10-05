-- Student feedback: the 2-minute evaluation, quick notes, completion codes, and product changes
-- 2026-10-05
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY (Kal, 2026-10-05)
-- Students need one easy place to tell us what is broken, confusing, missing or good, and professors
-- may offer extra credit for a short evaluation — so a student needs proof they finished it, without
-- that proof showing their answers. Admins need to read it all, find patterns, and record which
-- product changes came from it. Research and plan: the "Student Feedback — Research & Plan" doc.
--
-- WHAT CHANGES
--   1. app_feedback            one row per piece of feedback, from any source. Students NEVER touch this
--                              table directly: no grants at all, so not even TRUNCATE. They write through
--                              submit_app_feedback(), which sets status, tags, notes, school and the time
--                              itself, limits how often, and refuses a suspended account. (So it does not
--                              need the no_*_while_suspended policies of 2026-09-28_enforce_suspension.sql:
--                              those guard tables students write directly, and nobody writes this one
--                              directly. The function checks suspension itself.)
--   2. feedback_completions    the codes shown on the "Feedback completed" card (NSTR-XXXX-XXXX). A student
--                              can read their own. Deliberately NOT linked to the feedback row, so a code
--                              can prove that someone finished without leading to what they said.
--   3. product_changes +       what was changed because of feedback, and which feedback led to it.
--      product_change_feedback Admin-only, readable with view_feedback, writable with manage_feedback.
--   4. app_feedback_admin      the view the admin Feedback page reads. Rows only for view_feedback.
--                              The student's name, email and id appear ONLY when they ticked
--                              "You can message me" (contact_allowed) — Kal, 2026-10-05: otherwise
--                              anonymous on every admin screen and export.
--   5. Functions: submit_app_feedback (students), admin_update_feedback, admin_feedback_student_counts,
--      admin_verify_completion, admin_notify_change_students (admins).
--   6. Two new admin switches, OFF for every existing role: view_feedback, manage_feedback. The super
--      admin always has both (has_admin_permission). Turn them on per role on the Admin team page.
--   7. purge_old_feedback(), run weekly by pg_cron: feedback and completion codes older than 2 years are
--      deleted (Privacy Policy section 07 promises it). Needs pg_cron, like the event-views erase.
--
-- PRIVACY, HONESTLY
--   - The database keeps the account id on every row (daily limits, and so a deleted account takes its
--     link with it). The app's admin screens and exports hide it unless contact_allowed.
--   - The completion code is not linked to the answers. admin_verify_completion() gives the DATE only,
--     never the time, so a code cannot be matched to a row by its timestamp. On a day with exactly one
--     evaluation, an admin who verifies that student's code could still guess — accepted, and why the
--     Privacy Policy says "not shown", not "impossible to know".
--   - admin_feedback_student_counts() counts distinct students in groups of rows. With effort an admin
--     could use it to tell whether two anonymous rows share an author; it never says who.
--   - Account deleted: feedback rows stay, with the link cleared (ON DELETE SET NULL); completion codes
--     go with the account (CASCADE). Privacy Policy sections 02, 03 and 07 say so.
--
-- UNDO: unschedule 'nestrel-purge-old-feedback', drop the view, the functions, the four tables (in reverse order) and the two
-- role_permissions keys; or ask Claude.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- 1. app_feedback ------------------------------------------------------------------------------------
create table if not exists public.app_feedback (
  id                    bigint generated always as identity primary key,
  user_id               uuid references public.profiles (id) on delete set null,
  -- general = a quick note from the Feedback button; student_evaluation = the 2-minute evaluation.
  -- The rest are reserved for later (admin-entered interviews, a course link, a term survey).
  feedback_source       text not null
                        check (feedback_source in ('general', 'student_evaluation', 'course_evaluation',
                                                   'usability_study', 'focus_group', 'term_survey', 'other')),
  kind                  text check (kind in ('bug', 'confusing', 'idea', 'praise')),       -- quick notes
  overall_rating        smallint check (overall_rating between 1 and 5),
  features_used         text[] not null default '{}',
  liked                 text check (char_length(liked) <= 2000),
  confusing_or_missing  text check (char_length(confusing_or_missing) <= 2000),
  one_thing_to_change   text check (char_length(one_thing_to_change) <= 2000),
  message               text check (char_length(message) <= 2000),                          -- quick notes
  would_miss_nestrel    text check (would_miss_nestrel in ('very_disappointed', 'somewhat_disappointed',
                                                             'not_disappointed')),
  contact_allowed       boolean not null default false,
  -- Attached by the app, never typed by the student. No IP address, ever.
  page_context          text check (char_length(page_context) <= 60),
  device_type           text check (device_type in ('phone', 'tablet', 'desktop')),
  browser               text check (char_length(browser) <= 40),
  app_version           text check (char_length(app_version) <= 40),
  completion_seconds    integer check (completion_seconds between 0 and 86400),
  course_ref            text check (char_length(course_ref) <= 60),   -- a future course / assignment id
  school                text,
  -- Admin-only fields. Students can neither set nor read them.
  status                text not null default 'new'
                        check (status in ('new', 'reviewing', 'planned', 'in_progress', 'completed',
                                          'wont_do', 'duplicate')),
  tags                  text[] not null default '{}' check (cardinality(tags) <= 20),
  admin_notes           text check (char_length(admin_notes) <= 4000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint app_feedback_features_known check (features_used <@ array['events', 'marketplace', 'housing',
    'textbooks', 'clubs', 'messaging', 'announcements', 'search', 'other']::text[])
);
create index if not exists app_feedback_created_idx on public.app_feedback (created_at desc);
create index if not exists app_feedback_user_idx    on public.app_feedback (user_id, created_at desc);

alter table public.app_feedback enable row level security;
-- No policies on purpose: nobody reads or writes this table except through the functions and view below.
revoke all on public.app_feedback from anon, authenticated;


-- 2. feedback_completions ----------------------------------------------------------------------------
create table if not exists public.feedback_completions (
  code             text primary key check (code ~ '^NSTR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  feedback_source  text not null default 'student_evaluation',
  course_ref       text check (char_length(course_ref) <= 60),
  completed_at     timestamptz not null default now()
);
create index if not exists feedback_completions_user_idx on public.feedback_completions (user_id, completed_at desc);

alter table public.feedback_completions enable row level security;
drop policy if exists "Students read their own completions" on public.feedback_completions;
create policy "Students read their own completions" on public.feedback_completions
  for select to authenticated using (user_id = auth.uid());
revoke all on public.feedback_completions from anon, authenticated;
grant select on public.feedback_completions to authenticated;


-- 3. product_changes + product_change_feedback -------------------------------------------------------
create table if not exists public.product_changes (
  id                 bigint generated always as identity primary key,
  title              text not null check (char_length(btrim(title)) between 3 and 120),
  reason             text check (char_length(reason) <= 1000),          -- what students asked for
  what_changed       text check (char_length(what_changed) <= 2000),
  expected_impact    text check (char_length(expected_impact) <= 1000),
  actual_result      text check (char_length(actual_result) <= 2000),
  status             text not null default 'planned'
                     check (status in ('planned', 'in_progress', 'shipped', 'dropped')),
  shipped_on         date,
  commit_ref         text check (char_length(commit_ref) <= 80),
  students_notified  boolean not null default false,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.product_change_feedback (
  change_id    bigint not null references public.product_changes (id) on delete cascade,
  feedback_id  bigint not null references public.app_feedback (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (change_id, feedback_id)
);
create index if not exists product_change_feedback_fb_idx on public.product_change_feedback (feedback_id);

-- Who made it and when it last changed are the database's to say, not the browser's.
create or replace function public.product_changes_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.students_notified := false;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    -- Only admin_notify_change_students() (which runs as the owner) may set this to true.
    if new.students_notified is distinct from old.students_notified and current_user <> 'postgres' then
      new.students_notified := old.students_notified;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
drop trigger if exists product_changes_stamp on public.product_changes;
create trigger product_changes_stamp before insert or update on public.product_changes
  for each row execute function public.product_changes_stamp();
revoke all on function public.product_changes_stamp() from public, anon, authenticated;

alter table public.product_changes enable row level security;
drop policy if exists "Feedback admins read product changes" on public.product_changes;
create policy "Feedback admins read product changes" on public.product_changes
  for select to authenticated using (public.has_admin_permission('view_feedback'));
drop policy if exists "Feedback managers add product changes" on public.product_changes;
create policy "Feedback managers add product changes" on public.product_changes
  for insert to authenticated with check (public.has_admin_permission('manage_feedback'));
drop policy if exists "Feedback managers edit product changes" on public.product_changes;
create policy "Feedback managers edit product changes" on public.product_changes
  for update to authenticated using (public.has_admin_permission('manage_feedback'))
  with check (public.has_admin_permission('manage_feedback'));
drop policy if exists "Feedback managers delete product changes" on public.product_changes;
create policy "Feedback managers delete product changes" on public.product_changes
  for delete to authenticated using (public.has_admin_permission('manage_feedback'));
revoke all on public.product_changes from anon;
revoke truncate, references, trigger on public.product_changes from authenticated;
grant select, insert, update, delete on public.product_changes to authenticated;

alter table public.product_change_feedback enable row level security;
drop policy if exists "Feedback admins read change links" on public.product_change_feedback;
create policy "Feedback admins read change links" on public.product_change_feedback
  for select to authenticated using (public.has_admin_permission('view_feedback'));
drop policy if exists "Feedback managers add change links" on public.product_change_feedback;
create policy "Feedback managers add change links" on public.product_change_feedback
  for insert to authenticated with check (public.has_admin_permission('manage_feedback'));
drop policy if exists "Feedback managers remove change links" on public.product_change_feedback;
create policy "Feedback managers remove change links" on public.product_change_feedback
  for delete to authenticated using (public.has_admin_permission('manage_feedback'));
revoke all on public.product_change_feedback from anon;
revoke update, truncate, references, trigger on public.product_change_feedback from authenticated;
grant select, insert, delete on public.product_change_feedback to authenticated;


-- 4. The admin view ----------------------------------------------------------------------------------
-- security_invoker stays OFF (the default), like org_directory: the view reads app_feedback as its
-- owner, and its WHERE clause is the gate. Identity columns are blanked unless contact_allowed.
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
                 from public.product_change_feedback l where l.feedback_id = f.id), '{}') as change_ids
from public.app_feedback f
left join public.profiles p on p.id = f.user_id
where public.has_admin_permission('view_feedback');

revoke all on public.app_feedback_admin from anon;
revoke insert, update, delete, truncate, references, trigger on public.app_feedback_admin from authenticated;
grant select on public.app_feedback_admin to authenticated;


-- 5. Functions ---------------------------------------------------------------------------------------

-- A completion code: NSTR-XXXX-XXXX from 32 letters and digits with the look-alikes (0 O 1 I) left
-- out, so it can be read off a screenshot. 40 random bits; the primary key refuses a repeat.
create or replace function public._feedback_code()
returns text
language plpgsql
volatile
set search_path to 'public'
as $function$
declare
  v_abc constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_hex text := replace(gen_random_uuid()::text, '-', '');
  v_out text := '';
begin
  for i in 1..8 loop
    v_out := v_out || substr(v_abc, (('x' || substr(v_hex, 2 * i - 1, 2))::bit(8)::int % 32) + 1, 1);
  end loop;
  return 'NSTR-' || substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4);
end;
$function$;
revoke all on function public._feedback_code() from public, anon, authenticated;


-- The one way a student sends feedback. Everything the browser sends is checked or cleaned here.
create or replace function public.submit_app_feedback(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid     uuid := auth.uid();
  v_prof    public.profiles%rowtype;
  v_source  text := coalesce(p ->> 'feedback_source', '');
  v_kind    text := nullif(p ->> 'kind', '');
  v_rating  int  := case when (p ->> 'overall_rating') ~ '^[1-5]$' then (p ->> 'overall_rating')::int end;
  v_miss    text := nullif(p ->> 'would_miss_nestrel', '');
  v_feats   text[];
  v_liked   text := nullif(btrim(left(p ->> 'liked', 2000)), '');
  v_conf    text := nullif(btrim(left(p ->> 'confusing_or_missing', 2000)), '');
  v_one     text := nullif(btrim(left(p ->> 'one_thing_to_change', 2000)), '');
  v_msg     text := nullif(btrim(left(p ->> 'message', 2000)), '');
  v_secs    int  := case when (p ->> 'completion_seconds') ~ '^\d{1,6}$'
                         then least((p ->> 'completion_seconds')::int, 86400) end;
  v_done    public.feedback_completions%rowtype;
  v_code    text;
  v_at      timestamptz;
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

  select coalesce(array_agg(distinct x order by x), '{}') into v_feats
  from jsonb_array_elements_text(case when jsonb_typeof(p -> 'features_used') = 'array'
                                      then p -> 'features_used' else '[]'::jsonb end) as t(x)
  where x in ('events', 'marketplace', 'housing', 'textbooks', 'clubs', 'messaging', 'announcements',
              'search', 'other');

  if v_source = 'student_evaluation' then
    if v_rating is null or v_miss not in ('very_disappointed', 'somewhat_disappointed', 'not_disappointed')
       or v_miss is null or cardinality(v_feats) = 0 then
      raise exception 'Please answer the rating, what you tried, and the last question.' using errcode = 'check_violation';
    end if;
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
    browser, app_version, completion_seconds, course_ref, school)
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
    v_prof.school);

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


-- Status, tags and internal notes. Only the keys present in p_patch change. Returns before + after so
-- the page can write the activity log entry.
create or replace function public.admin_update_feedback(p_id bigint, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old  public.app_feedback%rowtype;
  v_new  public.app_feedback%rowtype;
  v_tags text[];
begin
  if not public.has_admin_permission('manage_feedback') then
    raise exception 'Your role does not include managing feedback.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_old from public.app_feedback where id = p_id for update;
  if v_old.id is null then
    raise exception 'That feedback no longer exists.' using errcode = 'no_data_found';
  end if;
  if p_patch ? 'tags' then
    select coalesce(array_agg(distinct t order by t), '{}') into v_tags
    from (select left(regexp_replace(btrim(x), '\s+', ' ', 'g'), 30) as t
          from jsonb_array_elements_text(case when jsonb_typeof(p_patch -> 'tags') = 'array'
                                              then p_patch -> 'tags' else '[]'::jsonb end) as a(x)) s
    where t <> '';
  end if;
  update public.app_feedback set
    status      = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    tags        = case when p_patch ? 'tags' then v_tags else tags end,
    admin_notes = case when p_patch ? 'admin_notes'
                       then nullif(btrim(left(p_patch ->> 'admin_notes', 4000)), '') else admin_notes end,
    updated_at  = now()
  where id = p_id
  returning * into v_new;
  return jsonb_build_object('before', jsonb_build_object('status', v_old.status, 'tags', v_old.tags,
                                                         'notes_changed', false),
                            'after',  jsonb_build_object('status', v_new.status, 'tags', v_new.tags,
                                                         'notes_changed', v_new.admin_notes is distinct from v_old.admin_notes));
end;
$function$;
revoke all on function public.admin_update_feedback(bigint, jsonb) from public, anon;
grant execute on function public.admin_update_feedback(bigint, jsonb) to authenticated;


-- "Students mentioning this: 6" rather than "6 messages". Takes {"group name": [feedback ids], ...}
-- and answers {"group name": number of different students}. A row whose account was deleted counts as
-- one student of its own. Counts only — never who.
create or replace function public.admin_feedback_student_counts(p_groups jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_key  text;
  v_ids  bigint[];
  v_out  jsonb := '{}';
  v_n    int;
begin
  if not public.has_admin_permission('view_feedback') then
    raise exception 'Your role does not include feedback.' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_groups) <> 'object' then return v_out; end if;
  for v_key in select k from jsonb_object_keys(p_groups) as k limit 200 loop
    if jsonb_typeof(p_groups -> v_key) <> 'array' then continue; end if;
    select coalesce(array_agg(x::bigint), '{}') into v_ids
    from (select jsonb_array_elements_text(p_groups -> v_key) as x limit 20000) s
    where x ~ '^\d{1,18}$';
    select count(distinct f.user_id) + count(*) filter (where f.user_id is null) into v_n
    from public.app_feedback f where f.id = any (v_ids);
    v_out := v_out || jsonb_build_object(v_key, v_n);
  end loop;
  return v_out;
end;
$function$;
revoke all on function public.admin_feedback_student_counts(jsonb) from public, anon;
grant execute on function public.admin_feedback_student_counts(jsonb) to authenticated;


-- Is this completion code real? Name, email and the DATE only — never the time, and never the answers.
create or replace function public.admin_verify_completion(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_c  public.feedback_completions%rowtype;
  v_p  public.profiles%rowtype;
begin
  if not public.has_admin_permission('view_feedback') then
    raise exception 'Your role does not include feedback.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_c from public.feedback_completions
  where code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if v_c.code is null then
    return jsonb_build_object('valid', false);
  end if;
  select * into v_p from public.profiles where id = v_c.user_id;
  return jsonb_build_object('valid', true, 'code', v_c.code,
    'name', nullif(btrim(coalesce(v_p.first_name, '') || ' ' || coalesce(v_p.last_name, '')), ''),
    'email', v_p.email, 'completed_on', (v_c.completed_at at time zone 'America/New_York')::date,
    'feedback_source', v_c.feedback_source);
end;
$function$;
revoke all on function public.admin_verify_completion(text) from public, anon;
grant execute on function public.admin_verify_completion(text) to authenticated;


-- "You asked, we built": tells every student whose feedback is linked to a SHIPPED change, in their
-- Activity feed. Anonymous senders are told too — the admin never learns who they are.
create or replace function public.admin_notify_change_students(p_change_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ch  public.product_changes%rowtype;
  v_n   integer;
begin
  if not public.has_admin_permission('manage_feedback') then
    raise exception 'Your role does not include managing feedback.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_ch from public.product_changes where id = p_change_id for update;
  if v_ch.id is null then
    raise exception 'That product change no longer exists.' using errcode = 'no_data_found';
  end if;
  if v_ch.status <> 'shipped' then
    raise exception 'Mark the change as shipped before telling students.' using errcode = 'check_violation';
  end if;
  if v_ch.students_notified then
    raise exception 'Students were already told about this change.' using errcode = 'check_violation';
  end if;
  insert into public.notifications (profile_id, type, message)
  select distinct f.user_id, 'feedback_change',
         'You asked, we built: ' || v_ch.title || '. Thank you for your feedback!'
  from public.product_change_feedback l
  join public.app_feedback f on f.id = l.feedback_id
  where l.change_id = p_change_id and f.user_id is not null;
  get diagnostics v_n = row_count;
  update public.product_changes set students_notified = true where id = p_change_id;
  return v_n;
end;
$function$;
revoke all on function public.admin_notify_change_students(bigint) from public, anon;
grant execute on function public.admin_notify_change_students(bigint) to authenticated;


-- Feedback and completion codes are kept 2 years, then deleted (Privacy Policy, section 07). Granted to
-- nobody: only pg_cron, running as the database owner, calls it (scheduled at the bottom of PART 1).
create or replace function public.purge_old_feedback()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer;
begin
  delete from public.app_feedback where created_at < now() - interval '2 years';
  get diagnostics v_n = row_count;
  delete from public.feedback_completions where completed_at < now() - interval '2 years';
  return v_n;
end;
$function$;
revoke all on function public.purge_old_feedback() from public, anon, authenticated;


-- 6. The two switches, off for every role except the super admin (who always has every switch) --------
insert into public.role_permissions (role_id, permission_key, enabled)
select r.id, k.permission_key, false
from public.admin_roles r
cross join unnest(array['view_feedback', 'manage_feedback']) as k(permission_key)
where r.id <> 'super_admin'
on conflict (role_id, permission_key) do nothing;

commit;

-- 7. The weekly erase. Outside the transaction on purpose, like 2026-09-15's event-views erase: if pg_cron
-- cannot be enabled, everything above must still exist — so a failure here says so loudly instead.
do $cron$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise warning E'\n\npg_cron could not be enabled (%).\nFeedback works, but NOTHING DELETES IT AFTER 2 YEARS until it is — the Privacy Policy promise is not in force.\nEnable it: Supabase Dashboard -> Database -> Extensions -> pg_cron. Then run this file again.\n', sqlerrm;
    return;
  end;
  -- Unschedule first, so re-running this file never leaves two copies of the job.
  perform cron.unschedule(jobid) from cron.job where jobname = 'nestrel-purge-old-feedback';
  perform cron.schedule('nestrel-purge-old-feedback', '41 3 * * 0', 'select public.purge_old_feedback()');
end
$cron$;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Speaks as two real students, a visitor, then as you.
-- THE ERROR MESSAGE IS THE REPORT, and the error discards everything it made.
-- ============================================================================

DO $verify$
DECLARE
  v_s1     uuid;
  v_s2     uuid;
  v_super  uuid;
  v_res    jsonb;
  v_res2   jsonb;
  v_code   text;
  v_n      int;
  v_fb     bigint;
  v_fb2    bigint;
  v_ch     bigint;
  v_row    record;
  v_err    text;
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
  -- Start clean for these two, inside this rolled-back test only.
  DELETE FROM public.feedback_completions WHERE user_id IN (v_s1, v_s2);
  DELETE FROM public.app_feedback WHERE user_id IN (v_s1, v_s2);

  PERFORM set_config('role', 'authenticated', true);

  -- Student 1 ---------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s1), true);
  v_res := public.submit_app_feedback('{"feedback_source":"student_evaluation","overall_rating":4,
    "features_used":["events","clubs","nonsense"],"liked":"verify-liked","would_miss_nestrel":"somewhat_disappointed",
    "device_type":"phone","browser":"Safari","app_version":"2026-10-05a","page_context":"events",
    "status":"completed","admin_notes":"injected","tags":["hacked"]}'::jsonb);
  v_code := v_res ->> 'code';
  IF v_code ~ '^NSTR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$' AND NOT (v_res ->> 'already')::boolean
  THEN r := r || format(E'TEST 1  a student submits the evaluation, gets a code ...... PASS (%s)\n', v_code);
  ELSE r := r || format(E'TEST 1  a student submits the evaluation, gets a code ...... *** FAIL — %s ***\n', v_res); ok := false; END IF;

  v_res2 := public.submit_app_feedback('{"feedback_source":"student_evaluation","overall_rating":1,
    "features_used":["other"],"would_miss_nestrel":"not_disappointed"}'::jsonb);
  IF v_res2 ->> 'code' = v_code AND (v_res2 ->> 'already')::boolean
  THEN r := r || E'TEST 2  a second submit the same day returns the same code ... PASS\n';
  ELSE r := r || format(E'TEST 2  a second submit the same day returns the same code ... *** FAIL — %s ***\n', v_res2); ok := false; END IF;

  BEGIN
    PERFORM count(*) FROM public.app_feedback;
    r := r || E'TEST 3  a student cannot read the feedback table ............... *** FAIL — read it ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  a student cannot read the feedback table ............... PASS\n';
  END;

  BEGIN
    UPDATE public.app_feedback SET status = 'completed', admin_notes = 'x';
    r := r || E'TEST 4  a student cannot change status or notes ................ *** FAIL — updated ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 4  a student cannot change status or notes ................ PASS\n';
  END;

  SELECT count(*) INTO v_n FROM public.app_feedback_admin;
  IF v_n = 0 THEN r := r || E'TEST 5  the admin view shows a student nothing ................. PASS\n';
  ELSE r := r || format(E'TEST 5  the admin view shows a student nothing ................. *** FAIL — %s rows ***\n', v_n); ok := false; END IF;

  BEGIN
    PERFORM public.admin_update_feedback(1, '{"status":"completed"}'::jsonb);
    r := r || E'TEST 6  a student cannot call the admin functions .............. *** FAIL — allowed ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 6  a student cannot call the admin functions .............. PASS\n';
  END;

  BEGIN
    INSERT INTO public.product_changes (title) VALUES ('verify-student-change');
    r := r || E'TEST 7  a student cannot add a product change .................. *** FAIL — added ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 7  a student cannot add a product change .................. PASS\n';
  END;

  -- 10 quick notes a day, then a polite refusal.
  FOR i IN 1..10 LOOP
    PERFORM public.submit_app_feedback(format('{"feedback_source":"general","kind":"idea","message":"verify-note-%s"}', i)::jsonb);
  END LOOP;
  BEGIN
    PERFORM public.submit_app_feedback('{"feedback_source":"general","kind":"idea","message":"verify-note-11"}'::jsonb);
    r := r || E'TEST 8  the 11th quick note in a day is refused ................ *** FAIL — accepted ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN
    r := r || E'TEST 8  the 11th quick note in a day is refused ................ PASS\n';
  END;

  -- Student 2: sees none of student 1's codes; sends an evaluation they CAN be contacted about. ----
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_s2), true);
  SELECT count(*) INTO v_n FROM public.feedback_completions WHERE code = v_code;
  IF v_n = 0 THEN r := r || E'TEST 9  a student cannot see another student''s code ........ PASS\n';
  ELSE r := r || E'TEST 9  a student cannot see another student''s code ........ *** FAIL — visible ***\n'; ok := false; END IF;
  PERFORM public.submit_app_feedback('{"feedback_source":"student_evaluation","overall_rating":5,
    "features_used":["marketplace"],"one_thing_to_change":"verify-one-thing","would_miss_nestrel":"very_disappointed",
    "contact_allowed":true}'::jsonb);

  -- A visitor --------------------------------------------------------------------------------------
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.submit_app_feedback('{"feedback_source":"general","kind":"idea"}'::jsonb);
    r := r || E'TEST 10 a visitor cannot send feedback ......................... *** FAIL — accepted ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 10 a visitor cannot send feedback ......................... PASS\n';
  END;

  -- You ---------------------------------------------------------------------------------------------
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);

  SELECT id, status, tags, admin_notes, user_id, student_name INTO v_row
  FROM public.app_feedback_admin WHERE liked = 'verify-liked';
  v_fb := v_row.id;
  IF v_fb IS NOT NULL AND v_row.status = 'new' AND v_row.tags = '{}' AND v_row.admin_notes IS NULL
  THEN r := r || E'TEST 11 what the browser sent for status/notes/tags was ignored  PASS\n';
  ELSE r := r || format(E'TEST 11 what the browser sent for status/notes/tags was ignored  *** FAIL — %s ***\n', v_row); ok := false; END IF;
  IF v_row.user_id IS NULL AND v_row.student_name IS NULL
  THEN r := r || E'TEST 12 no tick box: you see the answers, not the name ........ PASS\n';
  ELSE r := r || E'TEST 12 no tick box: you see the answers, not the name ........ *** FAIL — name shown ***\n'; ok := false; END IF;

  SELECT id, user_id INTO v_row FROM public.app_feedback_admin WHERE one_thing_to_change = 'verify-one-thing';
  v_fb2 := v_row.id;
  IF v_row.user_id = v_s2
  THEN r := r || E'TEST 13 tick box on: you see who it was ....................... PASS\n';
  ELSE r := r || E'TEST 13 tick box on: you see who it was ....................... *** FAIL — no name ***\n'; ok := false; END IF;

  v_res := public.admin_verify_completion(lower(v_code));
  IF (v_res ->> 'valid')::boolean AND v_res ? 'completed_on' AND NOT v_res ? 'completed_at'
  THEN r := r || E'TEST 14 a real code verifies (date only) ...................... PASS\n';
  ELSE r := r || format(E'TEST 14 a real code verifies (date only) ...................... *** FAIL — %s ***\n', v_res); ok := false; END IF;
  IF NOT (public.admin_verify_completion('NSTR-AAAA-AAAA') ->> 'valid')::boolean
  THEN r := r || E'TEST 15 a made-up code does not ............................... PASS\n';
  ELSE r := r || E'TEST 15 a made-up code does not ............................... *** FAIL ***\n'; ok := false; END IF;

  v_res := public.admin_update_feedback(v_fb, '{"status":"planned","tags":["Search"," search ","UX"],"admin_notes":"verify"}'::jsonb);
  SELECT status, tags INTO v_row FROM public.app_feedback_admin WHERE id = v_fb;
  IF v_row.status = 'planned' AND 'UX' = ANY (v_row.tags)
  THEN r := r || E'TEST 16 you can set status, tags and notes .................... PASS\n';
  ELSE r := r || format(E'TEST 16 you can set status, tags and notes .................... *** FAIL — %s ***\n', v_row); ok := false; END IF;

  INSERT INTO public.product_changes (title, reason, status, students_notified)
  VALUES ('verify-change', 'verify', 'shipped', true) RETURNING id INTO v_ch;
  INSERT INTO public.product_change_feedback (change_id, feedback_id) VALUES (v_ch, v_fb), (v_ch, v_fb2);
  v_res := public.admin_feedback_student_counts(jsonb_build_object('pair', jsonb_build_array(v_fb, v_fb2)));
  IF (v_res ->> 'pair')::int = 2
  THEN r := r || E'TEST 17 two students counted as 2, not as rows ................ PASS\n';
  ELSE r := r || format(E'TEST 17 two students counted as 2, not as rows ................ *** FAIL — %s ***\n', v_res); ok := false; END IF;

  BEGIN
    v_n := public.admin_notify_change_students(v_ch);
    IF v_n = 2 THEN r := r || E'TEST 18 shipping tells both students in their Activity ...... PASS\n';
    ELSE r := r || format(E'TEST 18 shipping tells both students in their Activity ...... *** FAIL — %s told ***\n', v_n); ok := false; END IF;
  EXCEPTION WHEN others THEN
    r := r || format(E'TEST 18 shipping tells both students in their Activity ...... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — no test feedback, code, change or notification exists.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;


-- ============================================================================
-- CHECK: the weekly erase. Expect one row, active. If THIS query errors with "relation cron.job does not
-- exist", pg_cron is not enabled — see the warning PART 1 printed.
-- ============================================================================
-- select jobname, schedule, command, active from cron.job where jobname = 'nestrel-purge-old-feedback';


-- ============================================================================
-- CHECK (optional, any time): what each role can do with the new objects. Expect app_feedback to have
-- NO rows for anon or authenticated, and nothing beyond SELECT on app_feedback_admin.
-- ============================================================================
-- select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
-- from information_schema.role_table_grants
-- where table_schema = 'public' and grantee in ('anon', 'authenticated')
--   and table_name in ('app_feedback', 'feedback_completions', 'product_changes', 'product_change_feedback',
--                      'app_feedback_admin')
-- group by table_name, grantee order by table_name, grantee;
