-- Sign up with Google — Caldwell only
-- 2026-09-23
--
-- "Continue with Google" is now the ONLY way to create an account; the email signup form
-- is gone from the app. Login still works with Google or with email + password (the
-- password is set on the finish screen). Google hands back a verified email and a display
-- name, and nothing else — no school, no username, no consent. This file teaches the
-- database to cope with that, in three parts:
--
--   1. handle_new_user() REFUSES any email not on @caldwell.edu, then fills in what Google
--      didn't send: the school (worked out from the email domain), first/last name (split
--      from Google's full name), initials and a colour.
--   2. guard_profile_privileged_columns() gets ONE escape hatch, reachable only from the
--      function in part 3, so consent can be recorded after signup.
--   3. complete_google_signup() — the "Finish signing up" screen calls this to save the
--      username, name, major, year, and to record Terms consent with the SERVER's clock.
--
-- WHY THE DATABASE CHECKS THE DOMAIN when the app already asks Google for Caldwell accounts
-- only: that request (Google's `hd` setting) is sent from the browser, and anyone can edit
-- it out. This check runs where nobody can reach it. A refusal rolls back the whole signup,
-- so no half-account is left behind. enforce_school_email() is untouched and still runs too.
--
-- It applies to every NEW account, however it is created — including one added by hand in
-- the Supabase dashboard. Existing accounts are not touched. To open signup to another
-- school later, add its domain to the list in section 1 AND change SIGNUP_GOOGLE_DOMAIN in
-- js/auth.js.
--
-- BEFORE RUNNING: parts 1 and 2 REPLACE two live functions, rebuilt from their last
-- written-down versions (2026-09-01_record_signup_consent.sql and
-- 2026-09-01_guard_consent_columns.sql). The database is ground truth, so first confirm
-- nobody changed them directly in the dashboard since then:
--
--   select pg_get_functiondef('public.handle_new_user'::regproc);
--   select pg_get_functiondef('public.guard_profile_privileged_columns'::regproc);
--
-- Each should match its 2026-09-01 file. If either has something extra, stop and say so.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run.


-- ── 1. Caldwell-only, and profile creation that works without a signup form ───
--
-- Metadata still wins where it exists (each derived value is only a fallback behind
-- coalesce()), so an account created with metadata — the old email form did this — keeps
-- working the same way.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full   text  := btrim(coalesce(m->>'full_name', m->>'name', ''));
  v_first  text  := nullif(btrim(m->>'first_name'), '');
  v_last   text  := nullif(btrim(m->>'last_name'), '');
  v_school text  := nullif(m->>'school', '');
  v_domain text  := lower(split_part(btrim(coalesce(new.email, '')), '@', 2));
begin
  -- The lock. See the header for why this is here and not only in the app.
  if v_domain not in ('caldwell.edu') then
    raise exception 'Sign-up is open to @caldwell.edu accounts only'
      using errcode = 'check_violation';
  end if;

  -- Google sends one "full_name". First word is the first name, the rest is the last.
  -- The student can correct both on the finish screen, so a best guess is fine here.
  if v_first is null and v_full <> '' then
    v_first := split_part(v_full, ' ', 1);
    v_last  := coalesce(v_last, nullif(btrim(substr(v_full, length(v_first) + 1)), ''));
  end if;
  v_first := coalesce(v_first, split_part(new.email, '@', 1));
  v_last  := coalesce(v_last, '');   -- last_name is NOT NULL; empty beats a made-up one

  -- No school in the metadata (every Google signup): look it up from the email domain,
  -- the same table enforce_school_email() checks against. If the domain is unknown this
  -- stays NULL, and enforce_school_email() refuses the insert with its usual message.
  if v_school is null then
    select s.slug into v_school
    from public.school_domains d
    join public.schools s on s.id = d.school_id
    where d.domain = v_domain;
  end if;

  insert into public.profiles (
    id, first_name, last_name, email, username, major, year, initials, color, school, status,
    terms_version, terms_accepted_at
  )
  values (
    new.id,
    v_first, v_last,
    new.email,
    m->>'username', m->>'major', m->>'year',
    coalesce(nullif(m->>'initials', ''), upper(left(v_first, 1) || left(v_last, 1))),
    -- Same palette as AC in js/config.js.
    coalesce(nullif(m->>'color', ''),
             (array['#2d6148','#3B5BA5','#C0392B','#7D3C98','#D68910','#117A65','#A04000'])[1 + floor(random() * 7)::int]),
    v_school,
    'active',

    -- Consent, exactly as before: the VERSION comes from the browser, the TIMESTAMP from
    -- now(), and only when a version actually arrived. A Google signup sends none, so it
    -- starts with NULL here and gets its record from complete_google_signup() below.
    nullif(m->>'terms_version', ''),
    case
      when nullif(m->>'terms_version', '') is not null
      then now()
    end
  )
  on conflict (id) do nothing;
  return new;
end; $function$;


-- ── 2. The consent guard, with one escape hatch ───────────────────────────────
--
-- Unchanged from 2026-09-01_guard_consent_columns.sql except the marked lines.
--
-- The 2026-09-01 file said re-consent must go through a SECURITY DEFINER function that
-- stamps now() itself, and that the escape hatch must be reachable ONLY from it. This is
-- that. The hatch is a transaction-local setting, 'nestrel.recording_consent'. A student
-- cannot set it: the API only runs functions in the public schema, set_config() lives in
-- pg_catalog, and each API request is its own transaction, so the setting could not
-- survive into a separate UPDATE even if they could. Only complete_google_signup() sets it.

create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if exists (select 1 from public.user_roles where user_id = auth.uid()) then
    return new;
  end if;

  if new.status               is distinct from old.status
     or new.suspension_reason is distinct from old.suspension_reason
     or new.school            is distinct from old.school
     or new.email             is distinct from old.email
     or new.id                is distinct from old.id then
    raise exception 'Not permitted to change account status, school or email'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.terms_accepted_at is distinct from old.terms_accepted_at
      or new.terms_version  is distinct from old.terms_version)
     -- NEW 2026-09-23: complete_google_signup() records first-time consent.
     and coalesce(current_setting('nestrel.recording_consent', true), '') <> 'on' then
    raise exception 'Not permitted to change the recorded terms acceptance'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;


-- ── 3. Finish signing up ──────────────────────────────────────────────────────
--
-- Called once, by the "Finish signing up" screen, after a student arrives from Google.
-- It only acts on a profile that has NO username yet, so it cannot be replayed later to
-- re-stamp consent or to dodge the normal profile-edit path.
--
-- Consent is written with coalesce(): a profile that somehow already holds a record keeps
-- it. The timestamp is now(), never a value from the browser.
--
-- The password is NOT set here. Passwords live in Supabase Auth, not in this table; the
-- browser sets it with auth.updateUser() just before calling this.

create or replace function public.complete_google_signup(
  p_first         text,
  p_last          text,
  p_username      text,
  p_major         text,
  p_year          text,
  p_terms_version text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  v_first text := btrim(coalesce(p_first, ''));
  v_last  text := btrim(coalesce(p_last, ''));
  v_rows  int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;
  if v_first = '' or v_last = '' then
    raise exception 'First and last name are required' using errcode = 'check_violation';
  end if;
  -- Without this, an empty username would "finish" nothing: the row stays unfinished and the
  -- consent stamp would already be on it.
  if nullif(btrim(coalesce(p_username, '')), '') is null then
    raise exception 'Please choose a username' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_terms_version, '')), '') is null then
    raise exception 'You must accept the Terms to continue' using errcode = 'check_violation';
  end if;

  perform set_config('nestrel.recording_consent', 'on', true);

  update public.profiles
     set first_name        = v_first,
         last_name         = v_last,
         initials          = upper(left(v_first, 1) || left(v_last, 1)),
         username          = lower(btrim(p_username)),   -- username_format + unique index still apply
         major             = nullif(btrim(coalesce(p_major, '')), ''),
         year              = nullif(btrim(coalesce(p_year, '')), ''),
         terms_version     = coalesce(terms_version, btrim(p_terms_version)),
         terms_accepted_at = coalesce(terms_accepted_at, now())
   where id = v_uid
     and username is null;
  -- Read the row count BEFORE the next perform: perform overwrites FOUND.
  get diagnostics v_rows = row_count;

  perform set_config('nestrel.recording_consent', '', true);

  if v_rows = 0 then
    raise exception 'This account is already set up' using errcode = 'check_violation';
  end if;
end;
$function$;

-- Supabase grants EXECUTE on every new function to anon and PUBLIC by default. Only a
-- signed-in student has any business calling this one.
revoke all on function public.complete_google_signup(text, text, text, text, text, text) from public, anon;
grant execute on function public.complete_google_signup(text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
