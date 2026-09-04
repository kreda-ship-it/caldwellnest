-- Table definitions, captured from the live database
-- 2026-09-04
--
-- CAPTURE ONLY. Nothing here should be run against the existing database — every table
-- already exists. This is the rebuild reference sql/README.md has listed as missing since
-- 2026-08-08: "Table definitions: listings, book_listings, profiles, messages, appeals,
-- user_roles, schools, activity_log."
--
-- Generated from information_schema.columns rather than retyped, then wrapped in CREATE TABLE
-- form. 25 tables, every one in the public schema.
--
-- ############################################################################
-- READ THIS BEFORE TRUSTING IT FOR A REBUILD
-- ############################################################################
-- information_schema.columns knows about COLUMNS. It does not know about keys. So what is
-- below is complete for column names, types, nullability and defaults, and carries NONE of:
--
--     PRIMARY KEY        FOREIGN KEY        UNIQUE        CHECK        INDEXES
--
-- Running these statements on an empty database would give you tables that accept anything:
-- duplicate ids, orphan rows, `status` values that are not real statuses. **This file is a
-- large step toward a rebuild, not a rebuild.** The query that finishes the job is at the
-- bottom.
--
-- Two things were inferred rather than read, and both should be confirmed by that query:
--   * `ARRAY` is how information_schema reports any array type without saying which. Every
--     one here is written `text[]`, taken from its own default (`'{}'::text[]`). `tags` has
--     no default, so it is the only genuine guess.
--   * Identity vs serial: columns showing `nextval(...)` are serial; `bigint NOT NULL` with
--     no default is an identity column. That distinction matters — a serial needs
--     GRANT USAGE ON SEQUENCE and an identity column does not.


-- ---------- admin_activity_log ----------
create table if not exists public.admin_activity_log (
  id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL,
  actor_school text,
  action_type text NOT NULL,
  target_type text,
  target_id text,
  target_label text,
  school text,
  chain_report_id bigint,
  chain_suspension_id bigint,
  chain_appeal_id bigint,
  reason text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb,
  undone_at timestamp with time zone,
  undone_by uuid,
  reverts_id bigint,
  listing_id bigint,
  category text
);

-- ---------- admin_roles ----------
create table if not exists public.admin_roles (
  id text NOT NULL,
  label text NOT NULL,
  description text
);

-- ---------- appeal_audit_log ----------
create table if not exists public.appeal_audit_log (
  id bigint NOT NULL DEFAULT nextval('appeal_audit_log_id_seq'::regclass),
  appeal_id uuid,
  action text NOT NULL,
  new_status text,
  actioned_by uuid,
  note text,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------- appeals ----------
create table if not exists public.appeals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL,
  email text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  created_at timestamp with time zone DEFAULT now(),
  resolved_by uuid,
  resolved_at timestamp with time zone,
  decision_edited_by uuid,
  decision_edited_at timestamp with time zone,
  suspension_history_id uuid,
  listing_id bigint
);

-- ---------- book_listings ----------
create table if not exists public.book_listings (
  id bigint NOT NULL,
  book_type text NOT NULL,
  course_code text,
  genre text,
  title text NOT NULL,
  author text,
  isbn text,
  edition text,
  price numeric NOT NULL,
  condition text NOT NULL,
  description text,
  photo_urls text[] NOT NULL DEFAULT '{}'::text[],
  poster_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  approved boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  sold_at timestamp with time zone,
  lifecycle_status text NOT NULL DEFAULT 'active'::text,
  expires_at timestamp with time zone,
  status_changed_at timestamp with time zone DEFAULT now(),
  rejection_reason text
);

-- ---------- broadcasts ----------
create table if not exists public.broadcasts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid,
  school text,
  subject text NOT NULL,
  body text NOT NULL,
  type text NOT NULL DEFAULT 'announcement'::text,
  audience text NOT NULL DEFAULT 'All students'::text,
  status text NOT NULL DEFAULT 'draft'::text,
  scheduled_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  display_type text NOT NULL DEFAULT 'both'::text,
  landing_title text,
  landing_body text
);

-- ---------- courses ----------
create table if not exists public.courses (
  code text NOT NULL,
  name text NOT NULL,
  department text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'::text[]
);

-- ---------- favorites ----------
create table if not exists public.favorites (
  id bigint NOT NULL,
  user_id uuid NOT NULL,
  item_type text NOT NULL,
  item_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------- listing_status_history ----------
create table if not exists public.listing_status_history (
  id bigint NOT NULL DEFAULT nextval('listing_status_history_id_seq'::regclass),
  listing_id bigint,
  old_status text,
  new_status text NOT NULL,
  changed_by uuid,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------- listings ----------
create table if not exists public.listings (
  id bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  title text,
  price integer,
  location text,
  description text,
  tags text[],
  poster_name text,
  poster_initials text,
  poster_email text,
  poster_color text,
  emoji text,
  status text DEFAULT 'pending'::text,
  pinned boolean DEFAULT false,
  rejection_reason text,
  category text NOT NULL DEFAULT 'housing'::text,
  details jsonb DEFAULT '{}'::jsonb,
  photos text[] DEFAULT '{}'::text[],
  poster_id uuid,
  school text,
  photo_urls text[] DEFAULT '{}'::text[],
  lifecycle_status text NOT NULL DEFAULT 'active'::text,
  expires_at timestamp with time zone,
  status_changed_at timestamp with time zone DEFAULT now(),
  sold_via_platform boolean,
  view_count integer NOT NULL DEFAULT 0,
  renew_count integer NOT NULL DEFAULT 0
);

-- ---------- messages ----------
create table if not exists public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  conversation_key text,
  listing_id bigint,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  seen_at timestamp with time zone,
  reply_to uuid,
  message_type text NOT NULL DEFAULT 'text'::text,
  book_id bigint
);

-- ---------- notifications ----------
create table if not exists public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  profile_id uuid,
  type text NOT NULL,
  message text NOT NULL,
  read boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------- org_follows ----------
create table if not exists public.org_follows (
  user_id uuid NOT NULL,
  org_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------- org_memberships ----------
create table if not exists public.org_memberships (
  id bigint NOT NULL,
  org_id bigint NOT NULL,
  user_id uuid,
  pending_email text,
  role text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active'::text,
  can_post boolean NOT NULL DEFAULT false,
  can_manage_members boolean NOT NULL DEFAULT false,
  can_view_analytics boolean NOT NULL DEFAULT false,
  can_message boolean NOT NULL DEFAULT false,
  can_create_child_orgs boolean NOT NULL DEFAULT false,
  can_moderate boolean NOT NULL DEFAULT false,
  can_manage_admins boolean NOT NULL DEFAULT false,
  added_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------- organizations ----------
create table if not exists public.organizations (
  id bigint NOT NULL,
  school text NOT NULL,
  parent_id bigint,
  type text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  logo_url text,
  is_verified boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  contact_email text,
  office_location text,
  phone text,
  instagram text,
  website text,
  handshake_url text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------- platform_settings ----------
create table if not exists public.platform_settings (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  updated_by uuid
);

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  major text,
  year text,
  initials text NOT NULL,
  color text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  email text,
  status text NOT NULL DEFAULT 'active'::text,
  suspension_reason text,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  pronouns text,
  school text NOT NULL DEFAULT 'Caldwell'::text,
  verification_status text NOT NULL DEFAULT 'unverified'::text,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_admin_account boolean DEFAULT false,
  terms_accepted_at timestamp with time zone,
  terms_version text
);

-- ---------- reports ----------
create table if not exists public.reports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id bigint,
  reporter_id uuid NOT NULL,
  category text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open'::text,
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  listing_title_snapshot text
);

-- ---------- role_permissions ----------
create table if not exists public.role_permissions (
  role_id text NOT NULL,
  permission_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

-- ---------- saved_listings ----------
create table if not exists public.saved_listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL,
  listing_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------- school_domains ----------
create table if not exists public.school_domains (
  id bigint NOT NULL DEFAULT nextval('school_domains_id_seq'::regclass),
  school_id uuid NOT NULL,
  domain text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------- school_interest ----------
create table if not exists public.school_interest (
  id bigint NOT NULL DEFAULT nextval('school_interest_id_seq'::regclass),
  email text NOT NULL,
  school_name text NOT NULL,
  role text,
  created_at timestamp with time zone DEFAULT now()
);

-- ---------- schools ----------
create table if not exists public.schools (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  email_domain text NOT NULL,
  city text,
  state text,
  created_at timestamp with time zone DEFAULT now(),
  lat double precision,
  lng double precision,
  mascot text,
  brand_name text
);

-- ---------- suspension_history ----------
create table if not exists public.suspension_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  actioned_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  school text,
  report_id uuid,
  listing_id bigint
);

-- ---------- user_roles ----------
create table if not exists public.user_roles (
  user_id uuid NOT NULL,
  role_id text NOT NULL,
  granted_by uuid,
  granted_at timestamp with time zone DEFAULT now(),
  school text
);


-- ############################################################################
-- WHAT IS STILL MISSING, AND THE QUERY THAT GETS IT
-- ############################################################################
-- Run this and the result completes the rebuild: every primary key, foreign key, unique and
-- check constraint, as a runnable ALTER TABLE.

select conrelid::regclass::text as table_name,
       'alter table public.' || conrelid::regclass::text
         || ' add constraint ' || quote_ident(conname)
         || ' ' || pg_get_constraintdef(oid) || ';' as statement
from pg_constraint
where connamespace = 'public'::regnamespace
order by conrelid::regclass::text, conname;

-- And for indexes that are not constraint-backed:
--   select indexdef || ';' from pg_indexes where schemaname = 'public' order by tablename;


-- ############################################################################
-- OBSERVATIONS FROM THE CAPTURE
-- ############################################################################
--
-- 1. profiles.school DEFAULTS TO 'Caldwell' — WITH A CAPITAL C.
--    Everything else in the project uses the lowercase slug 'caldwell': js/boot.js:100,
--    js/listings.js:1275, get_admin_school(), and every RLS policy comparing
--    `school = get_admin_school()`. Those comparisons are exact, not case-insensitive, so a
--    row carrying 'Caldwell' would silently fail every school-scoped admin policy and every
--    `l.school === eu.school` filter in the browser.
--    It is not currently reachable: handle_new_user() always names the school column, and a
--    default only applies when a column is omitted. But it is a mismatched default sitting in
--    the one place nobody looks, waiting for the first insert that omits it.
--
-- 2. listings has no column at ordinal_position 4.
--    Postgres never renumbers after DROP COLUMN. The gap is permanent and harmless — it just
--    records that something was there once.
--
-- 3. Two id conventions, mixed.
--    bigint: listings, book_listings, organizations, org_memberships, favorites,
--            admin_activity_log, school_domains, school_interest, listing_status_history,
--            appeal_audit_log
--    uuid:   profiles, messages, notifications, reports, appeals, suspension_history,
--            saved_listings, schools
--    Neither is wrong; it matters when writing anything that joins across the two, and it is
--    why admin_activity_log.target_id is text — it has to hold both.
--
-- 4. saved_listings is a dead predecessor of favorites.
--    Same purpose, student_id/listing_id instead of user_id/item_type/item_id, one policy,
--    and no DML grants at all — so nothing can read or write it. Confirm it is empty, then
--    drop it. Two tables for saved items is how a future session picks the wrong one.
--
-- 5. profiles.verification_status and profiles.preferences exist and are unused.
--    Neither appears anywhere in js/. Both are correctly absent from the public_profiles
--    view created the same day; noting them so their absence is a decision on record rather
--    than an oversight to be "fixed" later.
