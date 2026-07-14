# Nestrel listing lifecycle & favorites — architecture plan

Save as `docs/nestrel-listing-lifecycle-plan.md`. Deep-dive companion to Section 2 of `docs/nestrel-feature-expansion-plan.md` — this supersedes that section's sketch.

---

## 0. Design principles (the multi-school foundation)

1. **Status vs visibility are separate concepts.** `status` is the poster-controlled lifecycle state. *Visibility* is computed: `status = 'active' AND (expires_at IS NULL OR expires_at > now()) AND owner not suspended`. One canonical rule, defined once (a Postgres view or shared query helper), used by feed, search, chat listing-cards, and share pages. When rules evolve (new school, new policy), they change in one place — this is what makes it scale to many schools without drift.
2. **Soft states, never deletion.** Sold/withdrawn/expired listings stay in the database. History powers analytics, admin audits, and "you sold 3 items this semester" moments. Hard delete exists but is rare and logged.
3. **Append-only activity log as the single source of truth.** Every lifecycle event writes a log row. The admin portal reads the log; it never reconstructs history from current state.
4. **Everything scoped by school_id** — listings, saves, log rows. Row Level Security enforces school boundaries; super-admin sees across schools.
5. **The system nudges data freshness.** Marketplaces die from stale listings. Deadlines, expiry, and (later) renewal reminders keep the feed trustworthy — the thing that actually differentiates CaldwellNest from a chaotic GroupMe.

## 1. What the majors do, and what we take

- **Facebook Marketplace**: seller marks items pending → sold; pending stays visible with a badge (buyers know to hurry or move on); on sold, asks "did you sell it on Marketplace?" → **take pending state, sold prompt (analytics gold), status badges in feed**.
- **Craigslist**: everything auto-expires (7–45 days by category) with one-click renew → **take per-category default deadlines + easy renewal; this is the anti-staleness engine**.
- **eBay / Depop**: seller hub with per-listing stats (views, watchers/saves) and one-tap relist of ended items → **take view + save counts on My Listings, relist from expired**.
- **OfferUp / Vinted**: saved/favorited items keep showing in your saved list when sold, greyed with a badge, so you learn the outcome instead of items vanishing mysteriously → **take this exact favorites behavior**.
- **Airbnb**: saving prompts nothing, syncs everywhere, heart is instant/optimistic → **take the interaction feel: optimistic UI, no confirmation dialogs**.
- What we skip (for now): paid bumping/promoting (OfferUp), offers/price negotiation in-line (Depop), shipping states (eBay). Campus trades are in-person; keep the machine small.

## 2. The state machine

States: `active`, `pending`, `sold` (label "Claimed" for free items), `withdrawn`, `expired`, `removed_by_admin`. Events end as `completed` (auto, at end time).

Transitions:
- create → active
- active ⇄ pending (poster toggles; deal fell through → back to active)
- active | pending → sold (poster) — optional prompt: "Did you sell it through CaldwellNest?" yes/no stored as `sold_via_platform`
- active | pending → withdrawn (poster, change of mind) → can reactivate
- active → expired (automatic when expires_at passes)
- expired → active (renew: one tap, sets a new deadline; increment `renew_count`)
- any → removed_by_admin (admin, requires a reason; poster notified; only an admin can restore)
- Account suspension does NOT change status — it flips visibility via the owner check, so unsuspension restores everything exactly as it was. (This closes the suspension-hides-listings gap.)

Visibility per state: active = visible; pending = visible with "Pending" badge; all others hidden from feeds/search. Deep links to a hidden listing show a graceful "No longer available" page with 2–3 similar active listings — never a 404 (people will hit these from shared chat links).

## 3. Schema (Supabase)

```sql
-- listings (and mirrored on book_listings; events get their own variant)
ALTER TABLE listings ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','pending','sold','withdrawn','expired','removed_by_admin'));
ALTER TABLE listings ADD COLUMN expires_at timestamptz;      -- optional deadline
ALTER TABLE listings ADD COLUMN status_changed_at timestamptz DEFAULT now();
ALTER TABLE listings ADD COLUMN sold_via_platform boolean;   -- null until sold prompt answered
ALTER TABLE listings ADD COLUMN view_count integer NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN renew_count integer NOT NULL DEFAULT 0;

-- favorites
CREATE TABLE saved_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL REFERENCES profiles(id),
  listing_id uuid NOT NULL REFERENCES listings(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, listing_id)
);

-- single source of truth for admin history (generic: listings today, events/accounts later)
CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  actor_id uuid,                 -- null for system actions (auto-expiry)
  actor_role text NOT NULL CHECK (actor_role IN ('student','school_admin','super_admin','system')),
  entity_type text NOT NULL,     -- 'listing' | 'event' | 'account' | ...
  entity_id uuid NOT NULL,
  action text NOT NULL,          -- 'created','status_changed','edited','renewed','removed','restored',...
  old_value text,
  new_value text,
  metadata jsonb,                -- e.g. removal reason
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity_log (school_id, created_at DESC);
CREATE INDEX ON activity_log (entity_type, entity_id);
```

Canonical visibility, defined once:
```sql
CREATE VIEW visible_listings AS
SELECT l.* FROM listings l
JOIN profiles p ON p.id = l.poster_id
WHERE l.status IN ('active','pending')
  AND (l.expires_at IS NULL OR l.expires_at > now())
  AND p.is_suspended = false;
```
Every read path (feed, search, chat picker, saved list resolution) queries this view — never raw listings with ad-hoc WHERE clauses.

Expiry mechanics: no cron needed at our scale — the view treats past-deadline rows as invisible at query time, which is always correct. A nightly `pg_cron` job that flips status to 'expired' and writes log rows becomes worthwhile only when we add expiry reminders/notifications (post-beta).

Default deadlines by category (poster can override or clear): marketplace 30 days, free items 14, housing 60, books end-of-semester preset, events = event end time (not editable). Craigslist proved defaults + easy renewal beats asking people to think.

## 4. Student experience — poster side

My Listings (profile): filter chips All / Active / Pending / Sold / Expired / Withdrawn. Each card: thumbnail, title, price, status badge, "expires in 12d" countdown, and two small stats — views, saves (the eBay/Depop motivator: sellers who see 9 saves lower their price instead of abandoning).

Tap a card → manage sheet:
- Active: Mark as pending · Mark as sold/claimed · Edit · Change deadline · Withdraw
- Pending: Mark as sold · Back to active · Edit
- Sold/Withdrawn: Relist (creates fresh active state, keeps history) · Delete
- Expired: Renew (one tap, new deadline) · Mark as sold ("actually it sold, I forgot") · Withdraw

Every action is optimistic in the UI, writes the status change + a log row in one transaction (Supabase RPC function `change_listing_status(listing_id, new_status, ...)` so app code can't forget the log).

## 5. Student experience — buyer side & favorites

- Heart icon on every listing card and detail page. Tap = instant save/unsave, optimistic, no dialog. Save count on the detail page ("7 students saved this") — social proof + urgency.
- Saved tab lives in the profile (a "Saved" section; could later earn a spot in the Search entry state as "Your saved items").
- Saved list shows status honestly (the Vinted behavior): active items normal; pending badged; sold/expired items stay listed but greyed with their badge, with a swipe/long-press to remove. Buyers learn outcomes; the list self-explains.
- Post-beta option: notify savers when a saved item's price drops or its deadline nears. The `saved_listings` table already supports it — no schema change later.
- Chat listing-cards (the share feature) read from the same status: a card shared last week shows a "Sold" badge today. One visibility rule, everywhere.

## 6. Admin side

- Listings view: table filtered by school / status / category / student, powered by `visible_listings` plus hidden states. Row actions: view, remove (reason required → log row + student notification), restore.
- Activity view: reverse-chronological feed from `activity_log`, filterable by student, action, entity type, date. Because the log is append-only and generic (`entity_type`), suspensions, event changes, and org actions land in the same stream later — the admin portal's single timeline.
- Metrics this unlocks (per school, because everything is school-scoped): active listings by category, median time-to-sold, % `sold_via_platform` = true (the number that proves CaldwellNest works — your future pitch slide), expiry/renewal rates (staleness health).
- Super-admin (Nestrel level) sees the same views across all schools; school admins see only theirs via RLS.

## 7. Multi-school & scale notes

- RLS policies: students SELECT visible listings where school_id = their school; posters UPDATE only their own rows and only via the RPC; saved_listings readable/writable only by the owning student; activity_log INSERT via RPC only, SELECT by admins scoped to school.
- Cross-school browsing (the parked radius feature) becomes a policy change on the view, not a rewrite — another payoff of the single visibility rule.
- Indexes: listings (school_id, status, expires_at), saved_listings (student_id), activity_log as above. Fine into the hundreds of thousands of rows.

## 8. Build sessions (each: plan → approve → build → test → commit)

1. **Schema + RPC**: run the SQL above (presented first, confirmed run), create `change_listing_status` RPC and the view; point feed/search queries at `visible_listings`. Test: existing listings unaffected, all default to active.
2. **My Listings manage UI**: status chips, manage sheet, all transitions, deadline picker with category defaults, optimistic updates. Test: every transition, badge correctness in feed, pending badge visible to others.
3. **Favorites**: heart on cards + detail, saved section in profile with honest statuses, save counts. Test: save/unsave persistence, sold item greys out in saved list.
4. **Admin**: listings table with remove/restore + reason, activity feed with filters. Test: student action → log row appears; admin removal → hidden from student feed + logged.
5. **Polish**: "No longer available" page with similar listings, sold prompt (`sold_via_platform`), status badges on chat listing-cards.

Beta scope = sessions 1–4 (5 if time). Post-beta: expiry reminder notifications, price-drop alerts for savers, pg_cron expiry job, relist analytics.
