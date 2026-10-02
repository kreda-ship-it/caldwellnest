-- Account deletion that works, and matches the Privacy Policy (section 07)
-- 2026-10-01
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the self-test)
-- as a separate run — the editor shows only the last result, and the self-test's result is its
-- error message. Safe to re-run.
--
-- WHY
-- Deleting an account failed: 18 links to profiles / auth.users had no ON DELETE rule ("no action"),
-- so any account that had posted a listing, written to the activity log, created a club event, etc.
-- could not be deleted (live list read 2026-10-01). The Privacy Policy promises deletion within 30
-- days of a request, and the pre-launch cleanup needs it to remove test accounts.
--
-- WHAT CHANGES
--   1. Deleted WITH the account (Privacy: "deleted along with your account"):
--        listings.poster_id, book_listings.poster_id                         -> ON DELETE CASCADE
--      (Already cascading, unchanged: profile, messages both sides, favourites, follows, memberships,
--       RSVPs, feedback, event views, poll votes, notifications, appeals, suspension history.)
--   2. KEPT, with the person's link cleared (they belong to the platform, a club, or the record):
--        the activity log (actor_id, undone_by), admins' fields on appeals / reports / suspension
--        history / broadcasts / settings, club content (organizations, events, org_posts,
--        event_media created_by), check-ins they did as an officer, members they added, and listing
--        status history                                                      -> ON DELETE SET NULL
--      Plus REPORTS THEY FILED (reports.reporter_id, was CASCADE): kept with the reporter's name
--      removed, so a victim deleting their account does not erase their report (Kal, 2026-10-01).
--   3. blocked_signups: when the deleted account was SUSPENDED, its email is kept for 2 years and a
--      new sign-up with it is refused (Kal, 2026-10-01; Privacy section 07 says so). Only the
--      function below writes it; only the super admin may read it.
--   4. admin_delete_account(user, typed_email): super admin only. Refuses an admin account (remove
--      its role first) and an email that does not match. Logs 'account_deleted', blocks the email if
--      suspended, then deletes the auth user — everything in 1 goes with it.
--      Photo FILES are not in the database: the admin page deletes the student's listing, book and
--      profile photos itself (js/admin.js), and leaves club logos alone.
--   The FK changes find each constraint by table, column and target, keep its name, and stop with
--   NOTHING changed if one is missing. A final check refuses to commit if any link to profiles or
--   auth.users in public is still "no action" or "restrict".
--
-- UNDO: the old rule for each link was "no action" (reports.reporter_id: "cascade"); ask Claude.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- 1 + 2. The links ----------------------------------------------------------------------------------
do $$
declare
  f     record;
  v_con text;
begin
  for f in select * from (values
    ('listings',               'poster_id',          'auth.users',      'cascade'),
    ('book_listings',          'poster_id',          'public.profiles', 'cascade'),
    ('reports',                'reporter_id',        'public.profiles', 'set null'),
    ('admin_activity_log',     'actor_id',           'auth.users',      'set null'),
    ('admin_activity_log',     'undone_by',          'auth.users',      'set null'),
    ('appeal_audit_log',       'actioned_by',        'auth.users',      'set null'),
    ('appeals',                'resolved_by',        'auth.users',      'set null'),
    ('appeals',                'decision_edited_by', 'auth.users',      'set null'),
    ('broadcasts',             'actor_id',           'auth.users',      'set null'),
    ('event_media',            'created_by',         'public.profiles', 'set null'),
    ('event_registrations',    'checked_in_by',      'public.profiles', 'set null'),
    ('events',                 'created_by',         'public.profiles', 'set null'),
    ('listing_status_history', 'changed_by',         'auth.users',      'set null'),
    ('org_memberships',        'added_by',           'public.profiles', 'set null'),
    ('org_posts',              'created_by',         'public.profiles', 'set null'),
    ('organizations',          'created_by',         'public.profiles', 'set null'),
    ('platform_settings',      'updated_by',         'auth.users',      'set null'),
    ('reports',                'resolved_by',        'public.profiles', 'set null'),
    ('suspension_history',     'actioned_by',        'public.profiles', 'set null')
  ) as t(tbl, col, ref, action)
  loop
    v_con := null;
    select c.conname into v_con
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.conrelid = ('public.' || f.tbl)::regclass and a.attname = f.col
      and c.confrelid = f.ref::regclass and array_length(c.conkey, 1) = 1
    limit 1;
    if v_con is null then
      raise exception 'No link %.% -> % was found, so NOTHING in PART 1 was changed. Send Claude this message.', f.tbl, f.col, f.ref;
    end if;
    if f.action = 'set null' then
      execute format('alter table public.%I alter column %I drop not null', f.tbl, f.col);
    end if;
    execute format('alter table public.%I drop constraint %I', f.tbl, v_con);
    execute format('alter table public.%I add constraint %I foreign key (%I) references %s (id) on delete %s',
                   f.tbl, v_con, f.col, f.ref, f.action);
  end loop;
end
$$;


-- 3. Blocked sign-ups ---------------------------------------------------------------------------------
create table if not exists public.blocked_signups (
  email         text primary key,                         -- lower case
  reason        text,
  blocked_until timestamptz not null,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null
);
alter table public.blocked_signups enable row level security;

drop policy if exists "Super admin reads blocked sign-ups" on public.blocked_signups;
create policy "Super admin reads blocked sign-ups" on public.blocked_signups
  as permissive for select to authenticated
  using (public.is_super_admin());

-- New table: Supabase hands it default privileges before any grant runs (CLAUDE.md). Nobody writes it
-- from a browser — only admin_delete_account() — so only SELECT is left, for the policy above.
revoke all on public.blocked_signups from anon;
revoke insert, update, delete, truncate, references, trigger on public.blocked_signups from authenticated;
grant select on public.blocked_signups to authenticated;

create or replace function public.refuse_blocked_signup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if exists (select 1 from public.blocked_signups b
             where b.email = lower(btrim(coalesce(new.email, ''))) and b.blocked_until > now()) then
    raise exception 'This email address cannot be used to create an account.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$function$;

drop trigger if exists profiles_refuse_blocked_signup on public.profiles;
create trigger profiles_refuse_blocked_signup
  before insert on public.profiles
  for each row execute function public.refuse_blocked_signup();


-- 4. Deleting an account ------------------------------------------------------------------------------
create or replace function public.admin_delete_account(p_user uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  p          public.profiles%rowtype;
  v_email    text;
  v_suspended boolean;
  v_counts   jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'Only the super admin can delete accounts' using errcode = 'insufficient_privilege';
  end if;
  select * into p from public.profiles where id = p_user;
  select lower(u.email) into v_email from auth.users u where u.id = p_user;
  v_email := coalesce(v_email, lower(p.email));
  if p.id is null and v_email is null then
    raise exception 'There is no such account' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.user_roles where user_id = p_user) then
    raise exception 'This is an admin account. Remove its admin access on the Admin team page first.'
      using errcode = 'insufficient_privilege';
  end if;
  if lower(btrim(coalesce(p_email, ''))) <> coalesce(v_email, '') then
    raise exception 'The email typed does not match this account' using errcode = 'check_violation';
  end if;

  v_suspended := coalesce(p.status = 'suspended', false);
  v_counts := jsonb_build_object(
    'listings', (select count(*) from public.listings where poster_id = p_user),
    'books',    (select count(*) from public.book_listings where poster_id = p_user),
    'messages', (select count(*) from public.messages where sender_id = p_user or receiver_id = p_user),
    'blocked',  v_suspended);

  if v_suspended then
    insert into public.blocked_signups (email, reason, blocked_until, created_by)
    values (v_email, coalesce(p.suspension_reason, 'Suspended account deleted'), now() + interval '2 years', auth.uid())
    on conflict (email) do update set reason = excluded.reason, blocked_until = excluded.blocked_until,
                                      created_by = excluded.created_by, created_at = now();
  end if;

  insert into public.admin_activity_log (actor_id, actor_school, action_type, target_type, target_id, target_label, reason, metadata)
  values (auth.uid(), public.get_admin_school(), 'account_deleted', 'student', p_user::text,
          nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
          case when v_suspended then 'Suspended account: email blocked from signing up for 2 years' end,
          v_counts);

  -- The auth user goes, and everything linked to it with it (profile, listings, books, messages, ...).
  -- An orphan profile with no auth user is removed directly.
  delete from auth.users where id = p_user;
  delete from public.profiles where id = p_user;
  return v_counts;
end;
$function$;

revoke all on function public.admin_delete_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;


-- Nothing may still block a deletion. If anything does, stop here and change nothing.
do $$
declare v_left text;
begin
  select string_agg(c.conrelid::regclass::text || '.' || a.attname, ', ') into v_left
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    and c.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)
    and c.confdeltype in ('a', 'r');
  if v_left is not null then
    raise exception 'These links would still block a deletion, so NOTHING was changed: %. Send Claude this message.', v_left;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — self-test (run on its own). Deletes two real student accounts INSIDE a test that is thrown
-- away: the one with the most listings and messages, and one made suspended for the test. THE ERROR
-- MESSAGE IS THE REPORT, and the error undoes everything — both accounts are exactly as they were.
-- ============================================================================

DO $verify$
DECLARE
  v_super  uuid;
  v_a      uuid;  v_a_email text;
  v_b      uuid;  v_b_email text;  v_b_school text;
  v_c      uuid;
  v_res    jsonb;
  v_n      int;
  r        text := E'\n';
  ok       boolean := true;
BEGIN
  SELECT user_id INTO v_super FROM public.user_roles WHERE role_id = 'super_admin' LIMIT 1;
  -- A: the non-admin student with the most of their own data
  SELECT p.id, lower(coalesce(u.email, p.email)) INTO v_a, v_a_email
  FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.school IS NOT NULL
  ORDER BY (SELECT count(*) FROM public.listings l WHERE l.poster_id = p.id)
         + (SELECT count(*) FROM public.messages m WHERE m.sender_id = p.id OR m.receiver_id = p.id) DESC, p.created_at
  LIMIT 1;
  -- B: another student, suspended for the test.  C: a third, who tries to delete someone.
  SELECT p.id, lower(coalesce(u.email, p.email)), p.school INTO v_b, v_b_email, v_b_school
  FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.school IS NOT NULL AND p.id <> v_a
  ORDER BY p.created_at LIMIT 1;
  SELECT p.id INTO v_c FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.id NOT IN (v_a, v_b)
  ORDER BY p.created_at LIMIT 1;
  IF v_super IS NULL OR v_a IS NULL OR v_b IS NULL OR v_c IS NULL THEN
    RAISE EXCEPTION 'Needs the super admin and three non-admin student accounts to test with.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint c
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND c.confrelid IN ('public.profiles'::regclass, 'auth.users'::regclass) AND c.confdeltype IN ('a', 'r');
  IF v_n = 0 THEN r := r || E'TEST 0  no link blocks a deletion any more ........... PASS\n';
  ELSE r := r || format(E'TEST 0  no link blocks a deletion any more ........... *** FAIL — %s left ***\n', v_n); ok := false; END IF;

  -- A student cannot delete anyone.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_c), true);
  BEGIN
    PERFORM public.admin_delete_account(v_a, v_a_email);
    r := r || E'TEST 1  a student cannot delete an account ........... *** FAIL — DELETED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 1  a student cannot delete an account ........... PASS (refused)\n';
  END;

  -- You, from here on (identity only: this test keeps the editor's own access to check the results).
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","sub":"%s"}', v_super), true);
  BEGIN
    PERFORM public.admin_delete_account(v_a, 'wrong@example.com');
    r := r || E'TEST 2  a mistyped email stops it .................... *** FAIL — DELETED ***\n'; ok := false;
  EXCEPTION WHEN check_violation THEN
    r := r || E'TEST 2  a mistyped email stops it .................... PASS (refused)\n';
  END;
  BEGIN
    PERFORM public.admin_delete_account(v_super, (SELECT lower(email) FROM auth.users WHERE id = v_super));
    r := r || E'TEST 3  an admin account cannot be deleted ............ *** FAIL — DELETED ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 3  an admin account cannot be deleted ............ PASS (refused)\n';
  END;

  BEGIN
    v_res := public.admin_delete_account(v_a, v_a_email);
    r := r || format(E'TEST 4  deleting the busiest student works ......... PASS (%s listings, %s books, %s messages)\n',
                     v_res->>'listings', v_res->>'books', v_res->>'messages');
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 4  deleting the busiest student works ......... *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;
  SELECT (SELECT count(*) FROM public.profiles WHERE id = v_a) + (SELECT count(*) FROM auth.users WHERE id = v_a)
       + (SELECT count(*) FROM public.listings WHERE poster_id = v_a) + (SELECT count(*) FROM public.book_listings WHERE poster_id = v_a)
       + (SELECT count(*) FROM public.messages WHERE sender_id = v_a OR receiver_id = v_a)
    INTO v_n;
  IF v_n = 0 THEN r := r || E'TEST 5  account, listings, books, messages: all gone  PASS\n';
  ELSE r := r || format(E'TEST 5  account, listings, books, messages: all gone  *** FAIL — %s rows left ***\n', v_n); ok := false; END IF;
  SELECT count(*) INTO v_n FROM public.admin_activity_log WHERE action_type = 'account_deleted' AND target_id = v_a::text;
  IF v_n = 1 THEN r := r || E'TEST 6  the deletion is in the activity log ......... PASS\n';
  ELSE r := r || format(E'TEST 6  the deletion is in the activity log ......... *** FAIL — %s rows ***\n', v_n); ok := false; END IF;

  -- B, suspended: deleted, then their email is refused for 2 years.
  UPDATE public.profiles SET status = 'suspended', suspension_reason = 'self-test' WHERE id = v_b;
  BEGIN
    v_res := public.admin_delete_account(v_b, v_b_email);
    SELECT count(*) INTO v_n FROM public.blocked_signups WHERE email = v_b_email AND blocked_until > now() + interval '700 days';
    IF v_n = 1 THEN r := r || E'TEST 7  a suspended account\'s email is blocked 2 years  PASS\n';
    ELSE r := r || E'TEST 7  a suspended account\'s email is blocked 2 years  *** FAIL — no block ***\n'; ok := false; END IF;
  EXCEPTION WHEN OTHERS THEN
    r := r || format(E'TEST 7  a suspended account\'s email is blocked 2 years  *** FAIL — %s ***\n', SQLERRM); ok := false;
  END;
  BEGIN
    INSERT INTO public.profiles (id, email, school) VALUES (gen_random_uuid(), v_b_email, v_b_school);
    r := r || E'TEST 8  that email cannot sign up again .............. *** FAIL — SIGNED UP ***\n'; ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    r := r || E'TEST 8  that email cannot sign up again .............. PASS (refused)\n';
  WHEN OTHERS THEN
    r := r || format(E'TEST 8  that email cannot sign up again .............. ?? refused for another reason: %s\n', SQLERRM); ok := false;
  END;

  r := r || E'\n' || CASE WHEN ok THEN 'ALL TESTS PASSED. Nothing was saved — both test accounts are exactly as they were.'
                           ELSE '*** SOME TESTS FAILED — read the lines marked FAIL or ??. Nothing was saved. ***' END;
  RAISE EXCEPTION '%', r;
END
$verify$;
