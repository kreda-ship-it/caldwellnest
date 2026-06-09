# CaldwellNest — Product Roadmap

*A living document. Update it as the project grows. Work in TIER order — each tier
mostly depends on the one above it. Check items off as they're done.*

Last updated: 2026-06-09

---

## How to read this
- ✅ = done   🔄 = in progress   ⬜ = not started
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
      purple CN avatar). Badge on posts is a future polish item.
- ✅ Student sign-up working (only @caldwell.edu emails, Supabase Auth)
- ✅ Student login — doLogin() calls Supabase Auth + fetches real profile
- ✅ Session restore on page load — getSession() + user_roles check routes
      admin vs student correctly; no stale profile bleed-through after refresh
- ✅ Logout — sLogout() calls supabaseClient.auth.signOut(); session fully cleared
- ✅ Role-ready RBAC structure: admin_roles + user_roles tables in Supabase.
      Roles are stored as data, not a hardcoded flag.
- ✅ Admin students list reads from real Supabase profiles

### Messaging
- ✅ Stage 1 — Save & show: messages table in Supabase; send saves; open loads
- ✅ Stage 2 — Linked conversations: sender/receiver/listing_id, conversation_key,
      poster_id backfilled. Right people see the right thread.
- ✅ Stage 3 — Feels live: Supabase Realtime subscription per conversation;
      new messages appear without refresh; dedup so sent messages don't appear twice;
      channel cleaned up on convo switch / logout
- ✅ Unread badge: Messages nav button shows a count when new messages arrive
      while you're on another page; clears when you open Messages
- ✅ Listing context dividers: pill-style "about: [listing]" divider inserted
      when listing_id changes in a thread; "general conversation" divider if context
      drops to null; listing titles fetched from Supabase

### Moderation system
A complete trust-and-safety layer. Built alongside core features, not as a
separate phase. Each piece here protects students and gives admin real control.

**Student reports ✅**
- ✅ Report button on every listing card (hidden from the poster, from admin, and
      from listings the viewer already reported)
- ✅ Report modal: category dropdown + free-text details → saves to `reports` table
- ✅ Admin reports review page: reads live from Supabase; action buttons: Dismiss,
      Remove Listing, Suspend Poster; clickable listing title opens a preview modal
- ✅ Reopen button on resolved/dismissed reports — admin can reverse their decision
- ✅ Reports badge on admin sidebar: live count of open reports
- ✅ `listing_title_snapshot` column on reports — preserves the listing title even
      after the listing is later removed, so the record stays readable
- ✅ `reports.listing_id` FK changed from ON DELETE CASCADE to ON DELETE SET NULL —
      reports survive listing deletion instead of being silently wiped

**Listings: soft delete + restore ✅**
- ✅ `aRemoveListing()` now sets `status='removed'` instead of hard DELETE —
      listing data is preserved for audit trail and possible restore
- ✅ `aRestoreListing()` — admin can relist a removed listing, setting it back to
      'approved' so it reappears in the student feed
- ✅ Removed listings section in admin portal — separate card below the main
      listings table, showing title, poster, removal date, and a green Restore button
- ✅ Active/pending/rejected listings stay in the main table;
      removed listings are separated and hidden from students automatically

**Suspensions ✅**
- ✅ `status` column on profiles (active / suspended)
- ✅ `suspension_reason` column on profiles — admin writes a reason when suspending
- ✅ Session restore checks suspension status on page load — suspended students
      are signed out and redirected to the suspension screen immediately
- ✅ Full-screen suspension overlay shows the reason the admin entered
- ✅ Admin Students table has a Reason column showing suspension reason
- ✅ Admin can reinstate from the Students list or from the Appeals page
- ✅ `suspension_history` table created in Supabase (for timeline audit trail)
- ⬜ Wire `confirmSuspend()` and `aReinstate()` to INSERT rows into
      `suspension_history` — the table exists; the code isn't updated yet

**Appeals ✅**
- ✅ Appeal form on the suspension screen: student writes their case and submits
- ✅ Saves to `appeals` table with profile_id, email, message, status='open'
- ✅ Admin appeals review page: lists open appeals; Reinstate or Deny buttons
- ✅ Appeals badge on admin sidebar: live count of open appeals
- ✅ Reinstating from the appeals page also marks the appeal as resolved_reinstated

---

## TIER 1 — Foundation (backend) — MOSTLY DONE

- ✅ Backend + database (Supabase) connected
- ✅ Real accounts & secure login — admin + student auth fully working via Supabase
- ⬜ **Move NestBot AI server-side** — so the AI bot works on the live site
      without exposing an API key in the browser. Needs a small backend function
      (Supabase Edge Function or similar).

---

## TIER 2 — Photos, Messaging & core features (the big build-out)

### ⬜ PHOTOS / IMAGE UPLOADS
The first genuinely new technical piece. Text saves differently from files.
- ⬜ Set up a Supabase **Storage bucket** for listing images
- ⬜ Add image upload to the post-a-listing form (choose/preview before submit)
- ⬜ Save the uploaded image's URL on the listing row in Supabase
- ⬜ Show images on listing cards + detail view
- ⬜ Handle: multiple photos per listing (5–10 is typical for housing),
      file size limits, allowed file types, a fallback image if none uploaded
- ⬜ Decide: which categories need photos (housing/clothing yes; event poster yes)
- ⬜ Later: image compression so the page stays fast

### 🔄 MESSAGING — polish (foundation complete, extras next)

**In progress / next up**
- ⬜ Filter messages by listing — inside a conversation, let either person
      filter to see only messages about a specific listing (dropdown or chips above
      the thread showing each listing the convo has touched)
- ⬜ Listing chip in the input bar — small pill in the bottom-left showing which
      listing the NEXT message is tagged to; tap to clear or switch listing
- ⬜ Typing indicator — "Jordan is typing…" using Supabase Presence (ephemeral
      real-time state, not stored in the DB)
- ⬜ Active now / last seen — show whether the other person is currently online

**Later polish**
- ⬜ Reply-to / quote — tap a bubble to quote it; needs `reply_to_id uuid` column
      on the messages table
- ⬜ "Official" badge on CaldwellNest messages — purple ✓ so students can't
      confuse the official account with a regular student
- ⬜ Message timestamps — date dividers ("Today", "Yesterday", "Jun 4") and
      per-message timestamps on hover/tap
- ⬜ Blocking / reporting — report a message or block a user; routes to admin queue
- ⬜ Push / email notifications — nudge when a new message arrives while offline

### ⬜ MOBILE + DESKTOP RESPONSIVE
- ⬜ Test and fix layout on phones (most students will use phones) and computers
- ⬜ Check the post form, filters, messaging, and admin panel all work on mobile

### ⬜ FILTERING & SORTING (expand what exists)
- ⬜ Filters: price range, distance from campus, # roommates, move-in date,
      lease length, furnished/unfurnished, private vs shared room, pet policy,
      condition (for items), size/brand (clothing), category
- ⬜ Sorting: newest, price low–high, closest to campus, best match to saved prefs
- ⬜ Saved favorites / watchlist (needs login to work per-user)

### ⬜ TIERED ADMIN ROLES & POSTING PERMISSIONS
- ⬜ Super-admin who oversees everything (RBAC tables already built; UI needed)
- ⬜ Multiple admins — main admin adds others with scoped permissions
- ⬜ Main admin can GRANT authority from inside the admin portal (promote any
      user, .edu or not, to an admin role and assign what they can do)
- ⬜ Org/club accounts that manage only their own profile + posts
- ⬜ Orgs get more flexibility (events, announcements, advertisements)

### ⬜ GOOGLE MAPS
- ⬜ Show listing locations on a map (add once listings + photos are solid)

---

## TIER 2.5 — Trust / professional pages (lighter wins, big credibility)
- ⬜ About Us — who we are, the CaldwellNest story (Kal writes the real story)
- ⬜ Mission & Vision — the problem solved and where it's going
- ⬜ Contact Us — start with a simple "email us" link; a real form needs backend
- ⬜ "Founded by Kalkidan Reda" credit (keep personal contact info minimal/safe)
- ⬜ FAQ / How it works
- ⬜ Links to Terms of Service + Privacy Policy

---

## TIER 2 (legal/safety) — Trust, safety & legal (before real students join)
- ⬜ **Terms of Service + Privacy Policy** — required (holds personal data).
      Claude can draft a starting version; NEEDS real review before launch.
- ⬜ **Security basics** — safe password storage (handled by Supabase Auth),
      HTTPS, protection against common attacks
- ⬜ **Password rules** — e.g. 8–12+ chars (the easy part of security)
- ⬜ **Login options** — password first; later device login (Face ID / passkeys)
- ⬜ **Fair Housing review** — get real guidance (school legal/housing office)
      before relaunching anything sex/gender-preference related on roommate posts

---

## TIER 3 — Growth (after the core works)
- ⬜ Marketplace polish for used items
- ⬜ Free Stuff / giveaways flow
- ⬜ Events & announcements board for student organizations
- ⬜ Local business advertising partners (revenue)
- ⬜ Notifications (email and/or in-app) — Supabase Edge Functions or third-party
- ⬜ Analytics — usage data to support the school-funding pitch
- ⬜ Possible future mobile app

---

## ⚠️ PARKED — needs outside guidance before building
- ⬜ **Roommate sex/gender preference** — removed for now. Fair Housing law treats
      "sex" as protected; shared-living arrangements may be treated differently,
      but it varies. Get guidance from the school's legal/housing office before
      rebuilding. Do NOT just re-add it.

---

## Known limitations to remember
- NestBot AI only works inside Claude's preview until moved server-side (Tier 1)
- Email confirmation is OFF for development — turn it back ON before real launch
- No automatic backups on Supabase free tier — don't store anything irreplaceable
- Free Supabase projects pause after ~1 week of inactivity (just un-pause them)
- Fake analytics numbers on admin dashboard — never show to school/partners as real;
  label as "sample" or hide entirely until real data exists

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

---

## ADDED 2026-05-29 (evening) — Multi-admin & granular roles

The auth/account system should be built with these future needs in mind, even
though we start with just one main admin:

- ✅ **Main / super-admin** = redakalkidan@gmail.com (a Gmail, NOT .edu — admin is
      a separate path from student sign-up; never blocked by the .edu rule).
- ⬜ **Multiple admins later** — the main admin will add more admins, each in
      charge of SPECIFIC features/areas (not all admins get full power).
- ✅ **Granular permissions / roles** — RBAC structure built: admin_roles and
      user_roles tables in Supabase. Roles are data, not code. UI for managing
      roles from the admin portal still needed.
- ⬜ **Main admin can GRANT authority from inside the admin portal** — promote any
      user (.edu or not) to an admin role and assign what they can do.

DESIGN IMPLICATION for the auth build:
- Don't hardcode a single boolean admin flag. Use a structure that can hold a
  ROLE and/or a set of permissions per user (so adding roles later is easy).
- Keep "who is an admin and what can they do" as data in Supabase (a roles/
  permissions table), editable later — not buried in code.
- Admin designation must work regardless of email domain (.edu or not).

---

## ADDED 2026-05-29 (evening) — Admin "view as student" dual access ✅ DONE

- ✅ Admin stays logged in as themselves (same account/session) — VIEW switch, not logout/login
- ✅ In student view, admin sees a persistent "Back to admin portal" button
- ✅ When admin acts in student view, they appear as the official "CaldwellNest" identity
- ✅ Switching views never accidentally drops admin privileges or locks out
- ⬜ "Official" badge on CaldwellNest posts/messages — so students can't confuse
      the official account with a regular student. Polish item, not yet built.

---

## ADDED 2026-06-09 — Student history dashboard (planned, not built yet)

A per-student drilldown panel inside the admin portal. Replaces the current
pop-up modal with a full panel view. Design finalized; build comes next.

- ⬜ `aOpenStudentHistory(profileId)` — function that switches to the student
      detail panel and loads their data from Supabase
- ⬜ `#asec-student-history` panel layout:
      - Header: name, email, account status, join date
      - 4 stat cards: listings posted, reports they filed, reports against them,
        times suspended
      - Suspension history timeline (reads from `suspension_history` table)
      - "Reports filed by them" list
      - "Reports filed against them" list
- ⬜ Back button with `_historyReturnSection` — returns admin to the exact section
      they came from (reports, students, listings, etc.)
- ⬜ Graceful "Account no longer exists" state if profile was deleted

**Clickable student names throughout admin (depends on dashboard existing first)**
While reviewing a report, click any name to instantly open that student's full
history — check if the reporter abuses the report system, or if the reported
student is a repeat offender.
- ⬜ Reports view: "Reported by" name → reporter's dashboard; listing owner → theirs
- ⬜ Listings table: poster name → their dashboard
- ⬜ Students table: student name → their dashboard (replaces current modal pop-up)
- ⬜ Appeals section: student name → their dashboard
- ⬜ `.stu-link` CSS class — one definition, used everywhere clickable names appear
- ⬜ Guard: skip the link (or show "(You)") when the profile ID matches the admin's
- ⬜ Pre-check: verify `reporter_id` column exists on `reports` table before wiring

---

## DATA AUDIT (updated 2026-06-09) — what's real vs. fake/in-memory

### What's genuinely real and working ✅
- Auth: student login, admin login, session restore, logout
- `profiles` table — student signup and profile data (with status, suspension_reason)
- `listings` table — post, approve, reject, pin, soft-delete/restore, edit (all Supabase)
- `messages` table — student-to-student messaging + Realtime
- `user_roles` / `admin_roles` tables — admin RBAC structure
- `reports` table — student reports, admin review, soft actions, reopen
- `appeals` table — student appeals, admin reinstate/deny
- `suspension_history` table — exists in Supabase; not yet wired to code

### Three buckets of remaining work
1. BROKEN features that already have a Supabase table (just wired to fake data) —
   these are FIXES, not new builds. Cheapest wins.
2. Real features MISSING a table or column — need new Supabase SQL.
3. Cosmetic fake numbers (analytics charts, health monitor) — can wait.
   ⚠️ NEVER show these to the school or partners as if real.

### Conversion order

**DATA TIER 1 — Fix broken features that already have Supabase tables**
- ⬜ `DB.convos` → replace admin Messages view (`renderAMessages`) with a real
     query on the `messages` table. Admin currently sees FAKE conversations.
     No new table needed — just a rewritten query.
- ⬜ Wire `confirmSuspend()` + `aReinstate()` → INSERT rows into `suspension_history`
     (table already created in SQL; code not updated yet)

**DATA TIER 2 — Safety features needing new tables / columns**
- ⬜ `PENDING_VERIFY` → add `verification_status` column to `profiles` so the
     student verification queue is real and persists across refreshes
- ⬜ Verify `reporter_id` column exists on `reports` table — needed before the
     clickable-names feature can link to a reporter's student history dashboard

**DATA TIER 3 — Admin operations that should persist across refreshes**
- ⬜ `DB.log` → create an `activity_log` table. Every admin action already works
     in Supabase but the audit log is completely lost on every page refresh.
- ⬜ `DB.settings` → create a `platform_settings` table. IMPORTANT: the
     `requireApproval` and `eduOnly` toggles affect real security behavior.
     A toggle that silently resets on refresh is a liability.
- ⬜ `BCAST_HIST` → create a `broadcasts` table. Sent broadcasts are currently
     forgotten the moment the page reloads.

**DATA TIER 4 — Content / cosmetic admins can customize**
- ⬜ `DB.content` → create a `site_config` table (hero headline, subtext, CTA
     button label, listings page title, banner message)
- ⬜ Site editor color changes → also save to `site_config`. Currently the colors
     admin sets via the editor vanish completely on refresh.

**DATA TIER 5 — Analytics & health (real data eventually, NOT urgent)**
- ⬜ Replace hardcoded charts/stat cards with real Supabase queries (signups by
     day, students by major, avg rent, etc.) once real data volume exists
- ⬜ Health monitor → real uptime/latency data. Out of scope until there's a
     backend service layer.

### Fine to leave as-is (no action needed)
- `localStorage` UI preferences: `cn_msg_sidebar`, `cn_admin_sidebar` — correct to keep local
- `BCAST_TEMPLATES`, `SYS_COMPONENTS`, `SYS_EVENTS` — intentional static content
- Placeholder HTML text ("Jane Doe", "JD", etc.) — overwritten by JS at runtime
- Admin sidebar footer shows "AD"/"Admin" — minor cosmetic; fix whenever

---

## ARCHITECTURE DECISION — Multi-school = ONE platform, NOT copies

DECISION: When expanding to other schools, build ONE multi-tenant platform (one
codebase, one database) where every user and listing is tagged with a SCHOOL.
Do NOT copy-paste the code per school. (Like Canvas: one system, each school sees
their own space.)

WHY:
- Copy-paste = maintaining N codebases; every bug/feature repeated N times.
- "Show nearby schools' listings" is IMPOSSIBLE with separate silos, but TRIVIAL
  with a school tag (just filter: school = mine, or school IN nearby list).

DO NOW (cheap future-proofing — not full multi-school yet):
- ⬜ Add a `school` field to profiles and listings (default 'Caldwell')
- ⬜ Keep building Caldwell features as normal — the school tag is the hook that
     makes expansion easy later

DO LATER (when actually expanding):
- ⬜ A `schools` table (name, domain like @caldwell.edu, location for "nearby")
- ⬜ Student preference: see only my school, or include nearby schools
- ⬜ Per-school admins (ties into the multi-admin/roles plan)
- ⬜ Email-domain → school mapping for sign-up (@caldwell.edu → Caldwell, etc.)

PRINCIPLE: design for multi-school, build for Caldwell.

---

## ADDED 2026-05-29 — Per-school admin management (extends multi-school + multi-admin)

When multi-school launches, admin roles must be SCHOOL-SCOPED:
- ⬜ Each school has its own admin(s) who manage ONLY their school's data
      (their students, listings, reports, etc.) — cannot touch other schools
- ⬜ A top-level super-admin (Kal / CaldwellNest) oversees ALL schools
- ⬜ Combines with multi-admin/roles plan: permissions = (a) what + (b) which school

ACTION TO TAKE NOW (cheap setup, full platform later):
- ⬜ Create a `schools` table in Supabase with Caldwell as the first row
- ⬜ Add `school_id` to profiles, listings, and other core tables, defaulting
     every existing record to Caldwell so all current data is correctly tagged

---

## ADDED 2026-05-29 — Student profile design

Design the full profile field set NOW so the dashboard and signup/login use it
consistently. Build gradually — keep required signup fields MINIMAL (quick signup),
let students fill in the rest later via profile editing.

PROPOSED PROFILE FIELDS:
- Identity: username/handle (unique, chosen, like Instagram), display name,
  profile picture, short bio (~150 chars)
- Academic: major, year (freshman/sophomore/junior/senior/grad), school
  (ties into multi-school school_id)
- Trust: .edu verified badge (have it), join date, (future) reputation signals
  like listings-posted count
- Preferences (plan for, don't fully build yet): notification settings,
  which schools' listings to see (my school / include nearby)

KEY CONSIDERATIONS:
- ⬜ Username uniqueness — no duplicate handles; decide rules (length, allowed
     characters, whether it can be changed later). Real sub-feature, do it right.
- ⬜ Profile pictures need Supabase Storage (same as listing photos — on roadmap).
     Plan the field now; add real uploads when Storage is built.
- ⬜ Privacy (FERPA-adjacent — holds student data): decide what's PUBLIC vs
     admin-only. Flag for the real legal/privacy review before launch.
- ⬜ Accessibility: support alt text on profile/listing images (ADA).
- ⬜ Required vs optional at signup: keep required minimal so signup stays quick.

BUILD ORDER: add core profile columns → username + basic profile working →
bio/photo/preferences later → connect to the student history dashboard.

---

## CURRENT BUILD ORDER (updated 2026-06-09)
1. ✅ Super-admin login
2. ✅ Admin view-as-student without second login
3. ✅ Official "CaldwellNest" identity
4. ✅ Student sign-up (.edu only, real Supabase Auth)
5. ✅ Student login + session restore (admin vs student routed correctly)
6. ✅ Messaging foundation (save, load, linked threads, Realtime, unread badge,
      listing context dividers)
7. ✅ Moderation system — reports, appeals, suspensions, soft-delete + restore listings
8. 🔄 **Moderation polish** ← IN PROGRESS
      - ✅ Removed listings section in admin portal with Restore button
      - ⬜ Wire suspension_history INSERT into confirmSuspend() + aReinstate()
      - ⬜ Student history dashboard (aOpenStudentHistory panel)
      - ⬜ Clickable student names throughout admin moderation views
9. ⬜ **Messaging polish**
      - ⬜ Filter by listing / listing chip in input bar
      - ⬜ Typing indicator (Supabase Presence)
      - ⬜ Active now / last seen
      - ⬜ Reply-to / quote
10. ⬜ **Backend data fixes** (Data Audit above — do in tier order)
      - ⬜ DATA TIER 1: Admin messages view (real) + wire suspension_history
      - ⬜ DATA TIER 2: verification_status column + reporter_id check
      - ⬜ DATA TIER 3: activity_log, platform_settings, broadcasts tables
      - ⬜ DATA TIER 4: site_config table (content + colors)
      - ⬜ DATA TIER 5: Real analytics queries (do when real data volume exists)
11. ⬜ Photos (Supabase Storage)
12. ⬜ Testing pass + polish + About/Contact pages
