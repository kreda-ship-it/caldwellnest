-- The events schema: tables, visibility, grants and RLS
-- 2026-09-07  ·  Session E1 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run (every statement is
-- `if not exists`, `create or replace`, or a `drop policy` followed by a create).
-- The RPCs are a SEPARATE file, 2026-09-07_events_rpcs.sql, and run AFTER this one.
--
-- Split into two files rather than one because this file is reviewable on its own:
-- it is all declarations. The RPC file contains the logic, and mixing them makes the
-- shape harder to see and a re-run of one half impossible without the other.
--
-- ############################################################################
-- FOUR THINGS THE PLAN GOT WRONG THAT ARE FIXED HERE
-- ############################################################################
-- Found in E1 step 1, reading the code rather than the plan documents. Each would
-- have failed, and two of them would have failed SILENTLY, which is worse.
--
-- 1. can_act() action names DROP the `can_` prefix.
--    The plan writes can_act('can_manage_events', org_id). The real names are
--    'manage_events', 'check_in', 'view_analytics' (sql/2026-09-05_flag_set.sql:146-153).
--    can_act() ends in `else false`, so a wrong name does not raise — it refuses
--    EVERYONE. Every officer locked out of their own events, with nothing in the
--    console to debug from. The flag_set file warns about exactly this: "a misspelled
--    action name fails silently."
--
-- 2. `school` is a text slug, not a uuid. Nothing outside school_domains has a
--    school_id. Keyed on a uuid these tables would join to nothing, and it would
--    surface as an empty feed rather than an error.
--
-- 3. `events` and `event_registrations` did not exist. The plan said they did, per
--    §4.3 of the campus engagement plan. They were specified there and never run,
--    so every `alter table` in the plan's §2 would have failed on its first line.
--
-- 4. visible_events needs `security_invoker`. A plain view runs with its OWNER's
--    permissions, so RLS on the underlying table does not reach the caller. For a
--    public-only V1 that is nearly the intended answer, which is what makes it
--    dangerous: correct-looking now, wide open the day members_only lands.
--    docs/ROADMAP.md already carried this warning about visible_listings.
--
-- ############################################################################
-- THE MIGRATION THAT IS NOT HAPPENING
-- ############################################################################
-- The plan lists "the migration for existing organization_event rows" as an E1
-- deliverable. Counted on 2026-09-07: there are TWO. One approved, one not; one has
-- a location and one does not, and events.location is NOT NULL.
--
-- Two rows is not a migration. Writing, testing and reviewing a mapping script —
-- with a free-text `org_name` that has to become a real org_id foreign key, and no
-- end time anywhere in the old shape — is more work and more risk than an officer
-- retyping two events into the new form. So: no migration script. The old rows stay
-- in `listings` where they are, and are archived by hand once E2 exists to recreate
-- them in. Nothing is deleted by this file.
--
-- ############################################################################
-- ONE DESIGN DECISION MADE HERE, BECAUSE THE OLD DATA FORCED IT
-- ############################################################################
-- The old event shape had a date and a time and NO end time. The new shape allows
-- ends_at to be null for the same reason: an officer posting "Club fair, Tuesday
-- 6pm" should not be blocked on deciding when it stops.
--
-- But §1.1 of the plan makes pastness `ends_at` vs `now()`, and a null ends_at under
-- that rule means the event is NEVER past — it would sit at the top of a
-- chronological feed forever, which is the single most visible way this feature
-- could look broken.
--
-- So visible_events computes an effective end:  coalesce(ends_at, starts_at + 3h).
-- Three hours is a guess about campus events, not a fact, and it is written in ONE
-- place so it can be changed in one place. It is not stored, for the same reason
-- pastness is not stored.


-- ============================================================================
-- 1. events
-- ============================================================================
create table if not exists public.events (
  id                  bigint generated always as identity primary key,
  school              text   not null,          -- slug, e.g. 'caldwell' — matches listings.school
  org_id              bigint not null references public.organizations(id),
  created_by          uuid   not null references public.profiles(id),
  title               text   not null,
  description         text,
  poster_url          text,                     -- null -> deterministic gradient, never blank
  event_type          text   not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz,              -- null -> starts_at + 3h, see header
  location            text   not null,
  status              text   not null default 'published'
                        check (status in ('draft','published','cancelled','completed')),
  registration_open   boolean not null default false,
  capacity            integer check (capacity is null or capacity > 0),
  external_ticket_url text,
  members_only        boolean not null default false,
  audience_tags       text[],
  recurrence_group_id uuid,
  cancelled_reason    text,
  trust_self_checkin  boolean not null default false,
  checkin_opens_at    timestamptz,              -- null -> starts_at - 1h
  checkin_closes_at   timestamptz,              -- null -> effective end + 1h
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A cancelled event must say why. §6 of the plan makes the reason the entire
  -- mitigation for having no notification layer: it is what the registrant reads
  -- on the banner. Enforced here rather than in the form, because the form is not
  -- the only thing that can write this row.
  constraint events_cancelled_needs_reason
    check (status <> 'cancelled' or (cancelled_reason is not null and cancelled_reason <> '')),

  -- An event that ends before it starts is a typo, and it would sort wrongly forever.
  constraint events_ends_after_starts
    check (ends_at is null or ends_at > starts_at)
);

create index if not exists events_school_starts_idx on public.events (school, starts_at);
create index if not exists events_org_starts_idx    on public.events (org_id, starts_at desc);


-- ============================================================================
-- 2. event_registrations — the door
-- ============================================================================
-- user_id is NULLABLE, deliberately, and this contradicts §4.3 of the campus
-- engagement plan on purpose. A walk-in may have no account at all: the officer
-- types a name and an email at the door and that is the whole row. Postgres permits
-- multiple NULLs in a unique index, so unique (event_id, user_id) still stops a
-- registered student registering twice while allowing many anonymous walk-ins.
create table if not exists public.event_registrations (
  id               bigint generated always as identity primary key,
  event_id         bigint not null references public.events(id) on delete cascade,
  user_id          uuid   references public.profiles(id) on delete cascade,
  name_at_signup   text not null,               -- snapshot; the profile may change later
  email_at_signup  text not null,
  status           text not null default 'registered'
                     check (status in ('registered','cancelled','self_reported',
                                       'checked_in','walk_in')),
  check_in_method  text check (check_in_method in ('officer','self_confirmed',
                                                   'self_auto','walk_in')),
  self_reported_at timestamptz,
  checked_in_at    timestamptz,
  checked_in_by    uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  unique (event_id, user_id)
);

create index if not exists event_reg_event_idx on public.event_registrations (event_id, status);
create index if not exists event_reg_user_idx  on public.event_registrations (user_id);


-- ============================================================================
-- 3. event_media
-- ============================================================================
create table if not exists public.event_media (
  id          bigint generated always as identity primary key,
  school      text   not null,
  event_id    bigint not null references public.events(id) on delete cascade,
  kind        text   not null check (kind in ('image','video_link')),
  url         text   not null,
  caption     text,
  phase       text   not null default 'promo' check (phase in ('promo','recap')),
  sort_order  integer not null default 0,
  created_by  uuid   not null references public.profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists event_media_event_idx
  on public.event_media (event_id, phase, sort_order);


-- ============================================================================
-- 4. event_feedback
-- ============================================================================
-- user_id is stored and NOT NULL: it is required to enforce one rating per person
-- and to check attendance. Officers never read this table — they read
-- get_event_feedback(), which returns no identities. The student-facing copy must
-- say "shared anonymously with the organizers", never "completely anonymous",
-- because at eleven attendees a detailed comment is recognisable.
create table if not exists public.event_feedback (
  id         bigint generated always as identity primary key,
  school     text   not null,
  event_id   bigint not null references public.events(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create index if not exists event_feedback_event_idx on public.event_feedback (event_id);


-- ============================================================================
-- 5. visible_events — one visibility rule, one place
-- ============================================================================
-- `with (security_invoker = true)` is NOT decoration. Without it the view runs as
-- its owner and the RLS policies below never reach the caller. See header note 4.
--
-- members_only is excluded rather than resolved: members-only gating is deferred
-- from V1 (§6 of the plan) because it is the hardest policy in the app and needs
-- its own test pass with a non-member account. Excluding those rows entirely is the
-- safe placeholder — a members-only event is invisible to everyone until the real
-- rule is written, which fails closed.
create or replace view public.visible_events with (security_invoker = true) as
  select e.*,
         coalesce(e.ends_at, e.starts_at + interval '3 hours') as effective_ends_at
  from public.events e
  where e.status = 'published'
    and e.members_only = false;


-- ============================================================================
-- 6. Grants, then the revokes Supabase makes necessary
-- ============================================================================
-- Supabase attaches DEFAULT PRIVILEGES to every new object in `public` BEFORE any
-- GRANT here runs: REFERENCES, TRIGGER and TRUNCATE for both anon and authenticated.
-- A grant only ever ADDS, so the extras must be revoked explicitly.
--
-- TRUNCATE is the one that matters, because RLS DOES NOT APPLY TO IT. It is a
-- table-level operation, so one statement ignores every policy below. On a view it
-- is unreachable and the revoke is only consistency.
--
-- This block has been missed twice since 2026-09-01_saved_items.sql got it right.
-- Verify afterwards with the grant query in sql/2026-09-03_capture_rls_and_grants.sql
-- rather than assuming it worked.
--
-- No DELETE for students anywhere. A registration is cancelled, not deleted, so the
-- seat history survives; an event is cancelled, not deleted, so its registrants can
-- still reach it and read the reason. Feedback gets INSERT and SELECT only — no
-- UPDATE, because an editable rating is a rating an officer can pressure someone to
-- change.
grant select, insert, update         on public.events              to authenticated;
grant select, insert, update         on public.event_registrations to authenticated;
grant select, insert, update, delete on public.event_media         to authenticated;
grant select, insert                 on public.event_feedback      to authenticated;
grant select                         on public.visible_events      to authenticated;

revoke truncate, references, trigger on public.events              from authenticated;
revoke truncate, references, trigger on public.event_registrations from authenticated;
revoke truncate, references, trigger on public.event_media         from authenticated;
revoke truncate, references, trigger on public.event_feedback      from authenticated;
revoke truncate, references, trigger on public.visible_events      from authenticated;

revoke all on public.events              from anon;
revoke all on public.event_registrations from anon;
revoke all on public.event_media         from anon;
revoke all on public.event_feedback      from anon;
revoke all on public.visible_events      from anon;


-- ============================================================================
-- 7. RLS
-- ============================================================================
alter table public.events              enable row level security;
alter table public.event_registrations enable row level security;
alter table public.event_media         enable row level security;
alter table public.event_feedback      enable row level security;

-- ---------- events ----------
-- Read: anything published and not members-only, plus anything at all for someone
-- who can manage that org's events (so drafts and cancellations stay visible to
-- their own officers). Registrants also keep read access to a cancelled event —
-- that is §6's whole mitigation and it is enforced here, not in the app.
drop policy if exists events_select on public.events;
create policy events_select on public.events
  as permissive for select to authenticated
  using (
    (status = 'published' and members_only = false)
    or public.can_act('manage_events', org_id)
    or exists (select 1 from public.event_registrations r
               where r.event_id = events.id and r.user_id = auth.uid())
  );

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  as permissive for insert to authenticated
  with check (public.can_act('manage_events', org_id) and created_by = auth.uid());

drop policy if exists events_update on public.events;
create policy events_update on public.events
  as permissive for update to authenticated
  using      (public.can_act('manage_events', org_id))
  with check (public.can_act('manage_events', org_id));

-- No DELETE policy at all, and no DELETE grant. An event with registrations must
-- never vanish from under them; it is cancelled with a reason.

-- ---------- event_registrations ----------
-- A student sees their own rows, and an officer with either events flag sees the
-- rows for their own events. can_check_in is included deliberately: someone working
-- the door must read the list without being able to post as the club.
drop policy if exists event_reg_select on public.event_registrations;
create policy event_reg_select on public.event_registrations
  as permissive for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.events e
               where e.id = event_registrations.event_id
                 and (public.can_act('manage_events', e.org_id)
                      or public.can_act('check_in', e.org_id)))
  );

-- Students insert only their OWN registration, only on a published event, only
-- while registration is open. Capacity is NOT checked here — a policy cannot count
-- safely against a concurrent insert. That is register_for_event()'s job, in the
-- RPC file, in one transaction. This policy is the floor, not the whole rule.
drop policy if exists event_reg_insert on public.event_registrations;
create policy event_reg_insert on public.event_registrations
  as permissive for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'registered'
    and check_in_method is null
    and exists (select 1 from public.events e
                where e.id = event_registrations.event_id
                  and e.status = 'published'
                  and e.registration_open = true)
  );

-- The narrowest policy in this file, and the most important one.
--
-- A student may touch their own row for exactly two reasons: to cancel, or to say
-- "I'm here". They may NOT write checked_in, walk_in, check_in_method, checked_in_at
-- or checked_in_by — those are the attendance record, and a student who can write
-- their own attendance makes the whole door theatre.
--
-- WITH CHECK constrains the row AFTER the update, so listing the allowed resulting
-- statuses is what blocks the escalation. Officers go through check_in_attendee()
-- instead, which is SECURITY DEFINER and bypasses this.
drop policy if exists event_reg_update_self on public.event_registrations;
create policy event_reg_update_self on public.event_registrations
  as permissive for update to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid()
              and status in ('cancelled','self_reported')
              and check_in_method is null
              and checked_in_at is null
              and checked_in_by is null);

-- ---------- event_media ----------
drop policy if exists event_media_select on public.event_media;
create policy event_media_select on public.event_media
  as permissive for select to authenticated
  using (exists (select 1 from public.events e
                 where e.id = event_media.event_id
                   and ((e.status = 'published' and e.members_only = false)
                        or public.can_act('manage_events', e.org_id))));

drop policy if exists event_media_write on public.event_media;
create policy event_media_write on public.event_media
  as permissive for insert to authenticated
  with check (exists (select 1 from public.events e
                      where e.id = event_media.event_id
                        and public.can_act('manage_events', e.org_id)));

drop policy if exists event_media_update on public.event_media;
create policy event_media_update on public.event_media
  as permissive for update to authenticated
  using      (exists (select 1 from public.events e
                      where e.id = event_media.event_id
                        and public.can_act('manage_events', e.org_id)))
  with check (exists (select 1 from public.events e
                      where e.id = event_media.event_id
                        and public.can_act('manage_events', e.org_id)));

drop policy if exists event_media_delete on public.event_media;
create policy event_media_delete on public.event_media
  as permissive for delete to authenticated
  using (exists (select 1 from public.events e
                 where e.id = event_media.event_id
                   and public.can_act('manage_events', e.org_id)));

-- ---------- event_feedback ----------
-- Three conditions in one policy, and all three have to be here rather than in the
-- app: you were there, the event is over, and it ended within seven days.
--
-- "You were there" means a check-in row, not a registration row. Registering and
-- not showing up earns no opinion — that is the entire design of §1.6, and it is
-- what makes check-in worth staffing.
drop policy if exists event_feedback_insert on public.event_feedback;
create policy event_feedback_insert on public.event_feedback
  as permissive for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.event_registrations r
      join public.events e on e.id = r.event_id
      where r.event_id = event_feedback.event_id
        and r.user_id  = auth.uid()
        and r.status in ('checked_in','walk_in')
        and coalesce(e.ends_at, e.starts_at + interval '3 hours') <= now()
        and coalesce(e.ends_at, e.starts_at + interval '3 hours') > now() - interval '7 days'
    )
  );

-- Own row only. Officers read get_event_feedback(), never this table: it is the
-- function that strips the identities and suppresses the average below five.
drop policy if exists event_feedback_select on public.event_feedback;
create policy event_feedback_select on public.event_feedback
  as permissive for select to authenticated
  using (user_id = auth.uid());

-- No UPDATE and no DELETE policy, and no grant for either.


notify pgrst, 'reload schema';

-- ============================================================================
-- AFTER RUNNING THIS
-- ============================================================================
-- 1. Run sql/2026-09-07_events_rpcs.sql next. Nothing works without it: students
--    hold no path to register safely until register_for_event() exists.
-- 2. Confirm the grants landed as intended with the query in
--    sql/2026-09-03_capture_rls_and_grants.sql. Do not assume the revokes worked.
-- 3. The verification file comes after both, and then every other file in sql/
--    gets re-run. A green test not re-run is a memory, not evidence.
