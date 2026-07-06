# CaldwellNest — Product Roadmap

*A living document. Update it as the project grows. Work in TIER order — each tier
mostly depends on the one above it. Check items off as they're done.*

Last updated: 2026-06-24

---

## BRAND DECISION (locked in)

**Company:** Amahle Digital Creatives — founded by Kalkidan Reda (KR).

**Parent platform:** NESTREL — the multi-school platform. This is the brand
schools sign onto. NESTREL is what the landing page, pitch deck, and any
expansion materials are built around.

**Per-school instances:** Each school gets its own branded instance of NESTREL:
- **CaldwellNest** — Caldwell University. The first and flagship instance.
- Future schools get their own name (e.g. RutgersNest, TempleNest, etc.)

**Hierarchy:**
Amahle Digital Creatives BUILT NESTREL.
NESTREL POWERS CaldwellNest (and every future per-school instance).

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

**Listing events / audit log ✅**
- ✅ All listing lifecycle events (submit, approve, reject, remove, restore,
      pin, unpin, edit) write to `admin_activity_log` — ONE table, no duplication
- ✅ `logEvent()` helper — student-safe writer; used by `submitListing()` to log
      the "submitted for review" event (students can't write to admin-only tables
      otherwise; logEvent() uses relaxed RLS: any authenticated user can log
      events where they are the actor)
- ✅ `logAdminAction()` updated with `category` field — all listing events now
      carry the listing's category for future filtering
- ✅ `saveAEdit()` captures full before/after snapshot: status, title, price,
      location, description — not just title and status as before
- ✅ `listing_status_history` table CANCELLED — never created; replaced by
      querying `admin_activity_log` directly (eliminates duplicate-write risk)
- ✅ Listing detail drawer timeline queries `admin_activity_log` by `listing_id`
      (oldest-first, so timeline reads: Submitted → Approved → Removed etc.)
- ✅ SQL run 2026-06-15

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
- ✅ `school` column on suspension_history — captures school at time of event,
      not derived from profiles later (survives transfers correctly). SQL run 2026-06-15.

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
- ✅ suspension_history.school column SQL — run 2026-06-15
- ⬜ School label on listing rows, suspension entries, report rows inside the
      student history tabs — display work; deferred to dashboard polish pass
- 🔒 School-admin RLS enforcement (scoped reports, profiles, suspension_history)
      — deferred until a real school admin account exists to test against
- 🔒 Stage B: permission-template loading + sidebar item hiding per permissions
- 🔒 Stage C: super-admin schools dashboard (school cards, assign admins,
      permission template editor)

### Broadcasts ✅

- ✅ `broadcasts` table in Supabase — fully persistent, survives refresh
- ✅ Broadcast compose: message type chips (announcement / warning / reminder / feature),
      display-as chips (banner / notification / both), subject, message body,
      audience selector, schedule datetime, expiry datetime
- ✅ Save as Draft / Send Now / Schedule — status auto-switches based on
      whether a schedule date in the future is entered
- ✅ Edit any broadcast (including already-sent ones) — loads back into the
      compose form with a note if already delivered
- ✅ Soft-delete: "Delete" sets status='deleted' and moves to Deleted tab;
      row is preserved, not removed
- ✅ Restore from Deleted tab → puts it back as a draft
- ✅ Delete forever → hard permanent delete, accessible from Deleted tab only
- ✅ History panel with 5 filter tabs: All (excludes deleted), Sent, Scheduled,
      Drafts, Deleted
- ✅ Status badges: Sent (blue), Scheduled (indigo), Draft (grey), Deleted (red)
- ✅ 19 quick templates across 6 categories: General, Welcome/Onboarding,
      Seasonal, Platform Updates, Safety, Beta — one-click pre-fill
- ✅ Student-facing broadcasts: colored dismissible banner cards above the
      student app; up to 3 shown at once; dismissed IDs saved in localStorage
- ✅ Broadcast landing pages — Stage 1:
      - Optional "Add landing page" toggle in compose (hidden by default)
      - Landing title + markdown textarea with live side-by-side preview
      - `renderMd()` — inline markdown renderer: headings, bold, italic, links, lists
      - `sanitizeMd()` — allowlist-based XSS filter: blocks javascript: URLs,
        strips unsafe tags; only h2/h3/h4/p/strong/em/ul/li/a/br allowed
      - Student banner: "Read more →" link appears when landing_body exists
      - Clicking opens a modal with the full rendered landing page
      - History panel shows a "📖 Landing page" chip on entries that have one
      - SQL: two nullable columns added: `landing_title text`, `landing_body text`
- ✅ Broadcast activity log: broadcast_sent, broadcast_drafted, broadcast_scheduled,
      broadcast_updated, broadcast_deleted, broadcast_restored,
      broadcast_permanently_deleted — all tracked in admin_activity_log
- ✅ Panel horizontal scroll — min-width:680px grid + overflow-x:auto wrapper
      so narrow screens slide instead of clip

**Pending for broadcasts**
- ⬜ Landing pages Stage 2: formatting toolbar (Bold/Italic/Link/Heading
      quick-insert buttons above the textarea), inline image via URL input
- ⬜ Activity log cleanup: remove remaining dead DB.log.unshift() calls, fix
      export function to query admin_activity_log instead of DB.log, add
      logAdminAction to dismissReport() and hideListingFromReport()

### Listing Photos — Stage 1 ✅ (2026-06-24)

**Infrastructure**
- ✅ Supabase Storage bucket `listing-photos` — public bucket, 3 policies:
      SELECT (public/unauthenticated read), INSERT + DELETE (authenticated, own
      folder only — policy checks first folder segment = auth.uid())
- ✅ `photo_urls text[]` column on listings table, default `{}`
- ✅ Single-source-of-truth enforced: file lives in Storage, URL stored ONLY in
      `listings.photo_urls`. Audited — no display surface copies or caches the URL
      anywhere else. All render functions reference photo_urls at render time.

**Upload pipeline**
- ✅ File picker in post-a-listing form (tap/drag dropzone) — JPEG, PNG, WebP,
      max 10 MB; HEIC blocked with a clear message
- ✅ Canvas compression — max 1600px on longest side, JPEG 0.85 quality, strips
      EXIF metadata (fixes iOS portrait rotation)
- ✅ Upload-before-insert pattern — photo uploaded first, URL included in the
      initial listings INSERT. Eliminates a separate UPDATE that was silently
      failing due to RLS (authenticated users couldn't update listings after insert).
- ✅ `crypto.randomUUID()` for storage path — collision-proof; replaces the
      earlier timestamp + 5-char random string scheme
- ✅ Orphan cleanup — if the DB insert fails after a successful photo upload,
      the orphaned file is automatically deleted from Storage (path extracted from
      the URL and removed via storage.remove())

**Display surfaces (audited — all reference photo_urls at render time)**
- ✅ Listing feed cards — photo replaces emoji when photo_urls[0] exists
- ✅ Listing detail modal — full-width photo header (220px)
- ✅ Student's own profile listing grid — thumbnail photo
- ✅ Public student profile listing grid — photo_urls now passed through the
      normalised mapping (was silently dropped — fixed)
- ✅ Admin approvals panel — photo shown above each pending listing card

**Safety + lifecycle**
- ✅ `deleteListingPhotos(photoUrls)` — reusable helper; extracts path(s) from
      URL(s), calls storage.remove(); designed to handle multi-photo Stage 2
- ✅ `aHardDeleteListing(id)` — "Delete forever" on removed listings:
      deletes photos from Storage first, then hard-deletes listing row from DB;
      confirms before acting; logs to activity log
- ✅ `listing_permanently_deleted` added to ACTION_META and
      ACTIVITY_FILTER_GROUPS.moderation
- ✅ Soft-delete safety: suspended/removed listings' photos stay in Storage
      so reinstatement restores them correctly. Photos are invisible to students
      because the listing is filtered out at loadListings() — not because the file
      is deleted.
- ✅ Multi-school: photo URLs are absolute HTTPS Supabase Storage URLs —
      school-agnostic. A Montclair student viewing a Caldwell listing loads the
      same URL from the same bucket with no extra routing.

**Bugs fixed during photo work (2026-06-24)**
- ✅ `initStudent()` off-by-one destructuring — `[, , , { count }]` was reading
      `_settingsReady` (index 2) instead of the Supabase count result (index 3)
- ✅ `viewStudentProfile` normalised mapping dropped `photo_urls` — added the field
- ✅ Demo login (Jamie Cruz) had no `id` property — the `&& u.id` guard silently
      skipped the entire upload block with no toast, no error. Guard removed.
- ✅ DB update after upload was failing silently (RLS) — restructured to
      upload-before-insert so no separate update is needed
- ✅ `aApprove` / `confirmReject` in-memory objects already carried photo_urls ✅

**Capacity (free tier)**
- ~5,000 photos at 200 KB average before hitting 1 GB Storage limit
- At 200 students × 2 listings × 1 photo = ~80 MB — well within free tier
- Upgrade to Supabase Pro ($25/mo) recommended around 400+ real active users
- Bandwidth (5 GB/mo) is the likelier bottleneck before Storage; `loading="lazy"`
  already reduces it by only loading visible images

---

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
- ✅ Analytics overhaul — complete rebuild with real Supabase data across all
      6 listing categories (not just housing); time-range filter (7d / 30d /
      3mo / All time); vs-prior-period deltas on all stat cards; real
      top-posted-students widget; fake "Top performing listings" table removed
- ✅ Platform Health section — honest real-time queries: DB ping + latency,
      listings posted today, new signups today, pending approvals, open reports,
      last backup age (from localStorage). No fake numbers.
- ✅ Analytics widgets clickable — each stat card and category bar navigates to
      the relevant filtered section; "← Back to Analytics" button appears at
      the top of the content area when navigating from analytics
- ✅ Category filter chips on Approvals page — filters pending listings by type
      (Housing, Clothing, Technology, etc.); auto-opens when a filter is active

---

## TIER 1 — Foundation (backend) — MOSTLY DONE

- ✅ Backend + database (Supabase) connected
- ✅ Real accounts & secure login — admin + student auth fully working
- ⬜ **Move NestBot AI server-side** — so the AI bot works on the live site
      without exposing an API key in the browser. Needs a Supabase Edge Function.
      Low urgency while still in dev.

---

## ✅ PENDING SQL — all run

```
✅ Listing audit system — listing_id + category on admin_activity_log,
   trigger, RLS, backfill (2026-06-15)
✅ suspension_history.school column — backfilled from profiles (2026-06-15)
✅ appeal_audit_log table — created with RLS (2026-06-15)
✅ notifications table — created with RLS (2026-06-15)
```

### LISTINGS AUDIT SYSTEM SQL (run this too — adds listing history to admin_activity_log)

```sql
-- =============================================
-- LISTINGS AUDIT SYSTEM
-- Extends admin_activity_log; never creates listing_status_history.
-- Run all at once.
-- =============================================

-- Step 1: Add listing_id and category columns to admin_activity_log
ALTER TABLE admin_activity_log
  ADD COLUMN IF NOT EXISTS listing_id bigint REFERENCES listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS idx_aal_listing_id ON admin_activity_log(listing_id);
CREATE INDEX IF NOT EXISTS idx_aal_category   ON admin_activity_log(category);

-- Step 2: Trigger that auto-fills listing_id from target_id
-- whenever target_type = 'listing'. No JS changes needed for existing events.
CREATE OR REPLACE FUNCTION fn_sync_listing_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type = 'listing' AND NEW.target_id IS NOT NULL THEN
    BEGIN
      NEW.listing_id := NEW.target_id::bigint;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_listing_id ON admin_activity_log;
CREATE TRIGGER trg_sync_listing_id
  BEFORE INSERT ON admin_activity_log
  FOR EACH ROW EXECUTE FUNCTION fn_sync_listing_id();

-- Step 3: Update INSERT RLS so authenticated students can log their own events
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Admins can insert activity log" ON admin_activity_log';
  EXECUTE 'DROP POLICY IF EXISTS "Admin insert activity log" ON admin_activity_log';
  EXECUTE 'DROP POLICY IF EXISTS "Admins insert activity" ON admin_activity_log';
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE POLICY "Authenticated users log own events"
  ON admin_activity_log FOR INSERT TO authenticated
  WITH CHECK (
    (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()))
    OR (auth.uid() = actor_id)
  );

-- Step 4: School-scoped SELECT policy
-- Super-admin sees all; school admins see only their school's events
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Admins can view activity log" ON admin_activity_log';
  EXECUTE 'DROP POLICY IF EXISTS "Admin view activity log" ON admin_activity_log';
  EXECUTE 'DROP POLICY IF EXISTS "Admins view activity" ON admin_activity_log';
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE POLICY "Scoped admin activity log view"
  ON admin_activity_log FOR SELECT TO authenticated
  USING (
    is_super_admin()
    OR (
      get_admin_school() IS NOT NULL
      AND school = get_admin_school()
    )
  );

-- Step 5: Backfill — create 'listing_submitted' events for existing listings
-- Idempotent: skips any listing that already has a submitted event.
-- Skips listings with no poster_id (legacy/demo rows).
INSERT INTO admin_activity_log
  (actor_id, actor_school, action_type, target_type, target_id,
   target_label, school, listing_id, category, after_state, created_at)
SELECT
  l.poster_id,
  l.school,
  'listing_submitted',
  'listing',
  l.id::text,
  l.title,
  l.school,
  l.id,
  l.category,
  jsonb_build_object('status', 'pending'),
  l.created_at
FROM listings l
WHERE l.poster_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM admin_activity_log a
    WHERE a.listing_id = l.id
      AND a.action_type = 'listing_submitted'
  );

NOTIFY pgrst, 'reload schema';
```

---

## PRE-BETA MUST-DO — polish before real students join

*These block the beta launch. Do them before opening signups to real Caldwell students.*

### ⬜ EMAIL VERIFICATION + WELCOME EMAIL
- ⬜ Turn Supabase Auth email confirmation back ON — it was disabled during
      development. This is a single toggle: Authentication → Settings →
      "Enable email confirmations". Do this before any real signups.
- ⬜ Student receives a confirmation email with a link they must click before
      the account is fully active — until confirmed, status is "pending verification"
- ⬜ Until verified: account exists but can't post listings or message
      *(commit `885852f` may have added a gate — status unconfirmed; verify before trusting)*
- ⬜ Send a "Welcome to CaldwellNest" email on successful signup — reflects
      per-school branding ("your slice of Nestrel")
- ⬜ Re-send option on the verification screen if they didn't get the email
- ⬜ Auto-reject / expire unverified accounts after X days (decide the policy)
- ⬜ Email templates for: welcome, verify email, password reset — all Nestrel-branded

### ⬜ REMOVE THE DEMO STUDENT ACCOUNT
- ⬜ Delete the "Jamie Cruz" / demo student path that bypasses real signup
- ⬜ Remove the demo login button from the login screen
- ⬜ Remove `demoLogin()` function and its call sites
- ⬜ Remove all demo-account conditional fallbacks (e.g. NestBot's "Demo User"
      fallback text, any `isDemoUser` checks)
- *Note: this was useful during development. It's a security and data-quality
  risk in beta — any real student can click it and access the app unverified.*

### ⬜ UI POLISH PASS — "human, not AI" feel
*The interface should feel warm, deliberate, and made-by-a-person.*

- ⬜ Microcopy review — every label, button, error message, empty state.
      Sound like a friend, not a system. No "No data found."
- ⬜ Empty states — when there are no listings / messages / reports, show
      something warm and specific, not a blank panel
- ⬜ Loading states — every spinner and "saving…" moment. Branded and brief.
- ⬜ Toast notifications — wording, timing, tone. Functional now; could feel
      more human
- ⬜ Transitions and motion — small tasteful animations where things appear or
      change. Nothing flashy; just signs of life
- ⬜ Typography pass — confirm hierarchy is consistent across all pages
- ⬜ Spacing / breathing room — generous and calm, not cramped
- ⬜ Mobile-first check — every screen actually tested on a phone
- ⬜ Tone-of-voice consistency — warm / professional / founder-led throughout;
      no drift into corporate or generic
- ⬜ Real photos / illustrations where they help (placeholders are obvious now)
- ⬜ Accessibility — alt text on images, semantic HTML, keyboard nav, contrast

*Principle: every detail should look like a person made a choice about it.*

---

## TIER 2 — Photos, Messaging & core features (the big build-out)

### Listing Photos — Stage 2 🔄 (Stage 1 complete; Stage 2 mostly shipped 2026-06-26, commit `534a94d`)

*Stage 1 shipped 2026-06-24. Everything below is Stage 2.*

- ✅ Multiple photos per listing (target: 5–10 max); multi-file picker;
      `photo_urls` array already supports it — UI + upload loop is the work
- ✅ Photo shown in admin listing detail drawer (`openListingDrawer`) — the fresh
      `select('*')` already returns `photo_urls`, just not rendered yet
- ⬜ Photo replacement on admin edit — delete old file(s) from Storage,
      upload new, update `photo_urls` in DB. `deleteListingPhotos()` helper
      is already built; the edit modal just needs the UI wired up.
- ✅ Log "submitted with photo" in activity log (observability gap — currently
      `listing_submitted` doesn't record whether a photo was attached)
- ✅ Decide per-category photo requirements (housing + clothing + event posters
      = required or strongly nudged; donation/other = optional) — per-category nudge shipped
- ✅ Profile pictures — same `listing-photos` bucket, different path convention
      (`profiles/{userId}/avatar.jpg`); needs avatar upload UI in profile modal
- ⬜ Image moderation / NSFW screening (long-term; may need external API)

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

### NOTIFICATIONS — plan locked in, build staged

**What's already done:**
- ✅ `notifications` table in Supabase — created with RLS (2026-06-15)
- ✅ In-app appeal notifications: student gets a modal on next login when their
      appeal decision is made or edited. Writes to the notifications table.
- ✅ Design principle: notifications table captures events FOR a specific user;
      admin_activity_log is an audit trail FOR admins. They are different tables
      with different purposes — do not merge them.

**The four types of notifications (build in this order):**

1. **⬜ IN-APP NOTIFICATIONS (bell icon + feed)** — highest impact, least infrastructure
   - Bell icon with unread count in student nav
   - Dropdown / feed: "Your listing was approved", "Jordan messaged you about
     [listing]", "Your appeal was [decided]", "Welcome to CaldwellNest", etc.
   - Persists across sessions; markable as read
   - Each notification: user_id, event_type, related_id, read/unread, created_at, school
   - Role-scoped: school admins only see their school; super-admin not spammed
   - *Target: later in beta or early post-beta*

2. **⬜ EMAIL NOTIFICATIONS** — critical events only, not spammy
   - Suspension, appeal decision, account verification, password reset, security events
   - User settings to opt in/out by category (safety events are NOT opt-out-able)
   - Welcome email + verify email overlap with PRE-BETA MUST-DO above
   - *Target: after in-app notifications*

3. **🔒 PUSH NOTIFICATIONS** — browser/mobile push for real-time alerts even
   when not on the site. Much heavier infrastructure (push service, permissions,
   mobile app or PWA). Defer to v2+.

4. **🔒 FULL ACTIVITY FEED** — dedicated page showing everything on a student's
   account. In-app notifications (#1) cover most of the value. Defer.

**Build order when the time comes:**
1. Capture every relevant event into notifications table (data foundation first)
2. In-app bell + dropdown UI
3. Settings page: notification preferences per category
4. Critical-event emails (suspension, appeals, account changes)
5. Welcome + verification emails (overlaps pre-beta items)
6. Later: dedicated student activity feed page
7. Much later: push notifications

**Design decisions to keep:**
- Notification events captured in the table from the start — even if no UI shows
  them yet. Then the UI can display history going back.
- Student activity feed (full history) is a future extension of the bell, not
  a separate thing to build now.

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

## DATA AUDIT (updated 2026-06-22)

### What's genuinely real and working ✅
- Auth: student login, admin login, session restore, logout
- `profiles` — student signup, profile data, school field, status,
  suspension_reason
- `listings` — post, approve, reject, pin, soft-delete/restore, edit,
  hard-delete + photo cleanup, school field, `photo_urls text[]` column
- `listing-photos` Storage bucket — public, 3 policies (read/insert/delete);
  URLs stored only in `listings.photo_urls`; `deleteListingPhotos()` helper
  removes files when a listing is permanently deleted
- `messages` — student-to-student messaging + Realtime
- `user_roles` / `admin_roles` — admin RBAC structure
- `role_permissions` — permission templates; `is_super_admin()` and
  `get_admin_school()` SECURITY DEFINER functions live in Supabase
- `reports` — student reports, admin review, soft actions, reopen, reporter_id
- `appeals` — student appeals, admin reinstate/deny, edit decision, audit log
- `suspension_history` — exists; confirmSuspend + aReinstate write to it;
  `school` column pending SQL run (see Pending SQL section)
- `schools` metadata table — Caldwell row exists with lat/lng/mascot
- `appeal_audit_log` — table created, RLS active (SQL run 2026-06-15)
- `notifications` — table created, RLS active (SQL run 2026-06-15)

### Still using fake/in-memory data (needs fixing)
- **`DB.log`** → activity log resets on every refresh. Some dead `DB.log.unshift()`
  calls still in the code (broadcasts cleanup pending). Fix: remove dead calls,
  wire export to query `admin_activity_log` (DATA TIER 3 cleanup).
- **`DB.settings`** → ✅ persisted to `platform_settings` table (2026-06-16).
  `requireApproval` and `maintenance` are now enforced in code. Toggles survive
  refresh. `emailAlerts` remains a no-op until a backend email service is added.
- **`BCAST_HIST`** → ✅ replaced by `broadcasts` table in Supabase (2026-06-22).
  Broadcasts persist through refresh; edit, soft-delete, restore, and scheduled
  sending all work.
- **`DB.content` / site editor** → color + content changes vanish on refresh.
  DATA TIER 4.

### Conversion order

**DATA TIER 1 — Fix broken features with existing Supabase tables**
- ✅ Admin Messages view — replaced DB.convos with real messages table query
- ✅ Wire `school` into suspension_history INSERT in confirmSuspend() +
      aReinstate() — school fetched at time of event, not derived later

**DATA TIER 2 — Safety features needing new columns**
- ⬜ `verification_status` column on profiles — student verification queue
- ✅ `reporter_id` on reports — confirmed exists and in use

**DATA TIER 3 — Admin operations that should persist across refreshes**
- ✅ `activity_log` / `admin_activity_log` — admin audit trail (complete)
- ✅ `platform_settings` table — requireApproval + maintenance enforced (2026-06-16)
- ✅ `broadcasts` table — sent broadcasts persist; soft-delete, restore,
      landing pages, student banner display (2026-06-22)

**DATA TIER 4 — Content / cosmetic**
- ⬜ `site_config` table — hero text, CTA label, banner, editor color changes

**DATA TIER 5 — Analytics (real data eventually, not urgent)**
- ✅ Analytics page stat cards + monthly chart + major chart + listings by type
      chart — all real Supabase queries now
- ✅ Platform Health section — real Supabase queries (DB ping, today counts,
      pending + open reports, backup age)
- ⬜ Deep health metrics (uptime %, error rate, server-side latency) — needs
      a backend service layer; deferred

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
- ⬜ Profile picture — Storage bucket exists (`listing-photos`); path convention
      planned (`profiles/{userId}/avatar.jpg`); UI work is Stage 2 photos
- ⬜ Username uniqueness rules finalized (length, allowed chars, changeable later?)
- ⬜ Privacy: decide what's public vs admin-only before launch (FERPA-adjacent)
- ⬜ Accessibility: alt text on profile + listing images (ADA)

---

## CURRENT BUILD ORDER (updated 2026-06-22)
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
10. ✅ **Admin portal polish + real data** — complete
       - ✅ Fix admin Messages view (DB.convos → real messages query)
       - ✅ Wire school into suspension_history INSERT in JS
       - ✅ Real dashboard stat counts (Supabase queries, not DB arrays)
       - ✅ Clickable school overview → filtered section navigation
       - ✅ Student section filter chips (school + status)
       - ✅ School shown on listings, approvals, messages participants
       - ✅ Analytics charts — real data (monthly, by major, by type)
       - ✅ Appeals: edit decision + audit log + student notifications
       - ✅ Analytics overhaul: time-range filter (7d/30d/3mo/All), vs-prior-period
             deltas, real category chart (all 6 types), real top-posted-students
             widget, Platform Health rebuilt with honest Supabase queries
       - ✅ Analytics widgets all clickable → filtered section navigation;
             "← Back to Analytics" back button in content area
       - ✅ Category filter chips on Approvals page
       - ✅ "Two Caldwells" data bug fixed — school field normalized to lowercase
       - ✅ Run Pending SQL — all tables and columns live as of 2026-06-15
       - ✅ platform_settings table — requireApproval + maintenance enforced, survive refresh
11. ✅ **Broadcasts** — complete (2026-06-22)
       - ✅ Supabase-backed: persist through refresh, edit, soft-delete, restore
       - ✅ Student banner: colored dismissible cards, dismiss saved in localStorage
       - ✅ Landing pages Stage 1: markdown editor + live preview + student modal
       - ✅ Soft-delete → Deleted tab → Restore / Delete forever
       - ✅ 19 templates, 5 history filter tabs, full activity log coverage
       - ⬜ Landing pages Stage 2: formatting toolbar + inline image support
       - ⬜ Activity log cleanup: remove dead DB.log.unshift() calls, fix export
             to query admin_activity_log, add logAdminAction to dismissReport()
             and hideListingFromReport()
12. 🔄 **Pre-beta must-do** ← NEXT
       - ⬜ Turn Supabase email confirmation ON
       - ⬜ Build email verification + welcome email flow
       - ⬜ Remove demo student account (Jamie Cruz / demoLogin())
       - ⬜ UI polish pass — microcopy, empty states, loading states, mobile check
13. ⬜ Messaging polish
       - ⬜ Filter by listing / listing chip in input bar
       - ⬜ Typing indicator (Supabase Presence)
       - ⬜ Active now / last seen
       - ⬜ Reply-to / quote
14. ⬜ Forgot password — needs hosted URL first
15. 🔄 Photos (Supabase Storage)
       - ✅ Stage 1 complete (2026-06-24) — see ALREADY DONE → Listing Photos
       - ⬜ Stage 2 — multiple photos, photo replacement in admin edit,
             profile pictures, drawer display, per-category requirements
16. ⬜ In-app notifications (bell icon + feed) — see NOTIFICATIONS section
17. ⬜ Testing pass + polish + About/Contact pages
18. 🔒 Multi-school enforcement — school-admin RLS, Stage B + C admin panel
       (build when a second school or school admin actually exists)

---

## Known limitations to remember
- NestBot AI only works inside Claude's preview until moved server-side
- Email confirmation is OFF for development — turn it back ON before real launch
- No automatic backups on Supabase free tier — don't store anything irreplaceable
- Free Supabase projects pause after ~1 week of inactivity (just un-pause them)
- Storage free tier = 1 GB; at 200 KB/photo average that's ~5,000 photos.
  At current scale (≤200 students) this is nowhere near the limit.
  Upgrade to Supabase Pro ($25/mo) when approaching 400+ real active users.
  Bandwidth (5 GB/mo free) is the more likely bottleneck — `loading="lazy"` helps.
- `requireApproval` and `maintenance` now persist via `platform_settings` table ✅.
  `eduOnly` still resets on refresh — potential security gap. Fix: add it to
  platform_settings (DATA TIER 3 cleanup).
- `appeal_audit_log` and `notifications` tables are live — appeal edit decisions
  and student notifications are fully active

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

### Maintenance mode polish (future)
Basic maintenance toggle works and persists. Future polish ideas:
- ⬜ Custom maintenance message — let admin write the reason/ETA shown on the page
      instead of the hardcoded "Scheduled maintenance" text
- ⬜ Estimated-back timer — admin sets a return time; countdown shown to students
- ⬜ Admin bypass link — a secret URL parameter (e.g. `?preview=1`) or allow-list
      so specific people can test the site while maintenance is on
- ⬜ Maintenance scheduled window — set a start + end time in advance; toggles
      automatically without admin staying awake to flip it

---
---

# APPENDED 2026-07-03 — sync from CaldwellNest_Roadmap (7).md

*These six sections existed in the working roadmap doc but hadn't made it into
this repo file yet. Added here verbatim (markers normalized to this file's
✅ done / 🔄 in progress / ⬜ not started; 📝 = not started but a build prompt
is already drafted).*

---

## ADDED 2026-06-24 — What Nestrel actually solves (locked-in answer)

### The student problem
College students live in scattered, chaotic information ecosystems for everything
outside the classroom — overflowing Messenger groups, scammy Facebook Marketplace,
random flyers, generic email blasts. Each tool solves one slice badly; together
they create a chaos tax students pay every day.

### What Nestrel solves
The ONE trusted space where verified students at a given school can do everything
campus life requires — housing, roommates, marketplace, free items, events,
organizations — inside one platform that knows they're a student at that school.

### The unique combination (the moat)
- Verified .edu only (eliminates scams + outside creeps)
- ALL campus-life threads in one place (not five separate apps)
- School-aware (your school is default; cross-school is opt-in for nearby)
- Built for college rhythms (semester cycles, move-in, graduation handoffs)
- Multi-school by design (CaldwellNest is the first instance of Nestrel)

### Why this isn't "just another roommate app"
The roommate space (Rumii, SpareRoom) is crowded. Nestrel's moat is the integrated
campus-life-hub model + multi-school scalability + verified-student trust layer.
Each piece alone exists; the combination doesn't.

### Why schools will eventually partner
Student housing chaos, roommate disputes, and unsafe peer-to-peer transactions
create real problems for residence life and student affairs offices. Nestrel offers
a school-branded, school-aware platform that improves student life with zero
infrastructure cost to the school.

---

## ADDED 2026-06-24 — Code organization roadmap (POST-BETA)

### Current state — single index.html (~10,000+ lines)
This was the right choice for the building phase: simplicity, speed, visibility,
no build tools, no module systems. Most successful products start this way.

### Why it's time to restructure (post-beta)
- Finding code is harder (file navigation > Cmd+F)
- Bugs in one feature can hide in another section
- Harder for collaborators / professors to read the repo
- Limits how the system can be thought about
- Makes Claude Code's edits less precise

### NOT NOW — after beta
Restructuring before launch is risky — it touches everything and introduces subtle
bugs that surface in production. Discipline: land the beta on current structure,
restructure after.

### A SMALL move that's safe pre-beta (optional, for the professor email)
- ✅ Extract CSS into a separate `styles.css` file. Biggest immediate win, lowest
     risk. Demonstrates structural thinking without touching logic.
     **DONE 2026-07-03 (commit `6e3fefd`) — pure move, 568 CSS lines, zero visual change.**
- ⬜ (Optional) Extract 1-2 JavaScript modules (auth, listings) into separate
     files. Riskier — defer if unsure.

### Post-beta full restructuring plan
1. ✅ Extract CSS into its own file *(done 2026-07-03)*
2. ⬜ Extract JavaScript modules by feature:
   auth.js, listings.js, messaging.js, admin.js, broadcasts.js, profile.js,
   settings.js, utils.js (shared helpers)
3. ⬜ Decide on framework path:
   - Option A: stay vanilla with proper ES modules (lowest risk, fastest)
   - Option B: migrate to a lightweight framework (Alpine.js, Lit) — middle ground
   - Option C: full React migration — biggest investment, biggest payoff
4. ⬜ Add a simple build setup (Vite or similar) — bundles files for production
5. ⬜ Set up local development workflow with hot-reload

### Use restructuring as a deliberate learning exercise
Don't restructure mindlessly — use it to deepen skills. Read other people's
well-organized projects first. Notice their conventions. Apply the patterns that
make sense for our codebase.

---

## ADDED 2026-06-24 — Personal coding development plan

Not a Nestrel task — but a longer arc that improves every Nestrel decision.

### Where I am now
Self-taught from zero to a real platform with auth, database, realtime, storage,
multi-tenancy, complex permissions. Real engineering instincts developing
(root-cause analysis, single source of truth, soft-delete, refusing to
over-engineer).

### Where to grow next (priority order)
1. ⬜ Read other people's well-written code (open-source projects, Supabase
   example apps) — like reading a book. Notice their organization, naming,
   edge-case handling.
2. ⬜ Learn Git deeply — branching, reviewing own diffs, rebasing. One focused weekend.
3. ⬜ Get comfortable with Chrome DevTools debugger — breakpoints, watching
   variables, stepping through code. Replaces 90% of "what's going on?" frustration.
4. ⬜ Read my own code from 6 months ago periodically. Wincing is learning.
5. ⬜ Build 2-3 small focused side projects between Nestrel sessions.
6. ⬜ Find one technical mentor — the biggest single unlock. The CS professor
   outreach is exactly this move.
7. ⬜ When restructuring post-beta, learn one framework properly — likely React.

### Reassurance to remember
Every developer feels they don't know enough. Even senior engineers google things
constantly, forget syntax, get stumped, ask colleagues. The mark of an engineer
isn't knowing everything — it's developing strategies for figuring things out.
I already have those strategies.

---

## ADDED 2026-06-24 — Launch timeline (working target, revisit before locking)

### Working soft-beta target: August 2, 2026
- Platform technically ready: all critical bugs fixed, all in-flight features shipped.
- Onboarding the first 5-10 closest friends for stress-testing.
- Closed-alpha mode — catch embarrassing bugs in low-stakes conditions.

### Working real-beta target: August 25-30, 2026
- Full beta opens to 20-50 Caldwell students.
- Aligns with students returning to campus + peak fall housing demand.

### Why this phasing
- Avoids launching too early (students still in summer mode in July).
- Avoids missing peak demand (waiting too long misses move-in season).
- Builds in real buffer for the surprises every founder hits.

### Honest reality check
Working hours per day average ~2-3 during school year, ~6-8 in focused stretches.
Average pre-beta feature: 4-6 hours of design + build + test + commit. Roughly
3-4 features per week. ~15 in-flight items = ~4-5 weeks of focused work.

### What MUST be done before any beta opening
- ⬜ Signup bug fixed
- ⬜ Photo upload end-to-end working
- ⬜ Email verification flow ON, with branded templates and "check your email" UI
      *(status unconfirmed — verify whether the gate in `885852f` is actually live)*
- ⬜ Auto-update audit + unified fix
- ⬜ Two-Caldwells root cause fixed
- ⬜ Suspension hides listings (safety gap)
- ⬜ Listings log / activity log integrated
- ⬜ Mark-as-sold + soft-hide listing lifecycle
- ✅ UI polish: masonry, no-photo cards, poster + description preview, filter redesign
      *(cards redesign `41467b4`; filter redesign `115ccda`)*
- ⬜ Demo account removed *(note: superseded — plan is now to REPURPOSE, not delete)*
- ⬜ Settings + maintenance mode tested
- ⬜ Basic Terms of Service + Privacy Policy (placeholder OK, real review pre-public)
- ⬜ Mobile responsiveness verified across every screen
- ⬜ All fake numbers / placeholder data removed
- ⬜ Working Nestrel landing page

### NOT required for beta opening (post-beta or later)
- Full notifications system
- Full email composer + digests
- Multi-photo carousel polish (Stage 1 photos is enough)
- Cross-school browsing UI (data foundation ready; UI experience can wait)
- Multi-admin permissions (only super-admin needed for beta)
- Code restructuring
- Real legal review (placeholder OK for closed beta; needed pre-public)

---

## ADDED 2026-06-24 — Second project: Student rideshare (LONG-TERM)

### The vision
An Uber-style rideshare app for verified college students — students driving and
riding with other students. Common routes: airport trips, home-for-break, late-night
campus runs, between-school events, grocery and off-campus needs. Pricing positioned
below Uber's surge rates, made trustworthy by .edu verification.

### Why this fits Amahle's thesis
- Same audience as Nestrel: verified college students.
- Same trust layer: .edu-gated.
- Same multi-school scalability pattern.
- Reinforces Amahle Digital Creatives' identity: TRUSTED SERVICES FOR VERIFIED
  COLLEGE STUDENTS.
- Network effects: students using Nestrel + Amahle Rides reinforces each.

### Why this is FAR more complex than Nestrel — to walk into eyes-open
- **Legal**: insurance law, contractor classification, state DOT regulations,
  NJ-specific TNC rules, background checks, liability law. Uber spent BILLIONS in
  legal fights. Real legal counsel is non-negotiable before any real rides.
- **Insurance**: personal auto insurance does NOT cover commercial driving. Drivers
  need rideshare riders or commercial coverage. One uncovered accident is
  catastrophic. The single biggest reason "rideshare for X" ideas fail.
- **Safety stakes are physical**: students in cars at 2am makes safety incidents the
  platform's problem. Real-time tracking, panic buttons, ride verification, identity
  systems are NON-NEGOTIABLE from day one.
- **Two-sided marketplace**: need drivers AND riders simultaneously. Cold-start is
  severe. Uber subsidized losses for years to bootstrap supply + demand.
- **Operational lift**: background checks, vehicle inspections, insurance
  verification, payments, dispute resolution, dynamic pricing, route optimization.
- **Capital**: Stripe Connect, Google Maps API (costs scale fast), legal counsel,
  insurance products, support, likely a small team. Cannot be bootstrapped on a free
  tier the way Nestrel can.

### Honest mentor framing
A real, worthwhile idea. But it is a 2-3 years from now idea, not a "right after
Nestrel beta" idea. Treating it as side-by-side underestimates the lift by 10-50x.

### A SANE staged path
- **Stage 0 (now, ZERO BUILD):** Park it. Document the vision. Don't build it.
- **Stage 1 (after Nestrel beta healthy, fall 2026):** Validate — survey 50+ Caldwell
  students; talk to 5-10 live; decide if demand is real.
- **Stage 2 (2027, if validated): MVP — RIDES BOARD.** Not a true rideshare app: a
  board where students post "driving to Newark Airport Sat, $20 gas share, 2 seats."
  Legally defensible (gas-sharing among classmates, no rides SOLD). Could be a
  NESTREL FEATURE (new category), not its own app — ~5% of the legal/ops complexity.
- **Stage 3 (post-grad, with legal counsel + possible funding): True rideshare.**
  Real entity, insurance, GPS tracking, payments, driver vetting, dispatch. Consider
  an accelerator. Start in ONE city, ONE school, ONE route. Prove it, then expand.

### Naming for the future
"Amahle Rides" or similar — within the Amahle Digital Creatives parent.

### Reference points to study
Uber's early regulatory history; HopSkipDrive (kids' rideshare safety standards);
BlaBlaCar (Europe's ride-share-for-gas, closest to Stage 2); Wheeli / RideWith /
college rideshare attempts — most failed; study WHY.

---

## ADDED 2026-06-26 — Full in-flight work log (everything we designed prompts for)

*Status legend: ⬜ not started · 📝 prompt written, build pending · 🔄 in progress · ✅ done.*

### 🐛 BUGS & FIXES (highest priority)
- 📝 SIGNUP BUG — silent failure on submit, no error shown.
     Diagnostic prompt written. CRITICAL: blocks new students entirely.
- 📝 TWO-CALDWELLS BUG — duplicate Caldwell records. Root-cause
     diagnostic prompt written. Must merge data before deleting duplicate.
- 📝 AUTO-UPDATE AUDIT (student side) — listings don't load on
     first sign-in (needs refresh); messaging badge doesn't update live.
- 📝 AUTO-UPDATE AUDIT (admin side) — refresh button doesn't work;
     messages don't auto-update. Unified fix strategy requested.
- 📝 SUSPENSION HIDES LISTINGS — safety gap: suspending a student
     does NOT hide their active listings. CRITICAL safety.
- 📝 PROFILE PICTURE ZOOM — avatars zoom in too much when set.
- ✅ SETTINGS PERSISTENCE — require-approval + maintenance toggles persist to
     Supabase and survive refresh. Maintenance mode blocks students, not admins.

### 📸 PHOTOS
- ✅ PHOTO UPLOAD — end-to-end working (Stage 1 + Stage 2 shipped).
- ✅ Storage architecture decided — public bucket `listing-photos`, path
     {poster_id}/{listing_id}/{timestamp}{random}.jpg, photo_urls text[] column.
- 📝 SINGLE-SOURCE-OF-TRUTH photo audit — verify no duplicate
     photo storage across surfaces; every render reads from photo_urls.
- 🔄 MULTI-PHOTO — multi-file upload shipped (`534a94d`); Instagram-style
     swipeable CAROUSEL polish (dots, arrows, keyboard nav) still pending.

### 🎨 LISTING UI REDESIGN — ✅ shipped (commit `41467b4`)
- ✅ PHOTO-LED CARD REDESIGN — natural aspect ratios, not cropped to a fixed box.
- ✅ NO-PHOTO CARDS — typography-on-color, category-aware soft palette.
- ✅ POSTER ON CARD — small avatar + first name + school + subtle verified signal;
     description preview under location.
- ✅ MASONRY LAYOUT — Pinterest-style; single column on mobile.
- ✅ DESCRIPTION COLOR — darker for readability.

### 🔍 FILTER UI (student side) — ✅ redesign shipped (commit `115ccda`)
- ✅ FILTER REDESIGN — collapsed behind a "Filters" button; category strip visible;
     active filter chips, dynamic result count, real-time updates.
- ✅ Stage B — deep filters panel (price slider, category-specific fields).
- 📝 Stage C — cross-school browsing (My School / 10mi / 25mi / All,
     haversineDistance() helper, lat/lng on schools table).
- ✅ Stage D — mobile bottom drawer + visual polish.

### 💬 MESSAGING
- 📝 PREMIUM MESSAGING EXPERIENCE — real-time everywhere, touch
     gestures (swipe-to-reply, long-press), desktop keyboard shortcuts.
- 📝 PHOTO SHARING in messages — storage-smart hybrid; client-side
     compression. Possibly deferrable for beta.
- 📝 LISTING CONTEXT SYSTEM — established once at convo start;
     pinned header + small chip near input; inline divider only when context switches.

### 📢 BROADCASTS
- ✅ Broadcasts persistence (moved to Supabase).
- 📝 BROADCAST TEMPLATES — welcome, seasonal, updates, safety, beta, breaks.
- 📝 BROADCAST UI UPGRADE — premium compose, preview,
     send-confirmation with audience count, recent-broadcasts log.
- 📝 BROADCAST LANDING PAGES — optional richer click-through content
     (MUST sanitize for XSS).

### 🎫 ADMIN PORTAL
- ✅ Admin logo role-aware — super-admin sees "Nestrel" + "Platform Admin"; school
     admins see their brand + "School Admin". Drill-in "Viewing: CaldwellNest" indicator.
- 📝 ADMIN MESSAGES PORTAL — real metadata (active conversations,
     counts, trends). NO content reading. Role-scoped.
- 📝 LISTINGS LOG / ACTIVITY LOG — comprehensive history of every
     listing. ONE event log. Per-listing lifecycle + per-student history + search/filter.
- 📝 ACTIVITY LOG PERSISTENCE — DB.log currently in-memory; move to
     Supabase via one logEvent() helper.
- 📝 ANALYTICS INTERACTIVITY — clickable widgets that navigate to the
     relevant page with a back button.

### 🔐 AUTH & ONBOARDING
- 📝 SCHOOL PICKER SIGNUP — pick school from list + email domain
     verification + waitlist for unrecognized schools; multiple domains per school.
- 📝 EMAIL VERIFICATION FLOW — Supabase confirm-email ON; branded verification +
     welcome emails; unverified state gates posting/messaging; "check your email"
     screen; resend option. *(commit `885852f` may have added a gate — unconfirmed.)*
- 📝 DEMO STUDENT ACCOUNT — REPURPOSE (not delete) into a real
     verified account with one-click login, for demos. SUPERSEDES the earlier
     "remove demo account" item.
- 📝 SECOND SUPER-ADMIN (amahledigitalcreatives@gmail.com) — blocked
     by "Database error creating new user" (signup trigger fails for Gmail/non-.edu).

### 🏠 LANDING PAGE & PAGES
- 📝 NESTREL LANDING PAGE REBUILD — three audiences
     (students/schools/orgs), Nestrel lead brand, CaldwellNest as flagship proof.
- 📝 PER-SCHOOL BRAND FOR STUDENTS — Caldwell students see
     "CaldwellNest" throughout; "Nestrel" only on landing/partner pages.
- ⬜ ABOUT / MISSION / CONTACT / TERMS / PRIVACY pages — placeholder for beta.

### ✨ UI POLISH (student experience)
- 📝 EMOJI REMOVAL — replace emoji-as-UI-labels with typography /
     subtle icons / category color dots. Keep emoji only where decorative.
- 📝 ENTER KEY SUBMITS — login, signup, and other actions via Enter.

### 🗂️ CODE ORGANIZATION
- ✅ EXTRACT CSS into styles.css — safe pre-beta refactor. Done 2026-07-03
     (commit `6e3fefd`), pure move, verified identical. JS extraction deferred post-beta.

### 🔁 LISTING LIFECYCLE (student-facing)
- 📝 MARK AS SOLD / FILLED — soft-hide (stays in DB + logged), un-hide.
- 📝 LAST DAY / EXPIRATION — optional soft deadline; auto-hide +
     "still available?" prompt.
- 📝 SAVE DRAFT + PREVIEW — drafts in Supabase; 30-day auto-cleanup.

### 🔮 DEFERRED / FUTURE (documented, not for beta)
- ⬜ Admin reading private messages — needs ToS disclosure + scoped access + audit log
     + NJ wiretap law research. Deferred.
- ⬜ Multi-admin permissions system + school-admin management dashboard.
- ⬜ Sex/gender preference on housing — PARKED until Fair Housing legal review.
- ⬜ Featured posts redesign (premium UI treatment).
- ⬜ Reports system with clickable cross-linking.
- ⬜ Student history dashboard (appeals column, side expansion, grid/list toggle).
- ⬜ Branches / worktrees / PRs workflow — deferred until basics solid.
- ⬜ Rides board (Nestrel feature) — see rideshare second-project entry.
