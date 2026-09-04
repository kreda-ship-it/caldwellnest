-- Campus engagement, workstream 1 stage 1: organizations, memberships, and can_act()
-- 2026-09-04
--
-- Implements §2.2, §2.4 and §2.6 of docs/nestrel-campus-engagement-plan.md, with every
-- correction from its §12 applied. Nothing here is new design — it is the plan, in SQL.
--
-- RUN THE HARDENING FILE FIRST. sql/2026-09-04_harden_policies.sql pins search_path on
-- is_super_admin(), which can_act() calls. Run that, confirm the app still works, and only
-- then run this. Two permission changes at once means a break you cannot attribute.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run: tables use `if not exists`, policies are dropped before creation, and
-- functions use `create or replace`. It creates no rows — see BOOTSTRAP at the end.
--
-- WHAT THIS DOES NOT DO
-- No UI, no console, no events table. Those are workstreams 2 and 3. After this file the
-- database can express "who is allowed to do what in which organization" and nothing in the
-- app can see it yet. That is deliberate: §9 of the plan puts permissions first because
-- everything else asks the permission system a question.


begin;


-- ============================================================================
-- 1. organizations — school, department and club in ONE table
-- ============================================================================
-- A department is just an organization that can create child organizations, and a school is
-- just a department at the root. Separate tables would mean writing every permission check,
-- every profile page and every analytics query two or three times. See §2.1.
--
-- `school` is TEXT, not a uuid. This is correction C1 and it is the one that would have cost
-- the most: nothing outside school_domains has a school_id. profiles.school and
-- listings.school hold a slug like 'caldwell', get_admin_school() returns text, and every
-- existing feed compares those slugs. A uuid here would have joined to nothing and shown up
-- as an empty page rather than an error.
--
-- `generated always as identity` rather than bigserial is correction C5 — identity owns its
-- sequence internally, so INSERT on the table is enough and no GRANT USAGE ON SEQUENCE is
-- needed. sql/2026-09-01_saved_items.sql records the confusing error bigserial gives without it.

create table if not exists public.organizations (
  id              bigint generated always as identity primary key,
  school          text not null,          -- slug, e.g. 'caldwell' — matches listings.school
  parent_id       bigint references public.organizations(id),
  type            text not null check (type in ('school','department','club','office')),
  name            text not null,
  slug            text not null,
  description     text,
  logo_url        text,
  is_verified     boolean not null default true,
  is_active       boolean not null default true,
  contact_email   text,
  office_location text,
  phone           text,
  instagram       text,                   -- handle only, not URL (matches profiles convention)
  website         text,
  handshake_url   text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (school, slug)
);

create index if not exists organizations_parent_idx on public.organizations (parent_id);
create index if not exists organizations_school_idx on public.organizations (school, is_active);


-- ============================================================================
-- 2. org_memberships — officers are members with flags set
-- ============================================================================
-- Permissions are explicit grants, never implied by a role name. Different departments will
-- want different capabilities, and `if role == 'department_admin'` guarantees a rewrite the
-- first time that is untrue. Plain members have every flag false. See §2.2.
--
-- pending_email exists so an e-board can be added before those people have accounts (A15).

create table if not exists public.org_memberships (
  id                    bigint generated always as identity primary key,
  org_id                bigint not null references public.organizations(id) on delete cascade,
  user_id               uuid   references public.profiles(id) on delete cascade,
  pending_email         text,
  role                  text not null check (role in ('member','officer')),
  title                 text,
  status                text not null default 'active'
                          check (status in ('pending','active','removed')),
  can_post              boolean not null default false,
  can_manage_members    boolean not null default false,
  can_view_analytics    boolean not null default false,
  can_message           boolean not null default false,
  can_create_child_orgs boolean not null default false,
  can_moderate          boolean not null default false,
  can_manage_admins     boolean not null default false,
  added_by              uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists org_memberships_user_idx on public.org_memberships (user_id, status);
create index if not exists org_memberships_org_idx  on public.org_memberships (org_id, status);


-- ============================================================================
-- 3. org_follows — following is NOT membership
-- ============================================================================
-- The student grants a follow with one tap; the organization grants membership. If following
-- were membership, "members-only" would mean nothing, because anyone can follow. See §2.4.

create table if not exists public.org_follows (
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);


-- ============================================================================
-- 4. can_act() — the single permission rule
-- ============================================================================
-- Written once, called by every policy below. No ad-hoc permission checks anywhere — the
-- same discipline as visible_listings, and the answer to the drift found on 2026-09-04 where
-- the same admin subquery was pasted into roughly thirty policies.
--
--   is_super_admin()                                       -> true
--   active membership on this org with the flag            -> true
--   active membership on any ANCESTOR org with the flag    -> true
--   otherwise                                              -> false
--
-- Authority flows DOWNWARD only. A Caldwell school admin can act on Chess Club because the
-- walk goes up from Chess Club and finds them on the school row. A Chess Club officer walking
-- up from Student Life finds nothing, which is the point.
--
-- THE DEPTH CAP IS NOT DECORATION. `with recursive` following parent_id will loop forever if
-- anyone ever creates a cycle (A is a child of B, B is a child of A). A hung query holds its
-- connection, and Supabase has a limited pool of those, so one bad row could take the whole
-- app down. Ten levels is far more than school -> department -> club needs.

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
            when 'moderate'          then m.can_moderate
            when 'manage_admins'     then m.can_manage_admins
            else false
          end
  );
$function$;


-- ============================================================================
-- 5. The flag guard — a policy cannot do this job
-- ============================================================================
-- Adding a plain member needs can_manage_members. GRANTING PERMISSIONS is a different and
-- larger authority: it needs can_manage_admins, because whoever can grant permissions can
-- grant them to themselves. §2.3.
--
-- That distinction cannot be written as an RLS policy, for exactly the reason F2 could not be
-- fixed with one: **RLS decides which ROWS you may touch, never which COLUMNS.** A policy can
-- say "you may update this membership"; it cannot say "you may update this membership but not
-- its can_post column". Postgres has one tool for that, and it is a trigger.
--
-- This is the same shape as guard_profile_privileged_columns() on profiles. When you meet a
-- "they may edit the row but not that field" rule, reach for a trigger, not a policy.

create or replace function public.guard_org_membership_flags()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flags_changed boolean;
begin
  if public.is_super_admin() then
    return new;
  end if;

  v_flags_changed :=
       new.can_post              is distinct from old.can_post
    or new.can_manage_members    is distinct from old.can_manage_members
    or new.can_view_analytics    is distinct from old.can_view_analytics
    or new.can_message           is distinct from old.can_message
    or new.can_create_child_orgs is distinct from old.can_create_child_orgs
    or new.can_moderate          is distinct from old.can_moderate
    or new.can_manage_admins     is distinct from old.can_manage_admins
    or new.role                  is distinct from old.role;

  if v_flags_changed and not public.can_act('manage_admins', new.org_id) then
    raise exception 'Changing permissions requires can_manage_admins on this organization'
      using errcode = 'insufficient_privilege';
  end if;

  -- The org a membership belongs to is not an editable field. Without this, someone with
  -- can_manage_members on a club they run could move a row to an org they do not.
  if new.org_id is distinct from old.org_id then
    raise exception 'A membership cannot be moved between organizations'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$function$;

drop trigger if exists org_memberships_guard_flags on public.org_memberships;
create trigger org_memberships_guard_flags
  before update on public.org_memberships
  for each row execute function public.guard_org_membership_flags();


-- ============================================================================
-- 6. Row Level Security
-- ============================================================================

alter table public.organizations   enable row level security;
alter table public.org_memberships enable row level security;
alter table public.org_follows     enable row level security;

-- ---------- organizations ----------
-- Any signed-in student may see active organizations; that is the directory. Inactive ones
-- stay visible to anyone who can manage them, so a dormant club does not vanish from its own
-- officers' console.
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  as permissive for select to authenticated
  using (is_active = true or public.can_act('manage_members', id));

-- Creation is delegated downward: you may create an organization if you hold
-- can_create_child_orgs on its PARENT. A root organization (parent_id is null) has no parent
-- to delegate from, so only a super admin can create one — which is what makes verification
-- provenance rather than a checkbox (§2.5).
drop policy if exists organizations_insert on public.organizations;
create policy organizations_insert on public.organizations
  as permissive for insert to authenticated
  with check (
    case when parent_id is null
         then public.is_super_admin()
         else public.can_act('create_child_orgs', parent_id)
    end
  );

-- Editing the org profile is treated as an officer-admin action. NOTE: the plan does not name
-- a flag for this, so can_manage_members is the choice made here. If org-profile editing
-- should be separable from roster management, that is a new flag, not a policy change.
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  as permissive for update to authenticated
  using      (public.can_act('manage_members', id))
  with check (public.can_act('manage_members', id));

-- No DELETE policy. Organizations are deactivated (is_active = false), never deleted — the
-- same soft-state discipline as listings, and A9 depends on past events staying reachable.

-- ---------- org_memberships ----------
-- You can always see your own memberships. Anyone who manages the roster sees all of it.
drop policy if exists org_memberships_select on public.org_memberships;
create policy org_memberships_select on public.org_memberships
  as permissive for select to authenticated
  using (user_id = auth.uid() or public.can_act('manage_members', org_id));

-- Two ways a membership row is created, and the second one is the dangerous one.
--   1. An officer adds someone: needs can_manage_members.
--   2. A student asks to join: inserts their OWN row, and it must be powerless.
-- The second branch pins every flag to false, role to 'member' and status to 'pending'. If it
-- did not, "request to join" would be "grant yourself officer", which is the same
-- privilege-escalation shape as A0 wearing a different hat.
drop policy if exists org_memberships_insert on public.org_memberships;
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
      and can_moderate          = false
      and can_manage_admins     = false
    )
  );

-- Updating a membership needs can_manage_members. Changing its FLAGS additionally needs
-- can_manage_admins, enforced by the trigger above — a policy cannot express it.
drop policy if exists org_memberships_update on public.org_memberships;
create policy org_memberships_update on public.org_memberships
  as permissive for update to authenticated
  using      (public.can_act('manage_members', org_id))
  with check (public.can_act('manage_members', org_id));

-- A student may always leave. An officer may remove someone.
drop policy if exists org_memberships_delete on public.org_memberships;
create policy org_memberships_delete on public.org_memberships
  as permissive for delete to authenticated
  using (user_id = auth.uid() or public.can_act('manage_members', org_id));

-- ---------- org_follows ----------
-- Own rows only, exactly like favorites. Follower COUNTS for an org console are a separate
-- problem — a count needs an aggregate the follower cannot be shown row by row — and belong
-- with the analytics workstream.
drop policy if exists org_follows_select on public.org_follows;
create policy org_follows_select on public.org_follows
  as permissive for select to authenticated
  using (user_id = auth.uid());

drop policy if exists org_follows_insert on public.org_follows;
create policy org_follows_insert on public.org_follows
  as permissive for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists org_follows_delete on public.org_follows;
create policy org_follows_delete on public.org_follows
  as permissive for delete to authenticated
  using (user_id = auth.uid());


-- ============================================================================
-- 7. GRANTs — the other lock
-- ============================================================================
-- RLS filters rows; GRANT decides whether the role may touch the table at all. Both have to
-- be right, and the 2026-09-03 audit found this project had several tables where only one
-- was. No anon grants at all — matching public.favorites, the cleanest table in the database.
--
-- No DELETE on organizations, because there is no delete policy and no delete path: a grant
-- with nothing behind it is the unlocked door in front of a locked one that the audit spent
-- a day removing.

grant select, insert, update         on public.organizations   to authenticated;
grant select, insert, update, delete on public.org_memberships to authenticated;
grant select, insert, delete         on public.org_follows     to authenticated;

-- AND TAKE BACK WHAT SUPABASE HANDED OUT ON ITS OWN.
-- Corrected 2026-09-04: the first version of this file granted what these tables need and
-- stopped there, which was wrong. Supabase sets project-wide DEFAULT PRIVILEGES on the public
-- schema, so a brand-new table arrives already carrying REFERENCES, TRIGGER and TRUNCATE for
-- both roles before any grant of ours runs. Verified on these three tables the moment they
-- were created: anon held all three.
--
-- TRUNCATE is the one that matters, and it is the reason this is not merely tidiness:
-- **RLS does not apply to TRUNCATE.** It is a table-level operation, so a single statement
-- would empty every membership row regardless of every policy above it. PostgREST will not
-- issue a TRUNCATE, so this was never an open door — but a permission that RLS cannot govern
-- has no business sitting on the table that decides who is an officer.
--
-- sql/2026-09-01_saved_items.sql found and documented this first, on `favorites`. That is why
-- favorites is the only table in the database with no anon grant at all.

revoke truncate, references, trigger on public.organizations   from authenticated;
revoke truncate, references, trigger on public.org_memberships from authenticated;
revoke truncate, references, trigger on public.org_follows     from authenticated;

revoke all on public.organizations   from anon;
revoke all on public.org_memberships from anon;
revoke all on public.org_follows     from anon;


commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================

-- Expected: three rows, all rls_enabled = true, with 3 / 4 / 3 policies.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('organizations','org_memberships','org_follows')
order by c.relname;

-- Expected: no rows. Nothing anonymous should reach any of the three tables.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon','public')
  and table_name in ('organizations','org_memberships','org_follows');

-- Expected: false. You hold no membership yet, and this asks about an org that does not
-- exist — the honest answer for a super admin is still true, so run it as a student to see
-- false. (As the super admin it returns true, which is itself a useful check.)
select public.can_act('post', 1) as can_i_post_in_org_1;


-- ============================================================================
-- BOOTSTRAP — one manual step, then everything else is data (§2.8)
-- ============================================================================
-- This file creates no rows. The hierarchy starts with the school organization, and only a
-- super admin can create a root org, which is why §2.8 calls it the one manual step.
--
-- Run this as the super admin once you have confirmed the verification above. Uncomment it.
-- Adjust the name if 'Caldwell University' is not exactly what should appear on the badge.
--
--   insert into public.organizations (school, parent_id, type, name, slug, created_by)
--   values ('caldwell', null, 'school', 'Caldwell University', 'caldwell', auth.uid())
--   on conflict (school, slug) do nothing;
--
-- Then make yourself a school admin on it — this is the row that gives you authority over
-- every organization created underneath, because can_act() walks parent_id upward:
--
--   insert into public.org_memberships (
--     org_id, user_id, role, title, status,
--     can_post, can_manage_members, can_view_analytics, can_message,
--     can_create_child_orgs, can_moderate, can_manage_admins, added_by)
--   select o.id, auth.uid(), 'officer', 'Administrator', 'active',
--          true, true, true, true, true, true, true, auth.uid()
--   from public.organizations o
--   where o.school = 'caldwell' and o.slug = 'caldwell'
--   on conflict (org_id, user_id) do nothing;
--
-- Note you are already a super admin, so can_act() would return true for you regardless.
-- The membership row is still worth creating: it is what makes the console show you as an
-- officer of Caldwell rather than as a platform operator, and §2.7 is explicit that those are
-- two different identities that happen to share one login.
