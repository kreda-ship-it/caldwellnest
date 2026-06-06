# CaldwellNest — Product Roadmap

*A living document. Update it as the project grows. Work in TIER order — each tier
mostly depends on the one above it. Check items off as they're done.*

Last updated: 2026-06-06

---

## How to read this
- ✅ = done   🔄 = in progress   ⬜ = not started
- Work top-down. The backend (Tier 1) is the foundation almost everything needs.
- "Supabase rule": from now on, any data change is made in Supabase via the SQL
  Editor (Kal runs the SQL herself) to keep frontend and database consistent.

---

## ✅ ALREADY DONE (today, 2026-05-29)
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

---

## TIER 1 — Foundation (backend) — MOSTLY DONE, a few pieces left
- ✅ Backend + database (Supabase) connected
- 🔄 **Real accounts & secure login** — admin login and student sign-up now use
      real Supabase Auth. Student login (doLogin) + session restore on page load
      still needed to complete this item.
- ⬜ **Move NestBot AI server-side** — so the AI bot works on the live site
      without exposing an API key in the browser. Needs a small backend function.

---

## TIER 2 — Photos, Messaging & core features (the big build-out)

### ⬜ PHOTOS / IMAGE UPLOADS  (NEW — detailed)
The first genuinely new technical piece. Text saves differently from files.
- ⬜ Set up a Supabase **Storage bucket** for listing images
- ⬜ Add image upload to the post-a-listing form (choose/preview before submit)
- ⬜ Save the uploaded image's URL on the listing row in Supabase
- ⬜ Show images on listing cards + detail view
- ⬜ Handle: multiple photos per listing (5–10 is typical for housing),
      file size limits, allowed file types, a fallback image if none uploaded
- ⬜ Decide: which categories need photos (housing/clothing yes; event poster yes)
- ⬜ Later: image compression so the page stays fast

### 🔄 MESSAGING  (core feature — build in stages)
The core of why CaldwellNest exists (replaces the overflowing group chats).

**Foundation — done ✅**
- ✅ **Stage 1 — Save & show:** messages table in Supabase; send saves; open loads
- ✅ **Stage 2 — Linked conversations:** sender/receiver/listing_id, conversation_key,
      poster_id backfilled. Right people see the right thread.
- ✅ **Stage 3 — Feels live:** Supabase Realtime subscription per conversation;
      new messages appear without refresh; dedup so sent messages don't appear twice;
      channel cleaned up on convo switch / logout
- ✅ **Unread badge:** Messages nav button shows a count when new messages arrive
      while you're on another page; clears when you open Messages
- ✅ **Listing context dividers:** pill-style "about: [listing]" divider inserted
      when listing_id changes in a thread; "general conversation" divider if context
      drops to null; listing titles fetched from Supabase

**In progress / next up**
- ⬜ **Filter messages by listing** — inside a conversation, let either person
      filter to see only messages about a specific listing (dropdown or chips above
      the thread showing each listing the convo has touched)
- ⬜ **Listing chip in the input bar** — small pill in the bottom-left of the input
      area showing which listing the NEXT message is tagged to; tap to clear or
      switch listing (so the listing context isn't just inherited from the opener)
- ⬜ **Typing indicator** — "Jordan is typing…" using Supabase Presence (a separate
      Realtime channel dedicated to ephemeral state, not stored in the DB)
- ⬜ **"Active now" / last seen** — show whether the other person is currently
      online in the chat header (also Supabase Presence)

**Later polish**
- ⬜ **Reply-to / quote** — tap a bubble to quote it; message stores a reply_to_id
      (UUID FK to messages); UI shows a quoted excerpt above the bubble
      (needs a new column in the messages table: reply_to_id uuid nullable)
- ⬜ **"Official" badge on CaldwellNest messages** — purple ✓ badge so students
      can't confuse the official account with a regular student
- ⬜ **Message timestamps** — show date dividers ("Today", "Yesterday", "Jun 4") and
      per-message timestamps on hover/tap
- ⬜ **Blocking / reporting** — report a message or block a user; routes to admin queue
- ⬜ **Push / email notifications** — nudge when a new message arrives while offline

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
- ⬜ Super-admin who oversees everything
- ⬜ Org/club accounts that manage only their own profile + posts
- ⬜ Grant posting access to specific emails
- ⬜ Orgs get more flexibility (e.g. events, announcements, advertisements)

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
- ⬜ **Reporting & moderation** — let users flag bad listings/users
- ⬜ **Fair Housing review** — get real guidance (school legal/housing office)
      before relaunching anything sex/gender-preference related on roommate posts

---

## TIER 3 — Growth (after the core works)
- ⬜ Marketplace polish for used items
- ⬜ Free Stuff / giveaways flow
- ⬜ Events & announcements board for student organizations
- ⬜ Local business advertising partners (revenue)
- ⬜ Notifications (email and/or in-app)
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
- ⬜ **Main admin can GRANT authority from inside the admin portal** — a feature
      where the super-admin promotes a user (either an .edu student OR a non-.edu
      user) to an admin/role, and assigns what they're allowed to do.

---

## ADDED 2026-05-29 (evening) — Admin "view as student" dual access

- ✅ Admin stays logged in as themselves (same account/session) — this is a VIEW
      switch, not a logout/login. No need to sign in again to switch sides.
- ✅ In student view, admin sees a persistent "Back to admin portal" button.
- ✅ When admin acts in student view (posts a listing, sends a message), they
      appear as "CaldwellNest" — an official brand identity, not their personal
      name. Implemented as a special in-memory identity with isAdminAccount flag.
- ✅ Switching views never accidentally drops admin privileges or locks out of
      the admin portal.
- ⬜ "Official" badge on CaldwellNest posts/messages — so students can't confuse
      the official account with a regular student. Polish item, not yet built.

---

## ADDED 2026-05-29 (evening, session 2) — Auth progress

### ✅ Done (as of 2026-06-05)
- ✅ Super-admin login working (redakalkidan@gmail.com via Supabase Auth)
- ✅ Admin "view as student" without a second login — CaldwellNest identity,
      Back to Admin button always visible, admin session protected
- ✅ Official "CaldwellNest" identity in student view (isAdminAccount flag,
      purple CN avatar). Badge on posts is a future polish item.
- ✅ Student sign-up working (only @caldwell.edu emails, Supabase Auth)
- ✅ Role-ready RBAC structure confirmed (admin_roles + user_roles tables,
      roles stored as data in Supabase — not a hardcoded admin flag)
- ✅ Admin students list reads from Supabase profiles (real signups appear)

### ✅ Auth now complete (as of 2026-06-06)
- ✅ **Student login** — doLogin() calls Supabase Auth + fetches real profile
- ✅ **Session restore on page load** — getSession() + user_roles check routes
      admin vs student correctly; no "Kal Reda" bleed-through after refresh
- ✅ **Logout** — sLogout() calls supabaseClient.auth.signOut(); session fully cleared
- ⬜ **Future:** main admin can promote any user to an admin role and assign
      permissions, from inside the admin portal.

---

## CURRENT BUILD ORDER (updated 2026-06-06)
1. ✅ Super-admin login
2. ✅ Admin view-as-student without second login
3. ✅ Official "CaldwellNest" identity (editable from admin Settings)
4. ✅ Student sign-up (.edu only, real Supabase Auth)
5. ✅ Student login + session restore (admin vs student routed correctly)
6. ✅ Messaging foundation (save, load, linked threads, Realtime, unread badge,
      listing context dividers)
7. 🔄 **Messaging polish** ← IN PROGRESS
      - ⬜ Filter by listing
      - ⬜ Listing chip in input bar
      - ⬜ Typing indicator (Supabase Presence)
      - ⬜ Active now / last seen
      - ⬜ Reply-to / quote
8. ⬜ Photos (Supabase Storage)
9. ⬜ Testing pass + polish + About/Contact pages
