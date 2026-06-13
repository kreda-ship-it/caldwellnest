# CaldwellNest — Product Roadmap

*A living document. Update it as the project grows. Work in TIER order — each tier
mostly depends on the one above it. Check items off as they're done.*

Last updated: 2026-06-12

---

## How to read this
- ✅ = done   🔄 = in progress   ⬜ = not started   🔒 = deferred by design
- Work top-down. The backend (Tier 1) is the foundation almost everything needs.
- "Supabase rule": from now on, any data change is made in Supabase via the SQL
  Editor (Kal runs the SQL herself) to keep frontend and database consistent.

---

## ✅ ALREADY DONE

### Setup & foundation
- ✅ Full dev environment: Homebrew, Git, Node, VS Code, GitHub + SSH, Claude Code
- ✅ Project on GitHub (private): github.com/kreda-ship-it/caldwellnest
- ✅ CLAUDE.md guide + refine-first prompt workflow
- ✅ Supabase project created (free tier) + listings table
- ✅ Listings SAVE to Supabase and persist through refresh (with safe fallback to
      sample data when the table is empty or errors)
- ✅ Admin approvals page reads listings from Supabase
- ✅ Rejection messages (status + rejection_reason) flow to the student
- ✅ Admin "all listings" control panel: view + change status, saved to Supabase
- ✅ Category-based posting system (Housing, Clothing, Technology, Free Stuff,
      Organization/Event, Other) with per-category fields
- ✅ Auto-assigned category emoji
- ✅ Filters repurposed for categories
- ✅ Fair Housing reminder + link added to housing posts
- ✅ Removed sex/gender preference field (parked for legal review — see below)

### Auth & accounts
- ✅ Super-admin login working (redakalkidan@gmail.com via Supabase Auth)
- ✅ Admin "view as student" without a second login — CaldwellNest identity,
      Back to Admin button always visible, admin session protected
- ✅ Official "CaldwellNest" identity in student view (isAdminAccount flag,
      purple CN avatar)
- ✅ Student sign-up working (only @caldwell.edu emails, Supabase Auth)
- ✅ Student login — doLogin() calls Supabase Auth + fetches real profile
- ✅ Session restore on page load — getSession() + user_roles check routes
      admin vs student correctly; no stale profile bleed-through after refresh
- ✅ adminUUID set at both login AND session restore (so the admin lockout guard
      works correctly even after a page refresh)
- ✅ Logout — sLogout() calls supabaseClient.auth.signOut(); session fully cleared
- ✅ Role-ready RBAC structure: admin_roles + user_roles tables in Supabase.
      Roles are stored as data, not a hardcoded flag.
- ✅ Admin students list reads from real Supabase profiles
- ✅ Real listing count per student in admin Students table (fetched from
      Supabase, not hardcoded)

### Admin lockout protection
- ✅ SUPER_ADMIN_ID constant (hardcoded UUID for redakalkidan@gmail.com)
- ✅ isProtectedAdmin(id) helper — returns true for the super-admin account
- ✅ Suspend / Remove buttons hidden for the protected admin everywhere:
      Students table, aViewStu modal, Student history page, Reports panel
- ✅ suspendFromReport() hard-guarded with isProtectedAdmin() — can't be
      bypassed from the browser console even if the UI button were visible

### Messaging
- ✅ Stage 1 — Save & show: messages table in Supabase; send saves; open loads
- ✅ Stage 2 — Linked conversations: sender/receiver/listing_id, conversation_key,
      poster_id backfilled; right people see the right thread
- ✅ Stage 3 — Feels live: Supabase Realtime subscription per conversation;
      new messages appear without refresh; dedup so sent messages don't appear
      twice; channel cleaned up on convo switch / logout
- ✅ Unread badge: Messages nav button shows a count when new messages arrive
      while you're on another page; clears when you open Messages
- ✅ Listing context dividers: pill-style "about: [listing]" divider inserted
      when listing_id changes in a thread; "general conversation" divider if
      context drops to null; listing titles fetched from Supabase
- ✅ Admin messages view — real Supabase query (participants, listing, count,
      last active). Replaces fake DB.convos entirely.

### Moderation system

**Student reports ✅**
- ✅ Report button on every listing card (hidden from the poster, from admin,
      and from listings the viewer already reported)
- ✅ Report modal: category dropdown + free-text details → saves to `reports` table
- ✅ Admin reports review page: reads live from Supabase; action buttons: Dismiss,
      Remove Listing, Suspend Poster
- ✅ Reopen button on resolved/dismissed reports — admin can reverse their decision
- ✅ Reports badge on admin sidebar: live count of open reports
- ✅ `listing_title_snapshot` column on reports — preserves the listing title
      even after the listing is later removed, so the record stays readable
- ✅ `reports.listing_id` FK changed from ON DELETE CASCADE to ON DELETE SET NULL —
      reports survive listing deletion instead of being silently wiped
- ✅ `reporter_id` column on reports — exists; used to link reports to the
      student who filed them

**Listings: soft delete + restore ✅**
- ✅ `aRemoveListing()` sets `status='removed'` instead of hard DELETE —
      listing data preserved for audit trail and possible restore
- ✅ `aRestoreListing()` — admin can relist a removed listing
- ✅ Removed listings section in admin portal — separate card below the main
      listings table, with title, poster, removal date, and a Restore button
- ✅ Active/pending/rejected listings stay in the main table;
      removed listings separated and hidden from students automatically

**Listing status history ✅ (JS done — SQL still needs to be run)**
- ✅ `logStatusChange()` helper — fires-and-forgets an INSERT after every
      status change: approve, reject, remove, restore, pin, unpin, and edit
- ✅ Status history is fetched from Supabase and displayed in the listing
      detail drawer (timeline with old → new status, reason, date)
- ⬜ SQL still needs to be run in Supabase (see Pending SQL section below)

**Suspensions ✅**
- ✅ `status` column on profiles (active / suspended)
- ✅ `suspension_reason` column on profiles
- ✅ Session restore checks suspension status — suspended students are signed
      out and redirected to the suspension screen immediately
- ✅ Full-screen suspension overlay shows the admin's reason
- ✅ Admin Students table has a Reason column
- ✅ Admin can reinstate from Students list or Appeals page
- ✅ `suspension_history` table in Supabase
- ✅ `confirmSuspend()` INSERTs into suspension_history (action: 'suspended')
- ✅ `aReinstate()` INSERTs into suspension_history (action: 'reinstated')
- ⬜ `school` column on suspension_history — design complete (REFINE ONLY done);
      SQL not yet run. Needed so school-at-time-of-event is captured as a
      snapshot, not derived from profiles.school later (which could change
      if a student transfers). See Pending SQL section.

**Appeals ✅**
- ✅ Appeal form on the suspension screen
- ✅ Saves to `appeals` table with profile_id, email, message, status='open'
- ✅ Admin appeals review page: Reinstate or Deny buttons
- ✅ Appeals badge on admin sidebar: live count of open appeals
- ✅ Reinstating from the appeals page marks the appeal as resolved_reinstated
- ✅ Label clarity: "Reinstated" = appeal granted (account restored);
      "Upheld" = appeal denied (suspension stands)
- ✅ Edit decision after the fact — admin can flip a resolved appeal decision
      with a mandatory reason; both the appeal and the student's account
      status are updated atomically
- ✅ Per-appeal audit log — expandable history in each appeal card showing
      every decision and edit with who, when, and reason
- ✅ Student notification — student gets an in-app notification (modal on next
      login) when their appeal is decided or when a decision is edited

### Student history dashboard ✅
Full per-student drilldown inside the admin portal. A dedicated full-panel view,
not a modal. Navigated to by clicking any student name anywhere in admin.

- ✅ `aOpenStudentHistory(profileId)` — switches to the student detail panel
      and parallel-fetches profile, listings, reports filed, reports received,
      and suspension history from Supabase in one round trip
- ✅ Header card: avatar, name, email, school badge, status pill, major/year,
      join date, Suspend/Reinstate action button (hidden for protected admin)
- ✅ 4 stat cards (clickable — jump to the relevant tab):
      listings posted, reports filed, reports received, times suspended
- ✅ 4-tab layout: Listings | Reports Filed | Reports Received | Suspension History
- ✅ Listings tab: list view AND grid view with a toggle button bar;
      each row/card is clickable → opens the listing detail drawer
- ✅ Reports tabs: each row is clickable → opens the report detail drawer
- ✅ Suspension History tab: timeline with suspend/reinstate events, dates,
      and the reason the admin entered at the time
- ✅ Graceful "Account no longer exists" state if the profile was deleted

**Side detail drawer (slide-in panel) ✅**
- ✅ Listing drawer: full listing — price, location, description, tags, poster
      (clickable → their history page), complete status history timeline,
      all reports ever filed against this listing
- ✅ Report drawer: category, full details text, the listing involved
      (clickable → listing drawer), link to view the reporter's profile
- ✅ Drawer opens/closes with smooth CSS transition; clicking the dark overlay
      also closes it
- ✅ Drawer links chain together: report → listing → student and back all work

**Clickable student names throughout admin ✅**
- ✅ Reports view: poster name + "Reported by" name → aOpenStudentHistory()
- ✅ Students table: student name → aOpenStudentHistory()
- ✅ Appeals section: student name/email → aOpenStudentHistory()
- ✅ Listing drawer: poster name → aOpenStudentHistory()
- ✅ Report drawer: "View reporter's profile" → aOpenStudentHistory()
- ✅ `.stu-link-a` CSS class — one definition, used everywhere clickable names appear

**Back button navigation stack ✅**
- ✅ `_histStack` — proper navigation stack (replaces the old single
      `_historyReturnSection` variable that got overwritten on each navigation)
- ✅ Students → Student A → Student B → Back → Student A → Back → Students
      all work correctly at every step
- ✅ `_histGoingBack` flag prevents double-pushing when unwinding the stack
- ✅ Stack resets cleanly whenever entering from a non-history section

### Multi-school architecture ✅ (foundations complete; enforcement deferred)

**Data layer**
- ✅ `school` field on profiles — written at signup, loaded at login, restored
      from session; defaults to 'caldwell'
- ✅ `school` field on listings — written at submitListing(); preserved in
      all admin queries
- ✅ `schools` metadata table in Supabase: id, name, slug, email_domain,
      city, state, lat, lng, mascot, created_at. Caldwell is row 1.
- ✅ `aAdminSchool` global — null = super-admin (sees all schools);
      'caldwell' etc = school-scoped admin. Set at login from user_roles.school.

**Admin scoping**
- ✅ `renderAStudents()` school-scoped: if aAdminSchool is set, the Supabase
      query filters to that school only; school badge shown per student row
- ✅ School badge in admin Students table, student history header card
- ✅ School filter chips on Students page — super-admin can filter to any school
      or by status (Active / Suspended); filters stack
- ✅ School filter on Listings page — derived from school overview click or
      cleared via badge; school shown per listing under poster name
- ✅ School filter on Reports page — applied via school overview click
- ✅ School filter on Approvals page — chips filtered from pending queue
- ✅ School shown per participant in admin Messages view
- ✅ School overview table on dashboard — every count is a clickable link
      (students → Students filtered, listings → Listings filtered,
       reports → Reports filtered, suspensions → Students filtered + Suspended)
- ✅ buildMultiSchoolStats() derives school list from profiles.school (no
      separate schools table needed — works automatically as schools expand)

**RBAC infrastructure**
- ✅ `role_permissions` table in Supabase — template-based permission system
- ✅ `is_super_admin()` SECURITY DEFINER function in Supabase
- ✅ `get_admin_school()` SECURITY DEFINER function in Supabase
- ✅ RLS policies on user_roles, role_permissions, listings, profiles (school-aware)

**Multi-school student history — designed, not yet built**
- ✅ REFINE ONLY plan complete: suspension_history.school column design,
      cross-school report scoping rules, RLS policy drafts for school admins
- ⬜ suspension_history.school column SQL — not yet run (see Pending SQL)
- ⬜ School label on listing rows, suspension entries, report rows inside the
      student history tabs — display work; deferred to dashboard polish pass
- 🔒 School-admin RLS enforcement (scoped reports, profiles, suspension_history)
      — deferred until a real school admin account exists to test against
- 🔒 Stage B: permission-template loading + sidebar item hiding per permissions
- 🔒 Stage C: super-admin schools dashboard (school cards, assign admins,
      permission template editor)

### Analytics dashboard
- ✅ Dashboard stat cards (Students, Pending, Live, Pinned, Reports, Messages)
      are real counts from Supabase — no hardcoded numbers
- ✅ School overview table on dashboard — real per-school counts
- ✅ Analytics page: Avg rent, This month, Approval rate, Total students —
      all real Supabase counts; update when section is opened
- ✅ Monthly listings chart (posted vs approved) — real data from Supabase,
      last 6 months
- ✅ Students by major chart — real data from profiles.major
- ✅ Listings by type chart — real data; each bar is clickable and filters
      the All Listings section to that type

---

## TIER 1 — Foundation (backend) — MOSTLY DONE

- ✅ Backend + database (Supabase) connected
- ✅ Real accounts & secure login — admin + student auth fully working
- ⬜ **Move NestBot AI server-side** — so the AI bot works on the live site
      without exposing an API key in the browser. Needs a Supabase Edge Function.
      Low urgency while still in dev.

---

## ⬜ PENDING SQL — run these in Supabase SQL Editor

These features are already wired in the JS code. The database side just hasn't
been created yet. Run in order, then check each item off.

```sql
-- 1. Listing status history (tracks every approve/reject/pin/remove action)
CREATE TABLE IF NOT EXISTS listing_status_history (
  id bigserial PRIMARY KEY,
  listing_id bigint REFERENCES listings(id) ON DELETE CASCADE,
  old_status text,
  new_status text NOT NULL,
  changed_by uuid REFERENCES auth.users(id),
  reason text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE listing_status_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON listing_status_history TO authenticated;
CREATE POLICY "Admins can view status history"
  ON listing_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()));
CREATE POLICY "Admins can insert status history"
  ON listing_status_history FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()));

-- 2. School snapshot on suspension_history
--    Records which school the student was at the TIME of each event,
--    so the record stays accurate even if they later transfer.
ALTER TABLE suspension_history ADD COLUMN IF NOT EXISTS school text;
UPDATE suspension_history sh
SET school = p.school
FROM profiles p
WHERE sh.profile_id = p.id AND sh.school IS NULL;

-- 3. Appeal audit log (one row per decision or edit; never deleted)
CREATE TABLE IF NOT EXISTS appeal_audit_log (
  id bigserial PRIMARY KEY,
  appeal_id uuid REFERENCES appeals(id) ON DELETE CASCADE,
  action text NOT NULL,      -- 'resolved_reinstated', 'resolved_upheld', 'decision_edited'
  new_status text,           -- the status after this action
  actioned_by uuid REFERENCES auth.users(id),
  note text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE appeal_audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON appeal_audit_log TO authenticated;
CREATE POLICY "Admins view appeal log"
  ON appeal_audit_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()));
CREATE POLICY "Admins insert appeal log"
  ON appeal_audit_log FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()));

-- 4. Notifications (student sees these on next login after an appeal decision)
CREATE TABLE IF NOT EXISTS notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  type text NOT NULL,          -- 'appeal_resolved', 'appeal_edited'
  message text NOT NULL,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON notifications TO authenticated;
CREATE POLICY "Own notifications"
  ON notifications FOR SELECT TO authenticated
  USING (auth.uid() = profile_id);
CREATE POLICY "Admin insert notifications"
  ON notifications FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "Own mark read"
  ON notifications FOR UPDATE TO authenticated
  USING (auth.uid() = profile_id);

NOTIFY pgrst, 'reload schema';
```

---

## TIER 2 — Photos, Messaging & core features (the big build-out)

### ⬜ PHOTOS / IMAGE UPLOADS
- ⬜ Supabase Storage bucket for listing images
- ⬜ Image upload to the post-a-listing form (choose/preview before submit)
- ⬜ Save uploaded image URL on the listing row in Supabase
- ⬜ Show images on listing cards + detail view
- ⬜ Multiple photos per listing (5–10 is typical for housing), file size
      limits, allowed file types, fallback if none uploaded
- ⬜ Decide which categories require photos (housing/clothing yes; event poster yes)
- ⬜ Profile picture support (same Storage bucket, separate path)
- ⬜ Image compression so the page stays fast

### 🔄 MESSAGING — polish (foundation complete, extras next)

**Next up**
- ⬜ Filter messages by listing — inside a conversation, filter to messages
      about a specific listing (dropdown or chips)
- ⬜ Listing chip in the input bar — small pill showing which listing the next
      message is tagged to; tap to clear or switch
- ⬜ Typing indicator — "Jordan is typing…" using Supabase Presence
- ⬜ Active now / last seen

**Later polish**
- ⬜ Reply-to / quote — tap a bubble to quote it; needs `reply_to_id uuid` column
- ⬜ "Official" badge on CaldwellNest messages — purple ✓, not confusable with
      a regular student
- ⬜ Message timestamps — date dividers ("Today", "Yesterday") + per-message
      timestamps on hover/tap
- ⬜ Blocking / reporting — report a message or block a user
- ⬜ Push / email notifications

### ⬜ MOBILE + DESKTOP RESPONSIVE
- ⬜ Test and fix layout on phones (most students will use phones)
- ⬜ Post form, filters, messaging, and admin panel all work on mobile

### ⬜ FILTERING & SORTING (expand what exists)
- ⬜ Filters: price range, distance from campus, # roommates, move-in date,
      lease length, furnished/unfurnished, private vs shared room, pet policy,
      condition (for items), size/brand (clothing)
- ⬜ Sorting: newest, price low–high, closest to campus, best match
- ⬜ Saved favorites / watchlist (needs login to work per-user)

### ⬜ GOOGLE MAPS
- ⬜ Show listing locations on a map (add once listings + photos are solid)

---

## TIER 2.5 — Trust / professional pages (lighter wins, big credibility)
- ⬜ About Us — who we are, the CaldwellNest story (Kal writes the real story)
- ⬜ Mission & Vision — the problem solved and where it's going
- ⬜ Contact Us — start with a simple "email us" link; a real form needs backend
- ⬜ FAQ / How it works
- ⬜ Links to Terms of Service + Privacy Policy

---

## TIER 2 (legal/safety) — Trust, safety & legal (before real students join)
- ⬜ **Terms of Service + Privacy Policy** — required (holds personal data).
      Claude can draft a starting version; NEEDS real review before launch.
- ⬜ **Security basics** — safe password storage (handled by Supabase Auth),
      HTTPS, protection against common attacks
- ⬜ **Forgot password / password reset** — placeholder UI already in login form.
      Full flow: `auth.resetPasswordForEmail()` → Supabase sends reset email →
      student lands back on the site → `auth.updateUser({ password })`.
      No SQL needed — pure Supabase Auth. Requires a hosted URL first (the reset
      link needs somewhere to redirect to). Also configure in Supabase Dashboard:
      Authentication → URL Configuration (add site URL) and
      Authentication → Email Templates → Reset Password.
- ⬜ **Login options** — password first; later passkeys / Face ID
- ⬜ **Fair Housing review** — get real guidance from school legal/housing office
      before rebuilding any sex/gender-preference functionality on roommate posts

---

## TIER 3 — Growth (after the core works)
- ⬜ Marketplace polish for used items
- ⬜ Free Stuff / giveaways flow
- ⬜ Events & announcements board for student organizations
- ⬜ Local business advertising partners (revenue)
- ⬜ Analytics — real usage data to support the school-funding pitch
- ⬜ Possible future mobile app

---

## 🔒 DEFERRED / BLOCKED — do not build yet

### Admin access to message content
**Status: BLOCKED — requires legal + trust groundwork first**

The admin Messages view intentionally shows only conversation *metadata*
(participants, listing, message count, last active). Full message content
is NOT accessible to admins by default.

**Why it's blocked:** Reading private student messages requires:
1. Explicit disclosure in Terms of Service that admin reads are possible
2. Scoped access — only via a report or active investigation, not free-browse
3. An audit log of every admin read (who accessed which thread, when, why)
4. Student-facing notice that their messages may be reviewed

**What needs to happen before building:**
- Draft and publish Terms of Service + Privacy Policy with message-access disclosure
- Design scoped access flow (admin must link an active report to unlock a thread)
- Build the admin-read audit log first
- Legal review of access policy (especially FERPA-adjacent for student platforms)

**Do not add a "View log" button to the admin Messages page until all of the above
are in place. The placeholder currently says "Full viewer coming soon" — leave it.**

---

## ⚠️ PARKED — needs outside guidance before building
- ⬜ **Roommate sex/gender preference** — removed for now. Fair Housing law treats
      "sex" as protected; shared-living arrangements may be treated differently,
      but it varies by jurisdiction. Get guidance from the school's legal/housing
      office. Do NOT just re-add it.

---

## DATA AUDIT (updated 2026-06-12)

### What's genuinely real and working ✅
- Auth: student login, admin login, session restore, logout
- `profiles` — student signup, profile data, school field, status,
  suspension_reason
- `listings` — post, approve, reject, pin, soft-delete/restore, edit, school field
- `messages` — student-to-student messaging + Realtime
- `user_roles` / `admin_roles` — admin RBAC structure
- `role_permissions` — permission templates; `is_super_admin()` and
  `get_admin_school()` SECURITY DEFINER functions live in Supabase
- `reports` — student reports, admin review, soft actions, reopen, reporter_id
- `appeals` — student appeals, admin reinstate/deny, edit decision, audit log
- `suspension_history` — exists; confirmSuspend + aReinstate write to it;
  `school` column pending SQL run (see Pending SQL section)
- `schools` metadata table — Caldwell row exists with lat/lng/mascot
- `appeal_audit_log` — pending SQL run (see Pending SQL section)
- `notifications` — pending SQL run (see Pending SQL section)

### Still using fake/in-memory data (needs fixing)
- **`DB.log`** → activity log resets on every refresh. Fix later: create
  `activity_log` table (DATA TIER 3).
- **`DB.settings`** → `requireApproval` and `eduOnly` toggles reset on refresh.
  ⚠️ This is a real security risk — if the page refreshes, unapproved listings
  could slip through or the .edu gate could silently drop. Priority: DATA TIER 3.
- **`BCAST_HIST`** → sent broadcasts are lost on refresh. DATA TIER 3.
- **`DB.content` / site editor** → color + content changes vanish on refresh.
  DATA TIER 4.
- **Analytics charts + health monitor** → hardcoded fake numbers (analytics
  page charts are now real; health monitor is still fake).
  ⚠️ NEVER show health monitor to school or partners as real data. DATA TIER 5.

### Conversion order

**DATA TIER 1 — Fix broken features with existing Supabase tables**
- ✅ Admin Messages view — replaced DB.convos with real messages table query
- ✅ Wire `school` into suspension_history INSERT in confirmSuspend() +
      aReinstate() — school fetched at time of event, not derived later

**DATA TIER 2 — Safety features needing new columns**
- ⬜ `verification_status` column on profiles — student verification queue
- ✅ `reporter_id` on reports — confirmed exists and in use

**DATA TIER 3 — Admin operations that should persist across refreshes**
- ⬜ `activity_log` table — admin audit trail
- ⬜ `platform_settings` table — requireApproval + eduOnly toggles (security risk)
- ⬜ `broadcasts` table — sent broadcasts persist

**DATA TIER 4 — Content / cosmetic**
- ⬜ `site_config` table — hero text, CTA label, banner, editor color changes

**DATA TIER 5 — Analytics (real data eventually, not urgent)**
- ✅ Analytics page stat cards + monthly chart + major chart + listings by type
      chart — all real Supabase queries now
- ⬜ Health monitor — real uptime/latency; needs a backend service layer

### Fine to leave as-is
- `localStorage` UI preferences (cn_msg_sidebar, cn_admin_sidebar) — correct to keep local
- `BCAST_TEMPLATES`, `SYS_COMPONENTS`, `SYS_EVENTS` — intentional static content
- Placeholder HTML ("Jane Doe", etc.) — overwritten by JS at runtime

---

## ARCHITECTURE DECISION — Multi-school = ONE platform, NOT copies

DECISION: One multi-tenant platform, one codebase, one database. Every user and
listing tagged with a school. NOT a copy per school.

WHY: Cross-school listing discovery is impossible with silos. Maintaining N
codebases doesn't scale. The school tag is the hook that makes expansion easy.

PRINCIPLE: design for multi-school, build for Caldwell.

DONE NOW:
- ✅ `school` field on profiles and listings (default 'caldwell')
- ✅ `schools` metadata table with Caldwell as row 1 (lat/lng ready for distance)
- ✅ Admin scoping: aAdminSchool global + school-filtered student queries

DEFERRED (🔒 build when actually expanding):
- 🔒 Student preference: see only my school, or include nearby schools
- 🔒 Per-school admins with school-scoped RLS enforcement
- 🔒 Email-domain → school mapping at sign-up (@caldwell.edu → Caldwell, etc.)
- 🔒 Distance-based "nearby schools" filtering (lat/lng already in schools table,
      ready when needed)

---

## MULTI-SCHOOL STUDENT HISTORY — design complete, build deferred

Plan finalized for making the student history dashboard fully multi-school-aware.
Foundations are in the data layer. Enforcement is deferred.

KEY DESIGN DECISIONS (locked in, don't change without reason):
- `suspension_history.school` = snapshot of student's school at time of event,
  NOT derived from profiles.school at read time. Survives transfers correctly.
- Reports are school-scoped through `listing_id → listings.school` join; no
  denormalized column on reports (source of truth stays clean).
- "Reports Filed" for a school admin: only shows reports where the listing
  belongs to their school — not all reports that student ever filed.
- School-admin RLS policies are drafted and commented out. Not yet active.
  Stage-gate: build only when a real school admin account exists to test against.

---

## STUDENT PROFILE (partially implemented)

Core fields exist on `profiles` and display in various places. Full public
profile and editing flow is partially built.

- ✅ First name, last name, major, year, initials, color (avatar)
- ✅ school field (set at signup, loaded at session restore)
- ✅ username (set at signup; uniqueness check exists)
- ✅ bio, pronouns, display_name (fields on profiles; editable in profile modal)
- ⬜ Profile picture — needs Supabase Storage first
- ⬜ Username uniqueness rules finalized (length, allowed chars, changeable later?)
- ⬜ Privacy: decide what's public vs admin-only before launch (FERPA-adjacent)
- ⬜ Accessibility: alt text on profile + listing images (ADA)

---

## CURRENT BUILD ORDER (updated 2026-06-12)
1. ✅ Super-admin login
2. ✅ Admin view-as-student without second login
3. ✅ Official "CaldwellNest" identity
4. ✅ Student sign-up (.edu only, real Supabase Auth)
5. ✅ Student login + session restore (admin vs student routed correctly)
6. ✅ Messaging foundation (save, load, linked threads, Realtime, unread badge,
      listing context dividers)
7. ✅ Moderation system — reports, appeals, suspensions, soft-delete + restore
8. ✅ Student history dashboard — full panel, 4 tabs, stat cards, back-navigation
      stack, side detail drawer, clickable names throughout admin,
      listing status tracking (JS wired; SQL pending)
9. ✅ Multi-school data foundations — school field on profiles + listings,
      schools metadata table, aAdminSchool scoping, role_permissions + RLS
      infrastructure in Supabase
10. 🔄 **Admin portal polish + real data** ← CURRENT
       - ✅ Fix admin Messages view (DB.convos → real messages query)
       - ✅ Wire school into suspension_history INSERT in JS
       - ✅ Real dashboard stat counts (Supabase queries, not DB arrays)
       - ✅ Clickable school overview → filtered section navigation
       - ✅ Student section filter chips (school + status)
       - ✅ School shown on listings, approvals, messages participants
       - ✅ Analytics charts — real data (monthly, by major, by type)
       - ✅ Appeals: edit decision + audit log + student notifications
       - ⬜ Run Pending SQL (listing_status_history, suspension_history.school,
             appeal_audit_log, notifications) — Kal runs in Supabase SQL Editor
       - ⬜ platform_settings table (security: approval toggle resets on refresh)
11. ⬜ Messaging polish
       - ⬜ Filter by listing / listing chip in input bar
       - ⬜ Typing indicator (Supabase Presence)
       - ⬜ Active now / last seen
       - ⬜ Reply-to / quote
12. ⬜ Forgot password — needs hosted URL first
13. ⬜ Photos (Supabase Storage) — listing photos + profile pictures
14. ⬜ Testing pass + polish + About/Contact pages
15. 🔒 Multi-school enforcement — school-admin RLS, Stage B + C admin panel
       (build when a second school or school admin actually exists)

---

## Known limitations to remember
- NestBot AI only works inside Claude's preview until moved server-side
- Email confirmation is OFF for development — turn it back ON before real launch
- No automatic backups on Supabase free tier — don't store anything irreplaceable
- Free Supabase projects pause after ~1 week of inactivity (just un-pause them)
- Fake analytics numbers on admin dashboard — never show to school/partners as real
- `requireApproval` and `eduOnly` toggles reset on page refresh — potential
  security gap if a refresh happens mid-session. Fix is DATA TIER 3.
- `appeal_audit_log` and `notifications` tables require SQL to be run before
  those features activate (edits and notifications fail silently until then)

---

## Daily workflow reminder
1. cd ~/Documents/Amahle/CaldwellNest  (always first)
2. Edit via terminal Claude Code OR Claude Code in VS Code
3. Test in browser (hard refresh: Cmd+Shift+R)
4. Make any DB changes in Supabase via SQL Editor
5. Commit + push (terminal: git add . / commit -m / push, OR VS Code Source Control)

---

## Notes & parking lot
*(Drop new ideas here, then sort them into a tier later.)*
-
