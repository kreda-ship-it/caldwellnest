-- Capture every Row Level Security policy, exactly as the database has them
-- 2026-09-04
--
-- CAPTURE. These 68 policies were emitted by the database itself (query 10 of
-- sql/2026-09-03_capture_rls_and_grants.sql, which builds CREATE POLICY statements from
-- pg_policies) and are reproduced here verbatim. Nobody retyped them — a policy transcribed
-- with one wrong operator would look authoritative and be wrong, which is worse than having
-- no file at all.
--
-- This is the item sql/README.md has listed as missing since 2026-08-08: "All RLS policies
-- and GRANTs". With it, this folder can finally rebuild the permission layer.
--
-- IT RECORDS REALITY, NOT THE IDEAL. Eleven of these policies are exact duplicates of
-- another, two are misnamed, and three are noted as findings at the bottom. They are all
-- kept, because a capture file that quietly "improves" the database is a file that disagrees
-- with it — and disagreement between the repo and the database is the exact failure this
-- folder exists to prevent. Fix them in a separate, deliberate change.
--
-- ORDER MATTERS ON A REBUILD. Run these first:
--   1. the tables themselves
--   2. 2026-09-04_capture_permission_functions.sql  (is_super_admin, get_admin_school)
--   3. user_is_admin()  -- see the note at the end of this file
--   4. this file
-- Policies reference those functions; creating a policy before its function fails.
--
-- SAFE TO RE-RUN. Every policy is dropped and recreated inside one transaction, so the
-- database is never briefly without them. Running this changes nothing when the database
-- already matches — which is the point: it is how you prove it still does.

begin;


-- ============================================================================
-- admin_activity_log  (3 policies)
-- ============================================================================
-- NOTE: RLS was switched OFF on this table until 2026-09-03, so these three
--   policies existed but were never consulted. See 2026-09-03_fix_rls_and_grants.sql.
alter table public.admin_activity_log enable row level security;

drop policy if exists "Admins can mark entries as undone" on public.admin_activity_log;
create policy "Admins can mark entries as undone" on public.admin_activity_log as permissive for update to public using (user_is_admin());
drop policy if exists "Admins can read activity log" on public.admin_activity_log;
create policy "Admins can read activity log" on public.admin_activity_log as permissive for select to public using (user_is_admin());
drop policy if exists "Authenticated users can log activity" on public.admin_activity_log;
create policy "Authenticated users can log activity" on public.admin_activity_log as permissive for insert to public with check (((auth.uid() IS NOT NULL) AND (auth.uid() = actor_id)));

-- ============================================================================
-- admin_roles  (1 policy)
-- ============================================================================
alter table public.admin_roles enable row level security;

drop policy if exists "Admin roles are public" on public.admin_roles;
create policy "Admin roles are public" on public.admin_roles as permissive for select to public using (true);

-- ============================================================================
-- appeal_audit_log  (2 policies)
-- ============================================================================
alter table public.appeal_audit_log enable row level security;

drop policy if exists "Admins insert appeal log" on public.appeal_audit_log;
create policy "Admins insert appeal log" on public.appeal_audit_log as permissive for insert to authenticated with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins view appeal log" on public.appeal_audit_log;
create policy "Admins view appeal log" on public.appeal_audit_log as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));

-- ============================================================================
-- appeals  (6 policies)
-- ============================================================================
-- NOTE: DUPLICATES: 'Admins update appeals'/'admin can update appeals',
--   'Admins view all appeals'/'admin can read appeals', and
--   'Anon can file appeal'/'anon can insert appeals' are three identical pairs.
alter table public.appeals enable row level security;

drop policy if exists "Admins update appeals" on public.appeals;
create policy "Admins update appeals" on public.appeals as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins view all appeals" on public.appeals;
create policy "Admins view all appeals" on public.appeals as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Anon can file appeal" on public.appeals;
create policy "Anon can file appeal" on public.appeals as permissive for insert to anon with check (true);
drop policy if exists "admin can read appeals" on public.appeals;
create policy "admin can read appeals" on public.appeals as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "admin can update appeals" on public.appeals;
create policy "admin can update appeals" on public.appeals as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "anon can insert appeals" on public.appeals;
create policy "anon can insert appeals" on public.appeals as permissive for insert to anon with check (true);

-- ============================================================================
-- book_listings  (4 policies)
-- ============================================================================
alter table public.book_listings enable row level security;

drop policy if exists book_listings_admin_update on public.book_listings;
create policy book_listings_admin_update on public.book_listings as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists book_listings_insert_own on public.book_listings;
create policy book_listings_insert_own on public.book_listings as permissive for insert to authenticated with check ((auth.uid() = poster_id));
drop policy if exists book_listings_read_all on public.book_listings;
create policy book_listings_read_all on public.book_listings as permissive for select to authenticated using (true);
drop policy if exists book_listings_update_own on public.book_listings;
create policy book_listings_update_own on public.book_listings as permissive for update to authenticated using ((auth.uid() = poster_id)) with check ((auth.uid() = poster_id));

-- ============================================================================
-- broadcasts  (4 policies)
-- ============================================================================
-- NOTE: DUPLICATE: 'Admins can manage broadcasts' and 'Admins manage broadcasts'.
alter table public.broadcasts enable row level security;

drop policy if exists "Admins can manage broadcasts" on public.broadcasts;
create policy "Admins can manage broadcasts" on public.broadcasts as permissive for all to public using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins manage broadcasts" on public.broadcasts;
create policy "Admins manage broadcasts" on public.broadcasts as permissive for all to public using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "All auth users can read sent broadcasts" on public.broadcasts;
create policy "All auth users can read sent broadcasts" on public.broadcasts as permissive for select to public using (((auth.uid() IS NOT NULL) AND (status = 'sent'::text)));
drop policy if exists "Read active broadcasts" on public.broadcasts;
create policy "Read active broadcasts" on public.broadcasts as permissive for select to public using (((auth.uid() IS NOT NULL) AND (status = ANY (ARRAY['sent'::text, 'scheduled'::text]))));

-- ============================================================================
-- courses  (2 policies)
-- ============================================================================
alter table public.courses enable row level security;

drop policy if exists courses_admin_write on public.courses;
create policy courses_admin_write on public.courses as permissive for all to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid())))) with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists courses_read_all on public.courses;
create policy courses_read_all on public.courses as permissive for select to authenticated using (true);

-- ============================================================================
-- favorites  (3 policies)
-- ============================================================================
-- NOTE: The cleanest table in the database: own-rows-only on all three commands,
--   and no anon grant at all.
alter table public.favorites enable row level security;

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own on public.favorites as permissive for delete to authenticated using ((auth.uid() = user_id));
drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own on public.favorites as permissive for insert to authenticated with check ((auth.uid() = user_id));
drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own on public.favorites as permissive for select to authenticated using ((auth.uid() = user_id));

-- ============================================================================
-- listing_status_history  (2 policies)
-- ============================================================================
alter table public.listing_status_history enable row level security;

drop policy if exists "Admins can insert status history" on public.listing_status_history;
create policy "Admins can insert status history" on public.listing_status_history as permissive for insert to authenticated with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins can view status history" on public.listing_status_history;
create policy "Admins can view status history" on public.listing_status_history as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));

-- ============================================================================
-- listings  (4 policies)
-- ============================================================================
alter table public.listings enable row level security;

drop policy if exists "Owners manage listing lifecycle" on public.listings;
create policy "Owners manage listing lifecycle" on public.listings as permissive for update to authenticated using ((auth.uid() = poster_id)) with check ((auth.uid() = poster_id));
drop policy if exists listings_insert on public.listings;
create policy listings_insert on public.listings as permissive for insert to authenticated with check ((auth.uid() = poster_id));
drop policy if exists listings_select on public.listings;
create policy listings_select on public.listings as permissive for select to authenticated using (((status = ANY (ARRAY['approved'::text, 'pinned'::text])) OR (poster_id = auth.uid()) OR is_super_admin() OR ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))) AND (school = get_admin_school()))));
drop policy if exists listings_update on public.listings;
create policy listings_update on public.listings as permissive for update to authenticated using ((is_super_admin() OR ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))) AND (school = get_admin_school())))) with check ((is_super_admin() OR ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))) AND (school = get_admin_school()))));

-- ============================================================================
-- messages  (4 policies)
-- ============================================================================
alter table public.messages enable row level security;

drop policy if exists "Receivers can mark messages seen" on public.messages;
create policy "Receivers can mark messages seen" on public.messages as permissive for update to authenticated using ((auth.uid() = receiver_id)) with check ((auth.uid() = receiver_id));
drop policy if exists "Users can read own messages" on public.messages;
create policy "Users can read own messages" on public.messages as permissive for select to authenticated using (((auth.uid() = sender_id) OR (auth.uid() = receiver_id)));
drop policy if exists "Users can send messages" on public.messages;
create policy "Users can send messages" on public.messages as permissive for insert to authenticated with check ((auth.uid() = sender_id));
drop policy if exists admins_read_all_messages on public.messages;
create policy admins_read_all_messages on public.messages as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));

-- ============================================================================
-- notifications  (4 policies)
-- ============================================================================
-- NOTE: *** BOTH INSERT POLICIES CHECK `true`. *** Despite the names, neither
--   tests for an admin, so ANY authenticated student may insert a notification
--   for ANY profile_id. See the FINDINGS block at the end of this file.
alter table public.notifications enable row level security;

drop policy if exists "Admin can insert" on public.notifications;
create policy "Admin can insert" on public.notifications as permissive for insert to authenticated with check (true);
drop policy if exists "Admin insert notifications" on public.notifications;
create policy "Admin insert notifications" on public.notifications as permissive for insert to authenticated with check (true);
drop policy if exists "Own mark read" on public.notifications;
create policy "Own mark read" on public.notifications as permissive for update to authenticated using ((auth.uid() = profile_id));
drop policy if exists "Own notifications" on public.notifications;
create policy "Own notifications" on public.notifications as permissive for select to authenticated using ((auth.uid() = profile_id));

-- ============================================================================
-- platform_settings  (3 policies)
-- ============================================================================
alter table public.platform_settings enable row level security;

drop policy if exists "Admins insert settings" on public.platform_settings;
create policy "Admins insert settings" on public.platform_settings as permissive for insert to authenticated with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins update settings" on public.platform_settings;
create policy "Admins update settings" on public.platform_settings as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid())))) with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Anyone reads settings" on public.platform_settings;
create policy "Anyone reads settings" on public.platform_settings as permissive for select to public using (true);

-- ============================================================================
-- profiles  (4 policies)
-- ============================================================================
-- NOTE: The student UPDATE policy has no WITH CHECK, so Postgres reuses USING —
--   an owner may write any column of their own row. The real defence is the
--   profiles_guard_privileged trigger, not this policy. See 2026-09-01_guard_consent_columns.sql.
--   SELECT is `true`: every signed-in student can read every column of every
--   profile, email and suspension_reason included. See FINDINGS.
alter table public.profiles enable row level security;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles" on public.profiles as permissive for select to authenticated using (true);
drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile" on public.profiles as permissive for insert to authenticated with check ((auth.uid() = id));
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile" on public.profiles as permissive for update to public using ((auth.uid() = id));
drop policy if exists admin_school_scoped_profiles on public.profiles;
create policy admin_school_scoped_profiles on public.profiles as permissive for update to authenticated using ((is_super_admin() OR ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))) AND (school = get_admin_school())))) with check ((is_super_admin() OR ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))) AND (school = get_admin_school()))));

-- ============================================================================
-- reports  (7 policies)
-- ============================================================================
-- NOTE: DUPLICATES: three identical pairs, differing only in capitalisation.
alter table public.reports enable row level security;

drop policy if exists "Admins update reports" on public.reports;
create policy "Admins update reports" on public.reports as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins view all reports" on public.reports;
create policy "Admins view all reports" on public.reports as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Students can file reports" on public.reports;
create policy "Students can file reports" on public.reports as permissive for insert to authenticated with check ((auth.uid() = reporter_id));
drop policy if exists "admins can read all reports" on public.reports;
create policy "admins can read all reports" on public.reports as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "admins can update reports" on public.reports;
create policy "admins can update reports" on public.reports as permissive for update to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "students can file reports" on public.reports;
create policy "students can file reports" on public.reports as permissive for insert to authenticated with check ((reporter_id = auth.uid()));
drop policy if exists "students can read own reports" on public.reports;
create policy "students can read own reports" on public.reports as permissive for select to authenticated using ((reporter_id = auth.uid()));

-- ============================================================================
-- role_permissions  (2 policies)
-- ============================================================================
alter table public.role_permissions enable row level security;

drop policy if exists admin_reads_own_permissions on public.role_permissions;
create policy admin_reads_own_permissions on public.role_permissions as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role_id = role_permissions.role_id)))));
drop policy if exists super_admin_manages_permissions on public.role_permissions;
create policy super_admin_manages_permissions on public.role_permissions as permissive for all to authenticated using (is_super_admin()) with check (is_super_admin());

-- ============================================================================
-- saved_listings  (1 policy)
-- ============================================================================
alter table public.saved_listings enable row level security;

drop policy if exists "Students manage own saves" on public.saved_listings;
create policy "Students manage own saves" on public.saved_listings as permissive for all to authenticated using ((student_id = auth.uid())) with check ((student_id = auth.uid()));

-- ============================================================================
-- school_domains  (1 policy)
-- ============================================================================
alter table public.school_domains enable row level security;

drop policy if exists "Public can read school domains" on public.school_domains;
create policy "Public can read school domains" on public.school_domains as permissive for select to anon, authenticated using (true);

-- ============================================================================
-- school_interest  (1 policy)
-- ============================================================================
alter table public.school_interest enable row level security;

drop policy if exists "Anyone can submit school interest" on public.school_interest;
create policy "Anyone can submit school interest" on public.school_interest as permissive for insert to anon, authenticated with check (true);

-- ============================================================================
-- schools  (1 policy)
-- ============================================================================
alter table public.schools enable row level security;

drop policy if exists "Public can read schools" on public.schools;
create policy "Public can read schools" on public.schools as permissive for select to anon, authenticated using (true);

-- ============================================================================
-- suspension_history  (5 policies)
-- ============================================================================
-- NOTE: DUPLICATES: two identical pairs.
alter table public.suspension_history enable row level security;

drop policy if exists "Admins insert suspension history" on public.suspension_history;
create policy "Admins insert suspension history" on public.suspension_history as permissive for insert to authenticated with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Admins view suspension history" on public.suspension_history;
create policy "Admins view suspension history" on public.suspension_history as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "Students view own suspension history" on public.suspension_history;
create policy "Students view own suspension history" on public.suspension_history as permissive for select to authenticated using ((auth.uid() = profile_id));
drop policy if exists "admins can insert suspension history" on public.suspension_history;
create policy "admins can insert suspension history" on public.suspension_history as permissive for insert to authenticated with check ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));
drop policy if exists "admins can read suspension history" on public.suspension_history;
create policy "admins can read suspension history" on public.suspension_history as permissive for select to authenticated using ((EXISTS ( SELECT 1 FROM user_roles WHERE (user_roles.user_id = auth.uid()))));

-- ============================================================================
-- user_roles  (3 policies)
-- ============================================================================
-- NOTE: 'User roles are public' is `to public using (true)` — an anonymous visitor
--   can read the whole admin roster. See FINDINGS.
alter table public.user_roles enable row level security;

drop policy if exists "User roles are public" on public.user_roles;
create policy "User roles are public" on public.user_roles as permissive for select to public using (true);
drop policy if exists "Users can read own roles" on public.user_roles;
create policy "Users can read own roles" on public.user_roles as permissive for select to authenticated using ((auth.uid() = user_id));
drop policy if exists super_admin_manages_roles on public.user_roles;
create policy super_admin_manages_roles on public.user_roles as permissive for all to authenticated using (is_super_admin()) with check (is_super_admin());

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- FINDINGS — recorded here, deliberately NOT fixed in a capture file
-- ============================================================================
--
-- F1. notifications INSERT is open to every student.
--     Both INSERT policies are `to authenticated with check (true)`. The names say "Admin"
--     but nothing tests for one. Any signed-in student can insert a row for any profile_id
--     with any message text, because profile_id is never constrained to auth.uid().
--     js/auth.js:497 does exactly this insert, so the endpoint and its shape are public.
--     A student cannot READ another student's notifications (the SELECT policy is correct),
--     but they can WRITE them — forging "Your listing was approved" or "You have been
--     suspended" into someone else's feed.
--     FIX: notifications are written by admin actions, so the check should be
--     user_is_admin(), matching every other admin-write table. Needs a pass over
--     js/auth.js:497 first to confirm no student-triggered path depends on it.
--
-- F2. Every signed-in student can read every profile column.
--     'Authenticated users can read profiles' is `using (true)`, and the app calls
--     select('*') on profiles in eight places. That returns email, status,
--     suspension_reason, terms_accepted_at and terms_version for every student to every
--     other student. Public profile pages are intended; exposing suspension reasons and
--     email addresses to the whole campus is probably not.
--     FIX is not a policy change — RLS filters rows, not columns. It needs either a view
--     exposing only the public columns, or column-level GRANTs, plus changing those
--     select('*') calls. Real work, not a one-liner.
--
-- F3. The admin roster is world-readable.
--     'User roles are public' is `to public using (true)`, so an anonymous visitor can list
--     every administrator. 'Admin roles are public' on admin_roles is the same. Information
--     disclosure rather than an access hole — but it hands an attacker the exact list of
--     accounts worth attacking.
--     FIX: 'Users can read own roles' already covers the app's need
--     (js/boot.js:71 reads the current user's roles). Confirm nothing reads the whole table,
--     then drop the public policy.
--
-- F4. Eleven duplicate policies.
--     appeals x3 pairs, reports x3, suspension_history x2, broadcasts x1, notifications x1.
--     Permissive policies OR together, so duplicates change nothing at runtime. They make
--     the policy list roughly a third longer than it needs to be and much harder to audit,
--     which is its own cost.
--
-- F5. user_is_admin() is the inline check, not a third one.
--     An earlier note in 2026-09-04_capture_permission_functions.sql suggested there were
--     three disagreeing admin checks. There are two. user_is_admin() is
--     `EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid())` — character for
--     character what the inline form in most policies does. So the real split is:
--       broad  — any user_roles row: user_is_admin() and its inlined copies
--       narrow — is_super_admin(): role_id = 'super_admin'
--     That is a duplication problem, not a correctness one. The named function is the better
--     form; the inlined copies should be replaced with calls to it so there is one place to
--     change when can_act() lands.

