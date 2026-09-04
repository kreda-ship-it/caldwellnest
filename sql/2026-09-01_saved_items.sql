-- ============================================================
-- CaldwellNest — Saved items (private, per-student)
-- Adds ONE new table. Changes nothing that already exists.
-- Run the whole file in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ---------- 1. The table ----------
-- One row = "this student saved this thing".
--
-- Why `item_type` + `item_id` instead of a foreign key:
-- `listings` and `book_listings` are two separate tables, each with its own
-- independent id counter. Listing 5 and book 5 are unrelated things. One
-- foreign-key column cannot point at two tables, so the row records WHICH
-- table the id belongs to, alongside the id itself.
--
-- 'service' is accepted but unused. The services category is planned for a
-- later session; allowing the value now costs nothing and avoids having to
-- DROP and re-add the CHECK constraint later. Nothing writes it yet.
--
-- Because there is no foreign key on item_id, a row can outlive the thing it
-- points at (the poster deletes the listing, an admin removes it). That is
-- handled in the app: the Saved section checks every item against the live
-- visibility rule and shows "No longer available" instead of quietly
-- dropping it, so a student is never left wondering where something went.

create table if not exists public.favorites (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  item_type  text   not null check (item_type in ('listing', 'book', 'service')),
  item_id    bigint not null,
  created_at timestamptz not null default now(),

  -- Saving the same thing twice is a no-op, not an error. This lets the app
  -- fire a plain INSERT and read a duplicate-key result as "already saved",
  -- instead of doing a read first and racing between the read and the write.
  -- It also indexes (user_id, ...), which is exactly how the Saved section
  -- queries: "everything user X saved".
  unique (user_id, item_type, item_id)
);

-- ---------- 2. Table-level permissions (GRANTs) ----------
-- Deliberately NO update. A save is created or destroyed; it holds no field a
-- student could meaningfully change. Withholding UPDATE means there is no
-- update path to secure in the first place.
grant select, insert, delete on public.favorites to authenticated;

-- Supabase sets project-wide DEFAULT PRIVILEGES on the public schema, so a new
-- table arrives already carrying grants nobody asked for. Verified on this table
-- 2026-09-01: it came with REFERENCES, TRIGGER and TRUNCATE attached.
--
-- TRUNCATE is the one that matters: RLS does NOT apply to it. It is a table-level
-- operation, so one statement would empty every student's saves no matter what the
-- policies below say. PostgREST will not issue a TRUNCATE, so this was never an
-- open door -- but the grant should not be sitting there at all.
--
-- Take back everything this table does not need, and give `anon` nothing: the app
-- never touches saved items while logged out.
revoke truncate, references, trigger on public.favorites from authenticated;
revoke all on public.favorites from anon;

-- No sequence grant is needed here. `generated always as identity` owns its
-- sequence internally, so INSERT on the table is enough. (That is the
-- difference from `bigserial`, which would also need GRANT USAGE ON SEQUENCE
-- and fails at insert time with a confusing permission error without it.)

-- ---------- 3. Row Level Security ----------
alter table public.favorites enable row level security;

-- CREATE POLICY has no "OR REPLACE", so drop first to keep this file re-runnable.
drop policy if exists "favorites_select_own" on public.favorites;
drop policy if exists "favorites_insert_own" on public.favorites;
drop policy if exists "favorites_delete_own" on public.favorites;

-- READ — your own rows, and nothing else.
--
-- There is deliberately no second SELECT policy for admins. Postgres combines
-- multiple permissive policies with OR, so adding an admin-read policy here
-- would be the one change that turns this table from private into readable.
-- Saves are treated as private by design: no "12 students saved this" count,
-- no admin browsing of what someone saved. If that is ever wanted, it should
-- be a deliberate, separately-reviewed change to this file.
create policy "favorites_select_own" on public.favorites
  for select to authenticated
  using (auth.uid() = user_id);

-- WRITE — you may only save as yourself. Without the WITH CHECK, a student
-- could insert a row carrying someone else's user_id.
create policy "favorites_insert_own" on public.favorites
  for insert to authenticated
  with check (auth.uid() = user_id);

-- UNSAVE — you may only remove your own rows.
create policy "favorites_delete_own" on public.favorites
  for delete to authenticated
  using (auth.uid() = user_id);

-- ---------- 4. Make PostgREST pick up the new table ----------
notify pgrst, 'reload schema';

-- ---------- 5. Check it worked (read-only, needs no editing) ----------
-- Expect exactly: policies = 3, rls_on = true
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'favorites')  as policies,
  (select relrowsecurity from pg_class
    where oid = 'public.favorites'::regclass)                 as rls_on;

-- Expect exactly ONE row: authenticated | DELETE, INSERT, SELECT
-- If an `anon` row appears at all, the revoke above did not take.
select grantee,
       string_agg(privilege_type, ', ' order by privilege_type) as grants
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'favorites'
   and grantee in ('anon', 'authenticated')
 group by grantee
 order by grantee;
