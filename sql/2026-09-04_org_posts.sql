-- Organization posts: announcements and polls
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
-- Requires 2026-09-04_org_hierarchy.sql (organizations, org_memberships, can_act).
--
-- WHY A SEPARATE TABLE FROM `events`
-- Every mature product in this space keeps events as their own entity and everything else as
-- a post. Anthology Engage and CampusGroups both hang registration, attendance and badges off
-- an event; Facebook Groups and Discord have one post entity plus pinning; a Slack poll is an
-- ordinary message carrying structured options.
--
-- §4.1 of docs/nestrel-campus-engagement-plan.md already made this argument once, about
-- moving events OFF `listings`: an event needs capacity, registrations, recurrence, audience
-- targeting, member-gating and check-in state, "none of which belong on listings". Putting
-- events onto a generic posts table would be the same mistake with a new table name. So
-- `events` stays as designed, `org_posts` carries the light-weight content, and a view can
-- merge the two into one org feed later without either table pretending to be the other.


begin;

-- ============================================================================
-- 1. org_posts
-- ============================================================================
create table if not exists public.org_posts (
  id             bigint generated always as identity primary key,
  org_id         bigint not null references public.organizations(id) on delete cascade,
  school         text   not null references public.schools(slug) on update cascade,  -- derived; see trigger below
  type           text   not null check (type in ('announcement','poll')),
  title          text   not null,
  body           text,
  is_pinned      boolean not null default false,
  -- Stored now, honest about doing nothing yet. In every product that has an urgent flag it
  -- is a DELIVERY decision -- Remind sends an SMS, Slack's @channel pushes to everyone. This
  -- app has no delivery layer (A1), so today this is a red border seen only by students who
  -- were already looking. The column is right and the email layer will read it; it is not a
  -- feature until then. A flag nothing acts on is theater, the same way a permission the
  -- holder can lift is theater.
  is_urgent      boolean not null default false,
  members_only   boolean not null default false,
  status         text   not null default 'published'
                   check (status in ('draft','published','archived')),
  poll_closes_at timestamptz,        -- polls only; null means open until archived
  created_by     uuid   references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists org_posts_org_idx on public.org_posts (org_id, created_at desc);

-- ONE pinned post per organization, enforced by the database rather than by remembering.
-- Discord allows exactly one pinned post per forum channel and that is not a limitation: if
-- everything is pinned, nothing is. A partial unique index says it in one line -- unique
-- across org_id, but only among rows where is_pinned is true.
create unique index if not exists org_posts_one_pinned
  on public.org_posts (org_id) where is_pinned;


-- `school` is denormalised from the organization so school-scoped admin queries stay cheap,
-- which is the established pattern here (listings.school, suspension_history.school). But a
-- denormalised column the client fills is a column that can disagree with its source, and a
-- post whose school does not match its org would be invisible to exactly the admin responsible
-- for it. So it is derived, never accepted: whatever the client sends is overwritten.
create or replace function public.set_org_post_school()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  select o.school into new.school from public.organizations o where o.id = new.org_id;
  return new;
end;
$function$;

drop trigger if exists org_posts_set_school on public.org_posts;
create trigger org_posts_set_school
  before insert or update of org_id on public.org_posts
  for each row execute function public.set_org_post_school();


-- ============================================================================
-- 2. poll_options and poll_votes
-- ============================================================================
create table if not exists public.poll_options (
  id       bigint generated always as identity primary key,
  post_id  bigint not null references public.org_posts(id) on delete cascade,
  label    text   not null,
  position integer not null default 0
);
create index if not exists poll_options_post_idx on public.poll_options (post_id, position);

create table if not exists public.poll_votes (
  post_id    bigint not null references public.org_posts(id) on delete cascade,
  option_id  bigint not null references public.poll_options(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One vote per person per poll. Changing your mind is an UPDATE of this row, not a second
  -- row -- which is why the key is (post_id, user_id) and not (post_id, user_id, option_id).
  primary key (post_id, user_id)
);
create index if not exists poll_votes_option_idx on public.poll_votes (option_id);


-- ============================================================================
-- 3. Two helper functions
-- ============================================================================
-- can_act() answers "does this person hold this FLAG here". Neither question below is about a
-- flag, so neither belongs in it.

-- Plain membership, with no permissions at all. This is what members_only actually means, and
-- it is deliberately not can_act(): a member holds no flags, so can_act would answer false for
-- every action and members-only posts would be invisible to exactly the people they are for.
create or replace function public.is_org_member(p_org_id bigint)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_super_admin() or exists (
    select 1 from public.org_memberships m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$function$;

-- "Have I already voted in this poll?" — the gate for seeing results.
--
-- THIS HAS TO BE A FUNCTION, and the reason is worth knowing. The natural way to write the
-- rule is a policy on poll_votes that queries poll_votes: "you may read this poll's votes if
-- a row exists here with your user_id". But RLS applies to the inner query too, so the policy
-- consults itself and Postgres raises infinite recursion.
--
-- SECURITY DEFINER breaks the loop: the function runs as its owner, so the lookup inside is
-- not subject to the policy that calls it. Same trick as every other guard in this project,
-- used here for recursion rather than for privilege.
create or replace function public.has_voted(p_post_id bigint)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.poll_votes v
    where v.post_id = p_post_id and v.user_id = auth.uid()
  );
$function$;


-- ============================================================================
-- 4. Row Level Security
-- ============================================================================
alter table public.org_posts    enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes   enable row level security;

-- ---------- org_posts ----------
-- Published posts from an active org, with members-only actually gating the READ rather than
-- merely the reply — a non-member cannot see the row at all (§4.5 applies the same rule to
-- events). Anyone who can post here also sees drafts.
drop policy if exists org_posts_select on public.org_posts;
create policy org_posts_select on public.org_posts
  as permissive for select to authenticated
  using (
    (
      status = 'published'
      and exists (select 1 from public.organizations o where o.id = org_id and o.is_active)
      and (members_only = false or public.is_org_member(org_id))
    )
    or public.can_act('post', org_id)
  );

drop policy if exists org_posts_write on public.org_posts;
create policy org_posts_write on public.org_posts
  as permissive for all to authenticated
  using      (public.can_act('post', org_id))
  with check (public.can_act('post', org_id));

-- ---------- poll_options ----------
-- Visible to anyone who can see the post it belongs to. Written by whoever can post.
drop policy if exists poll_options_select on public.poll_options;
create policy poll_options_select on public.poll_options
  as permissive for select to authenticated
  using (exists (select 1 from public.org_posts p where p.id = post_id));

drop policy if exists poll_options_write on public.poll_options;
create policy poll_options_write on public.poll_options
  as permissive for all to authenticated
  using      (exists (select 1 from public.org_posts p where p.id = post_id and public.can_act('post', p.org_id)))
  with check (exists (select 1 from public.org_posts p where p.id = post_id and public.can_act('post', p.org_id)));

-- ---------- poll_votes ----------
-- RESULTS AFTER YOU VOTE. You can always read your own vote; you can read everyone's once you
-- have cast one; an officer with can_view_analytics can read them to run the club.
--
-- This is enforced in RLS rather than by hiding a tally in the browser, which matters: the
-- rule is "you cannot SEE the votes", not "we will not show them to you". A curious student
-- reading the network tab learns nothing.
--
-- Early results measurably anchor later voting, which is why this is the default rather than
-- an always-visible tally.
drop policy if exists poll_votes_select on public.poll_votes;
create policy poll_votes_select on public.poll_votes
  as permissive for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_voted(post_id)
    or exists (select 1 from public.org_posts p
               where p.id = post_id and public.can_act('view_analytics', p.org_id))
  );

-- You cast, change and withdraw your OWN vote and nobody else's. Note there is no officer
-- write policy: an officer running a poll must not be able to vote on someone's behalf.
drop policy if exists poll_votes_insert on public.poll_votes;
create policy poll_votes_insert on public.poll_votes
  as permissive for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists poll_votes_update on public.poll_votes;
create policy poll_votes_update on public.poll_votes
  as permissive for update to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists poll_votes_delete on public.poll_votes;
create policy poll_votes_delete on public.poll_votes
  as permissive for delete to authenticated
  using (user_id = auth.uid());


-- ============================================================================
-- 5. GRANTs — and taking back what Supabase hands out
-- ============================================================================
-- Supabase attaches DEFAULT PRIVILEGES to every new object in `public` before any grant here
-- runs, so a `grant` only ever ADDS. The extras have to be revoked explicitly. This is the
-- third time this project has met that; it is now a standing rule in CLAUDE.md.

grant select, insert, update, delete on public.org_posts    to authenticated;
grant select, insert, update, delete on public.poll_options to authenticated;
grant select, insert, update, delete on public.poll_votes   to authenticated;

revoke truncate, references, trigger on public.org_posts    from authenticated;
revoke truncate, references, trigger on public.poll_options from authenticated;
revoke truncate, references, trigger on public.poll_votes   from authenticated;

revoke all on public.org_posts    from anon;
revoke all on public.poll_options from anon;
revoke all on public.poll_votes   from anon;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: three rows, rls_enabled true, with 2 / 2 / 4 policies.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relname in ('org_posts','poll_options','poll_votes')
order by c.relname;

-- Expected: NO ROWS. Nothing anonymous reaches any of the three.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public' and grantee in ('anon','public')
  and table_name in ('org_posts','poll_options','poll_votes');

-- Expected: one row — org_posts_one_pinned, the partial unique index.
select indexname, indexdef from pg_indexes
where schemaname='public' and indexname = 'org_posts_one_pinned';

-- Expected: false, false.
--
-- Both false is the CORRECT answer and worth understanding, because the obvious guess is that
-- is_org_member() returns true for a super admin. It does not — not here.
--
-- **In the SQL editor there is no JWT, so auth.uid() is NULL.** You are not the super admin
-- in this window; you are nobody. is_super_admin() looks for a user_roles row matching a null
-- id, finds none, and answers false, so is_org_member() falls through to its membership check
-- and answers false too.
--
-- This is the same fact that every guard in sql/ carries a break-glass clause for, and the
-- reason 2026-09-04_verify_can_act.sql has to impersonate students with set_config() rather
-- than simply calling can_act() and reading the result. A permission function tested from the
-- SQL editor tells you almost nothing: it answers for a caller who does not exist.
select public.has_voted(0) as have_i_voted, public.is_org_member(0) as am_i_a_member;


-- ============================================================================
-- NOT BUILT HERE, ON PURPOSE
-- ============================================================================
-- * No `events` table. That is workstream 3 and it stays its own entity.
-- * No delivery. is_urgent is stored and acts on nothing until the email layer exists (A1).
-- * No comments or reactions. Both are a social layer, and the plan explicitly skips
--   Partiful's "whole social layer" in §1. Adding replies to an announcement means
--   moderation, reporting and notification volume — a feature, not a field.
-- * No scheduled publishing. `status = 'draft'` exists so a post can be written and held, but
--   nothing publishes it on a timer; that needs a scheduler this project does not have.
