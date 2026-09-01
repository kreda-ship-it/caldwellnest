-- CAPTURE ONLY -- the .edu email gate, as it really exists
-- 2026-09-01
--
-- Not a change. This is the trigger and function behind launch blocker #1, read out
-- of the live database and written down for the first time. sql/README.md lists the
-- profiles triggers under "Still missing"; this closes part of that.
--
-- Running it is a no-op against the current database: it recreates what is already
-- there, byte for byte. Its value is that the rule now exists somewhere it can be
-- read, reviewed and restored -- rather than only inside one hosted Supabase project.
--
-- The other two triggers on public.profiles are captured in their own files:
--   handle_new_user                  -> 2026-09-01_record_signup_consent.sql
--   guard_profile_privileged_columns -> 2026-09-01_guard_consent_columns.sql

create or replace function public.enforce_school_email()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_domain text;
  v_slug   text;
begin
  -- Admins and service accounts are exempt: they legitimately hold non-.edu addresses,
  -- and locking them out of their own profile row is worse than the hole it closes.
  if exists (select 1 from public.user_roles where user_id = new.id) then
    return new;
  end if;

  v_domain := lower(split_part(btrim(coalesce(new.email, '')), '@', 2));

  if v_domain = '' or v_domain not like '%.edu' then
    raise exception 'Sign-up requires a .edu university email address'
      using errcode = 'check_violation';
  end if;

  select s.slug into v_slug
  from public.school_domains d
  join public.schools s on s.id = d.school_id
  where d.domain = v_domain;

  if v_slug is null then
    raise exception 'Unrecognized university email domain: %', v_domain
      using errcode = 'check_violation';
  end if;

  if new.school is null or lower(new.school) <> lower(v_slug) then
    raise exception 'Email domain % does not match the selected school (%)', v_domain, new.school
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

-- The trigger definition, exactly as pg_get_triggerdef reports it. Note it fires on
-- INSERT and on UPDATE OF email, school only -- an ordinary profile edit (bio, major,
-- avatar) never re-runs the domain lookup.
drop trigger if exists profiles_enforce_school_email on public.profiles;
create trigger profiles_enforce_school_email
  before insert or update of email, school on public.profiles
  for each row execute function enforce_school_email();

notify pgrst, 'reload schema';
