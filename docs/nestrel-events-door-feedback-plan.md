# Nestrel events, the door, and feedback — design + build plan

Companion to `docs/nestrel-campus-engagement-plan.md` (§4 events data model, §6 check-in, §8
student UI). This document **extends** that one — it does not replace it. Where the two disagree,
this one is newer.

**Rev 2 — 2026-09-06.** Rev 1 was saved verbatim as received, with a corrections appendix on top.
Rev 2 folds those corrections into the body and reshapes the document around one decision Kal made
after reading it: **events is its own section of the app, precisely specified, not a category tab
on the marketplace.** What changed:

- §0 rewritten — the org directory shipped while rev 1 was being written, so rev 1's central
  scope recommendation was advice about a decision already made the other way.
- §1.0 added — events as a section, and what that costs.
- §2 SQL is now **runnable**: `school text` not `school_id uuid`, identity not `bigserial`, the two
  base tables created rather than altered, `user_id` nullable, revokes and `notify` present,
  `visible_events` written out.
- §4 promoted from a sketch to **the Events section spec**, with §4.0 enumerating every marketplace
  call site that has to move.
- §5.1 added — the hash router collides with Supabase auth tokens.
- `activity_log` / `entity_type` corrected to `logEvent()` / `admin_activity_log` / `target_type`
  everywhere.
- §9 open questions are now §9 decisions, answered.
- Sessions resequenced to E0 … E6, each with a **Done when** checklist.

Rev 1 is recoverable at commit `bf17325`.

---

## 0. Where this sits — checked against the code, 2026-09-06

**Built and live.** Organizations, memberships, `can_act()`, the flag guard, the admin
Organizations tab, the org console (announcements, polls, profile, roster). And — this landed
after rev 1 was written — a real student-facing **Clubs & organizations directory**:
`page-orgs` in `index.html:194`, `js/orgdir.js`, a desktop nav entry, search, type filters, and
**Follow already working** (`js/orgdir.js:190`).

`can_manage_events` and `can_check_in` are frozen into the flag set and reach nothing yet.

**Rev 1's scope recommendation is withdrawn.** It argued for a thin org page instead of a
browsable directory, on the reasoning that a directory of five clubs is a list. That argument lost
on the merits the day the directory shipped. What is actually missing is the other half:
**directory cards are not tappable — there is nowhere to land.** So events does not need a thin org
page invented for it; it needs the **org profile page** the directory is already waiting for, and
that page is where an event card's org row points.

**Events, meanwhile, is a section in costume.** This is the real gap and it is worth stating
exactly, because it is easy to look at the app and conclude events already exists:

- There is **no `page-events`**. The pages are home, orgs, listings, messages, profile,
  org-console, maintenance.
- The **mobile Events tab is a filter wearing a tab's clothes**. `index.html:369` runs
  `_mTabIntent='search'; setListingCat('organization_event'); showPage('listings')`. It sets a
  marketplace category and shows the marketplace.
- `js/listings.js:46` says so in its own comment: *"Home, Search and Events all share
  page-listings."*
- On **desktop** events is one category button in the Browse category strip
  (`index.html:255`), alongside Housing and Clothing.

An event is not a thing for sale. It has a start time, an end time, a host, a door and an
afterwards. None of that fits a listing card, and the costume is why it has never been built
properly.

---

## 1. The decisions that shape everything

### 1.0 Events is its own section, reached from where it already is

The section is new. **The entry points are not, and they do not move.**

| Surface | Today | After |
|---|---|---|
| Phone | Bottom tab bar: Home · Search · **+** · Messages · **Events** | Same five tabs. Events opens `page-events`. |
| Desktop | Browse → category strip → **Events** | Same button, same place. It opens `page-events`. |

Two consequences of keeping the desktop entry inside the category strip, and both must be built or
it will feel broken:

1. **`page-events` carries the category strip too**, with Events active. A student who clicks
   Events among the categories must still see Housing, Clothing and Books there, and clicking one
   returns them to the marketplace with that category set. Otherwise clicking a tab in a row of
   tabs strands them on a page with no row of tabs.
2. **Nothing is added to the desktop top nav.** Browse · Clubs · Messages stays as it is.

The marketplace keeps **one line, not a category**: where the Events tab used to filter, an empty
result for anyone who lands on stale state reads *"Events moved to their own place →"*. Students
who look in the old spot get redirected rather than concluding events were deleted.

### 1.1 The events feed is chronological. It is not a ranked feed.

The marketplace feed answers "what is available." The events feed answers "what is happening, and
when." Those are different axes, and the second one has a hard property the first does not: **an
event has an expiry that is a fact about the world, not a policy choice.** A listing is stale
because nobody bought it; an event at 6pm Tuesday is simply over at 8pm Tuesday.

Consequences, all of which fall out of that one sentence:

- Sort is `starts_at` ascending. There is no relevance ranking, no "recommended," no engagement
  ordering. Chronology is the product.
- Pastness is **computed from the clock, never stored**. No cron job flips a flag. `visible_events`
  compares `ends_at` to `now()`. Same discipline as `visible_listings`, right for the same reason:
  one rule, one place.
- The feed is **not** shown inside the marketplace feed, and marketplace listings are not shown in
  the events feed.

### 1.2 Two search surfaces, one query function

The events page has its own search, opened from its header. The global search tab keeps existing.

| | Global search (existing tab) | Events search (new) |
|---|---|---|
| Corpus | listings, books, **and events** | events only |
| Entry state | category tiles, recent searches, saved shortcut | **orgs you follow**, event-type tiles, date chips |
| Axis | what a thing is | when a thing is, and who is running it |
| Result shape | sectioned by type | date-grouped, poster cards |

Build the matching logic **once** as a function over `visible_events` and call it from both. The
global search Events section and the scoped events search must never diverge — that divergence is
exactly the bug already flagged for `book_listings` bypassing `visible_listings`.

The entry state matters more than the query state. With twelve events this semester, a typed query
returns nothing most of the time. Zero results is Tuesday, not an error. The entry state is the
product.

### 1.3 Media: photos in V1, video by link

**Photos: yes, now.** Multiple images per event, a gallery on the detail page, the first one (or
the dedicated `poster_url`) as the card image. Same Supabase Storage pattern already working for
`listing-photos`, but a **separate `event-media` bucket** — event posters are portrait (~4:5) and
listing photos are not, and one bucket with two aspect conventions produces a broken grid.

**Video: link only, in V1.** Not because video is hard to display, but because of three costs that
are easy to miss until the bill arrives:

1. **Egress.** A 30-second phone video is 30–60 MB. One popular recap video watched 200 times is
   more bandwidth than the entire marketplace has used to date. The fastest way off a free tier.
2. **No transcoding.** An iPhone `.mov` is often HEVC/H.265, which will not play in Chrome on
   Android. Uploads without transcoding produce videos that work on the uploader's phone and
   nowhere else — the worst failure, because the person who posted it cannot reproduce it.
3. **Moderation surface.** Video is the hardest media to review, and a daily human review
   commitment is already in the moderation model pitched to administrators.

So: a `video_link` kind holding an Instagram / YouTube / TikTok URL, rendered as a link card.
Clubs already post video to Instagram; the platform does not need to host it to benefit from it.
If uploads become a real request later, `kind='video'` is one value in one check constraint.

**Recap media is the part worth building.** `event_media.phase` is `'promo'` or `'recap'`. Recap
media is what makes a past event worth looking at, what makes an org profile look alive to a
student deciding whether to join, and it costs one column. It is also the best retention hook in
this document — a student who attended will open the app to see whether the photos are up.

### 1.4 The door has three ways in, and they all write one row

**The officer's eyes are the security layer.** No geofence, no rotating code, no cryptography. A
human at a door confirming a face is both cheaper to build and harder to fool than anything in
software.

| Path | Who acts | Status written | `check_in_method` |
|---|---|---|---|
| Officer finds them by name and taps | Officer | `checked_in` | `officer` |
| Student taps "I'm here", officer confirms | Both | `self_reported` → `checked_in` | `self_confirmed` |
| Student taps "I'm here", event trusts self check-in | Student | `checked_in` | `self_auto` |
| Officer adds someone who never registered | Officer | `walk_in` | `walk_in` |

`check_in_method` **cannot be backfilled**. Six months from now, "how much of our attendance data
is officer-verified" is a question an advisor will ask and the analytics cannot answer unless the
column existed from the first event. It costs nothing.

`trust_self_checkin` is per-event, default false. A club fair with 300 people through a lawn does
not want a confirm queue; a members-only leadership dinner does.

### 1.5 The QR code needs no scanner code

The instinct is to build a QR scanner into the app — `getUserMedia`, a decoding library, camera
permissions, the iOS Safari permission dance. **Do not.** Every modern phone camera reads QR codes
natively and opens the URL. If the QR encodes a URL to the event page, the entire scanning half of
the feature is free and already installed on every student's phone.

```
QR on the poster  →  https://<domain>/#/event/123  →  event page  →  [Register] / [I'm here]
```

Generate it client-side with a **bundled** library (`qrcode.js` or equivalent) — **not** an
external QR image API, which would send every event URL to a third party. The officer gets a
"Download QR" button producing a printable PNG.

Two things this exposes that must be built with it, or the QR is a dead end:

1. **A real deep link.** `#/event/:id` must work cold, from a fresh tab, on a phone that has never
   opened the app. See §5.1 — the hash is not free.
2. **Return-to-intent after login.** A student who scans while signed out must land on login and be
   returned **to that event**, not the home feed. The single most likely thing to be forgotten and
   the single most likely thing to make the QR feel broken at a real door.

The deployed domain has to be in the Supabase redirect allow-list before any of this works from a
phone. `127.0.0.1:5500` is not reachable from a student's phone at a door.

**The honest limit.** A static printed QR is a URL, and a URL can be texted to a friend who is not
there. Nothing short of rotating codes or geofencing prevents that, and both have real costs —
CampusGroups offers exactly this tradeoff: a static printable flyer, *or* a code refreshing every
30 seconds, never both. Moodle's rotating-QR module generates a steady stream of support tickets
from students who could not check in. For V1: static QR, and the confirm queue is what makes the
number honest.

**The fallback that requires no work.** Anyone whose phone fails at the door is checked in by the
officer typing their name. That path always works. There is no need for a manual numeric backup —
the backup is a person.

### 1.6 Ratings are gated on attendance, and that is the whole design

**Only a student with a check-in row can rate an event.** One rule, three jobs:

- The feedback means something, because it comes from people who were there.
- Check-in acquires a reason to exist for the *student*, not just the org.
- It closes the loop that makes the door worth staffing.

**Window.** Opens when the event ends; closes seven days later (§9.5). A rating left in November
about a September event is noise, and an open-forever window means the officer never knows when
the numbers are final.

**Private to the org, not public.** A public star average on a club with six attendees is a
permanent scar from one bad night, and at that size the person who left it is guessable. The
existing analytics rule applies identically: **no aggregate is displayed below five responses.**
Officers see "3 responses — not enough to summarise yet" and the comments, nothing more. Public
ratings cannot be un-published once they exist.

**Anonymity, described honestly.** `user_id` is stored — it has to be, to enforce one rating per
person and to check attendance — but officers never see it. The officer read goes through a
`SECURITY DEFINER` function returning the aggregate and comment text with no identity attached,
guarded by `can_act('can_view_analytics', org_id)`. Student-facing copy says what is true and no
more: *shared anonymously with the organizers — though at a small event, a detailed comment may
still be recognisable.* Do not write "completely anonymous." It is not, at eleven attendees, and
the first person who feels identified will be right.

**Delivery is passive.** No push, no email — neither exists. The ask is a card at the top of the
events feed and in Going: *"How was Fall Club Fair?"* for anyone with a check-in row and no rating,
inside the window. When a notification layer lands, the post-event prompt is the second thing it
carries. The first is cancellation (§6).

---

## 2. Schema

Written as one runnable script. **Captured as a file in `sql/` first, then pasted into the Supabase
SQL editor** — untracked dashboard edits are the documented cause of a past bug. Every verification
file gets re-run afterward, including ones unrelated to this change. That rule already cost two
false green results this month.

Corrections applied against rev 1, all verified in the repository:

- **`school` is a text slug, not `school_id uuid`.** Nothing outside `school_domains` has a
  `school_id`. Keyed on a uuid these tables join to nothing, and it surfaces as an empty feed, not
  an error. (`sql/2026-09-04_org_hierarchy.sql:44`)
- **`bigint generated always as identity`, not `bigserial`.** Identity owns its sequence; bigserial
  needs a separate `GRANT USAGE ON SEQUENCE` and gives a confusing error without it.
  (`sql/2026-09-01_saved_items.sql:27`)
- **`events` and `event_registrations` do not exist.** Rev 1 said they did, per campus §4.3. They
  are specified there and were never run. They are created here, not altered.
- **`event_registrations.user_id` is NULLABLE** (§9.2), which contradicts campus §4.3. Walk-ins
  are the point of the door. `unique (event_id, user_id)` still behaves, because Postgres permits
  multiple NULLs in a unique index.

```sql
-- ── events ───────────────────────────────────────────────────────────────────
create table if not exists public.events (
  id                  bigint generated always as identity primary key,
  school              text   not null,                       -- slug, matches listings.school
  org_id              bigint not null references public.organizations(id),
  created_by          uuid   not null references public.profiles(id),
  title               text   not null,
  description         text,
  poster_url          text,                                  -- null → gradient fallback
  event_type          text   not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz,
  location            text   not null,
  status              text   not null default 'published'
                        check (status in ('draft','published','cancelled','completed')),
  registration_open   boolean not null default false,
  capacity            integer,                               -- null = unlimited
  external_ticket_url text,
  members_only        boolean not null default false,
  audience_tags       text[],
  recurrence_group_id uuid,
  cancelled_reason    text,
  trust_self_checkin  boolean not null default false,
  checkin_opens_at    timestamptz,                           -- null → starts_at - 1 hour
  checkin_closes_at   timestamptz,                           -- null → ends_at + 1 hour
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists events_school_starts_idx on public.events (school, starts_at);
create index if not exists events_org_starts_idx    on public.events (org_id, starts_at desc);

-- ── the door ─────────────────────────────────────────────────────────────────
-- user_id is NULLABLE on purpose: a walk-in may have no account at all.
create table if not exists public.event_registrations (
  id               bigint generated always as identity primary key,
  event_id         bigint not null references public.events(id) on delete cascade,
  user_id          uuid   references public.profiles(id) on delete cascade,
  name_at_signup   text not null,                            -- snapshot; profile may change
  email_at_signup  text not null,
  status           text not null default 'registered'
                     check (status in ('registered','cancelled','self_reported',
                                       'checked_in','walk_in')),
  check_in_method  text check (check_in_method in ('officer','self_confirmed',
                                                   'self_auto','walk_in')),
  self_reported_at timestamptz,
  checked_in_at    timestamptz,
  checked_in_by    uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists event_reg_event_idx on public.event_registrations (event_id, status);

-- ── media ────────────────────────────────────────────────────────────────────
create table if not exists public.event_media (
  id          bigint generated always as identity primary key,
  school      text   not null,
  event_id    bigint not null references public.events(id) on delete cascade,
  kind        text   not null check (kind in ('image','video_link')),
  url         text   not null,
  caption     text,
  phase       text   not null default 'promo' check (phase in ('promo','recap')),
  sort_order  integer not null default 0,
  created_by  uuid   not null references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists event_media_event_idx
  on public.event_media (event_id, phase, sort_order);

-- ── feedback ─────────────────────────────────────────────────────────────────
create table if not exists public.event_feedback (
  id         bigint generated always as identity primary key,
  school     text   not null,
  event_id   bigint not null references public.events(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists event_feedback_event_idx on public.event_feedback (event_id);

-- ── visibility ───────────────────────────────────────────────────────────────
-- One rule, one place. Pastness is computed here and nowhere else. Members-only is
-- deferred from V1 (§6), so the view ships without it and gains the clause later —
-- which is exactly why every read must go through the view rather than the table.
create or replace view public.visible_events as
  select e.*
  from public.events e
  where e.status = 'published'
    and e.members_only = false;

-- ── grants, then the revokes Supabase makes necessary ────────────────────────
-- Supabase attaches DEFAULT PRIVILEGES to every new object in public BEFORE any
-- GRANT here runs: REFERENCES, TRIGGER and TRUNCATE for both anon and authenticated.
-- A grant only ever ADDS. The extras must be revoked explicitly. TRUNCATE is the one
-- that matters, because RLS DOES NOT APPLY TO IT — one statement ignores every policy.
grant select, insert, update, delete on public.events              to authenticated;
grant select, insert, update, delete on public.event_registrations to authenticated;
grant select, insert, update, delete on public.event_media         to authenticated;
grant select, insert                 on public.event_feedback      to authenticated;
grant select                         on public.visible_events      to authenticated;

revoke truncate, references, trigger on public.events              from authenticated;
revoke truncate, references, trigger on public.event_registrations from authenticated;
revoke truncate, references, trigger on public.event_media         from authenticated;
revoke truncate, references, trigger on public.event_feedback      from authenticated;
revoke truncate, references, trigger on public.visible_events      from authenticated;

revoke all on public.events              from anon;
revoke all on public.event_registrations from anon;
revoke all on public.event_media         from anon;
revoke all on public.event_feedback      from anon;
revoke all on public.visible_events      from anon;

notify pgrst, 'reload schema';
```

Verify the grants afterwards with the query in `sql/2026-09-03_capture_rls_and_grants.sql`. This
revoke block has been missed twice since `saved_items` got it right — assume it will be missed
again and check rather than trust.

**RLS, in words; written properly in E1:**

- `events` — SELECT via `visible_events` for any authenticated student of the school.
  INSERT/UPDATE/DELETE gated on `can_act('can_manage_events', org_id)`.
- `event_media` — SELECT follows the event's own visibility. Writes gated on
  `can_act('can_manage_events', org_id)`.
- `event_registrations` — a student SELECTs and INSERTs their own row only, and may UPDATE it only
  to `cancelled`. **A student can never write `status='checked_in'` or `check_in_method`.**
- `event_feedback` — INSERT only when a row exists in `event_registrations` for
  `(event_id, auth.uid())` with status in `('checked_in','walk_in')`, **and** the event has ended,
  **and** it ended within seven days. SELECT: own row only. Officers never read this table
  directly.
- `get_event_feedback(event_id)` — `SECURITY DEFINER`, guarded by
  `can_act('can_view_analytics', org_id)`, returns `{count, avg, comments[]}` with no user ids and
  a **null average when `count < 5`**. The suppression lives in the function, not the UI — a
  suppression rule enforced only in JavaScript is not a suppression rule.

**All lifecycle writes go through RPCs** (`register_for_event`, `cancel_registration`,
`check_in_attendee`, `self_report_arrival`, `add_walk_in`, `cancel_event`), never bare
INSERT/UPDATE, so the method and the actor are recorded in one transaction alongside the log row.
Same reasoning as `change_listing_status`: app code cannot be trusted to remember the log.

**Logging is `logEvent()`.** Not `activity_log`, not `entity_type` — rev 1 had both wrong. The
table is **`admin_activity_log`**, the column is **`target_type`**, and it also carries `school`
(`js/admin.js:469-492`). Events use `target_type = 'event'`.

**Capacity is enforced in the database.** Two students tapping the last seat simultaneously is a
real race. `register_for_event` counts and inserts in one transaction, or a `before insert` trigger
counts and raises. A client-side count will oversell.

---

## 3. Officer side — what an organizer sees

### 3.1 Creating an event

Progressive disclosure: a short required block (title, date/time, location, type, poster) then
collapsed toggles for *Add registration*, *Add photos*, *Limit audience*, *Repeat this event*.
Every required field is a reason someone abandons the form.

- **Photos**: drag or pick multiple, reorder, one is the card image. Uploads to `event-media`, not
  `listing-photos`.
- **Add a video link** inside the photos section, with the same URL validation posture used for
  ticket links — accept Instagram / YouTube / TikTok, reject payment domains.
- **`trust_self_checkin`** toggle, default off, with one line explaining what it does.

### 3.2 The event's console page

Reached from the console Events list. In this order, because this is the order an organizer needs
them in over an event's life:

1. **Overview** — poster, details, edit, cancel (reason required), duplicate, and **Download QR**
   with a print-ready sheet: poster, title, date, the QR, and one line: *Scan to sign up or check
   in.*
2. **Registrations** — the list, capacity state, CSV export.
3. **Door** — §5. Only inside the check-in window, and only for a holder of `can_check_in`.
4. **Recap** — after the event: upload recap photos, and the feedback summary.

The permission split frozen into the flag set pays off exactly here: `can_manage_events` gets 1, 2
and 4; `can_check_in` alone gets 3 and nothing else. A first-year working the door for one evening
receives the door and cannot post as the club. That separation is why the flag is narrow, and this
is the first screen where it becomes visible.

---

## 4. The Events section

### 4.0 Leaving the marketplace

Events currently lives inside the marketplace at seven call sites. Moving out is mechanical, it
touches three files at once, and it therefore breaks the one-area-per-change rule on purpose — so
it is **its own commit, alone, with nothing else in it** (session E2.5).

| Where | Today | After |
|---|---|---|
| `index.html:369` mobile tab | `_mTabIntent='search'; setListingCat('organization_event'); showPage('listings')` | `showPage('events')` |
| `index.html:255` category strip | `setListingCat('organization_event',this)` | `showPage('events')` |
| `index.html:1311` post-form picker | `selectCategory('organization_event')` | removed — students do not post events |
| `index.html:1377` `catFields-organization_event` | event fields on the listing form | removed |
| `index.html:503` admin filter chip | `setAListFilter('type','organization_event')` | removed; events moderate in their own queue |
| `js/listings.js:51` `updateMTabbar` | `_filters.category === 'organization_event' ? 'mtab-events'` | `name === 'events' ? 'mtab-events'` |
| `js/listings.js:435, 673, 790, 1230, 1243` | category branches, icon, badge, post fields, photo nudge | branches removed |
| `js/admin.js:913` | `organization_event` in the type filter list | removed |
| `js/config.js:23, 24, 42` | emoji, label, colour | **kept** — the migration and the log still render old rows |

Where the post form offered "Org / Event", it now says one line: **"Running an event? Ask your
organization to post it from the club console."** Removing an option without saying where it went
reads as a bug.

**New files:** `js/events.js` (loaded before `boot.js`), event-section classes in `styles.css`.
Bump `?v=` on every asset touched, or the browser serves the old file and you debug code that is
not running.

**Migration:** existing `listings` rows with `category='organization_event'` move to `events` in
E1, mapping the `details` JSON keys to real columns. The listing rows are archived, not deleted.

### 4.1 The feed

`page-events`. Poster-first, vertically scrollable, chronological ascending, date-grouped with
sticky headers (*Today*, *Tomorrow*, then *Fri, Sep 11*). Desktop carries the category strip at the
top with Events active (§1.0); phone does not.

```
  What's happening                            [🔍]  [filter]

  ┌─────────────────────────────────────────────┐
  │  ⬤ Chess Club ✓                             │
  │                                             │
  │            [ POSTER IMAGE ]                 │
  │                                             │
  │  Fall Club Fair                      ☆   📅 │
  │  Tue Sep 8 · 6:00 PM · Main Hall Lawn       │
  │  42 going · 18 spots left                   │
  └─────────────────────────────────────────────┘
```

- The org row is tappable and goes to the **org profile page** (§4.8). The verified badge sits
  there and is the answer to "is this a real club or someone's Instagram."
- The star is **private** (saved — `favorites` already accepts `'event'`, no migration needed:
  `sql/2026-09-04_favorites_allow_event.sql`). The calendar icon means **registered** and is **not**
  private — the org sees name and email. Stated on the detail page, once, plainly, under the
  register button. Do not bury it.
- Above the first date group, **at most one** contextual card: a pending feedback ask, or "You're
  going to something today," or nothing. One slot, never a stack.
- Past events are not in the main list. A single *Past* chip reveals them, newest first, greyed —
  and past events with recap photos show a photo count, which is the reason anyone would ever tap
  that chip.
- **Empty state**: with no upcoming events, the page says so and points at Clubs — *"No events
  yet. Follow a club and theirs will show up here."* Never a blank column.

### 4.2 Events search

The 🔍 in the events header. Entry state, top to bottom:

1. Search input, dominant.
2. **Orgs you follow** — a horizontal row of logos. Tapping one filters to that org's events. On a
   campus feed this is the most-used control and it is not a search at all.
3. **Date chips** — This week · This weekend · Next week · This month.
4. **Event type tiles** — Social, Academic, Sports, Service, Career, Arts, Meeting.

Query state: substring match over title, org name, location and description across
`visible_events`, grouped by date exactly like the feed, with a result count line. Empty results
suggest broadening (clear the date chip, try the org) rather than a bare *no results*.

Members-only events are filtered **by RLS, not by a JavaScript `.filter()`**. A filter in
JavaScript is not a permission — and this is the surface where it will be tempting to forget it.

### 4.3 Event detail

Poster, org header, title, full date and time with **add to calendar** (a constructed Google
Calendar template URL plus an `.ics` — convert to UTC explicitly and test it; the shifted-by-hours
bug is the classic one), location, description, audience tags, photo gallery, video link cards,
register button with capacity state, and — inside the check-in window — the **I'm here** button.

Register states: `Register` · `You're going ✓` · `Full` · `Registration closed` · `Cancelled`.
Cancelled events stay reachable by their registrants with a red banner and the reason, even though
`visible_events` excludes them from the feed.

Unregistering frees the seat but keeps the row as `status='cancelled'`.

### 4.4 "I'm here"

Only between `checkin_opens_at` and `checkin_closes_at`. Three outcomes:

- Registered, event trusts self check-in → *Checked in ✓*, done.
- Registered, confirmation required → *Waiting for the organizer to confirm* — a **persistent
  state on the page, not a toast that vanishes**. The student must be able to see that their tap
  landed.
- Not registered → registers and self-reports in one action, if registration is open and there is
  capacity. This is the walk-up-and-scan case and it is most of the value of the QR.

### 4.5 Rating and feedback

For anyone with a check-in row, once the event has ended and within seven days: a card at the top
of the events feed and an entry in Going. Five stars, an optional comment, one line of honest copy
about who sees it (§1.6). Submitting replaces the card with a thank-you and it does not come back.

### 4.6 Going

The profile icon row gains **📅 Going** — upcoming registered events first, past ones below, past
ones showing rating state (rated / rate now / window closed), and cancelled ones showing the
cancellation banner (§6).

### 4.7 The org profile page

Not a "thin org page invented for events" — the page the shipped directory is already missing.
Reached from a directory card **and** from an event card's org row. Logo, name, verified badge,
description, contact block, Follow (the button already exists in the directory —
`js/orgdir.js:190` — reuse it, do not write a second one), upcoming events, past events with
recap photos.

---

## 5. The door — the officer's live screen

**It must work when everything else fails.** The name search path never depends on the student's
phone, the QR, or the network being good in a gym basement.

```
  Fall Club Fair · Door                         47 / 120

  ┌───────────────────────────────────────────┐
  │  🔔 Arrivals waiting (3)                  │
  │  Maya R. · '27              [Confirm] [✕] │
  │  Daniel O. · '26            [Confirm] [✕] │
  └───────────────────────────────────────────┘

  [ 🔍 Search by last name…                   ]

  Reyes, Maya · '27          registered   [Check in]
  Okafor, Daniel · '26       checked in ✓
  Osei, Daniel · '25         registered   [Check in]

  [ + Add walk-in ]
```

- **Arrivals queue** at the top: students who tapped *I'm here*, newest first. Confirm marks them
  `checked_in`; dismiss returns them to `registered` so they can be found by name instead. Poll
  every few seconds — websockets are not needed for a queue that peaks at a dozen rows.
- **Name search** filters as you type, last name first.
- **Tap to check in**, with a five-second Undo. Undo, not a confirmation dialog: confirmations at a
  door slow a line that is already forming.
- **Counter** at the top, live.
- **Walk-in** captures name and email, records `walk_in`, links to a profile if the email matches
  one, and otherwise stands alone with a null `user_id`.

**The class-year row degrades.** Rev 1 assumed `profiles.class_year`. The column is **`year`**, it
is **nullable**, and it is **free text** — a student may have typed anything or nothing
(`js/profile.js:301, 316`). So *Daniel O. '26* vs *Daniel O. '25* is the good case, not the
guaranteed one. Rows render as `Daniel O.` with no year when it is absent, never as a blank gap,
and disambiguation falls back to email initial. Do not build a UI that assumes the year is there.

**Known risk, not solved:** no wifi in gyms and basements. Offline check-in is its own project.
The fallback is paper for that one event, and that is an acceptable answer to write down now
rather than discover later.

### 5.1 The hash router collides with Supabase auth — read before building the deep link

`#/event/:id` needs a hash router, and there is no router today. But **the hash is not free.**
Supabase returns auth tokens in it, and `js/boot.js` already reads them:

- `js/boot.js:25` — `if (/[#&]type=recovery/.test(window.location.hash)) showResetScreen();`
- `js/boot.js:131` — `if (/[#&]type=signup/.test(window.location.hash)) { … }`

A router that claims the whole fragment will swallow `#access_token=…&type=recovery` and **break
password reset and signup confirmation**. Password reset is already the last unverified item on the
v1 launch-blocker list, so this is not a small collision.

The rule: **the router checks for the Supabase token shapes first and yields to them.** Only a hash
matching `#/…` is a route. Anything containing `access_token`, `type=recovery` or `type=signup`
belongs to boot and the router must not touch it. E3's test list gains a case: a password-reset
link still reaches the reset screen after the router exists.

---

## 6. What is V1 and what is deferred

**In V1 — the events product is not credible without these**

- events schema, migration off `listings`, `visible_events`, RLS, RPCs
- create/edit/cancel an event, poster + photos, from the console
- **the events section itself** — `page-events`, both entry points repointed, marketplace branches
  removed
- the student events feed, date-grouped, poster cards
- event detail with add-to-calendar and the photo gallery
- register / unregister, capacity enforced **in the database**
- the org profile page, reached from the event card and the directory
- events search, scoped, with the follow/date/type entry state
- deep link `#/event/:id` + return-to-intent, yielding to Supabase auth hashes
- QR download for the officer (URL-encoding, no scanner)
- the door: name search, tap to check in, undo, counter, walk-in
- "I'm here" + the arrivals queue + `trust_self_checkin`
- `check_in_method` recorded on every check-in

**Deferred, deliberately**

| Deferred | Why it can wait |
|---|---|
| Video **uploads** | Egress and transcoding. Links cover the need. |
| Recurrence | Materialising rows is right; it is also a session. Duplicate covers 80%. |
| Members-only gating | The hardest RLS policy in the app, needing its own test pass with a non-member account. Ship public-only. |
| Waitlists | Promotion logic plus notifications. `Full` as a hard stop is fine (§9.4). |
| Analytics rollups, CSV export | One event's worth of data is not a dashboard. |
| Public star ratings on org profiles | Cannot be un-published. Wait for volume. |
| Rotating QR codes | Known support cost, no benefit at this scale. |
| Offline door mode | Own project. Paper is the fallback. |
| Notification delivery | Blocks nothing here — except cancellation, below. |
| Full events moderation queue in admin | The admin type-chip is removed in E2.5; events moderate through the org console until the queue exists. Note it, do not silently drop it. |

**The one deferral with a sharp edge.** Cancellation has no delivery path. An event is cancelled
and a registrant who does not open the app finds out at the door. The V1 mitigation is passive and
**must be built**: required reason, red banner on detail, cancelled state in Going, and the event
stays reachable by its registrants. That is not adequate, it is merely honest, and a cancellation
email is the first thing the notification layer must carry.

---

## 7. Build sessions

Each: investigate → plan → **approve** → build → test → commit. Commit before starting as a
restore point.

| # | Session | Done when |
|---|---|---|
| **E0** | Capture stage 0 | `visible_listings`, `is_super_admin()` and the `user_roles` shape exist as files in `sql/`. Three items already open in `sql/README.md`. Everything below builds on all three and none is written down. |
| **E1** | Schema, visibility, RPCs | The §2 script is a file in `sql/`, has run, and `information_schema` matches it. `visible_events` returns rows. `sql/2026-09-XX_verify_events.sql` passes its 10 assertions. Every other file in `sql/` re-run and reported. |
| **E2** | Officer: create, edit, media, QR | An officer creates an event with a poster from the console and it appears in the database. Cancel without a reason is refused. QR downloads and a phone camera opens the event URL. |
| **E2.5** | **Section scaffold + marketplace extraction** | `page-events` exists and both entry points reach it. All nine call sites in §4.0 are moved. Home feed, saved, profile listings and chat listing-cards render identically to before. **Own commit, nothing else in it.** |
| **E3** | Feed, detail, register, org profile | A student browses events chronologically, opens one, registers, and the seat count is right with two browsers racing. `#/event/:id` works cold in incognito. A password-reset link still reaches the reset screen. |
| **E4** | Events search | The scoped search and the global search Events section call the same match function over `visible_events`. |
| **E5** | The door | Officer, self-confirm, trusted-self and walk-in each write the correct `check_in_method`, verified in the database, not the UI. A student cannot set their own status to `checked_in` via the API. |
| **E6** | Feedback | `get_event_feedback` returns a null average at 4 responses and a number at 5. Feedback without a check-in row is refused by the policy. |

E1 → E2.5 → E3 is a shippable events product. E5 is what makes it worth an administrator's
attention. E4 and E6 are small and can slot in either order.

**E2.5 sits after E2 on purpose.** Building the officer side first means that the moment the
student section exists there is something real inside it. A section that ships empty teaches
students it is empty, and they stop opening it.

---

## 8. Paste-ready prompts

Written fresh in rev 2 against the corrected schema. E1 and E3 in full; E2, E2.5 and E5 as their
scope boundaries, which are the part that matters.

### E0 — capture stage 0

```
CONTEXT
CaldwellNest. Before the events work starts, three things it depends on are
not written down anywhere in sql/. sql/README.md already lists all three as
missing.

TASK — CAPTURE ONLY. No new schema, no behaviour change.
Write these into sql/, in the style of the existing capture files:
1. The definition of the visible_listings view, exactly as it exists.
2. The definition of is_super_admin().
3. The full shape of user_roles: columns, constraints, RLS, grants.

Read each from the live database. Do NOT reconstruct them from comments or
from the plan documents — that is the exact mistake CLAUDE.md records.
Tell me what to run to get each definition; I will paste the output back.

Then report anything that surprised you, especially any difference between
what the code assumes and what the database actually holds.

COMMIT "Capture the visibility view, super-admin function and user_roles"
```

### E1 — schema, visibility, RPCs

```
CONTEXT
CaldwellNest. We are building the events system in
docs/nestrel-events-door-feedback-plan.md (rev 2), which extends
docs/nestrel-campus-engagement-plan.md §4. Read both fully, and read §12 of
the campus plan before writing any SQL.

STEP 1 — INVESTIGATE ONLY. NO CODE, NO SQL YET.
Report back:
1. Every place that reads or writes listings rows with
   category='organization_event'. §4.0 of the plan lists nine — verify that
   list is complete and correct, and report anything it missed.
2. The exact keys inside the listings `details` JSON blob used for event
   date, time, location and host, and how many rows currently carry them.
3. Confirm no events tables exist yet. Do not assume the plan is right —
   check the database.
4. The existing RPC pattern: read change_listing_status and report how it
   writes its admin_activity_log row and how errors surface to the client.
5. Where the Supabase storage upload helper lives and which bucket it
   hardcodes.
Report these five things and stop.

STEP 2 — PLAN, FOR MY APPROVAL.
Then write (a) the §2 script as ONE file in sql/, which I will paste into the
Supabase SQL editor by hand; (b) the RLS policies; (c) the RPC signatures;
(d) the migration for existing organization_event rows; (e) what could break.
I approve before anything is applied.

NOT NEGOTIABLE
- `school` is a TEXT SLUG. There is no school_id on these tables.
- `bigint generated always as identity`, never bigserial.
- event_registrations.user_id is NULLABLE, for walk-ins. Campus §4.3 says
  not null; this document overrides it. Confirm it explicitly in the plan.
- Capacity is enforced in the database in one transaction. A client-side
  count will oversell the last seat.
- check_in_method is written by the RPC, never by app code.
- get_event_feedback is SECURITY DEFINER, guarded by can_act(), and returns
  a NULL average below 5 responses. The suppression is in the function.
- Feedback INSERT requires a check-in row, a past event, and a 7-day window,
  all in the policy.
- Lifecycle writes go through RPCs that call logEvent() — the table is
  admin_activity_log and the column is target_type. Not activity_log, not
  entity_type.
- The file ends with the revoke block from §2 and
  notify pgrst, 'reload schema';

STEP 3 — AFTER I CONFIRM THE SQL RAN
Write sql/2026-XX-XX_verify_events.sql in the style of the existing
verification files: impersonate real students, assert refusals AND
permissions, roll everything back, report by raising an exception.
Assert at minimum:
 1. A non-officer cannot insert an event.
 2. An officer of a child club can insert an event for their club.
 3. A school admin can edit a club's event (authority flows down).
 4. A club officer CANNOT edit another club's event.
 5. Registering past capacity fails.
 6. A student cannot write check_in_method or status='checked_in' directly.
 7. Feedback insert without a check-in row fails.
 8. Feedback insert outside the 7-day window fails.
 9. get_event_feedback returns a null average at 4 responses, a number at 5.
10. A cancelled event is excluded from visible_events but is still readable
    by a registrant.
11. anon has no privilege at all on any of the five new objects.

THEN re-run every other verification file in sql/ and report the results.
A green test not re-run is a memory, not evidence.

COMMIT before starting. Then: "Events schema, visibility and RPCs"
```

### E2 — officer surfaces

Full prompt written at session start. Scope boundaries, which are the load-bearing part:

```
DO NOT:
- Do not build recurrence. Duplicate-an-event covers it.
- Do not build the student feed, detail page, or search.
- Do not build any check-in UI.
- Do not add video FILE upload — links only.
- Do not touch the marketplace listing card or the post form. That is E2.5.
- Do not call an external QR image service. Bundle the library.
- REFINE ONLY.
```

### E2.5 — the section scaffold and the marketplace extraction

```
This session moves events out of the marketplace. It touches index.html,
js/listings.js and js/admin.js in one change, which breaks the one-area rule
on purpose. It is therefore ITS OWN COMMIT with nothing else in it.

Work the nine call sites in §4.0 of the plan, one at a time, in the order
listed. After each, say what you changed and what you expect to still work.

DO NOT:
- Do not build the feed itself. This session creates an empty page-events
  and repoints the two entry points at it. E3 fills it.
- Do not remove the organization_event entries from js/config.js — the
  migrated rows and the activity log still render them.
- Do not leave the post form's removed option unexplained. Replace it with
  "Running an event? Ask your organization to post it from the club console."
- Do not forget the ?v= bump. A change that appears to do nothing is a cache
  symptom more often than a logic one.

TEST BEFORE REPORTING DONE
1. Phone bottom bar: Events opens page-events and the tab highlights.
2. Desktop category strip: Events opens page-events; the strip is still
   there with Events active; clicking Housing returns to the marketplace
   with Housing set.
3. Home feed, saved tab, profile listings and chat listing-cards render
   identically to before. Confirm you checked EACH ONE.
4. The post form no longer offers Org / Event and explains where it went.
5. Admin listings queue has no organization_event chip and does not error.
6. 390px.

COMMIT before and after. "Move events out of the marketplace"
```

### E3 — the events section

```
CONTEXT
Officer side (E2) and the section scaffold (E2.5) are live. Fill page-events
per §4 of docs/nestrel-events-door-feedback-plan.md.

STEP 1 — INVESTIGATE. Report: exactly how boot.js decides what to render
after a Supabase auth session resolves, and every place window.location.hash
is read today. Stop.

STEP 2 — PLAN FOR APPROVAL, then build:
- Feed: chronological ascending over visible_events, date-grouped with
  sticky headers. Poster-first cards: org logo + name + verified badge
  (tappable), poster, title, date · time · location, one social-proof line,
  star (private save) and calendar icon (registered).
- One contextual slot above the first date group. At most one card.
- "Past" chip: past events greyed, newest first, photo count where recap
  media exists.
- Empty state pointing at Clubs. Never a blank column.
- Detail: poster, org header, full date/time, add to calendar (Google
  template URL + .ics — convert to UTC explicitly and TEST it), location,
  description, audience tags, gallery, video link cards, register button in
  all states.
- Under the register button, once, plainly: the organization will see your
  name and email.
- Unregister frees the seat, keeps the row as status='cancelled'.
- Org profile page: reached from a directory card AND an event card's org
  row. REUSE the follow button in js/orgdir.js:190 — do not write a second.
- Profile icon row gains "Going".
- DEEP LINK #/event/:id, working cold in a fresh tab.
- ROUTER YIELDS TO SUPABASE. Read §5.1 first. A hash containing access_token,
  type=recovery or type=signup belongs to boot.js and the router must not
  touch it.
- RETURN-TO-INTENT: signed out at #/event/:id → login → THAT EVENT. An
  unresolved session and an absent session must not render the same way.

DO NOT:
- Do not modify the marketplace listing card. Build a separate event card.
- Do not build check-in, "I'm here", or ratings.
- Do not build events search — that is E4.
- Do not implement members-only gating; public-only for now.
- Do not build a calendar month grid.
- REFINE ONLY.

TEST BEFORE REPORTING DONE
1. A past event is absent from the main list, present under Past.
2. Registering twice is impossible; the button survives a reload.
3. Capacity full shows Full, and the last seat cannot be double-booked —
   test with two browsers.
4. Add-to-calendar lands at the correct local time, not shifted by hours.
5. #/event/:id in a fresh incognito tab: login → the event.
6. A PASSWORD RESET LINK STILL REACHES THE RESET SCREEN.
7. A cancelled event is gone from the feed but reachable by its registrant,
   with banner and reason.
8. 390px.

COMMIT before and after. "Student events feed, detail and registration"
```

### E5 — the door

Full prompt at session start. Scope boundaries:

```
DO NOT:
- Do not build a QR scanner. The phone camera is the scanner.
- Do not build offline mode.
- Do not build analytics, rollups or CSV export.
- Do not build rotating or expiring codes.
- Do not assume profiles.year exists on a row. It is nullable free text.
- REFINE ONLY.
```

E4 (search) and E6 (feedback) get their prompts once E3 and E5 land — both are small, and both
depend on how the feed's card and the check-in rows actually ended up shaped.

---

## 9. Decisions — recorded

Rev 1 left these open. They are decided.

1. **Deployed domain.** *Still open, and now the only blocker in this list.* The QR encodes it and
   the Supabase redirect allow-list needs it. **E0, E1, E2.5 and E3 do not need it. E2 cannot
   finish without it** — the QR would encode a URL resolving to nothing at a real door. Deployment
   is described as soon; decide before E2.
2. **`event_registrations.user_id` nullable?** **Yes.** Walk-ins are the point of the door. This
   overrides campus §4.3.
3. **Does registering require a verified account?** **Yes** — the same gate as posting and
   messaging, enforced at the data layer. Note the gate is `validateSchoolEmail()`, any `.edu` in
   `school_domains`, not `@caldwell.edu` specifically. The platform is multi-school by design.
4. **`class_year` on profiles — required or nullable?** Neither: the column is **`year`**, it is
   **nullable**, and it is **free text**. The door row renders without it (§5).
5. **Hard stop or waitlist at capacity?** **Hard stop** for V1.
6. **Feedback window?** **Seven days.** A number, not a principle, picked deliberately: long enough
   to catch a student who was out all weekend, short enough that an officer knows when the numbers
   are final.
7. **Does a thin org page replace the directory?** **No — the question is obsolete.** The directory
   shipped. What gets built is the **org profile page** it currently lacks (§4.7).
8. **Where does the events section live?** **Where events already lives.** Phone: the existing
   bottom tab. Desktop: the existing Events button in the category strip. Nothing is added to the
   desktop top nav (§1.0).
