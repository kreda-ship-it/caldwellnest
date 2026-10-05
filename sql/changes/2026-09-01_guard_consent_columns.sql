-- Protect the recorded consent columns
-- 2026-09-01
--
-- Second half of 2026-09-01_record_signup_consent.sql, which deliberately shipped
-- with its section 3 saying it wasn't finished. That file added
-- profiles.terms_accepted_at / terms_version and started writing them. This one
-- stops the student from rewriting them.
--
-- Why it matters: a student can UPDATE their own profiles row. Without this, the
-- one person with a reason to erase a consent record is the one person able to.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run.

-- This is the EXISTING guard (behind trigger profiles_guard_privileged), unchanged
-- except for the second `if` block. The trigger itself is not touched -- it already
-- points here, and it is BEFORE UPDATE only, so handle_new_user's INSERT at signup
-- is unaffected and can still write consent.

create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- auth.uid(), never current_user: inside SECURITY DEFINER, current_user is the
  -- function's owner, so it would exempt everybody. (Learned the hard way -- see
  -- sql/2026-08-08_check_book_listings_guard.sql.)
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

  -- Consent is a record of something that happened, not a profile setting. It gets
  -- its own block and its own message so a student editing their bio never sees an
  -- error about "account status, school or email" that has nothing to do with them.
  --
  -- Checked before shipping: no client write path touches these columns.
  -- saveProfile() sends a narrow object, so the unlisted columns keep their old
  -- values and `is distinct from` stays false; the signup upsert is ON CONFLICT DO
  -- NOTHING; every admin write is exempted above. This block cannot fire during
  -- ordinary use -- which is the check that was NOT done before
  -- messages_guard_immutable, and is why that one broke read receipts.
  if new.terms_accepted_at is distinct from old.terms_accepted_at
     or new.terms_version  is distinct from old.terms_version then
    raise exception 'Not permitted to change the recorded terms acceptance'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

-- ── A note for whoever builds re-consent ──────────────────────────────────────
--
-- When terms.html or privacy.html change materially, TERMS_VERSION in js/config.js
-- gets bumped and existing students should be asked to accept again. That flow will
-- hit this guard, and the fix is NOT to weaken it.
--
-- Do it with a SECURITY DEFINER RPC that stamps now() server-side, exactly as
-- handle_new_user does -- the timestamp must never come from the browser. Note that
-- auth.uid() still resolves to the calling student inside such a function, so the
-- RPC needs an explicit escape hatch here rather than inheriting the admin exemption.
--
-- Whatever that escape hatch is, it must be reachable ONLY from that RPC. A student
-- who can call it directly can forge a consent date, which is the same problem in a
-- nicer costume.

notify pgrst, 'reload schema';
