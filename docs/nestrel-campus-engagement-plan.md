# Nestrel campus engagement system — architecture plan

Save as `docs/nestrel-campus-engagement-plan.md`.

Companion to `docs/nestrel-listing-lifecycle-plan.md`. This supersedes the Stage 3 events page
sketch from the previous session — that work was never sent to Claude Code, so nothing is lost.

**Scope**: organization hierarchy, permissions, the org console, the events data model,
registration, check-in, and analytics. Six workstreams, not one session.

**Revision note (rev 2)** — changed since first draft, after decisions made in planning:
the school is now the root organization rather than a separate concept; the login model is
resolved; two permission flags added (`can_moderate`, `can_manage_admins`); `is_super_admin`
and its privilege-escalation risk added as a hard requirement; the permission rule is now a
real Postgres function; bootstrap is specified. Details in §2 and §10.

---

## 0. What this actually is

This is not an events page. It is a campus engagement system — the product category that
Anthology Engage, Presence, and CampusGroups sell to colleges for five figures a year.

Caldwell currently runs on paper forms, bulletin boards, and scattered Instagram accounts.
That is the problem being solved, and it is the first CaldwellNest feature a school
administrator would actively want rather than tolerate.

Two consequences:

1. **Permissions come first.** Nothing else can be built safely until the hierarchy exists,
   because everything else asks "is this person allowed to do that."
2. **Credibility is the feature.** The verified badge is not decoration. It is the answer to
   "is this a real club or someone's Instagram account," which is the current failure mode.

---

## 1. Prior art — what to take and what to skip

| Product | Take | Skip |
|---|---|---|
| **Luma** | Poster-first cards, very few required fields, generated gradient when no image, one-tap register, calendar-add immediately after | Its ticketing/payments |
| **Eventbrite** | Capacity, check-in by name search, attendee export, per-event analytics | Payments, refunds, fees |
| **Meetup** | Following an *organization* rather than an event | Paid group subscriptions |
| **Partiful** | Poster + minimal fields beats structured forms for a young audience | Its whole social layer |
| **Campus Labs / Presence** | Officer rosters with titles, per-org analytics visible to Student Life, org provenance | Co-curricular transcripts, budget/funding workflows, room reservation |

Deliberately not building: room booking, funding requests, advisor approval chains, co-curricular
transcripts. All real incumbent features, all swamps.

---

## 2. Hierarchy and permissions

### 2.1 The school is the root organization

```
organizations
└─ Caldwell University       type='school'       parent_id = null
   ├─ Student Life           type='department'   parent_id = Caldwell
      ├─ Chess Club          type='club'         parent_id = Student Life
      └─ BSU                 type='club'         parent_id = Student Life
   ├─ Athletics              type='department'   parent_id = Caldwell   (later)
   └─ Career Services        type='department'   parent_id = Caldwell   (later)
```

School, department, and club are **the same table** with a `type` column and a `parent_id`.

The reason: a department is just an organization that can create child organizations, and a school
is just a department that sits at the root. Separate tables would mean writing every permission
check, every profile page, and every analytics query two or three times — and it breaks the first
time Athletics wants to post as a department *and* own sub-teams.

**School admins are `org_memberships` rows on the school org row.** There is no separate
`school_admins` table and no separate permission system. Because `can_act()` walks `parent_id`
upward, a Caldwell school admin can act on Chess Club automatically — authority flows downward
through ancestry, for free.

**`school_id` is unchanged everywhere in the existing codebase.** The school org row carries a
`school_id` pointing at its own school uuid; every descendant org carries the same value. Nothing
on `listings`, `profiles`, or any existing table needs migrating.

### 2.2 Schema

```sql
create table public.organizations (
  id              bigserial primary key,
  school_id       uuid not null,
  parent_id       bigint references public.organizations(id),
  type            text not null check (type in ('school','department','club','office')),
  name            text not null,
  slug            text not null,
  description     text,
  logo_url        text,
  is_verified     boolean not null default true,   -- see 2.5
  is_active       boolean not null default true,
  -- contact block
  contact_email   text,
  office_location text,          -- "Student Center, Room 214"
  phone           text,
  instagram       text,          -- handle only, not URL (matches profiles convention)
  website         text,
  handshake_url   text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (school_id, slug)
);

create table public.org_memberships (
  id                    bigserial primary key,
  org_id                bigint not null references public.organizations(id) on delete cascade,
  user_id               uuid   references public.profiles(id) on delete cascade,
  pending_email         text,   -- set when added before the person has signed up; see A15
  role                  text not null check (role in ('member','officer')),
  title                 text,   -- "President", "Social Chair", "Director"
  status                text not null default 'active'
                          check (status in ('pending','active','removed')),
  can_post              boolean not null default false,
  can_manage_members    boolean not null default false,
  can_view_analytics    boolean not null default false,
  can_message           boolean not null default false,
  can_create_child_orgs boolean not null default false,
  can_moderate          boolean not null default false,
  can_manage_admins     boolean not null default false,
  added_by              uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  unique (org_id, user_id)
);

alter table public.profiles add column is_super_admin boolean not null default false;
```

Permissions are **explicit grants**, not implied by a role name. Different departments will have
different capabilities — hardcoding `if role == 'department_admin'` guarantees a rewrite the first
time that is untrue.

Officers are members with flags set. Plain members have all flags false. One table.

### 2.3 The president vs. operations distinction

"The president makes major decisions but shouldn't be solving easy stuff" is a permissions problem,
and the grant model handles it directly:

| Flag | President | Ops staff |
|---|---|---|
| `can_manage_admins` | ✓ add/remove other school admins | ✗ |
| `can_create_child_orgs` | ✓ | ✓ |
| `can_moderate` | ✓ | ✓ |
| `can_view_analytics` | ✓ | ✓ |
| `can_manage_members` | ✓ | ✓ |
| `can_post` | ✓ | ✓ |
| `can_message` | ✓ | ✓ |

Same row shape, different flags. The president holds the one authority nobody else does: granting
authority. Multiple school admins is the normal case, not an exception — they are simply multiple
rows on the school org.

### 2.4 Follow vs. member — do not conflate these

Members-only postings only work if following and membership are different things:

| | Follow | Member |
|---|---|---|
| Who grants it | The student, one tap | The organization |
| Approval | None | Officer adds, or approves a request |
| Means | "show me your events" | "I belong to this org" |
| Unlocks | Events in your feed | Members-only events |

If following *were* membership, "members-only" would mean nothing — anyone can follow.

```sql
create table public.org_follows (
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  org_id     bigint not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);
```

Membership requests: student taps "Request to join" → `org_memberships` row with `role='member'`
and `status='pending'` → officer approves in the console.

### 2.5 Verification is provenance, not a checkbox

An org is verified **because a department created it**. It is not a field someone toggles — it is a
consequence of who created the row. `is_verified` defaults true and is only false for orgs created
outside the hierarchy, which in v1 cannot happen.

That is what makes the badge trustworthy, and it is the structural answer to fake orgs.

### 2.6 One permission rule, as a Postgres function

```
can_act(user_id, action, org_id):
  is_super_admin                                       → true
  active membership on org with the matching flag      → true
  active membership on any ANCESTOR org with the flag  → true   (walk parent_id upward)
  otherwise                                            → false
```

Written once as a Postgres function. RLS policies call it. No ad-hoc permission checks anywhere —
same discipline as `visible_listings`.

A client-side mirror lives in `js/orgs.js` for **hiding UI only**. RLS is the real enforcement.
This must be stated in a comment at the top of that file, because the standing project principle is
that UI-only gating is a launch blocker.

Note the direction: authority flows **downward** only. A Chess Club officer has no authority over
Student Life.

### 2.7 The login model — resolved

Two different situations, two different answers:

| Situation | Credential | Why |
|---|---|---|
| Nestrel operator (Kal's main admin email) | **Separate account**, `is_super_admin=true` | Genuinely a different entity — a platform operator, not a Caldwell student |
| Caldwell school admin (Kal's `@caldwell.edu`) | **Same account** as the student profile | Same human wearing a hat |
| Club officer | **Same account** as their student profile | Same human wearing a hat |

So: a separate credential where the identity genuinely differs, a shared credential where one
person holds a role.

**The console is a separate surface, not a separate login.** Officers get a "Switch to org console"
entry; the console has its own route, its own nav, and an org identity in the header. That delivers
the separation without shared club passwords.

Three reasons the credential stays personal:

1. **Attribution.** `activity_log` must answer "which officer cancelled this event." A shared club
   login makes every row say "Chess Club."
2. **Offboarding.** A president graduates every year. Personal credentials mean removing a
   membership row, not rotating a password among four people.
3. **Orgs may not have their own email addresses** — with personal credentials the question does
   not arise.

### 2.8 Bootstrap — exactly one manual step

1. **In Supabase, by hand, once:** set `is_super_admin = true` on the Nestrel operator profile.
2. Everything after that happens through the UI: create Caldwell (school) → add the
   `@caldwell.edu` account as school admin → create Student Life (department) → create clubs.

### 2.9 Privilege escalation — hard requirement

`is_super_admin` on `profiles` is a total compromise of the permission system if a user can write
it on their own row. This is the single most common Supabase mistake: an UPDATE policy of
`using (auth.uid() = id)` permits writing *any* column, including role columns.

The `profiles` UPDATE policy must explicitly exclude `is_super_admin` (and any future role column)
from self-writes. This is not optional and gets its own test.

---

## 3. The org console

A separate surface at `/org` (or `#page-org-console`). Not a separate login.

**Sequencing note:** the console is workstream 2. Workstream 1 puts basic org management into the
*existing* admin page so orgs can be created at all. Do not build the console early.

**Entry point**: if a user has any `org_memberships` row with `role='officer'`, a "Switch to org
console" control appears in their profile menu. Students with no memberships never see it. Officers
in more than one org get a picker.

**Header**: `Chess Club — President` at all times, so there is never ambiguity about what identity
an action is taken under.

**Console sections** (club-level):

| Section | Contents |
|---|---|
| Events | Create, edit, cancel, duplicate. Upcoming / past split. |
| Registrations | Per-event registrant list, capacity, CSV export |
| Check-in | Live door mode, last-name search (§6) |
| Members | Roster, add/remove, titles, permission toggles, pending requests |
| Messages | Org inbox — replies signed with the officer's title |
| Analytics | Per-event and rollup (§7) |
| Org profile | Name, logo, description, contact block, Handshake link |

**Department-level** adds: create/deactivate child orgs, assign first officers, cross-org analytics.

**School-level** adds: create departments, manage school admins (gated on `can_manage_admins`), and
everything above across all orgs in the school.

---

## 4. Events data model

### 4.1 Events leave `listings`

Events currently live as `listings` rows with `category='organization_event'`. That was correct
when an event was a post. It does not survive this build. Events now need an owning organization,
capacity, registrations, recurrence, audience targeting, member-gating, check-in state, and an
external ticket URL — none of which belong on `listings`, and all of which make the `listings` RLS
policies worse.

**Migration**: copy existing `organization_event` rows into `events`, mapping the `details` blob's
`event_date` into real columns. Then remove the event branch from the student post form — after
this, only orgs post events. Small migration; do it now rather than after more rows exist.

### 4.2 Fields — required vs. optional

Rule: **required only if the event is unusable without it.** Every required field is a reason
someone abandons the form.

| Field | Status | Notes |
|---|---|---|
| Title | **Required** | |
| Organization | Auto | From console context. Never typed. |
| Start date + time | **Required** | |
| End time | Optional | Defaults to +2h. Drives auto-hide. |
| Location | **Required** | Free text in v1. Not a room-booking integration. |
| Poster image | **Required with escape** | Upload, or auto-generate a gradient card from the title. Never allow a blank card. |
| Description | Optional | Nudge for it — empty descriptions read as low-effort |
| Event type | **Required** | Social / Academic / Sports / Service / Career / Arts / Meeting |
| Registration on? | Optional toggle | Off by default |
| Capacity | Optional | Field only appears when registration is on |
| External ticket URL | Optional | Paid events only (§5) |
| Audience tags | Optional | Label, not gate (§4.5) |
| Members-only | Optional toggle | This *is* a gate (§4.5) |
| Recurrence | Optional | §4.4 |
| Contact | Optional | Defaults to the org's contact block |

**Form design**: a short required block, then progressive disclosure — "Add registration",
"Add a poster", "Repeat this event", "Limit audience" as collapsed toggles. This is what makes it
feel light. Luma does it well; copy the pattern.

### 4.3 Schema

```sql
create table public.events (
  id                  bigserial primary key,
  school_id           uuid   not null,
  org_id              bigint not null references public.organizations(id),
  created_by          uuid   not null references public.profiles(id),  -- the human officer
  title               text   not null,
  description         text,
  poster_url          text,               -- null → gradient fallback
  event_type          text   not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz,
  location            text   not null,
  status              text   not null default 'published'
                        check (status in ('draft','published','cancelled','completed')),
  registration_open   boolean not null default false,
  capacity            integer,            -- null = unlimited
  external_ticket_url text,
  members_only        boolean not null default false,
  audience_tags       text[],             -- ['freshmen','nursing'] — display + filter only
  recurrence_group_id uuid,               -- shared by materialized instances
  cancelled_reason    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on public.events (school_id, starts_at);
create index on public.events (org_id, starts_at desc);

create table public.event_registrations (
  id              bigserial primary key,
  event_id        bigint not null references public.events(id) on delete cascade,
  user_id         uuid   not null references public.profiles(id) on delete cascade,
  name_at_signup  text not null,          -- snapshot; profile may change later
  email_at_signup text not null,
  status          text not null default 'registered'
                    check (status in ('registered','cancelled','checked_in','walk_in')),
  checked_in_at   timestamptz,
  checked_in_by   uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  unique (event_id, user_id)
);
```

**Capacity must be enforced in the database, not the client.** Two students tapping the last seat
simultaneously is a real race. Either a `before insert` trigger that counts and raises, or a
registration RPC doing count and insert in one transaction. Client-side count checks will oversell.

### 4.4 Recurrence — materialize, do not compute

Recurring events are one of the genuinely hard problems in software. The full model is an RRULE plus
an exception list plus per-instance overrides, and it produces bugs for years.

**v1: generate real rows up front.** "Repeats weekly on Tuesdays until Dec 15" creates ~15 event
rows sharing a `recurrence_group_id`. Each is independently editable and cancellable. Cap the
generator at 20 instances.

Less elegant than a rule engine, dramatically less likely to break, and it makes per-instance
registration natural — each Tuesday has its own attendee list, which is what an org actually wants.

Editing later offers "this event" or "this and all future" (delete-and-regenerate the tail).

### 4.5 Audience tags vs. members-only — two different mechanisms

**Audience tags are a label.** "For freshmen" shows on the card and works as a filter. It does not
prevent a junior from registering. A hard gate needs class-year data you can trust, and
self-reported data is not that; the support cost of "the system wrongly locked me out" outweighs
the benefit.

**Members-only is a real gate**, enforced in RLS — a non-member cannot read the row at all, not
merely fail to register. This is the hardest RLS policy in the app and needs its own test pass.

### 4.6 Visibility rule

Same discipline as `visible_listings` — define it once:

```sql
create view public.visible_events as
select e.* from public.events e
join public.organizations o on o.id = e.org_id
where e.status = 'published'
  and o.is_active = true
  and coalesce(e.ends_at, e.starts_at + interval '2 hours') > now();
```

Members-only filtering happens in RLS on top of this, since it depends on the requesting user.

Every read path uses this view. Cancelled events are excluded here but must still be reachable by
their registrants (§8, A1).

---

## 5. Payments — the line does not move

External link only. `external_ticket_url` → outbound link → done.

The reason, stated plainly so it survives future temptation: the moment CaldwellNest touches money
it is arguably a payment facilitator, inheriting chargebacks, refunds, PCI scope, and
money-transmission questions. None of that is survivable for a student-run platform.

Two requirements:

1. A visible line on any paid event: payment is handled by the organization; CaldwellNest is not a
   party to the transaction.
2. **Validate the URL.** Reject `venmo.com`, `cash.app`, `zelle`, `paypal.me` and personal handles
   with an explanation. Otherwise someone pastes one on day two.

---

## 6. Check-in

1. Officer opens Check-in for an event on their phone.
2. Search box filters the registrant list as they type — last-name first.
3. Tap a row → flips to checked-in, green, with a 5-second Undo.
4. Counter at top: `47 / 120 checked in`.

Two things that always come up at a real door:

- **Duplicate last names.** Show class year and first initial in the row to disambiguate.
- **Walk-ins.** People who never registered. Needs an "Add attendee" path capturing name + email
  and recording `status='walk_in'`, so analytics can distinguish planned from actual.

Noted risk, not solved in v1: gyms and basements have no wifi. Fully offline check-in is its own
project. Flag it; the fallback is paper for that one event.

---

## 7. Analytics

**Per event**: registered, checked in, no-show rate, walk-ins, registration timeline (when people
signed up relative to the event), breakdown by class year and major.

**Per org rollup**: events run, total attendance, average attendance, follower growth, repeat
attendee rate — the number that actually indicates a healthy club.

**Department rollup**: the same across child orgs, plus which orgs are dormant.

Three constraints:

1. **Class year and major come from `profiles`.** They exist. Confirm whether they are required at
   signup — if nullable, "Unknown" is a real bucket every chart must show rather than silently
   dropping people.
2. **Suppress small buckets.** Any demographic cell under ~5 shows as "<5". Otherwise an org can
   infer "the one senior who attended was X." On a campus this size that is real re-identification.
3. **CSV export** of the attendee list. Small to build, high value, first thing an advisor asks for.

---

## 8. Student-facing UI

**Events browse** — poster-first, Instagram-shaped:

```
  What's happening                          [filter]

  ┌──────────────────────────────────────────┐
  │  [org logo] Chess Club  ✓                │
  │                                          │
  │           [ POSTER IMAGE ]               │
  │                                          │
  │  Fall Club Fair                  ★   🎟  │
  │  Tue Sep 2 · 6:00 PM · Main Hall Lawn    │
  │  42 going · 18 spots left                │
  └──────────────────────────────────────────┘
```

Org identity at top with the verified check. Poster dominant. Two icons bottom-right: **star**
(saved, private) and **event icon** (registered). Minimal text — date, time, location, one social
proof line. Everything else lives on the detail page.

**Detail page**: poster, org header (tappable → org profile), title, full date/time with
add-to-calendar, location, description, audience tags, register button with capacity state, and —
if paid — the external ticket link plus its disclaimer.

**Register button states**: `Register` → `You're going ✓` → `Full` → `Registration closed` →
`Cancelled`. Directly under it, once, plainly: *the organization will see your name and email.*
Do not bury this. The star is private; this is not, and the difference has to be visible.

**Add to calendar** is a URL, not an integration. Construct a
`calendar.google.com/calendar/render?action=TEMPLATE&...` link, and emit an `.ics` file for Apple
Calendar. A couple of hours, no OAuth. **Watch the timezone conversion** — Google's TEMPLATE
parameter wants UTC, and this is the most common bug in this feature.

**Profile tabs** (the TikTok-style icon row): `Listings` · `★ Saved` · `🎟 Going` · `Following`.
Going shows upcoming registered events first, past ones below.

**Org profile page**: logo, name, verified badge, description, contact block (email, office, phone,
Instagram, website, Handshake), Follow button, upcoming events, and past events as history — past
events are credibility, not clutter.

---

## 9. Build sequence

| # | Workstream | Why here | Size |
|---|---|---|---|
| 1 | Organizations, memberships, `can_act()`, RLS, **org management in the existing admin page** | Nothing else is safe first. Nobody can post until this exists. | Full session, 3 stages |
| 2 | Org console shell + org profile CRUD + context switcher entry | The surface everything else hangs on | Full session |
| 3 | `events` table, migration, post form with progressive disclosure | Data layer before UI | Full session |
| 4 | Student browse + detail + org profile page | The visible payoff | Full session |
| 5 | Registration, capacity, calendar-add, Going tab, follow | Needs 3 and 4 | Full session |
| 6 | Check-in + analytics + CSV export | Needs registration data to exist | Full session |

Workstream 1 stages: (1) schema + `can_act()` + RLS, run manually in Supabase; (2) `js/orgs.js`
permissions module + bootstrap; (3) org management UI inside the **existing** admin page — not the
console.

Recurrence slots after 5, or defers. Members-only gating rides with 5 but needs its own RLS test
pass. Following is the cheapest thing here and could ship with 4.

**This displaces the search rebuild again, correctly** — search will need an Events section reading
from a table that does not exist until workstream 3.

---

## 10. AUDIT — gaps in this plan

Grouped by severity. This section is the point of the document.

### Blockers

**A0. Privilege escalation on `profiles`.** See §2.9. If a student can set `is_super_admin` on their
own row, nothing built on top of the permission system means anything. Must be closed in workstream
1 stage 1 and tested explicitly by attempting the write as a normal student.

**A1. Cancellation has no delivery path.** An event gets cancelled; registrants must be told. There
is no notification layer in CaldwellNest today — it is on the roadmap and unbuilt. Minimum viable:
`status='cancelled'` with a required reason, a red banner on the detail page, and the event showing
as cancelled in the Going tab. That is passive — a student who does not open the app finds out at
the door. **A cancelled-event email is the first thing the notification layer must carry**, and
this feature is the reason to build it.

**A2. Edits after registration have the same problem.** Time or location changes are functionally a
cancellation for anyone who does not re-check. Same fix, same dependency.

**A3. Capacity race.** Enforce in the database. Client-side counting oversells the last seat.

**A4. Members-only enforced in RLS, not UI.** A members-only event must be unreadable to a
non-member, not merely unregisterable. Needs its own test pass with a non-member account.

### Needs a decision

**A6. Waitlist or hard stop when full.** Recommend hard stop for v1; the `Full` button state must
exist and look obviously different from `Register`. Waitlists mean promotion logic and
notifications.

**A7. Un-registering.** Students must be able to cancel a signup, and it must free the seat.
Recommend yes, with the row kept as `status='cancelled'` rather than deleted so no-show analytics
stay honest.

**A8. Officer offboarding.** A president graduates. Removing them must not orphan their events —
events belong to the org (`org_id`), not the person (`created_by`). Confirm the console has a
remove-officer path and that removal does not cascade to events.

**A9. Org deactivation.** A club goes dormant. `is_active=false` hides it and its future events via
the view, but past events should remain on the org profile as history. Confirm that is the intent.

**A10. Poster image storage and aspect ratio.** Existing bucket is `listing-photos`. Posters are
portrait (roughly 4:5); listing photos are not. Recommend a separate `event-posters` bucket with its
own size limit, and a fixed display aspect with cover-crop so the grid never breaks.

**A11. Gradient fallback must be deterministic.** Generate from a hash of the event id or title so
the same event has the same gradient on every render and device. A gradient that changes on refresh
looks broken.

**A12. Verification gate on registration.** Posting and messaging require `@caldwell.edu` +
confirmed email. Does registering? Recommend yes — same gate, same enforcement layer.

**A13. Can students still post events at all?** After this, no — events are org-only. That removes a
capability students currently have. Confirm, and decide what the post form says when someone looks
for the events option (recommend a line pointing to "ask your org to post it").

### Noted, not solved in v1

**A14. Offline check-in.** Real risk, own project. Documented in §6.

**A15. Officers added before they sign up.** Student Life adds an e-board by email; some have not
made accounts yet. Handled with `pending_email` on the membership row, resolved to `user_id` at
signup. Without it, onboarding an org requires everyone to sign up first, in order.

**A16. Jobs / Handshake postings.** Orgs posting jobs with a Handshake apply link: the
`handshake_url` field is on the org profile now. A job *post type* is a separate entity — evergreen,
no date — and belongs with the services work. Flagged, not built.

**A17. FERPA-adjacent exposure.** A student-run platform collecting attendance data that a
university department then uses touches student records. Not a beta blocker, but it belongs in the
existing legal review queue alongside the marketplace disclaimer and subprocessor list.

**A18. `activity_log` reuse.** Org creation, membership changes, permission-flag changes, event
cancellation, and admin removals all write to the existing append-only `activity_log` with
`entity_type` of `'organization'`, `'membership'`, `'event'`. Do not invent a second log. This is
also where personal credentials pay off — the log records which officer acted.

**A19. Search gets harder, not easier.** Its Events section now reads `visible_events` instead of a
`listings` filter, and must respect members-only. Fold into the search rebuild spec.

**A20. Timezone.** Single campus, all `America/New_York`. Store `timestamptz` regardless, and
convert explicitly for the Google Calendar link. See §8.

### Resolved since rev 1

- **Login model** — §2.7.
- **Bootstrap / who is school admin** — §2.8. The school is the root org; school admins are
  memberships on it.

---

## 11. Open questions

1. Waitlist or hard stop at capacity (A6).
2. Are `class_year` and `major` required at signup, or nullable (A7 / §7)?
3. Confirm students can no longer post events directly (A13).
4. Confirm registration requires student verification (A12).
