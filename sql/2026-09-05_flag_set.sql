-- Freeze the permission flag set: drop can_moderate, add can_manage_events and can_check_in
-- 2026-09-05
--
-- Phase 0 of docs/nestrel-engagement-build.md. This is the last cheap moment to change the
-- flag set, and that is the entire reason it happens now rather than when it is needed.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
--
-- WHY NOW, AND WHY THIS IS NOT A NORMAL MIGRATION
-- Every RLS policy on every org table asks can_act() a question, and can_act() reads these
-- columns. A flag added later is not one column: it is a column, a branch in can_act(), two
-- lists inside the guard trigger, a list inside the insert policy, and two places in the
-- browser mirror. Six edits that must agree, with nothing checking that they do.
--
-- Today org_memberships holds a handful of rows and one real organization exists. The same
-- change after a hundred clubs have officers is the same six edits against live authority.
--
--
-- WHAT CHANGES
--
--   DROP can_moderate.
--     Nothing reads it. Not one policy, not one function, not one line of JavaScript beyond
--     the mirror map that lists it. docs/ROADMAP.md mentions it exactly once, in a list of
--     flags NOT to hand out casually. The build document's rule is: if the roadmap can name
--     the session that reads it, keep it; otherwise drop it and add it back the day replies
--     exist. The roadmap cannot, so it goes.
--
--     A flag nothing checks is not protection. It is a column every future reader of these
--     policies has to think about and then discover means nothing — and worse, it reads on
--     the officer panel as though content moderation is a thing this system does.
--
--   ADD can_manage_events. Create, edit, publish and cancel events. Read by Phase 3.
--
--   ADD can_check_in. Mark attendance and read the door code. Read by Phase 4.
--
--     can_check_in is deliberately narrow, and the narrowness is the feature. A president
--     hands it to a first-year working the door for one evening without also handing over
--     the ability to post as the club. If checking people in were a facet of
--     can_manage_events, that separation would not exist.
--
--
-- THE ORDER OF STATEMENTS BELOW IS NOT ARBITRARY
-- org_memberships_insert is an RLS policy that names can_moderate. Postgres records that
-- dependency, so `alter table drop column` refuses while the policy stands (or, with CASCADE,
-- silently drops the policy and leaves the table with no insert rule at all — which is worse
-- than an error, because it fails open). So: drop the policy, drop the column, recreate the
-- policy. Three steps that must stay in that order.
--
-- The two FUNCTIONS are the opposite case and it is a trap. can_act() and
-- guard_org_membership_flags() both name can_moderate too, but their bodies are stored as
-- strings, so Postgres tracks no dependency and the drop succeeds with them left behind,
-- broken. They will not complain until something calls them — which, for a permission
-- function, means the failure surfaces as a student being refused, not as a migration error.
-- That is why they are replaced here even though nothing forces it.
--
--
-- READ THIS BEFORE EDITING guard_org_membership_flags() ANYWHERE
-- There are now THREE files containing `create or replace function
-- public.guard_org_membership_flags()`, and only the newest is correct:
--
--   2026-09-04_org_hierarchy.sql          BEFORE UPDATE only  <- SUPERSEDED, has the hole
--   2026-09-04_fix_membership_insert_guard.sql   INSERT OR UPDATE  <- was correct
--   THIS FILE                                    INSERT OR UPDATE  <- correct now
--
-- The version below was built from the FIX file, not from the hierarchy file. Building it
-- from the hierarchy file would have quietly deleted the INSERT branch and reopened the
-- privilege escalation closed on 2026-09-04 — and every verification file in sql/ would
-- still have reported PASS, because until 2026-09-05_verify_flag_guard.sql none of them
-- tested this trigger at all.


begin;


-- ============================================================================
-- 1. The two new columns
-- ============================================================================
-- NOT NULL DEFAULT false: an existing membership grants nothing new. Adding a permission
-- must never be the same statement as handing it to somebody.

alter table public.org_memberships
  add column if not exists can_manage_events boolean not null default false;

alter table public.org_memberships
  add column if not exists can_check_in boolean not null default false;

comment on column public.org_memberships.can_manage_events is
  'Create, edit, publish and cancel events for this organization. Read by can_act(''manage_events'').';
comment on column public.org_memberships.can_check_in is
  'Mark attendance and read the rotating door code. Deliberately separate from can_manage_events so it can be handed to someone working one door for one evening.';


-- ============================================================================
-- 2. Drop the insert policy, so the column can go
-- ============================================================================
-- Recreated in step 5. Between here and there the table has no INSERT policy, which under
-- RLS means no insert is permitted at all — the safe direction to be interrupted in, and the
-- reason this whole file is one transaction.

drop policy if exists org_memberships_insert on public.org_memberships;


-- ============================================================================
-- 3. Drop can_moderate
-- ============================================================================
-- `if exists` so a second run is a no-op rather than an error.

alter table public.org_memberships drop column if exists can_moderate;


-- ============================================================================
-- 4. can_act() — the single permission rule, with the new flag set
-- ============================================================================
-- Unchanged except for the CASE. Reproduced whole rather than patched, because this function
-- is the one place authority is computed and it should be readable in one piece in the file
-- that last changed it.
--
-- The depth cap stays at 10 and stays load-bearing: `with recursive` over parent_id loops
-- forever on a cycle, and a hung query holds a connection from a small pool.

create or replace function public.can_act(p_action text, p_org_id bigint)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_super_admin() or exists (
    with recursive chain(id, parent_id, depth) as (
      select o.id, o.parent_id, 0
      from public.organizations o
      where o.id = p_org_id
      union all
      select o.id, o.parent_id, c.depth + 1
      from public.organizations o
      join chain c on o.id = c.parent_id
      where c.depth < 10
    )
    select 1
    from public.org_memberships m
    join chain c on c.id = m.org_id
    where m.user_id = auth.uid()
      and m.status = 'active'
      and case p_action
            when 'post'              then m.can_post
            when 'manage_members'    then m.can_manage_members
            when 'view_analytics'    then m.can_view_analytics
            when 'message'           then m.can_message
            when 'create_child_orgs' then m.can_create_child_orgs
            when 'manage_admins'     then m.can_manage_admins
            when 'manage_events'     then m.can_manage_events
            when 'check_in'          then m.can_check_in
            else false
          end
  );
$function$;

-- The `else false` is why a typo is safe. can_act('moderate', 42) does not error now that the
-- flag is gone — it returns false, and the caller is refused. An unknown action being refused
-- rather than raising is the correct direction for a permission function, but it does mean a
-- misspelled action name fails silently. The browser mirror warns to the console for exactly
-- this reason; see js/orgs.js.


-- ============================================================================
-- 5. The flag guard — rebuilt from the FIX file, with can_moderate removed
-- ============================================================================
-- See the header. This is the file that supersedes 2026-09-04_fix_membership_insert_guard.sql.
--
-- What it enforces, unchanged: adding a plain member needs can_manage_members, but GRANTING
-- PERMISSIONS needs can_manage_admins, because whoever can grant permissions can grant them
-- to themselves. RLS decides which ROWS you may touch and never which COLUMNS, so this
-- cannot be a policy. It is the same shape as guard_profile_privileged_columns() on profiles.

create or replace function public.guard_org_membership_flags()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role             text;
  v_grants_authority boolean;
begin
  -- BREAK-GLASS, and it is required rather than convenient.
  -- The SQL editor sends no JWT, so auth.uid() is null there and every check below would
  -- refuse. Without this, the bootstrap in 2026-09-04_org_hierarchy.sql could not create the
  -- first school admin, and the verification files could not build their test hierarchies —
  -- the guard would lock the database out of setting itself up.
  --
  -- Note 'anon' deliberately does NOT match. An unauthenticated browser request carries
  -- role 'anon', which is a JWT, so it falls through to the real checks. This is the exact
  -- distinction sql/2026-08-08_align_owner_guards.sql was written to make, after an earlier
  -- guard used `auth.uid() IS NULL` and waved through every anonymous caller along with the
  -- SQL editor.
  --
  -- THE COST OF THIS BRANCH, WRITTEN DOWN: it means a test that inserts rows from the SQL
  -- editor without setting request.jwt.claims is not testing this trigger. It is walking
  -- straight past it. 2026-09-05_verify_flag_guard.sql sets the claims before every
  -- assertion for that reason, and it is the only file that tests this function.
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if v_role = '' or v_role = 'service_role' then
    return new;
  end if;

  if public.is_super_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- No OLD row to compare against. The question is not "what changed" but "does this row
    -- hand anyone anything". Any true flag, or officer standing, is authority being granted.
    v_grants_authority :=
         new.can_post
      or new.can_manage_members
      or new.can_view_analytics
      or new.can_message
      or new.can_create_child_orgs
      or new.can_manage_admins
      or new.can_manage_events
      or new.can_check_in
      or new.role = 'officer';
  else
    v_grants_authority :=
         new.can_post              is distinct from old.can_post
      or new.can_manage_members    is distinct from old.can_manage_members
      or new.can_view_analytics    is distinct from old.can_view_analytics
      or new.can_message           is distinct from old.can_message
      or new.can_create_child_orgs is distinct from old.can_create_child_orgs
      or new.can_manage_admins     is distinct from old.can_manage_admins
      or new.can_manage_events     is distinct from old.can_manage_events
      or new.can_check_in          is distinct from old.can_check_in
      or new.role                  is distinct from old.role;

    -- Only meaningful on UPDATE: an INSERT cannot move a row that did not exist.
    if new.org_id is distinct from old.org_id then
      raise exception 'A membership cannot be moved between organizations'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if v_grants_authority and not public.can_act('manage_admins', new.org_id) then
    raise exception 'Granting permissions requires can_manage_admins on this organization'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

-- Recreated because a `create or replace function` does not touch the trigger, and a reader
-- checking whether this file left the trigger correct should be able to see the answer here
-- rather than in an older file.
drop trigger if exists org_memberships_guard_flags on public.org_memberships;
create trigger org_memberships_guard_flags
  before insert or update on public.org_memberships
  for each row execute function public.guard_org_membership_flags();


-- ============================================================================
-- 6. The insert policy, back with the new flag set
-- ============================================================================
-- Two ways a membership row is created, and the second one is the dangerous one.
--   1. An officer adds someone: needs can_manage_members.
--   2. A student asks to join: inserts their OWN row, and it must be powerless.
--
-- The second branch pins every flag to false, role to 'member' and status to 'pending'.
-- Without that, "request to join" would read as "grant yourself officer".
--
-- THE PINNED LIST MUST NAME EVERY FLAG. A flag added later and forgotten here is a flag a
-- student can set on their own join request, and the policy would still look correct — it
-- would just be silent about the one column that matters. That is the failure this list has,
-- and it is why the flag set is being frozen rather than grown.

create policy org_memberships_insert on public.org_memberships
  as permissive for insert to authenticated
  with check (
    public.can_act('manage_members', org_id)
    or (
      user_id = auth.uid()
      and role   = 'member'
      and status = 'pending'
      and can_post              = false
      and can_manage_members    = false
      and can_view_analytics    = false
      and can_message           = false
      and can_create_child_orgs = false
      and can_manage_admins     = false
      and can_manage_events     = false
      and can_check_in          = false
    )
  );


commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- GRANTS — nothing to do, and here is why that is not an oversight
-- ============================================================================
-- CLAUDE.md's standing rule is that every new object in `public` arrives carrying
-- Supabase's DEFAULT PRIVILEGES — REFERENCES, TRIGGER and TRUNCATE for anon and
-- authenticated — and must have them revoked explicitly.
--
-- That rule is about new TABLES and VIEWS. This file adds no object: two columns on an
-- existing table, and replacements for two existing functions. A table-level GRANT covers
-- every column of the table including ones added afterwards, so the grants set by
-- 2026-09-04_org_hierarchy.sql already govern these two columns, and the revokes in that
-- file already took back what Supabase handed out.
--
-- Confirm rather than trust that, with query 2 below.


-- ============================================================================
-- VERIFY (read-only — run after the file, expect all four)
-- ============================================================================

-- 1. Expected: eight rows, and can_moderate is NOT among them.
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'org_memberships'
  and column_name like 'can\_%'
order by column_name;

-- 2. Expected: no rows. Nothing anonymous reaches the table, and `authenticated` holds only
--    select/insert/update/delete — no TRUNCATE, REFERENCES or TRIGGER.
--
--    CORRECTED 2026-09-05, having cried wolf on its first run. The earlier version applied
--    the privilege filter to EVERY grantee, so it returned six rows for `postgres` and
--    `service_role` holding TRUNCATE, REFERENCES and TRIGGER — and reported them as though
--    something were wrong. Nothing was. `postgres` owns the database and `service_role` is
--    Supabase's internal admin; both are SUPPOSED to hold everything, and neither is
--    reachable from a browser. The roles this check is about are the two a request can
--    actually arrive as.
--
--    A verification query that raises a false alarm is nearly as expensive as one that
--    misses a real problem: it teaches you to skim its output, and the day it means
--    something you will skim that too.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'org_memberships'
  and grantee in ('anon', 'public', 'authenticated')          -- browser-reachable roles only
  and (grantee in ('anon', 'public')                          -- these should hold NOTHING
       or privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER'));  -- authenticated must not hold these

-- 3. Expected: BEFORE INSERT OR UPDATE. If this says UPDATE only, an older file was run
--    after this one and the escalation hole is open again.
select pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'org_memberships' and not t.tgisinternal;

-- 4. Expected: no rows. Nothing anywhere still names the dropped flag.
select p.polname as policy, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
from pg_policy p
join pg_class c on c.oid = p.polrelid
where c.relname = 'org_memberships'
  and pg_get_expr(p.polwithcheck, p.polrelid) like '%can_moderate%';


-- ============================================================================
-- THEN RUN THESE THREE, IN THIS ORDER
-- ============================================================================
--   1. sql/2026-09-05_verify_flag_guard.sql   — the guard trigger, which has never been tested
--   2. sql/2026-09-04_verify_can_act.sql      — can_act(), now including the two new flags
--   3. sql/2026-08-08_verify_owner_guards.sql — unrelated, and re-run because §6.4 says so
--
-- Both org verification files need at least three non-admin student accounts to be complete.
-- See sql/2026-09-05_seed_dev_org.sql for how to create them.
