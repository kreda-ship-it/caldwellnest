# CaldwellNest — Project Guide for Claude Code

## About this project
CaldwellNest is a student-only housing and campus-life platform for Caldwell University students.
It has two interfaces sharing one data store (`DB`, defined in `js/config.js`):
- Student interface: sign-up gate (.edu email), listings feed + filters, post a room, in-app messaging, NestBot AI helper.
- Admin dashboard: approve/reject/pin listings, student + verification queues, live site editor, broadcasts, analytics, data export, health monitor.

## File layout (split out of the old single file on 2026-07-11)
`index.html` is now **markup only**. All styling is in `styles.css`. All JavaScript lives in `js/`,
loaded in this order by plain `<script src>` tags at the bottom of `index.html`:

| File | Holds |
|---|---|
| `js/config.js` | Supabase client, the shared `DB` store, category constants, all global state. **Loads first.** |
| `js/utils.js` | `openModal` / `closeModal` / `toast` |
| `js/data.js` | Loading + shaping Supabase data: `loadListings`, `loadBooks`' callers, `isListingLive`, `browseItems`, `initStudent` |
| `js/auth.js` | Login/logout (student + admin), signup, email verification, suspension screen, `getEffectiveUser()` |
| `js/profile.js` | School picker, waitlist, availability checks, public profile, edit profile |
| `js/listings.js` | Browse feed: pages, filters, cards, detail modal, owner lifecycle actions, posting |
| `js/books.js` | Course catalog, typeahead, book detail, posting a book |
| `js/media.js` | Photo resize/upload/delete, galleries, avatars |
| `js/messages.js` | Chat: sidebar, conversation mode, swipe-to-reply, realtime, listing sharing |
| `js/admin.js` | The entire admin dashboard |
| `js/boot.js` | Starts the app. **Must load LAST** — the only file that *runs* code instead of defining it. |

Two rules this layout depends on:
- **They are plain scripts, NOT ES modules.** Every function must stay global, because the HTML is full
  of inline `onclick="foo()"` handlers. Never add `type="module"` and never add `export`.
- **Function hoisting no longer spans files.** Inside one file, order doesn't matter. Across files it does:
  a file can only *call* something from a later file at runtime (inside a function), never at load time.
  That is why `boot.js` is last.

## Two standing rules
1. **One area per change.** When working on one feature, do not edit other feature files in the same change.
   That is the whole point of the split — a messages fix must never be able to break listings.
2. **All CSS goes in `styles.css`.** Never add a `<style>` block to `index.html`. New UI should use classes
   defined in `styles.css`. (Known debt: JS-generated HTML still contains many inline `style="..."` attributes.
   Migrating them is a slow future cleanup — but don't add new ones.)

## Read this before starting work
`docs/AUDIT-2026-07.md` — full code audit (known bugs by severity, with a suggested order of attack).
Line numbers in it refer to the pre-split file; search by function name instead.

## About me (the founder)
- I'm Kal, the founder. I'm learning to code from scratch — I am NOT an experienced developer.
- Explain things in plain language. Avoid jargon, or define it the first time you use it.
- I'm a fast, motivated learner and I want to understand what's happening, not just get results.

## How I want you to handle my requests (REFINE-FIRST WORKFLOW)

I am working on getting better at writing clear prompts. So:

### When my request is rough, vague, or short:
DO NOT edit files immediately. Instead:
1. Rewrite my request as a clear, specific instruction. A good instruction names:
   - WHERE: the file and (if known) the section/element
   - WHAT: the exact thing to change
   - RESULT: what it should look/behave like afterward
2. Briefly explain WHY the sharpened version is clearer, so I learn.
3. Ask me any questions you need answered before proceeding.
4. WAIT for me to approve before making any edit.

### When my request is already clear and specific:
Go ahead and make the change — but still show me the before/after and let me approve before saving.

### If I start my message with "REFINE ONLY":
Only sharpen the prompt and ask questions. Do not touch any files until I say go.

### If I start my message with "JUST DO IT":
Skip the refining and make the change directly (I've decided it's clear enough).

## Always explain your changes
- After editing, tell me in plain language what you changed and where.
- For anything complex, explain the "why" so I learn.

## Go slow and safe
- One focused change at a time unless I ask for more.
- Never delete large sections or rewrite the whole file unless I explicitly ask.
- If a request is risky or could break something, warn me first.
- When unsure what I mean, ask instead of guessing.

## Teach as you go
- Point out good habits when they come up.
- When relevant, remind me of the git step after a change (add, commit, push).

## Supabase rules (hard-learned — follow exactly)
- After ANY schema change (`ALTER TABLE`, `CREATE POLICY`, `GRANT`, new table), always tell me to also run `NOTIFY pgrst, 'reload schema';` — Supabase's API caches the schema and will reject new columns until then, with errors that look like the column doesn't exist.
- When code and database disagree about a column name, the DATABASE is ground truth. Verify what actually exists (Table Editor, or `information_schema.columns`) before renaming anything in code. Plans/roadmap notes describe intentions, not reality. (A session once renamed working code to match a stale ROADMAP note — don't repeat that.)
- Mobile gestures: use `touchstart/touchmove/touchend` with `preventDefault()` on a non-passive touchmove — NOT pointer events, which iOS Safari cancels silently.

- **Supabase attaches DEFAULT PRIVILEGES to every new object in `public`** — tables AND views — before any `GRANT` of yours runs. A new table arrives already holding `REFERENCES`, `TRIGGER` and `TRUNCATE` for both `anon` and `authenticated`. So a `grant` only ever ADDS; the extras must be revoked explicitly. Every new-object file should end with `revoke truncate, references, trigger on <obj> from authenticated;` and `revoke all on <obj> from anon;`. `sql/2026-09-01_saved_items.sql` was the first file to get this right, which is why `favorites` is the cleanest table in the database. It has been missed twice since (2026-09-04, on the org tables and on `public_profiles`) — assume you will forget it, and check with the grant query in `sql/2026-09-03_capture_rls_and_grants.sql`.
- **`TRUNCATE` is the one that matters on a table**, because **RLS does not apply to it**: it is a table-level operation, so one statement ignores every policy above it. On a view it is unreachable and the revoke is only consistency.

## Browser cache (hard-learned 2026-09-04)
- **Every local asset carries a `?v=` marker** — `js/*.js` and `styles.css` in `index.html`. **Bump it whenever you change a JS or CSS file**, or the browser serves the old one and you debug code that isn't running. The value is a date plus a letter (`2026-09-04a`) because more than one change can land in a day. It only has to differ from last time.
- Before this existed, the tags were bare, so after editing a JS file the browser kept serving the old one. `index.html` often refreshed when the JS did not, which produced **new markup calling into old code** — a convincing fake bug.
- **A change that appears to have had no effect at all is a cache symptom more often than a logic one.** Before debugging, hard refresh: `Cmd+Shift+R` / `Ctrl+Shift+F5`.
- The tell on 2026-09-04: a new admin tab appeared but rendered blank, *and* its heading showed the raw section name. Two unrelated edits in the same file both missing points at the file being stale, not at either edit.
- Not to be confused with `Uncaught SyntaxError: Unexpected token '<'`. On a real `.js` file that means the server returned an HTML page (usually a 404) where JavaScript was expected. Prefixed `VM###` instead, it just means something was pasted into the console.

## Known limitations (do NOT "fix" these silently — they're known and planned)
- Core data (accounts, profiles, listings, messages, books) persists in Supabase. The ADMIN side still has in-memory pieces that reset on refresh: the live site editor content (`DB.content`) and `DB.settings`. Persisting those is a future task.
- **There are two activity logs, and only one is real.** `admin_activity_log` (a Supabase table) is the audit trail: written by `logEvent()`, read back by `fetchActivityLog()` with filtering, paging and undo. `DB.log` is a leftover in-memory array — still written in 21 places, but read by nothing since 2026-09-03. **Write new logging through `logEvent()`, never `DB.log`.** Removing the dead writes is a pending cleanup (it spans `js/admin.js` and `js/listings.js`).
- NestBot calls the Anthropic API from the browser, so it only works inside Claude's preview, not a plain browser. A real backend will fix this later.
