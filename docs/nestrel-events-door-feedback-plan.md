# Nestrel events, the door, and feedback — design + build prompts

Save as `docs/nestrel-events-door-feedback-plan.md`.

Companion to `docs/nestrel-campus-engagement-plan.md` (§4 events data model, §6 check-in, §8
student UI). This document **extends** that one — it does not replace it. Where the two disagree,
this one is newer.

What is new here, relative to the campus engagement plan:

- the events **feed** as its own surface, with its own **search**, separate from marketplace search
- **media** on events (photos now, video by link) including recap media after the event
- **post-event ratings and feedback**, gated on attendance
- the **door**: three ways in — officer name search, student self check-in, walk-in — plus a
  **QR code** that needs no scanner code at all
- an explicit **V1 line**, because the goal is to launch, not to finish

---

## 0.5. Corrections against the live database (added 2026-09-06, on save)

**Read this before running any SQL from §2 or pasting the E1 prompt.**

This section was written when the document was saved, not by its author. The body below is the
plan exactly as received. It was checked against the repository and the captured schema in `sql/`,
and its SQL contradicts reality in five places — four of them the *same* contradictions that §12
of `docs/nestrel-campus-engagement-plan.md` already caught and corrected in its own rev 3.

The body has been left unedited on purpose, so that what was proposed stays visible. These are the
corrections that apply on top of it.

| # | This document says | Reality | Evidence |
|---|---|---|---|
| E-C1 | `school_id uuid not null` on `event_media` and `event_feedback` | The scope column is **`school`, a text slug** (`'caldwell'`). `school_id` exists only on `school_domains`. Keyed on a uuid, these tables join to nothing — and it surfaces as an empty feed, not an error. | `sql/2026-09-04_org_hierarchy.sql:44`, §12 C1 |
| E-C2 | `id bigserial primary key` (twice, in §2) | Convention is **`bigint generated always as identity`**. `bigserial` also needs a separate `GRANT USAGE ON SEQUENCE` and gives a confusing error without it. | `sql/2026-09-01_saved_items.sql:27`, `sql/2026-09-04_org_hierarchy.sql:38-43`, §12 C5 |
| E-C3 | log to `activity_log`, column `entity_type` (§2 and the E1 prompt) | Table is **`admin_activity_log`**, column is **`target_type`**, written through `logEvent()`. It also carries `school`. | `js/admin.js:469-485`, `js/admin.js:492`, §12 C3 |
| E-C4 | `profiles.class_year` (§9 Q3, and the door row in §5) | Column is **`year`**. It is **nullable and free text** — not a controlled set of class years. §9 Q3 is therefore already answered: nullable, and the door row must render without it. | `js/profile.js:301`, `js/profile.js:316`, §12 C4 |
| E-C5 | "`event_registrations` already exists per §4.3" (§2) | **It does not.** No `events`, `event_registrations`, `event_media` or `event_feedback` table exists in `sql/` or in the database. Every events table is new. The `alter table` statements in §2 will fail as written. | nothing in `sql/` defines them |

### Two rules from CLAUDE.md the §2 SQL omits

Both are recorded in CLAUDE.md as hard-learned, and both are missing from all three new objects:

1. **The default-privilege revoke.** Supabase attaches `REFERENCES`, `TRIGGER` and `TRUNCATE` for
   `anon` and `authenticated` to every new object in `public` before any `GRANT` runs, so a grant
   only ever adds. Each new table needs
   `revoke truncate, references, trigger on <obj> from authenticated;` and
   `revoke all on <obj> from anon;`. `TRUNCATE` is the one that matters, because **RLS does not
   apply to it**. CLAUDE.md says to assume this will be forgotten; it was forgotten here.
2. **`notify pgrst, 'reload schema';`** at the end of the file. Without it the API keeps serving a
   cached schema and rejects the new columns with errors that read as though they do not exist.

### One collision this document could not have known about

§1.5 and the E3 prompt require a deep link at `#/event/:id`. There is no URL router today (§12 C7)
— but the hash is **not unused**. Supabase returns auth tokens in it, and `js/boot.js` already
reads them:

- `js/boot.js:25` — `if (/[#&]type=recovery/.test(window.location.hash)) showResetScreen();`
- `js/boot.js:131` — `if (/[#&]type=signup/.test(window.location.hash)) { ... }`

A hash router that claims the whole fragment will swallow `#access_token=…&type=recovery` and break
password reset and signup confirmation. Password reset is already the last unverified item on the
v1 launch-blocker list, so this is not a small collision. **The router must check for the Supabase
token shapes first and yield to them**, and E3's test list must gain a case: a password-reset link
still reaches the reset screen after the router exists.

### Two things this document is right about, confirmed

- `favorites.item_type` already accepts `'event'`, so the star on the event card works with no
  migration. (`sql/2026-09-04_favorites_allow_event.sql`)
- `can_manage_events` and `can_check_in` are frozen into the flag set and reach nothing yet, as §0
  states. (`sql/2026-09-05_flag_set.sql`)

### The open question that is still open

§9 Q1, the deployed domain. Still undecided as of 2026-09-06; deployment is described as soon. The
QR encodes it and the Supabase redirect allow-list needs it, so **E2 cannot finish without it** —
the QR would encode a URL that resolves to nothing at a real door. E1 and E3 can proceed without
it. §9 Q3 is closed by E-C4 above.

---

## 0. Where this sits

Built and live: organizations, memberships, `can_act()`, the flag guard, the admin Organizations
tab, the org console (announcements, polls, profile, roster). `can_manage_events` and
`can_check_in` are frozen into the flag set and reach nothing yet.

Not built: any student-facing org surface at all. Zero students can see any of it.

**The scope observation worth making before anything else.** The last plan put the org directory at
Phase 1 on the reasoning that "a student with nothing to look at is the larger failure." Events
change that calculation. An event card carries the org logo, name and verified badge inline — the
feed *introduces* the organizations by itself. So the full directory + org profile page can shrink
to a **thin org page** (header, description, contact block, upcoming events, past events, follow
button) reached by tapping the org name on an event card. That is most of Phase 1's value for a
fraction of Phase 1's work, and it removes a session from the critical path to launch.

Recommendation: fold the thin org page into the events sessions and defer the browsable directory
until there are more than a handful of orgs to browse. A directory of five clubs is a list, not a
directory.

---

## 1. The decisions that shape everything

### 1.1 The events feed is chronological. It is not a ranked feed.

The marketplace feed answers "what is available." The events feed answers "what is happening, and
when." Those are different axes, and the second one has a hard property the first does not: **an
event has an expiry that is a fact about the world, not a policy choice.** A listing is stale
because nobody bought it; an event at 6pm Tuesday is simply over at 8pm Tuesday.

Consequences, all of which fall out of that one sentence:

- Sort is `starts_at` ascending. There is no relevance ranking, no "recommended," no engagement
  ordering. Chronology is the product.
- Pastness is **computed from the clock, never stored**. No cron job flips a flag. The visibility
  view compares `ends_at` to `now()`. This is the same discipline as `visible_listings` and it is
  right for the same reason: one rule, one place.
- The feed is **not** shown inside the marketplace listings feed, and marketplace listings are not
  shown in the events feed. Events left `listings` for a reason.

### 1.2 Two search surfaces, one query function

Kal's description: the events page has a search icon that leads to "the real search place, which
will also look different from how it is now."

Read carefully, that is two things, and they should stay two things:

| | Global search (existing tab) | Events search (new, opened from the events header) |
|---|---|---|
| Corpus | listings, books, **and events** | events only |
| Entry state | category tiles, recent searches, saved shortcut | **orgs you follow**, event-type tiles, date chips (This week / This weekend / Next week) |
| Axis | what a thing is | when a thing is, and who is running it |
| Result shape | sectioned by type | date-grouped, poster cards |

Build the matching logic **once** as a function over `visible_events` and call it from both. The
global search Events section and the scoped events search must never diverge — that divergence is
exactly the bug already flagged for `book_listings` bypassing `visible_listings`.

The events search entry state matters more than the query state, for the same small-corpus reason
established in the search session: with twelve events this semester, a typed query returns nothing
most of the time. Zero results is Tuesday, not an error. The entry state is the product.

### 1.3 Media: photos in V1, video by link

Kal wants photos and video. Split them, because they cost wildly different amounts.

**Photos: yes, now.** Multiple images per event, a gallery on the detail page, the first one (or the
dedicated `poster_url`) as the card image. Same Supabase Storage pattern already working for
`listing-photos`, but a **separate `event-media` bucket** — event posters are portrait (~4:5) and
listing photos are not, and one bucket with two aspect conventions produces a broken grid.

**Video: link only, in V1.** Not because video is hard to display, but because of three specific
costs that are easy to miss until the bill arrives:

1. **Egress.** A 30-second phone video is 30–60 MB. One popular recap video watched 200 times is
   more bandwidth than the entire marketplace has used to date. This is the single fastest way to
   leave a Supabase free tier.
2. **No transcoding.** An iPhone `.mov` is often HEVC/H.265, which will not play in Chrome on
   Android. Uploads without a transcoding step produce videos that work on the uploader's phone and
   nowhere else — the worst possible failure, because the person who posted it cannot reproduce it.
3. **Moderation surface.** Video is the hardest media to review, and there is a daily human review
   commitment in the moderation model already pitched to administrators.

So: a `video_link` media kind holding an Instagram / YouTube / TikTok URL, rendered as a link card
with a thumbnail. Clubs already post video to Instagram; the platform does not need to host it to
benefit from it. If uploads become a real request later, the schema below already has the row shape
for it — `kind='video'` is one value in one check constraint.

**Recap media is the part worth building.** `event_media.phase` is `'promo'` or `'recap'`. Promo
photos go up before; recap photos go up after. Recap media is what makes a past event worth looking
at, it is what makes an org profile look alive to a student deciding whether to join, and it costs
one column. It is also, quietly, the best retention hook in this whole document — a student who
attended will open the app to see whether the photos are up.

### 1.4 The door has three ways in, and they all write one row

Kal's design — student taps "I'm here," pops up on the officer's screen, officer taps attended,
plus name search, plus walk-ins — is correct, and it is correct for a reason worth stating: **the
officer's eyes are the security layer.** No geofence, no rotating code, no cryptography. A human at
a door confirming a face is both cheaper to build and harder to fool than anything in software.

Three paths, one table:

| Path | Who acts | Status written | `check_in_method` |
|---|---|---|---|
| Officer finds them by name and taps | Officer | `checked_in` | `officer` |
| Student taps "I'm here", officer confirms | Both | `self_reported` → `checked_in` | `self_confirmed` |
| Student taps "I'm here", event trusts self check-in | Student | `checked_in` | `self_auto` |
| Officer adds someone who never registered | Officer | `walk_in` | `walk_in` |

`check_in_method` is a column that **cannot be backfilled**. Six months from now, "how much of our
attendance data is officer-verified" is a question an advisor will ask and the analytics will not be
able to answer unless this column exists from the first event. Add it now; it costs nothing.

`trust_self_checkin` is a per-event boolean, default false. A club fair with 300 people through a
lawn does not want a confirm queue; a members-only leadership dinner does. Let the officer decide
per event rather than deciding for them globally.

### 1.5 The QR code needs no scanner code

This is the most useful thing in this document for shipping speed.

The instinct is to build a QR scanner into the app — `getUserMedia`, a decoding library, camera
permissions, the iOS Safari permission dance. **Do not.** Every modern phone camera app reads QR
codes natively and opens the URL. So if the QR simply *encodes a URL to the event page*, the entire
scanning half of the feature is free and already installed on every student's phone.

```
QR on the poster  →  https://<domain>/#/event/123  →  event page  →  [Register] / [I'm here]
```

Generating the QR is a client-side library (`qrcode.js` or equivalent, bundled — **not** an external
QR image API, which would send every event URL to a third party). The officer gets a "Download QR"
button in the console that produces a printable PNG.

Two things this exposes that must be built with it, or the QR is a dead end:

1. **A real deep link.** `#/event/:id` must be a route that works cold, from a fresh tab, on a phone
   that has never opened the app. This is new — the app has been navigated tab-by-tab until now.
2. **Return-to-intent after login.** A student who scans and is signed out must land on login, and
   then be returned **to that event**, not dumped on the home feed. Store the intent before
   redirecting, restore it after the session resolves. This is the single most likely thing to be
   forgotten and the single most likely thing to make the QR feel broken at a real door.

Also: the deployed domain has to be in the Supabase redirect allow-list before any of this works
from a phone. Local `127.0.0.1:5500` will not be reachable from a student's phone at a door.

**The honest limit, stated so it is not discovered at the door.** A static printed QR is a URL, and
a URL can be texted to a friend who is not there. Nothing short of rotating codes or geofencing
prevents that, and both have real costs — CampusGroups, the direct incumbent, offers exactly this
tradeoff: a static printable flyer, *or* a code that refreshes every 30 seconds to stop sharing,
never both. Moodle's rotating-QR attendance module generates a steady stream of support tickets from
students who could not check in. For V1: static QR, and the confirm queue is what makes the number
honest. Rotating codes are a later upgrade with a known support cost attached.

**The fallback that requires no work.** Anyone whose phone fails at the door is checked in by the
officer typing their name. That path already exists and always works. There is no need to build a
manual numeric code as a backup — the backup is a person.

### 1.6 Ratings are gated on attendance, and that is the whole design

Anyone can have an opinion about a party they did not attend. **Only a student with a check-in row
can rate an event.** One rule, and it does three jobs at once:

- The feedback means something, because it comes from people who were there.
- Check-in acquires a reason to exist for the *student*, not just the org — "check in and you can
  tell them how it went."
- It closes the loop that makes the door worth staffing.

Four more decisions that come with it:

**Window.** Opens when the event ends; closes seven days later. A rating left in November about a
September event is noise, and an open-forever window means the officer never knows when the numbers
are final.

**Private to the org, not public on the profile.** A public star average on a club with six
attendees is a permanent scar from one bad night, and at that size the person who left it is
guessable. The existing analytics rule already covers this — suppress any cell under five — and it
applies here identically: **no aggregate is displayed at all below five responses.** Officers see
"3 responses — not enough to summarise yet" and the comments, nothing more. Public ratings can come
later if volume ever supports it; they cannot be un-published once they exist.

**Anonymity, described honestly.** `user_id` is stored — it has to be, to enforce one rating per
person and to check attendance — but officers never see it. The officer-facing read goes through a
`SECURITY DEFINER` function that returns the aggregate and the comment text with no identity
attached, guarded by `can_act('can_view_analytics', org_id)`. The student-facing copy must say
what is true and no more: *shared anonymously with the organizers — though at a small event, a
detailed comment may still be recognisable.* Do not write "completely anonymous." It is not, at
eleven attendees, and the first person who feels identified will be right.

**Delivery is passive, because there is no notification layer.** No push, no email — none of that
exists yet. The ask is a card at the top of the events feed and in the Going tab: *"How was Fall
Club Fair?"* for anyone with a check-in row and no rating, inside the window. That is free, it is
the correct first use of the "you have something to do" slot, and when the notification layer does
land, the post-event prompt is the second thing it carries (the first is event cancellation, which
is already the named blocker A1).

---

## 2. Schema — additions to the campus engagement plan

Present this as SQL first, run manually in the Supabase SQL editor, confirm, then write app code.
Every verification file gets re-run afterward — including the ones unrelated to this change. That
rule already cost two false green results this month.

```sql
-- ── events: additions beyond §4.3 of the campus engagement plan ──────────────
alter table public.events
  add column if not exists trust_self_checkin boolean not null default false,
  add column if not exists checkin_opens_at   timestamptz,   -- null → starts_at - 1 hour
  add column if not exists checkin_closes_at  timestamptz;   -- null → ends_at + 1 hour

-- ── media: photos now, video links now, video uploads later ──────────────────
create table if not exists public.event_media (
  id          bigserial primary key,
  school_id   uuid   not null,
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

-- ── the door ─────────────────────────────────────────────────────────────────
-- event_registrations already exists per §4.3. These are the additions.
alter table public.event_registrations
  add column if not exists check_in_method text
    check (check_in_method in ('officer','self_confirmed','self_auto','walk_in')),
  add column if not exists self_reported_at timestamptz;

-- status gains 'self_reported'. Drop and recreate the check constraint by name;
-- look the name up first with:
--   select conname from pg_constraint
--   where conrelid = 'public.event_registrations'::regclass and contype = 'c';

-- Walk-ins may have no account at all. user_id must be nullable, and the
-- unique(event_id, user_id) pair still behaves correctly because Postgres
-- permits multiple NULLs in a unique index. Confirm the column is nullable
-- before building the walk-in path — this is easy to miss and fails at the door.

-- ── feedback ─────────────────────────────────────────────────────────────────
create table if not exists public.event_feedback (
  id         bigserial primary key,
  school_id  uuid   not null,
  event_id   bigint not null references public.events(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists event_feedback_event_idx on public.event_feedback (event_id);
```

**RLS, in words, then written properly in the session:**

- `event_media` — SELECT follows the event's own visibility (public if the event is visible,
  members-only if it is). INSERT/UPDATE/DELETE gated on `can_act('can_manage_events', org_id)`.
- `event_feedback` — INSERT permitted only when a row exists in `event_registrations` for
  `(event_id, auth.uid())` with status in `('checked_in','walk_in')`, **and** the event has ended,
  **and** it ended within seven days. SELECT: own row only. Officers never read this table
  directly.
- `get_event_feedback(event_id)` — `SECURITY DEFINER`, guarded by
  `can_act('can_view_analytics', org_id)`, returns `{count, avg, comments[]}` with no user ids and
  returns a null average when `count < 5`. **The suppression lives in the function, not in the UI**
  — a suppression rule enforced only in JavaScript is not a suppression rule.
- Check-in writes go through an RPC (`check_in_attendee`, `self_report_arrival`), never a bare
  UPDATE, so the method and the actor are recorded in one transaction alongside the `activity_log`
  row. Same reasoning as `change_listing_status`: app code cannot be trusted to remember the log.

---

## 3. Officer side — what an organizer sees

### 3.1 Creating an event

Progressive disclosure, as already specified: a short required block (title, date/time, location,
type, poster) then collapsed toggles for *Add registration*, *Add photos*, *Limit audience*,
*Repeat this event*. Every required field is a reason someone abandons the form.

Two additions from this document:

- **Photos** section: drag or pick multiple, reorder, one is the card image. Uploading to
  `event-media`, not `listing-photos`.
- **Add a video link** field inside the photos section, with the same URL validation posture used
  for ticket links — accept Instagram / YouTube / TikTok, reject payment domains.

### 3.2 The event's console page (one event, everything about it)

Reached from the console Events list. Tabs or sections, in this order, because this is the order an
organizer needs them in over an event's life:

1. **Overview** — the poster, the details, edit, cancel (reason required), duplicate, and the
   **Download QR** button with a print-ready sheet: poster image, title, date, the QR, and one line
   of instruction (*Scan to sign up or check in*).
2. **Registrations** — the list, capacity state, CSV export.
3. **Door** — see §5. Only appears within the check-in window, and only for a holder of
   `can_check_in`.
4. **Recap** — after the event: upload recap photos, and the feedback summary.

The permission split already frozen into the flag set pays off exactly here: `can_manage_events`
gets 1, 2 and 4; `can_check_in` alone gets 3 and nothing else. A first-year working the door for one
evening receives the door and cannot post as the club. That separation is the reason the flag is
narrow, and this is the first screen where it becomes visible.

---

## 4. Student side

### 4.1 The events feed

Its own tab. Poster-first, vertically scrollable, chronological ascending, date-grouped with sticky
headers (*Today*, *Tomorrow*, then *Fri, Sep 11*).

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

- The org row is tappable and goes to the thin org page. The verified badge sits there and is the
  answer to "is this a real club or someone's Instagram."
- The star is **private** (saved). The calendar icon means **registered** and is **not** private —
  the org sees the name and email. This difference must be stated on the detail page, once, plainly,
  directly under the register button. Do not bury it.
- Above the first date group, **at most one** contextual card: a pending feedback ask, or "You're
  going to something today," or nothing. One slot, never a stack.
- Past events are not in the main list. A single *Past* chip reveals them, newest first, greyed —
  and past events with recap photos show a small photo count, which is the reason anyone would
  ever tap that chip.

### 4.2 Events search (the 🔍 in the header)

Opens a surface scoped to events. Entry state, top to bottom:

1. Search input, dominant.
2. **Orgs you follow** — a horizontal row of logos. Tapping one filters to that org's events. On a
   campus feed this is the most-used control and it is not a search at all.
3. **Date chips** — This week · This weekend · Next week · This month.
4. **Event type tiles** — Social, Academic, Sports, Service, Career, Arts, Meeting.

Query state: substring match over title, org name, location and description across `visible_events`,
grouped by date exactly like the feed, with a result count line. Empty results suggest broadening
(clear the date chip, try the org) rather than showing a bare *no results*.

Members-only events must be filtered by RLS, not by a JavaScript `.filter()`. A filter in JavaScript
is not a permission — that sentence is already in the project's own notes and this is the surface
where it will be tempting to forget it.

### 4.3 Event detail

Poster, org header, title, full date and time with **add to calendar** (a constructed Google
Calendar URL plus an `.ics` — watch the UTC conversion, it is the classic bug), location,
description, audience tags, the photo gallery, video link cards, register button with its capacity
state, and — while the check-in window is open — the **I'm here** button.

Register button states: `Register` · `You're going ✓` · `Full` · `Registration closed` ·
`Cancelled`. Cancelled events stay reachable by their registrants with a red banner and the reason,
even though the visibility view excludes them from the feed.

### 4.4 "I'm here"

Appears only between `checkin_opens_at` and `checkin_closes_at`. Three outcomes:

- Registered, event trusts self check-in — *Checked in ✓*, done.
- Registered, confirmation required — *Waiting for the organizer to confirm* — a persistent state
  on the page, not a toast that vanishes. The student must be able to see that their tap landed.
- Not registered — registers and self-reports in one action, if registration is open and there is
  capacity. This is the walk-up-and-scan case and it is most of the value of the QR.

### 4.5 Rating and feedback

For anyone with a check-in row, once the event has ended and within seven days: a card at the top of
the events feed and an entry in the Going tab. Five stars, an optional comment, one line of honest
copy about who sees it. Submitting replaces the card with a thank-you and it does not come back.

### 4.6 Profile

The icon row gains `📅 Going` — upcoming registered events first, past ones below, past ones showing
their rating state (rated / rate now / window closed).

---

## 5. The door — the officer's live screen

The single most important property: **it must work when everything else fails.** The name search
path never depends on the student's phone, the QR, or the network being good in a gym basement.

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

- **Arrivals queue** at the top: students who tapped *I'm here*. Newest first, with first name, last
  initial and class year. Confirm marks them `checked_in`; dismiss returns them to `registered` so
  they can be found by name instead. Poll every few seconds — websockets are not needed for a queue
  that peaks at a dozen rows.
- **Name search** filters as you type, last name first. Show class year and first initial in every
  row — *Daniel O. '26* and *Daniel O. '25* both walk through the door of a club fair and picking
  the wrong one is a silent error nobody ever notices.
- **Tap to check in**, with a five-second Undo. Undo, not a confirmation dialog: confirmations at a
  door slow a line that is already forming.
- **Counter** at the top, live.
- **Walk-in** captures name and email, records `walk_in`, and links to a profile if the email
  matches one. If it does not match, the row stands on its own with a null `user_id` — which is why
  that column must be nullable.

Known risk, not solved: no wifi in gyms and basements. Offline check-in is its own project. The
fallback is paper for that one event, and that is an acceptable answer to write down now rather than
discover later.

---

## 6. What is V1 and what is deferred

The goal is launching, so the line has to be drawn explicitly rather than by running out of time.

**In V1 — the events product is not credible without these**

- events schema, migration off `listings`, `visible_events`, RLS
- create/edit/cancel an event, poster + photos, from the console
- the student events feed, date-grouped, poster cards
- event detail with add-to-calendar and the photo gallery
- register / unregister, capacity enforced **in the database**
- the thin org page reached from the event card
- events search, scoped, with the follow/date/type entry state
- deep link `#/event/:id` + return-to-intent after login
- QR download for the officer (URL-encoding, no scanner)
- the door: name search, tap to check in, undo, counter, walk-in
- "I'm here" + the arrivals queue + `trust_self_checkin`
- `check_in_method` recorded on every check-in

**Deferred, deliberately**

| Deferred | Why it can wait |
|---|---|
| Video **uploads** | Egress and transcoding. Video links cover the need. |
| Recurrence | Materialising rows is the right answer; it is also a session. Duplicate-an-event covers 80%. |
| Members-only gating | The hardest RLS policy in the app, and it needs its own test pass with a non-member account. Ship events public-only first. |
| Waitlists | Promotion logic plus notifications. `Full` as a hard stop is fine. |
| Analytics rollups, CSV export | Needs attendance data to exist before it means anything. One event's worth of data is not a dashboard. |
| Public star ratings on org profiles | Cannot be un-published. Wait for volume. |
| Rotating QR codes | Known support cost, no benefit at this scale. |
| Offline door mode | Own project. Paper is the fallback. |
| Notification delivery | Blocks nothing here, but it is the named blocker for event **cancellation** — see below. |
| Full org directory | Five clubs is a list, not a directory. |

**The one deferral with a sharp edge.** Cancellation still has no delivery path. An event is
cancelled, and a registrant who does not open the app finds out at the door. The V1 mitigation is
passive and must be built: required reason, red banner on detail, cancelled state in the Going tab,
and the event stays reachable by its registrants. That is not adequate, it is merely honest, and a
cancellation email is the first thing the notification layer must carry when it lands.

---

## 7. Build sessions

Each: investigate → plan → **approve** → build → test → commit. Commit before starting as a restore
point.

| # | Session | Contents |
|---|---|---|
| **E1** | Schema + visibility + RPCs | `events` migration off `listings`, `event_media`, `event_feedback`, registration additions, `visible_events`, RLS, capacity RPC, check-in RPCs, verification file |
| **E2** | Officer: create, edit, media, QR | Console Events section, event form with progressive disclosure, `event-media` bucket, photo upload/reorder, video link, cancel with reason, QR download |
| **E3** | Student: feed, detail, register, thin org page | Feed with date groups, detail page, add-to-calendar, gallery, register/unregister, Going tab, deep link + return-to-intent |
| **E4** | Events search | Scoped search surface, shared match function, global search Events section pointed at `visible_events` |
| **E5** | The door | Officer door screen, name search, check-in RPC, undo, counter, walk-in, arrivals queue, "I'm here", `trust_self_checkin` |
| **E6** | Feedback | Rating card, submit, `get_event_feedback`, console Recap section, recap photo upload |

E1–E3 is a shippable events product. E5 is what makes it worth an administrator's attention. E4 and
E6 are small next to the others and can slot in either order.

---

## 8. Paste-ready prompts

### E1 — schema, visibility, RPCs

```
CONTEXT
CaldwellNest. We are building the events system described in
docs/nestrel-events-door-feedback-plan.md, which extends
docs/nestrel-campus-engagement-plan.md §4. Read both fully before responding.

STEP 1 — INVESTIGATE ONLY. NO CODE, NO SQL YET.
Report back:
1. Every place in the codebase that reads or writes listings rows with
   category='organization_event'. Function names and line ranges.
2. The exact current shape of any events data: which columns of `listings`
   and which keys inside the `details` JSON blob are used for event date,
   time, location, host.
3. Whether an `events` or `event_registrations` table already exists in the
   database, and if so its exact columns and constraints. Do not assume the
   plan document matches reality — check.
4. Whether `profiles.class_year` and `profiles.major` exist and whether they
   are nullable.
5. How the app currently routes between tabs, and whether any URL-based or
   hash-based routing exists at all.
6. Where the Supabase storage upload helper lives and which bucket it
   hardcodes.
Report these six things and stop.

STEP 2 — PLAN, FOR MY APPROVAL.
Then write: (a) the full SQL for the schema in §2 of the plan plus §4.3 of the
campus engagement plan, as one script I will paste into the Supabase SQL
editor by hand; (b) the RLS policies; (c) the RPC signatures; (d) the
migration for existing organization_event rows; (e) what could break.
I approve before anything is applied or any app code changes.

REQUIREMENTS THAT ARE NOT NEGOTIABLE
- Capacity is enforced in the database (trigger or RPC doing count+insert in
  one transaction). A client-side count will oversell the last seat.
- `event_registrations.user_id` must be NULLABLE, for walk-ins without an
  account. Confirm this explicitly in the plan.
- `check_in_method` exists from day one and is written by the RPC, never by
  app code.
- `get_event_feedback` is SECURITY DEFINER, guarded by can_act(), and returns
  a NULL average when fewer than 5 responses. The suppression is in the
  function, not the UI.
- Feedback INSERT requires an existing check-in row, a past event, and a
  7-day window — all in the policy.
- All lifecycle writes go through RPCs that also write activity_log rows,
  entity_type 'event'.

STEP 3 — AFTER I CONFIRM THE SQL RAN
Write sql/2026-XX-XX_verify_events.sql in the style of the existing
verification files: impersonate real students, assert refusals AND
permissions, roll everything back, report by raising an exception.
Minimum properties to assert:
 1. A non-officer cannot insert an event.
 2. An officer of a child club can insert an event for their club.
 3. A school admin can edit a club's event (authority flows down).
 4. A club officer CANNOT edit another club's event.
 5. Registering past capacity fails.
 6. A student cannot write check_in_method or status='checked_in' directly.
 7. Feedback insert without a check-in row fails.
 8. Feedback insert outside the 7-day window fails.
 9. get_event_feedback returns a null average at 4 responses and a number
    at 5.
10. A cancelled event is excluded from visible_events but is still readable
    by a registrant.

THEN re-run every other verification file in sql/ and report the results.
A green test not re-run is a memory, not evidence.

COMMIT
Commit before starting. Second commit: "Events schema, visibility and RPCs"
```

### E2 — officer surfaces

```
CONTEXT
Events schema is live (E1). Build the officer side per
docs/nestrel-events-door-feedback-plan.md §3.

STEP 1 — INVESTIGATE. Report: how the org console renders its sections and
gates them on can_act(); how the announcement composer handles its form; how
the existing photo upload helper works and what it hardcodes; what the
listing photo bucket's policies look like. Stop.

STEP 2 — PLAN FOR APPROVAL, then build:
- Console "Events" section, gated on can_manage_events: upcoming / past
  split, create, edit, duplicate, cancel (reason REQUIRED).
- Event form with progressive disclosure: required block (title, start
  date+time, location, event type, poster) then collapsed toggles for
  "Add registration" (capacity), "Add photos", "Add a video link".
- New `event-media` storage bucket, separate from listing-photos, with its
  own policies. Portrait ~4:5 display with cover-crop so the grid never
  breaks.
- Poster fallback: a deterministic gradient generated from a hash of the
  event id, so the same event renders identically on every device and every
  refresh. Never a blank card.
- Video link field: accept instagram.com, youtube.com, youtu.be, tiktok.com.
  Reject venmo, cashapp, zelle, paypal.me with an explanation, matching the
  existing ticket-URL validation posture.
- "Download QR" on the event: generate client-side with a BUNDLED library —
  do NOT call an external QR image service. Encodes the deep link
  https://<deployed-domain>/#/event/:id. Produce a printable sheet: poster,
  title, date, QR, and one line: "Scan to sign up or check in."

SCOPE BOUNDARIES — DO NOT:
- Do not build recurrence. Duplicate-an-event covers it for now.
- Do not build the student-facing feed, detail page, or search.
- Do not build any check-in UI.
- Do not add video FILE upload — links only.
- Do not touch the listings post form beyond removing the events branch,
  and if you remove it, replace it with a line pointing students at
  "ask your organization to post it."
- REFINE ONLY.

TEST BEFORE REPORTING DONE
1. A student with no officer membership sees no Events section.
2. A can_check_in-only officer sees no Events section either.
3. Create → appears in the console list and in the database.
4. Cancel without a reason is refused.
5. An event with no poster renders the same gradient twice in a row and on
   a reload.
6. A venmo.com video link is refused with an explanation.
7. The QR downloads and, scanned with a phone camera, opens the event URL.
8. Renders correctly at 390px.

COMMIT before and after. "Officer event creation, media and QR"
```

### E3 — student surfaces

```
CONTEXT
Officer side is live (E2). Build the student side per §4 of
docs/nestrel-events-door-feedback-plan.md.

STEP 1 — INVESTIGATE. Report: how the current Events tab renders and what it
shares with the marketplace feed card; whether ANY hash routing exists;
exactly how the app decides what to show after a Supabase auth session
resolves. Stop.

STEP 2 — PLAN FOR APPROVAL, then build:
- Events feed: chronological ascending over visible_events, date-grouped
  with sticky headers (Today / Tomorrow / "Fri, Sep 11"). Poster-first
  full-width cards: org logo + name + verified badge (tappable), poster,
  title, date · time · location, one social-proof line ("42 going ·
  18 spots left"), star (private save) and calendar icon (registered).
- A single contextual slot above the first date group. At most one card.
- "Past" chip revealing past events greyed, newest first, with a photo
  count where recap media exists.
- Event detail: poster, org header, title, full date/time, add to calendar
  (Google TEMPLATE URL + .ics — convert to UTC explicitly and test it),
  location, description, audience tags, photo gallery, video link cards,
  register button with all states (Register / You're going / Full /
  Registration closed / Cancelled).
- Directly under the register button, once, plainly: the organization will
  see your name and email. Do not bury it.
- Unregister frees the seat but keeps the row as status='cancelled'.
- Thin org page: logo, name, verified badge, description, contact block,
  Follow button, upcoming events, past events.
- Profile icon row gains "Going": upcoming registered first, past below.
- DEEP LINK: #/event/:id must work cold in a fresh tab on a phone that has
  never opened the app.
- RETURN-TO-INTENT: a signed-out visitor hitting #/event/:id lands on login
  and is returned TO THAT EVENT afterwards, not to the home feed. Handle the
  Supabase session-resolution race explicitly — an unresolved session and an
  absent session must not render the same way.

SCOPE BOUNDARIES — DO NOT:
- Do not modify the marketplace listing card. Build a separate event card.
- Do not build check-in, "I'm here", or ratings.
- Do not build events search — that is E4.
- Do not implement members-only gating; events are public-only for now.
- Do not build a calendar month grid.
- REFINE ONLY.

TEST BEFORE REPORTING DONE
1. An event whose end time has passed is absent from the main list and
   present under Past.
2. Registering twice is impossible; the button reflects state after reload.
3. Capacity full shows Full, and the last seat cannot be double-booked
   (test with two browsers).
4. Add-to-calendar lands at the correct local time, not shifted by hours.
5. Pasting #/event/:id into a fresh incognito tab: login → the event.
6. A cancelled event is gone from the feed but still reachable by its
   registrant, with the banner and reason.
7. Home feed, saved tab, profile listings and chat listing-cards render
   identically to before. Confirm you checked each.
8. 390px.

COMMIT before and after. "Student events feed, detail and registration"
```

### E5 — the door

```
CONTEXT
Registration works (E3). Build the door per §5 of
docs/nestrel-events-door-feedback-plan.md.

STEP 1 — INVESTIGATE. Report: the exact signature of the check-in RPCs from
E1; how the console gates sections on can_act(); whether any polling or
realtime subscription pattern exists in the codebase already. Stop.

STEP 2 — PLAN FOR APPROVAL, then build:
- Console "Door" section, gated on can_check_in ONLY (a can_check_in holder
  who lacks can_manage_events must reach the door and nothing else), and
  visible only inside the check-in window.
- Live counter "47 / 120".
- Arrivals queue at top: students who tapped I'm here, newest first, showing
  first name, last initial, class year. Confirm → checked_in. Dismiss →
  back to registered. Poll every few seconds; do not build realtime.
- Name search filtering as you type, last-name-first, every row showing
  class year and first initial.
- Tap to check in with a 5-second Undo. No confirmation dialog.
- "Add walk-in": name + email, status walk_in, linked to a profile if the
  email matches, standing alone with a null user_id if it does not.
- Student side: "I'm here" on the event detail page, visible only inside the
  window. Registered + trust_self_checkin → checked in immediately.
  Registered without it → a PERSISTENT "waiting for the organizer" state,
  not a toast. Not registered → register and self-report in one action if
  registration is open and capacity allows.
- trust_self_checkin toggle on the event form, default off, with one line
  explaining what it does.

SCOPE BOUNDARIES — DO NOT:
- Do not build a QR scanner. The phone camera is the scanner.
- Do not build offline mode.
- Do not build analytics, rollups or CSV export.
- Do not build rotating or expiring codes.
- REFINE ONLY.

TEST BEFORE REPORTING DONE
1. A can_check_in-only officer reaches Door and cannot reach Events.
2. Officer check-in writes check_in_method='officer'; self-confirm writes
   'self_confirmed'; trusted self writes 'self_auto'; walk-in writes
   'walk_in'. Verify in the database, not the UI.
3. Undo within 5 seconds fully reverts the row.
4. Two officers checking in the same student at once does not error or
   double-count.
5. A walk-in whose email matches no profile is created with user_id null.
6. "I'm here" outside the window is not offered.
7. A student cannot set their own status to checked_in via the API — try it.
8. 390px, one-handed. This screen is used standing up.

COMMIT before and after. "Event check-in: door, arrivals queue, walk-ins"
```

E4 (events search) and E6 (feedback) get their own prompts once E3 and E5 land — both are small, and
both depend on knowing exactly how the feed's card and the check-in rows ended up being shaped.

---

## 9. Open questions to decide before E1

1. **Deployed domain.** The QR encodes it and the Supabase redirect allow-list needs it. This has
   been an open placeholder in the legal pages too; the door is the deadline for deciding it.
2. **Does registering require a verified `@caldwell.edu` account?** Recommend yes — same gate as
   posting and messaging, enforced at the data layer.
3. **`class_year` on `profiles` — required or nullable?** The door's disambiguation row depends on
   it. If nullable, the row must render gracefully without it rather than showing a blank.
4. **Hard stop or waitlist at capacity.** Recommend hard stop for V1.
5. **Is the feedback window seven days?** It is a number, not a principle; pick it deliberately.
6. **Does the thin org page replace the Phase 1 directory for now?** Recommend yes, and revisit at
   roughly fifteen active orgs.
