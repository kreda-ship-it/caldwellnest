# Nestrel responsive UI overhaul — plan & Claude Code prompts

Goal: an app-native mobile experience (Pinterest/WhatsApp-style chrome) and a cleaner desktop layout, driven by screen width. Maximize content space on phones; make navigation thumb-reachable.

**Prerequisite (do first, separately):** Fix the Tier 1 unwanted-reload bug (misfiring `onAuthStateChange` redirect). This overhaul requires constant scroll/navigation testing on the phone, and random redirects to the landing page will make it impossible to tell UI bugs from auth bugs. Commit that fix before starting Session 1.

---

## Part 1 — Design specification (the "what")

### 1.1 Breakpoints & detection
- Mobile: viewport width ≤ 768px. Desktop: > 768px.
- Implement with CSS media queries for layout, plus one JS helper: `const mq = window.matchMedia('(max-width: 768px)')` with a change listener that toggles a `mobile` class on `<body>`. All JS behavior checks this single source of truth — no scattered `window.innerWidth` reads.
- Add/verify `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` (viewport-fit=cover is required for safe-area insets).

### 1.2 Mobile top bar
- Fixed bar, ~56px tall.
- Left: school instance name ("CaldwellNest"), tappable → Nestrel landing page.
- Right: profile avatar circle (current position preserved), tappable → profile personalization page.
- Scroll behavior: hide on scroll down, reveal on scroll up.
  - Track scroll delta (last scrollY vs current) inside a `requestAnimationFrame`-throttled scroll listener.
  - Hide = `transform: translateY(-100%)` with `transition: transform 200ms ease`; never `display:none` (layout jump).
  - Always visible when scrollY < 56px (top of page). Ignore deltas < ~8px to avoid jitter. Ignore rubber-band overscroll (negative scrollY on iOS).

### 1.3 Mobile bottom tab bar (persistent)
- Fixed to bottom, ~56px + `env(safe-area-inset-bottom)` padding (iPhone home indicator).
- Five items, left to right: **Home** (feed), **Search** (search + full filter UI), **Plus** (create listing — visually emphasized, filled circle), **Messages**, **Events**.
- **Plus** opens a bottom-sheet chooser: Marketplace, Free, Housing, Books, Events. Selecting one routes to that category's listing-detail creation form. (Books uses the structured-fields form, not a marketplace category.)
- **Events** tab is browse-first: look around, register for an event, and add-to-calendar / mark it.
- Active tab state (color/weight). Optional unread badge on Messages (see open decisions).
- Content area gets `padding-bottom: calc(56px + env(safe-area-inset-bottom))` so nothing is hidden behind it.
- Bottom bar does NOT hide on scroll — it is persistent (only the top bar hides).

### 1.4 Conversation mode (mobile)
When a specific conversation is open:
- Global top bar and bottom tab bar are hidden (toggle a single `chat-open` class on `<body>`; CSS handles the rest).
- Chat header replaces top bar: back chevron (returns to conversation list, restores normal chrome), other student's avatar + name (+ verified indicator).
- Composer replaces bottom bar: **plus button** (opens listing picker so students can share a listing into the chat), auto-growing text input, **send icon**.
- Send triggers: tap the icon; on desktop, Enter sends (Shift+Enter = newline); on mobile, Enter inserts a newline (standard mobile behavior) and send is tap-only.
- Shared listings render in the thread as a compact card (thumbnail, title, price), tappable → the listing.
- Keyboard handling: use `height: 100dvh` for the chat view and test that the composer stays visible above the on-screen keyboard (fall back to a `visualViewport` resize listener if needed on iOS Safari).

### 1.5 Desktop
- Phase A (Sessions 1–4): desktop untouched. All mobile chrome lives behind the ≤768px media query.
- Phase B (Session 5, optional before beta): replace horizontal top nav with a vertical left sidebar — school name at top, the same five destinations as icons + labels, profile at bottom. This unifies the mental model with mobile without cramming desktop into a phone layout.

### 1.6 Code-organization constraints
- Everything currently lives in `index.html`. New chrome must be additive: new prefixed classes (`m-topbar`, `m-tabbar`, `m-chatbar`, `chat-open`), old mobile nav hidden via media query — do not restructure existing desktop DOM.
- Strongly consider doing the planned CSS extraction as Session 0 of this project: this overhaul adds a lot of CSS, and extracting first gives a clean diff and a safe restore point. If skipping, at minimum group all new CSS in one clearly-commented block.

---

## Part 2 — Decisions (resolved)

1. **Plus button** — RESOLVED: bottom-sheet chooser first (Marketplace / Free / Housing / Books / Events), then route to that category's creation form.
2. **In-chat listing picker** — RESOLVED: a search field across ALL listings, with a filter chip row beneath it (same visual pattern as the existing All / Housing / Technology filter row) offering two scopes: `My listings` and `{other student's chosen display name} listings`. The other person's name is pulled from their profile display name.
3. **Shared-listing message schema** — RESOLVED: extend the Supabase messages table with explicit columns (`message_type` = 'text' | 'listing', `listing_id`). Not JSON. SQL to be run in the Supabase dashboard and confirmed before rendering code is written.

Still open:
- **Scroll-hide scope** — top bar hides on all scrollable pages, or only feed/browse pages? Recommendation: all pages except conversation mode (which has its own chrome). *(Needed before Session 1.)*
- **Messages badge** — unread count on the Messages tab now, or defer past beta? Fine to defer. *(Session 2 or later.)*
- **Desktop sidebar timing** — Session 5 before or after the Aug 2 soft beta? Cut-able if behind schedule. *(Decide at end of Session 4.)*

---

## Part 3 — Build sessions (paste-ready Claude Code prompts)

Run each in terminal Claude Code from `~/Documents/Amahle/caldwellNest`. Commit after each session (suggested messages included). Review in browser (and phone via local network or deployed preview) before moving on.

### Session 0 (optional but recommended): CSS extraction
> Extract all CSS from index.html into a new styles.css file linked from the head. Do not change any selectors, values, or ordering — this is a pure move, zero visual change. After extraction, verify the page renders identically. Do not refactor or "clean up" anything.

Commit: `refactor: extract CSS to styles.css (no visual change)`

### Session 1: Mobile chrome scaffolding (top bar + bottom tabs, no rewiring)
> We're adding app-style mobile chrome to CaldwellNest, behind a max-width 768px media query. Desktop must be completely unaffected.
>
> 1. Ensure the viewport meta tag includes viewport-fit=cover.
> 2. Add a matchMedia('(max-width: 768px)') listener that toggles a `mobile` class on body; use this as the single source of truth for mobile-only JS.
> 3. Build a fixed mobile top bar (class `m-topbar`, 56px): school name "CaldwellNest" on the left linking to the Nestrel landing page, the existing profile avatar on the right linking to the profile page. Hide the current mobile navigation UI via the media query — do not delete desktop nav markup.
> 4. Top bar scroll behavior: hide on scroll down (translateY(-100%), 200ms ease), show on scroll up, always visible near the top of the page, throttled with requestAnimationFrame, with an 8px delta dead zone.
> 5. Build a fixed bottom tab bar (class `m-tabbar`): five items — home, search, a visually emphasized circular plus button, messages, events — using our existing icon style. Height 56px plus env(safe-area-inset-bottom) padding. Add matching bottom padding to the main content container so nothing is hidden.
> 6. For this session the tabs only need correct layout and an active-state style; wire only Home and Messages to their existing views. Leave Search, Plus, and Events as no-ops with a TODO comment.
>
> Keep all new CSS in one clearly labeled block (or in styles.css). Do not restructure existing desktop DOM. Show me a plan of the exact insertion points before editing.

Commit: `feat(mobile): app-style top bar with scroll hide + bottom tab bar shell`

### Session 2: Wire the tabs (Search, Plus, Events)
> Wire the remaining mobile bottom tabs. [Insert your answers to open decisions 1 and 2 here.]
>
> 1. Search tab: opens the search view with the filter UI. On mobile, filters open as a bottom sheet.
> 2. Plus tab: [opens the create-listing flow / opens a bottom-sheet chooser with Marketplace, Free, Housing, Event options — per decision].
> 3. Events tab: opens the events section.
> 4. Correct active-tab highlighting for all five tabs, including when a view is opened by other means (e.g., from a listing card).
> 5. Verify the top-bar scroll behavior works on every one of these views.
>
> Plan first, then implement after I approve.

Commit: `feat(mobile): wire search, create, and events tabs`

### Session 3: Conversation mode chrome
> On mobile, opening a specific conversation should switch the app into conversation mode:
>
> 1. Toggle a `chat-open` class on body. CSS: when present, hide `m-topbar` and `m-tabbar`.
> 2. Chat header: back chevron (closes conversation, removes chat-open, restores normal chrome), the other student's avatar and name; tapping the name/avatar opens their profile.
> 3. Composer fixed at the bottom: a plus button (no-op with TODO this session), an auto-growing textarea (max ~4 lines then internal scroll), and a send icon.
> 4. Send behavior: tapping the icon always sends; on desktop, Enter sends and Shift+Enter inserts a newline; on mobile, Enter inserts a newline.
> 5. Chat view uses 100dvh; verify the composer stays above the on-screen keyboard. Also fix the existing message-bubble text overflow while we're here: overflow-wrap: anywhere and a max-width on bubbles.
> 6. Make sure browser back button also exits conversation mode cleanly (history state), so the top/bottom chrome never gets stuck hidden.
>
> Plan first, then implement after approval.

Commit: `feat(mobile): conversation mode with chat header and composer`

### Session 4: Listing sharing in chat
> Add listing sharing to the chat composer.
>
> 1. Supabase: extend the messages table with message_type ('text' | 'listing', default 'text') and a nullable listing_id foreign key to listings. Give me the SQL to run in the Supabase dashboard first; do not write rendering code until I confirm it ran.
> 2. The composer plus button opens a bottom-sheet listing picker: a search field across ALL listings at the top, and directly beneath it a filter chip row (reuse the existing All/Housing/Technology filter-row component style) with two chips — "My listings" and a chip labeled with the other student's chosen display name for their listings. Default to showing recent/all; chips scope the results.
> 3. Selecting a listing sends a listing-type message; render it in the thread as a compact card (thumbnail, title, price) that opens the listing when tapped.
> 4. Older plain-text messages must render exactly as before.
>
> Plan first, including the SQL, then implement after approval.

Commit: `feat(chat): share listings in conversations`

### Session 5 (optional, decide after Session 4): Desktop vertical sidebar
> Replace the desktop horizontal navigation with a fixed vertical left sidebar (only above 768px): school name at top, the same five destinations as icon + label items, profile avatar pinned at the bottom. Main content shifts right accordingly. Reuse the mobile tab wiring — same click handlers, different layout. No behavior changes, layout only. Plan first.

Commit: `feat(desktop): vertical sidebar navigation`

---

## Part 4 — Testing checklist (run after Sessions 1, 3, and 5)

- iPhone Safari and Android Chrome (real devices, not just DevTools): bottom bar clears the home indicator; top bar hide/show is smooth, no jitter at the top of the page.
- Rotate to landscape: chrome still usable, nothing overlapping.
- Conversation mode: open chat → chrome swaps; back chevron AND browser back both restore chrome; keyboard open → composer visible; long messages wrap inside bubbles.
- Deep links / refresh on each tab: correct view loads, correct tab highlighted, and no unwanted redirect to the landing page (regression check on the Tier 1 fix).
- Desktop at 769px and up: pixel-identical to before (Sessions 1–4) or new sidebar working (Session 5). Drag the window across 768px repeatedly — no broken in-between state.
- Verified badge, admin views, and NestBot untouched.

## Part 5 — Timeline fit

Rough sizing against the Aug 2 soft beta: Session 0 + 1 in one Saturday deep-work block; Session 2 in a second block or two strong commute-planning + one build session; Session 3 is the biggest (a full Saturday); Session 4 needs the schema decision plus a focused block; Session 5 is cut-able. If it's mid-July and Sessions 3–4 aren't done, ship the beta with Sessions 1–3 and defer listing-sharing — the chrome alone delivers most of the perceived upgrade.
