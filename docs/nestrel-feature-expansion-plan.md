# Nestrel feature expansion plan

Covers: search tab redesign, listing lifecycle (deadlines + status), the events platform, and organization profiles. Companion to `docs/nestrel-responsive-ui-plan.md` (the responsive overhaul). Save this file as `docs/nestrel-feature-expansion-plan.md`.

---

## 0. Priority framing (soft beta: Aug 2, real beta: Aug 25–30)

Beta scope (recommended): mobile messages fix → finish responsive overhaul → listing status/deadlines + activity logging → Events Phase E1 → search redesign if time remains.
Post-beta: Events E2 (public share pages), Events E3 (organization profiles). E3 is effectively a product of its own — application flow, multi-manager roles, analytics, forms. Building it before beta would put the beta date at risk; validating events demand during beta will also tell us what org profiles actually need.

---

## 1. Search tab redesign

Problem: the Search tab currently looks like the Home page. It should be intent-driven, not browse-driven — the pattern used by Pinterest, Airbnb, and Depop.

Recommended design:
- Entry state (no query yet): search bar auto-focused with keyboard up; below it, recent searches (tap to rerun, x to remove) and a grid of category quick-select tiles (Marketplace, Free, Housing, Books, Events).
- Results state: results list/grid with a compact toolbar above it — result count, a sort control (newest, price low→high, price high→low, soonest deadline), and a Filters button with an active-filter count badge.
- Filters open as a bottom sheet (mobile) / panel (desktop). Filters are category-aware:
  - All: category, price range, posted-within.
  - Housing: rent range, move-in date, lease length.
  - Books: course code (reuse the typeahead component), condition, price range.
  - Events: date range, free/paid, organization.
- Home keeps only the light category chips it has now; ALL detailed filtering lives in Search. One place to filter = simpler mental model and simpler code.
- Applied filters show as removable chips above results.

Verdict on "detailed filtering in search vs elsewhere": detailed filtering belongs in the Search tab. Home is for discovery; Search is for finding.

---

## 2. Listing lifecycle: deadlines, status updates, and logging

Every posting (marketplace, free, housing, books, events) gets a lifecycle so stale listings stop polluting the feed.

Data model (Supabase `listings`, and equivalent on `book_listings` / events):
- `status` text: 'active' | 'sold' (or 'claimed' for free items) | 'withdrawn' (change of mind) | 'expired'. Events additionally end as 'completed'.
- `expires_at` timestamp, optional: the poster can set a deadline at creation and edit it later. Housing/books lend themselves to semester deadlines; events auto-expire at event end time.
- All feed and search queries filter to status = 'active' AND (expires_at IS NULL OR expires_at > now()).

Student-facing flow:
- Profile → My listings: each listing row shows its current status badge.
- Tapping a listing opens a manage view: mark as sold/claimed, withdraw, edit details, extend or set the deadline, delete.
- Marking sold/withdrawn removes it from feeds immediately (soft state change, not deletion — history preserved).

Admin-side logging (ties to the "activity log as single source of truth" roadmap item):
- New `activity_log` table: id, actor_id, listing_id, action ('created', 'status_changed', 'edited', 'deleted'), old_value, new_value, created_at.
- Every status change writes a row. Admin portal gets a chronological activity view with filters by student, action, and date.
- Same table later absorbs suspension events — closing the suspension-hides-listings gap becomes: suspension writes a log row AND flips the student's listings out of 'active'.

---

## 3. Events platform

### Phase E1 — beta scope
Event creation (rich detail): title, description, cover image, location (text + optional map link), start/end date-time, capacity (optional), free/paid label, host name, contact/link field.
Student experience on the Events tab:
- Browse upcoming events (past events auto-drop via expires_at = end time).
- Event detail page: full details, attendee count, and two actions:
  - Reserve a spot: creates a row in a new `event_rsvps` table (event_id, student_id, created_at, unique together). Button flips to "Reserved ✓"; capacity enforced if set; show "X attending" and "Y spots left".
  - Add to calendar: no OAuth needed — generate a Google Calendar template URL (calendar.google.com/calendar/render?action=TEMPLATE&...) and a downloadable .ics file. The .ics covers Apple Calendar and Outlook. This satisfies "mark it on their Google or calendar app through their account" with zero account-linking complexity.
- Coordinator sees their attendee count (full attendee list = E3, org tooling).

### Phase E2 — public share pages (post-beta unless time allows)
- Each event gets a public URL that renders a professional-looking event page viewable WITHOUT login.
- Technical constraint to plan around: link previews on Instagram/WhatsApp read Open Graph meta tags at fetch time, and a single-page index.html serves the same tags for every URL. Options: (a) Supabase Edge Function that serves per-event OG tags then redirects into the app, (b) small static page generated per event, (c) a hosting-level rewrite. Decide when we get here; (a) is the likely fit with our stack.
- Coordinator toggles per event: public visibility on/off; whether non-Caldwell visitors can register. Registration options for outsiders: link to an external form (Google Forms URL field) now; a native Nestrel form-lite builder is a later enhancement, not beta or E2 scope.
- Non-signed-in visitors can view the public event page but are prompted to sign in for anything else.

### Phase E3 — organization profiles (post-beta, its own planning doc when we start)
- Application flow: on the login/signup page, "Apply for an organization profile" — org name, type (student org / school department), description, proof; admin approves in the portal.
- An approved org profile can be managed by the owner plus up to 4 additional member profiles (an `organization_members` table with roles: owner, manager).
- Org page: logo, description, its events (upcoming + past), follower option later.
- Analytics section: event page views, RSVP counts over time, share-link clicks.
- Activity log per org (posts, edits, member changes) mirrored to the admin portal.
- Integrations: Google Forms link per event first; native form builder as a later phase.
- Rough shape: this is 4–6 build sessions minimum plus schema design. Schedule after real beta opens and events demand is validated.

---

## 4. Supabase schema changes (cumulative)

Beta:
- listings / book_listings: add `status`, `expires_at`.
- events: add capacity, cover_url, location fields, host fields, `is_public` (default false, dormant until E2).
- new `event_rsvps` (event_id, student_id, created_at; unique pair).
- new `activity_log` (actor_id, listing_id, action, old_value, new_value, created_at).

Post-beta (E2/E3):
- events: external_registration_url, allow_external_registration.
- new `organizations`, `organization_members` (org_id, profile_id, role), `organization_applications`.

Rule from our workflow: every schema change is presented as SQL first, run manually in the Supabase dashboard, and confirmed before any app code assumes it.

---

## 5. Recommended build sequence

1. Mobile messages fix (immediate — separate prompt).
2. Finish remaining responsive overhaul sessions.
3. Listing status + deadlines + activity_log + admin activity view.
4. Events E1 (rich details, RSVP, add-to-calendar, auto-expire).
5. Search tab redesign.
6. — soft beta Aug 2 —
7. Events E2 public share pages.
8. Events E3 organization profiles (new planning doc first).

---

## 6. Merge prompt (paste into Claude Code in VS Code after adding this file to docs/)

I've added docs/nestrel-feature-expansion-plan.md. Read it fully, then read docs/nestrel-responsive-ui-plan.md. Compare the two and update the responsive UI plan so they're consistent: (1) insert the mobile messages fix as the immediate next session before any remaining overhaul sessions, (2) update the Search tab session to reference the search redesign in the expansion plan instead of duplicating it, (3) add a short "What comes after this overhaul" section pointing to the expansion plan's build sequence, and (4) flag any contradictions between the two docs for me instead of silently resolving them. Do not modify the expansion plan and do not touch any application code — docs only. Show me the proposed edits before writing them.
