-- ============================================================
-- CaldwellNest Books section: courses lookup + book_listings
-- Run this whole file once in the Supabase SQL Editor.
-- ============================================================

-- ---------- 1. courses lookup table ----------
create table courses (
  code        text primary key,          -- e.g. 'NU 301'
  name        text not null,             -- e.g. 'Fundamentals Of Nursing'
  department  text not null,             -- e.g. 'NU'
  aliases     text[] not null default '{}'  -- alternate names students may know
);

-- ---------- 2. book_listings table ----------
create table book_listings (
  id           bigint generated always as identity primary key,
  book_type    text not null check (book_type in ('course', 'other')),
  course_code  text references courses(code) on delete restrict,
  genre        text,                     -- only used when book_type = 'other'
  title        text not null,
  author       text,
  isbn         text,
  edition      text,
  price        numeric not null check (price >= 0),
  condition    text not null check (condition in ('New', 'Like New', 'Good', 'Fair', 'Worn')),
  description  text,
  photo_urls   text[] not null default '{}',
  poster_id    uuid not null references profiles(id),
  status       text not null default 'active'
               check (status in ('active', 'sold', 'removed')),
  approved     boolean not null default false,  -- admin approval queue, same as housing
  created_at   timestamptz not null default now(),
  sold_at      timestamptz,
  -- an "other" book can never carry a course code
  check (book_type = 'course' or course_code is null)
);

-- ---------- 3. Table-level permissions (GRANTs) ----------
grant select on courses to authenticated;
grant select, insert, update on book_listings to authenticated;

-- ---------- 4. Row Level Security ----------
alter table courses enable row level security;
alter table book_listings enable row level security;

-- courses: every signed-in student can read; only admins can change
create policy "courses_read_all" on courses
  for select to authenticated using (true);

create policy "courses_admin_write" on courses
  for all to authenticated
  using (exists (select 1 from user_roles where user_roles.user_id = auth.uid()))
  with check (exists (select 1 from user_roles where user_roles.user_id = auth.uid()));

-- book_listings: everyone signed in can read
create policy "book_listings_read_all" on book_listings
  for select to authenticated using (true);

-- students can create listings, but only as themselves
create policy "book_listings_insert_own" on book_listings
  for insert to authenticated
  with check (auth.uid() = poster_id);

-- students can edit/mark-sold their own listings
create policy "book_listings_update_own" on book_listings
  for update to authenticated
  using (auth.uid() = poster_id)
  with check (auth.uid() = poster_id);

-- admins can update any listing (approve, remove, etc.)
create policy "book_listings_admin_update" on book_listings
  for update to authenticated
  using (exists (select 1 from user_roles where user_roles.user_id = auth.uid()));

-- ---------- 5. Make PostgREST pick up the new tables ----------
notify pgrst, 'reload schema';
