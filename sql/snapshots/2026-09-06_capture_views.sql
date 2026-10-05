-- Capture the views in public — starting with visible_listings
-- 2026-09-06
--
-- READ ONLY. Every statement here is a SELECT against Postgres's own catalog. It creates
-- nothing, changes nothing, drops nothing. Safe on the live database, re-runnable.
--
-- No `NOTIFY pgrst, 'reload schema';` at the end: this file changes no schema, so there is
-- nothing to reload.
--
-- WHY THIS EXISTS
-- This is session E0 of docs/nestrel-events-door-feedback-plan.md — the capture that has to
-- happen before the events schema is built on top of it.
--
-- E0 was planned as three captures. Two were already done and the plan did not know:
--   * is_super_admin()  — captured 2026-09-04 in 2026-09-04_capture_permission_functions.sql
--   * user_roles        — captured 2026-09-04 in 2026-09-04_capture_table_definitions.sql
--                         (columns at line 379, all four constraints at 576-580)
-- So only the view is genuinely missing, and sql/README.md has never listed views at all.
--
-- THE QUESTION THIS FILE ANSWERS, AND WHY IT IS NOT RHETORICAL
-- `visible_listings` is referenced in the codebase exactly twice, and both are COMMENTS:
--
--     js/data.js:40     "Canonical visibility rule (mirrors the `visible_listings` SQL view)"
--     js/profile.js:151 "...the audit flagged between isListingLive() and the
--                        visible_listings view."
--
-- No query anywhere selects from it. The marketplace's real visibility rule is
-- isListingLive() — a JavaScript function, running in the browser, over already-fetched rows.
--
-- That leaves three possibilities and they are not equally good:
--   A. The view exists and nothing uses it.  → dead code, and the comments are describing an
--      intention as though it were a mechanism.
--   B. The view never existed.               → the comments are describing something that was
--      planned and never built. `visible_events` has no model to copy.
--   C. The view exists AND disagrees with isListingLive().  → the worst case: two visibility
--      rules, one in SQL and one in JavaScript, silently diverged.
--
-- This matters beyond tidiness. §4.2 of the events plan says "Members-only events must be
-- filtered by RLS, not by a JavaScript .filter(). A filter in JavaScript is not a permission."
-- The marketplace is currently doing the thing that sentence forbids. Whichever answer comes
-- back, `visible_events` gets built as a real view that the app actually SELECTS FROM — the
-- point of a view is that the browser cannot skip it, and a rule enforced only in the browser
-- is not enforced.
--
-- HOW TO RUN
-- Supabase Dashboard -> SQL Editor. Run ONE numbered query at a time and paste each result
-- back. The editor only shows the result of the LAST statement when several run at once,
-- which is why these are numbered rather than one script.


-- ############################################################################
-- QUERY 1 — every view in public, with its full definition
-- ############################################################################
-- Expect at least public_profiles and the org public views, which have their own files.
-- The row that matters is whether `visible_listings` is in this list at all.

select table_name,
       pg_get_viewdef(('public.' || table_name)::regclass, true) as definition
from information_schema.views
where table_schema = 'public'
order by table_name;


-- ############################################################################
-- QUERY 2 — who is allowed to read them
-- ############################################################################
-- A view with no grant to `authenticated` is unreadable by the app regardless of what it
-- contains. This is also the check from 2026-09-03_capture_rls_and_grants.sql, narrowed to
-- views: anon should hold nothing, and authenticated should hold SELECT and nothing else.

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in (select table_name
                     from information_schema.views
                     where table_schema = 'public')
order by table_name, grantee, privilege_type;


-- ############################################################################
-- PART 2 — the captured definitions
-- ############################################################################
-- Captured 2026-09-06 from QUERY 1 against the live database. Emitted by
-- pg_get_viewdef() and pasted back, not retyped.
--
-- Five views in public. Three have their own creation files already
-- (org_directory and org_public_officers in 2026-09-06_org_public_views.sql,
-- public_profiles in 2026-09-04_public_profiles_view.sql). The two visibility
-- views below had never been written down anywhere.
--
-- THE ANSWER TO THE QUESTION AT THE TOP: outcome A, then a surprise.
-- visible_listings EXISTS and its rule is correct. Nothing selects from it.
-- See the note under visible_book_listings for the part that is not fine.


-- ---------- visible_listings ----------
create or replace view public.visible_listings as
  select l.id, l.created_at, l.title, l.price, l.location, l.description, l.tags,
         l.poster_name, l.poster_initials, l.poster_email, l.poster_color, l.emoji,
         l.status, l.pinned, l.rejection_reason, l.category, l.details, l.photos,
         l.poster_id, l.school, l.photo_urls, l.lifecycle_status, l.expires_at,
         l.status_changed_at, l.sold_via_platform, l.view_count, l.renew_count
  from listings l
    join profiles p on p.id = l.poster_id
  where l.status = 'approved'::text
    and (l.lifecycle_status = any (array['active'::text, 'pending_sale'::text]))
    and (l.expires_at is null or l.expires_at > now())
    and p.status <> 'suspended'::text;

-- Four conditions. isListingLive() in js/data.js:44 implements the first three and
-- NOT the fourth. That is not a drift: the suspended check is done separately, in
-- loadListings() at js/data.js:89-95 and 147, which fetches the suspended ids and
-- filters the rows before they reach DB.listings. It even falls back to the last
-- known suspended set on a transient failure rather than an empty one, so a failed
-- lookup cannot un-hide a suspended poster for a refresh cycle. The rule is split
-- across two places in JavaScript but it is complete, and listings are correct.


-- ---------- visible_book_listings ----------
create or replace view public.visible_book_listings as
  select b.id, b.book_type, b.course_code, b.genre, b.title, b.author, b.isbn,
         b.edition, b.price, b.condition, b.description, b.photo_urls, b.poster_id,
         b.status, b.approved, b.created_at, b.sold_at, b.lifecycle_status,
         b.expires_at, b.status_changed_at
  from book_listings b
    join profiles p on p.id = b.poster_id
  where b.status = 'approved'::text
    and b.lifecycle_status = 'active'::text
    and (b.expires_at is null or b.expires_at > now())
    and p.status <> 'suspended'::text;

-- ############################################################################
-- FINDING — books have no suspended-poster filter anywhere
-- ############################################################################
-- The same fourth condition sits in this view, and on the books path there is no
-- second place implementing it. Following the code:
--
--   js/books.js:40-43   loadBooks() selects from book_listings directly, filtering
--                       status='approved' and lifecycle_status in (active,
--                       pending_sale). No poster status anywhere.
--   js/books.js:48-49   it does fetch public_profiles for the posters — but selects
--                       id, display_name, first_name, last_name, initials, color,
--                       avatar_url, school, year, major, created_at. NOT status.
--                       So the data needed to filter is not even in hand.
--   js/data.js:83-85    browseItems() = DB.listings (already suspended-filtered at
--                       load) + _books (never filtered).
--
-- So suspending a student hides their listings from the feed and leaves their books
-- in it. The moderation action half-works, and the half that fails is silent.
--
-- Two smaller differences on the same path, both harmless today:
--   * the view allows lifecycle_status = 'active' only, while loadBooks() also
--     fetches 'pending_sale' — deliberate, and js/books.js:34-39 explains why.
--     The view is the stricter one and would hide pending-sale books.
--   * expires_at is not checked in the query, but isListingLive() does check it
--     once books are shaped into browseItems(), so that one is covered.
--
-- NOT FIXED HERE. This file is a capture and captures change nothing. Logged to
-- docs/ROADMAP.md instead. The existing ROADMAP entry says these views have no
-- SELECT grant and that isListingLive() is a hand-copy that "has already drifted
-- once" — true, and this is the drift that has a live consequence.
--
-- ############################################################################
-- WHAT THIS CHANGES FOR THE EVENTS BUILD (E1)
-- ############################################################################
-- §2 of docs/nestrel-events-door-feedback-plan.md grants SELECT on visible_events
-- and says nothing about security_invoker. That is not enough, and the ROADMAP
-- already knew why: "a view runs with its owner's permissions by default, so it
-- needs security_invoker thought through rather than a quick GRANT."
--
-- A plain view is SECURITY DEFINER in effect — it runs as its owner and RLS on the
-- underlying table does not apply to the caller. So visible_events as currently
-- written in the plan would hand every student every published event regardless of
-- the policies above events. For a public-only V1 that is nearly the intended
-- answer, which is exactly what makes it dangerous: it would look correct, and then
-- silently expose every row the day members_only gating is added.
--
-- E1 must create it as:
--     create or replace view public.visible_events with (security_invoker = true) as ...
-- and the verification file must assert that a student who cannot SELECT an events
-- row directly also cannot see it through the view. Added to the E1 assertion list.
