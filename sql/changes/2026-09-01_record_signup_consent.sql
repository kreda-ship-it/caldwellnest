-- Record signup consent on the profile
-- 2026-09-01
--
-- The signup checkbox ("I'm 18+ and I agree to the Terms & Conditions and Privacy
-- Policy") has only ever gated the UI. Nothing was written, so there was no record
-- that any student agreed to anything. This adds one.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run.

-- ── 1. The columns ────────────────────────────────────────────────────────────
--
-- Two columns, not one. A timestamp alone says "they agreed on Sept 1" without
-- saying WHAT they agreed to. The moment the documents are edited, an undated
-- record stops meaning anything. The version makes it evidence.
--
-- Both are nullable ON PURPOSE. Every profile that exists today predates this,
-- and NULL is the truthful answer for them: there is no record. Backfilling a
-- timestamp onto those rows would be inventing evidence, so it is not done here.

alter table public.profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;

comment on column public.profiles.terms_accepted_at is
  'When this student accepted the Terms & Privacy Policy at signup. Set server-side by handle_new_user(), never by the client. NULL = no record of consent (accounts created before 2026-09-01).';
comment on column public.profiles.terms_version is
  'Which version of the documents they accepted, as shown to them in the browser. Mirrors TERMS_VERSION in js/config.js.';

-- ── 2. Teach the signup trigger to record it ──────────────────────────────────
--
-- Unchanged from the previous definition except for the two consent columns.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (
    id, first_name, last_name, email, username, major, year, initials, color, school, status,
    terms_version, terms_accepted_at
  )
  values (
    new.id,
    new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'last_name',
    new.email,
    new.raw_user_meta_data->>'username', new.raw_user_meta_data->>'major',
    new.raw_user_meta_data->>'year', new.raw_user_meta_data->>'initials',
    new.raw_user_meta_data->>'color', new.raw_user_meta_data->>'school',
    'active',

    -- The VERSION comes from the browser, because only the browser knows which
    -- document it actually rendered to the person.
    nullif(new.raw_user_meta_data->>'terms_version', ''),

    -- The TIMESTAMP is set HERE, with now(). Never accepted from the client: the
    -- anon key is public, so any timestamp a browser sends is a number the sender
    -- chose. A server clock cannot be argued with.
    --
    -- And it is stamped ONLY when a version actually arrived. Someone calling
    -- auth.signUp directly, bypassing the signup form, sends no consent metadata
    -- and must end up with NULL. Stamping now() unconditionally would manufacture
    -- a consent record for consent that never happened -- worse than no record.
    case
      when nullif(new.raw_user_meta_data->>'terms_version', '') is not null
      then now()
    end
  )
  on conflict (id) do nothing;   -- safe alongside the old client insert during transition
  return new;
end; $function$;

-- ── 3. STILL TO COME (do not consider this finished) ──────────────────────────
--
-- These columns are not yet protected. A student can UPDATE their own profiles
-- row, which means they can erase their own consent record -- and they are
-- exactly the person with a reason to. The fix belongs inside the existing
-- privileged-columns guard on this table, alongside status and email, and is
-- being written as a separate file once that function has been read rather than
-- guessed at.

notify pgrst, 'reload schema';
