-- Has everything in sql/ actually been RUN?
-- 2026-09-09
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- READ ONLY. Every line is a SELECT against Postgres's own catalog. It creates nothing,
-- changes nothing, drops nothing, and can be run against the live database any time.
--
-- No `notify pgrst, 'reload schema';` — this file changes no schema, so there is nothing to
-- reload.
--
--
-- WHY THIS EXISTS
-- Three times in one week, a file in sql/ was written, reviewed, committed, and never run.
-- Each time the SQL was correct and the reasoning was sound, and each time it surfaced later
-- as something that looked like a bug in the app:
--
--   2026-09-07  guard_org_self_removal() was missing. Found by re-running the verification
--               suite. Its file shipped in 4a61d1a the day before.
--   2026-09-08  The root administrator held can_manage_events = false, so the console's
--               Events tab was correctly hidden from the only person who could use it. The
--               flag had been frozen into the schema; nobody had been granted it.
--   2026-09-09  favorites_item_type_check still refused 'event', so the bookmark on an event
--               reported "could not save". ROADMAP marked that file DONE.
--
-- The gap is always the same, and it is not carelessness: WRITING the SQL and RUNNING it are
-- two separate acts, and nothing in git records the second one. A commit is evidence of the
-- first only. CLAUDE.md already says the database is ground truth; this file is how you ask
-- it, in one paste, instead of remembering to.
--
--
-- WHAT IS IN HERE, AND WHAT IS NOT
-- Only facts that have ALREADY been missed once, plus the two whose absence would be silent
-- rather than loud. This is deliberately not a schema dump: a check for everything is a check
-- nobody reads, and its failures stop being surprising. When something new is missed, add a
-- row. When a row has been green for a year and the thing it guards cannot regress, take it
-- out.
--
-- Every row is phrased so that TRUE means healthy, which is what lets the last line sort the
-- problems to the top.


with checks as (

  -- ---- 2026-09-09: the bookmark on an event reported "could not save" ----------------
  select 'favorites accepts item_type = event' as check_name,
         exists (select 1 from pg_constraint
                 where conrelid = 'public.favorites'::regclass
                   and conname = 'favorites_item_type_check'
                   and pg_get_constraintdef(oid) like '%event%') as ok

  -- ---- 2026-09-07: an officer could delete the row the whole hierarchy hangs from -----
  -- Two triggers, and they are independent: the flag guard stops permissions being minted,
  -- the self-removal guard stops the last officer stranding an organization. Neither
  -- replaces the other, and only the second one has ever gone missing.
  union all select 'org_memberships has the flag guard',
         exists (select 1 from pg_trigger where tgrelid = 'public.org_memberships'::regclass
                   and tgname = 'org_memberships_guard_flags' and not tgisinternal)
  union all select 'org_memberships has the self-removal guard',
         exists (select 1 from pg_trigger where tgrelid = 'public.org_memberships'::regclass
                   and tgname = 'org_memberships_guard_self_removal' and not tgisinternal)

  -- ---- 2026-09-08: the Events tab was hidden from the only person who could use it ----
  -- A flag frozen into the schema and granted to nobody reaches nothing. This asks whether
  -- anyone can actually run an event, which is a different question from whether the column
  -- exists.
  union all select 'someone active can manage events',
         exists (select 1 from public.org_memberships
                 where status = 'active' and can_manage_events)
  union all select 'someone active can check people in',
         exists (select 1 from public.org_memberships
                 where status = 'active' and can_check_in)

  -- ---- Silent if wrong: the view would run as its owner and RLS would not reach the caller
  -- This one has never broken. It is here because its failure is invisible — a public-only
  -- V1 looks correct without it, and the day members_only gating lands every row leaks.
  union all select 'visible_events runs with security_invoker',
         exists (select 1 from pg_class
                 where relname = 'visible_events' and relnamespace = 'public'::regnamespace
                   and array_to_string(reloptions, ',') like '%security_invoker=true%')

  -- ---- Silent if wrong: every caller would write its own comparison instead ------------
  union all select 'visible_events exposes its computed columns',
         (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'visible_events'
            and column_name in ('effective_ends_at','has_ended','is_browsable',
                                'going_count','seats_left','checkin_is_open')) = 6

  -- ---- The events tables themselves ---------------------------------------------------
  -- The plan asserted these existed a fortnight before they did, and every ALTER in it would
  -- have failed on its first line.
  union all select 'the four events tables exist',
         (select count(*) from information_schema.tables
          where table_schema = 'public'
            and table_name in ('events','event_registrations','event_media','event_feedback')) = 4

  -- ---- The door depends on this column being nullable ---------------------------------
  -- A walk-in may have no account at all. This is the single schema decision most likely to
  -- be "tidied" into NOT NULL by a future session, and doing so breaks the door for exactly
  -- the people it exists to serve.
  union all select 'event_registrations.user_id is still nullable',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'event_registrations'
                   and column_name = 'user_id' and is_nullable = 'YES')

  -- ---- school is derived, not trusted from the browser --------------------------------
  -- There is no foreign key anywhere on `school`, so a client typo writes a row into a
  -- school that does not exist and every feed silently skips it.
  union all select 'events derives school from its organization',
         exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass
                   and tgname = 'events_set_school' and not tgisinternal)

  -- ---- Supabase's default privileges were revoked -------------------------------------
  -- TRUNCATE is the one that matters, because RLS does not apply to it: one statement
  -- ignores every policy above the table. CLAUDE.md says to assume this will be forgotten.
  union all select 'anon holds nothing on the events objects',
         not exists (select 1 from information_schema.role_table_grants
                     where table_schema = 'public' and grantee = 'anon'
                       and table_name in ('events','event_registrations','event_media',
                                          'event_feedback','visible_events'))
  union all select 'authenticated cannot TRUNCATE the events objects',
         not exists (select 1 from information_schema.role_table_grants
                     where table_schema = 'public' and grantee = 'authenticated'
                       and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')
                       and table_name in ('events','event_registrations','event_media',
                                          'event_feedback'))

  -- ---- The event-media bucket ----------------------------------------------------------
  union all select 'the event-media bucket exists',
         exists (select 1 from storage.buckets where id = 'event-media')
  union all select 'officers can write to event-media',
         exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'Officers upload event media')

  -- ---- 'completed' was dropped, and should stay dropped ---------------------------------
  -- A stored completion flag is a second, drift-prone source of truth for what the clock
  -- already answers. Same argument change_listing_status makes about 'expired'.
  union all select 'events status no longer permits completed',
         not exists (select 1 from pg_constraint
                     where conrelid = 'public.events'::regclass
                       and conname = 'events_status_check'
                       and pg_get_constraintdef(oid) like '%completed%')
)

-- DRIFT sorts to the top, because a list you have to read all of is a list nobody reads.
select case when ok then 'ok' else '*** DRIFT — WRITTEN BUT NOT RUN ***' end as status,
       check_name
from checks
order by ok, check_name;
