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
-- ** RESOLVED 2026-09-04: the constraints are now in PART 2 at the bottom of this file. **
-- Run PART 1 (the tables) and then PART 2 (the keys), in that order — a foreign key cannot
-- reference a table that does not exist yet. Indexes that are not constraint-backed are still
-- uncaptured; the query for those is at the very bottom.
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
-- PART 2 — KEYS AND CONSTRAINTS
-- ############################################################################
-- Emitted by pg_get_constraintdef(), not retyped. Run AFTER part 1: a foreign key cannot
-- reference a table that does not exist yet.
-- 99 constraints across 25 tables.


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

-- ---------- admin_activity_log ----------
alter table public.admin_activity_log add constraint admin_activity_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.admin_activity_log add constraint admin_activity_log_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
alter table public.admin_activity_log add constraint admin_activity_log_pkey PRIMARY KEY (id);
alter table public.admin_activity_log add constraint admin_activity_log_reverts_id_fkey FOREIGN KEY (reverts_id) REFERENCES admin_activity_log(id);
alter table public.admin_activity_log add constraint admin_activity_log_undone_by_fkey FOREIGN KEY (undone_by) REFERENCES auth.users(id);

-- ---------- admin_roles ----------
alter table public.admin_roles add constraint admin_roles_pkey PRIMARY KEY (id);

-- ---------- appeal_audit_log ----------
alter table public.appeal_audit_log add constraint appeal_audit_log_actioned_by_fkey FOREIGN KEY (actioned_by) REFERENCES auth.users(id);
alter table public.appeal_audit_log add constraint appeal_audit_log_appeal_id_fkey FOREIGN KEY (appeal_id) REFERENCES appeals(id) ON DELETE CASCADE;
alter table public.appeal_audit_log add constraint appeal_audit_log_pkey PRIMARY KEY (id);

-- ---------- appeals ----------
alter table public.appeals add constraint appeals_decision_edited_by_fkey FOREIGN KEY (decision_edited_by) REFERENCES auth.users(id);
alter table public.appeals add constraint appeals_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
alter table public.appeals add constraint appeals_message_check CHECK ((char_length(message) <= 1000));
alter table public.appeals add constraint appeals_pkey PRIMARY KEY (id);
alter table public.appeals add constraint appeals_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.appeals add constraint appeals_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id);
alter table public.appeals add constraint appeals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved_reinstated'::text, 'resolved_upheld'::text])));
alter table public.appeals add constraint appeals_suspension_history_id_fkey FOREIGN KEY (suspension_history_id) REFERENCES suspension_history(id) ON DELETE SET NULL;

-- ---------- book_listings ----------
alter table public.book_listings add constraint book_listings_book_type_check CHECK ((book_type = ANY (ARRAY['course'::text, 'other'::text])));
alter table public.book_listings add constraint book_listings_check CHECK (((book_type = 'course'::text) OR (course_code IS NULL)));
alter table public.book_listings add constraint book_listings_condition_check CHECK ((condition = ANY (ARRAY['New'::text, 'Like New'::text, 'Good'::text, 'Fair'::text, 'Worn'::text])));
alter table public.book_listings add constraint book_listings_course_code_fkey FOREIGN KEY (course_code) REFERENCES courses(code) ON DELETE RESTRICT;
alter table public.book_listings add constraint book_listings_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['active'::text, 'sold'::text, 'withdrawn'::text])));
alter table public.book_listings add constraint book_listings_pkey PRIMARY KEY (id);
alter table public.book_listings add constraint book_listings_poster_id_fkey FOREIGN KEY (poster_id) REFERENCES profiles(id);
alter table public.book_listings add constraint book_listings_price_check CHECK ((price >= (0)::numeric));
alter table public.book_listings add constraint book_listings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'removed'::text])));

-- ---------- broadcasts ----------
alter table public.broadcasts add constraint broadcasts_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.broadcasts add constraint broadcasts_pkey PRIMARY KEY (id);

-- ---------- courses ----------
alter table public.courses add constraint courses_pkey PRIMARY KEY (code);

-- ---------- favorites ----------
alter table public.favorites add constraint favorites_item_type_check CHECK ((item_type = ANY (ARRAY['listing'::text, 'book'::text, 'service'::text])));
alter table public.favorites add constraint favorites_pkey PRIMARY KEY (id);
alter table public.favorites add constraint favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.favorites add constraint favorites_user_id_item_type_item_id_key UNIQUE (user_id, item_type, item_id);

-- ---------- listing_status_history ----------
alter table public.listing_status_history add constraint listing_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);
alter table public.listing_status_history add constraint listing_status_history_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
alter table public.listing_status_history add constraint listing_status_history_pkey PRIMARY KEY (id);

-- ---------- listings ----------
alter table public.listings add constraint listings_pkey PRIMARY KEY (id);
alter table public.listings add constraint listings_poster_id_fkey FOREIGN KEY (poster_id) REFERENCES auth.users(id);

-- ---------- messages ----------
alter table public.messages add constraint messages_book_id_fkey FOREIGN KEY (book_id) REFERENCES book_listings(id);
alter table public.messages add constraint messages_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
alter table public.messages add constraint messages_pkey PRIMARY KEY (id);
alter table public.messages add constraint messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.messages add constraint messages_reply_to_fkey FOREIGN KEY (reply_to) REFERENCES messages(id);
alter table public.messages add constraint messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ---------- notifications ----------
alter table public.notifications add constraint notifications_pkey PRIMARY KEY (id);
alter table public.notifications add constraint notifications_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ---------- org_follows ----------
alter table public.org_follows add constraint org_follows_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table public.org_follows add constraint org_follows_pkey PRIMARY KEY (user_id, org_id);
alter table public.org_follows add constraint org_follows_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ---------- org_memberships ----------
alter table public.org_memberships add constraint org_memberships_added_by_fkey FOREIGN KEY (added_by) REFERENCES profiles(id);
alter table public.org_memberships add constraint org_memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table public.org_memberships add constraint org_memberships_org_id_user_id_key UNIQUE (org_id, user_id);
alter table public.org_memberships add constraint org_memberships_pkey PRIMARY KEY (id);
alter table public.org_memberships add constraint org_memberships_role_check CHECK ((role = ANY (ARRAY['member'::text, 'officer'::text])));
alter table public.org_memberships add constraint org_memberships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'removed'::text])));
alter table public.org_memberships add constraint org_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ---------- organizations ----------
alter table public.organizations add constraint organizations_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.organizations add constraint organizations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES organizations(id);
alter table public.organizations add constraint organizations_pkey PRIMARY KEY (id);
alter table public.organizations add constraint organizations_school_slug_key UNIQUE (school, slug);
alter table public.organizations add constraint organizations_type_check CHECK ((type = ANY (ARRAY['school'::text, 'department'::text, 'club'::text, 'office'::text])));

-- ---------- platform_settings ----------
alter table public.platform_settings add constraint platform_settings_pkey PRIMARY KEY (key);
alter table public.platform_settings add constraint platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);

-- ---------- profiles ----------
alter table public.profiles add constraint bio_length CHECK (((bio IS NULL) OR (char_length(bio) <= 150)));
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table public.profiles add constraint profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])));
alter table public.profiles add constraint username_format CHECK (((username IS NULL) OR (username ~ '^[a-z0-9][a-z0-9_]{2,19}$'::text)));

-- ---------- reports ----------
alter table public.reports add constraint reports_category_check CHECK ((category = ANY (ARRAY['scam_or_fraud'::text, 'not_a_student'::text, 'wrong_price'::text, 'duplicate_listing'::text, 'inappropriate_content'::text, 'suspicious'::text, 'other'::text])));
alter table public.reports add constraint reports_details_check CHECK ((char_length(details) <= 500));
alter table public.reports add constraint reports_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
alter table public.reports add constraint reports_listing_id_reporter_id_key UNIQUE (listing_id, reporter_id);
alter table public.reports add constraint reports_pkey PRIMARY KEY (id);
alter table public.reports add constraint reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.reports add constraint reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES profiles(id);
alter table public.reports add constraint reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dismissed'::text, 'actioned'::text])));

-- ---------- role_permissions ----------
alter table public.role_permissions add constraint role_permissions_pkey PRIMARY KEY (role_id, permission_key);
alter table public.role_permissions add constraint role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES admin_roles(id) ON DELETE CASCADE;

-- ---------- saved_listings ----------
alter table public.saved_listings add constraint saved_listings_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id);
alter table public.saved_listings add constraint saved_listings_pkey PRIMARY KEY (id);
alter table public.saved_listings add constraint saved_listings_student_id_fkey FOREIGN KEY (student_id) REFERENCES profiles(id);
alter table public.saved_listings add constraint saved_listings_student_id_listing_id_key UNIQUE (student_id, listing_id);

-- ---------- school_domains ----------
alter table public.school_domains add constraint school_domains_domain_key UNIQUE (domain);
alter table public.school_domains add constraint school_domains_pkey PRIMARY KEY (id);
alter table public.school_domains add constraint school_domains_school_id_fkey FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE;

-- ---------- school_interest ----------
alter table public.school_interest add constraint school_interest_pkey PRIMARY KEY (id);

-- ---------- schools ----------
alter table public.schools add constraint schools_email_domain_key UNIQUE (email_domain);
alter table public.schools add constraint schools_pkey PRIMARY KEY (id);
alter table public.schools add constraint schools_slug_key UNIQUE (slug);

-- ---------- suspension_history ----------
alter table public.suspension_history add constraint suspension_history_action_check CHECK ((action = ANY (ARRAY['suspended'::text, 'reinstated'::text])));
alter table public.suspension_history add constraint suspension_history_actioned_by_fkey FOREIGN KEY (actioned_by) REFERENCES profiles(id);
alter table public.suspension_history add constraint suspension_history_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
alter table public.suspension_history add constraint suspension_history_pkey PRIMARY KEY (id);
alter table public.suspension_history add constraint suspension_history_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.suspension_history add constraint suspension_history_report_id_fkey FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL;

-- ---------- user_roles ----------
alter table public.user_roles add constraint user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.user_roles add constraint user_roles_pkey PRIMARY KEY (user_id, role_id);
alter table public.user_roles add constraint user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES admin_roles(id) ON DELETE CASCADE;
alter table public.user_roles add constraint user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;


-- ############################################################################
-- STILL UNCAPTURED: non-constraint indexes
-- ############################################################################
--   select indexdef || ';' from pg_indexes where schemaname = 'public' order by tablename;
-- Those are performance, not correctness — a rebuild without them is CORRECT and slow, where
-- a rebuild without the constraints above would be fast and wrong.


-- ############################################################################
-- WHAT THE CONSTRAINTS REVEALED
-- ############################################################################
--
-- 6. TWO TABLES POINT AT auth.users WHERE THE REST POINT AT profiles.
--      listings.poster_id  -> auth.users(id)      (no ON DELETE)
--      book_listings.poster_id -> profiles(id)    (no ON DELETE)
--      messages.sender_id / receiver_id -> auth.users(id) ON DELETE CASCADE
--      reports.reporter_id -> profiles(id) ON DELETE CASCADE
--    Both targets "work", because profiles.id is itself a foreign key to auth.users(id).
--    But they are not the same thing when a row is deleted, and the same concept -- "the
--    student who posted this" -- is modelled two ways one table apart. Worth converging on
--    profiles, which is the row the app actually reads.
--
-- 7. NO FOREIGN KEY ANYWHERE ON `school`.
--    organizations.school, listings.school, profiles.school, user_roles.school,
--    suspension_history.school and broadcasts.school are all free text. schools.slug is
--    UNIQUE, so a foreign key is available and simply was never added. Nothing in the
--    database prevents a typo creating an org in a school that does not exist -- and this is
--    exactly why the `profiles.school DEFAULT 'Caldwell'` mismatch in observation 1 is a
--    landmine rather than a curiosity. A constraint would have caught it on the first insert.
--
-- 8. favorites.item_type IS STILL ('listing','book','service').
--    Confirmed from the live check constraint. 'event' has to be added before an event can be
--    starred -- section 12 C6 of docs/nestrel-campus-engagement-plan.md. Now an ALTER, since
--    the table is live:
--      alter table public.favorites drop constraint favorites_item_type_check;
--      alter table public.favorites add constraint favorites_item_type_check
--        check (item_type in ('listing','book','service','event'));
--
-- 9. saved_listings is fully built -- primary key, two foreign keys, a unique pair -- and
--    completely unreachable, because it holds no DML grants. It is not a half-finished table;
--    it is a finished table that was replaced by favorites and never removed.
--
-- 10. profiles carries real input validation that the client should match:
--       username_format  ^[a-z0-9][a-z0-9_]{2,19}$
--       bio_length       <= 150 characters
--       status           only 'active' or 'suspended'
--     If the signup form's rules and this regex ever disagree, the database wins and the
--     student sees a raw constraint error.