-- Activity: which items you have SEEN and READ, kept with your account instead of on one device
-- 2026-09-25
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
--
-- WHY
-- Most of the Activity feed is worked out from data you can already read (an event you are going
-- to was cancelled, a club you follow shared a recap, a poll you voted in closed). Those items have
-- no row of their own, so until now "you read this" was remembered in the browser only: read it on
-- your phone and your laptop still showed it as new. This table keeps that memory with your
-- account, so every device agrees.
--
-- TWO LISTS, because Activity follows the seen/read model Facebook and LinkedIn use:
--   seen_keys  items that were on screen when you opened Activity. They stop counting on the badge.
--   read_keys  items you opened (or cleared with "Mark all as read"). They lose their unread dot.
-- A key is a short text id the app makes for each item, e.g. 'recap42' or 'cancel17' — never the
-- item's content. School notices ('notifications' rows) keep using their own `read` column; only
-- their "seen" state is kept here.
--
-- ONE ROW PER STUDENT, readable and writable only by that student. No delete policy: the row goes
-- when the account does (on delete cascade). The lists are capped so a row cannot grow forever;
-- the app keeps the newest 500 of each.

begin;

create table if not exists public.activity_state (
  user_id    uuid        primary key references public.profiles(id) on delete cascade,
  read_keys  text[]      not null default '{}',
  seen_keys  text[]      not null default '{}',
  updated_at timestamptz not null default now(),
  constraint activity_state_size check (cardinality(read_keys) <= 1000 and cardinality(seen_keys) <= 1000)
);

alter table public.activity_state enable row level security;

drop policy if exists activity_state_select on public.activity_state;
create policy activity_state_select on public.activity_state
  as permissive for select to authenticated
  using (user_id = auth.uid());

drop policy if exists activity_state_insert on public.activity_state;
create policy activity_state_insert on public.activity_state
  as permissive for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists activity_state_update on public.activity_state;
create policy activity_state_update on public.activity_state
  as permissive for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Grants: only what the app does (read, create its row, update it).
grant select, insert, update on public.activity_state to authenticated;
-- Supabase attaches default privileges to every new table before any grant runs. Take the extras
-- back — TRUNCATE in particular ignores every policy above.
revoke truncate, references, trigger on public.activity_state from authenticated;
revoke all on public.activity_state from anon;

commit;

-- Supabase's API caches the schema. Without this it answers as if the table did not exist.
notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: one row, rowsecurity = true.
select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'activity_state';

-- Expected: SELECT, INSERT, UPDATE for authenticated — and nothing else, nothing for anon.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'activity_state'
order by grantee, privilege_type;

-- Expected: three policies (select, insert, update).
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'activity_state' order by cmd;
