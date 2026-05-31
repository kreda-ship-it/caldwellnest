# CaldwellNest — Product Roadmap

*A living document. Update it as the project grows. Work in TIER order — each tier
mostly depends on the one above it. Check items off as they're done.*

Last updated: 2026-05-31

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
- ⬜ **Real accounts & secure login** — right now sign-in isn't real auth yet.
      Use Supabase Auth so students truly log in, sessions persist, passwords are
      stored safely (hashed). .edu email verification enforced for real.
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

### ⬜ MESSAGING  (NEW — detailed, build in 3 stages)
The core of why CaldwellNest exists (replaces the overflowing group chats).
Build in stages — do NOT do all at once:
- ⬜ **Stage 1 — Save & show:** a messages table in Supabase; sending a message
      saves it; opening a conversation loads it. (Prove the loop, like listings.)
- ⬜ **Stage 2 — Link conversations:** make sure the right two people see the
      right thread (sender, receiver, which listing it's about). Trickiest logic.
- ⬜ **Stage 3 — Feels live:** new messages appear without refresh
      (Supabase Realtime). Advanced polish — save for last.
- ⬜ Extras to consider later: unread indicators, blocking/reporting a user,
      message timestamps, "message about this listing" button on a listing

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
- Sign-in isn't real authentication yet (Tier 1: Supabase Auth)
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
