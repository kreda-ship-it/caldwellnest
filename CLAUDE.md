# CaldwellNest — Project Guide for Claude Code

## About this project
CaldwellNest is a student-only housing and campus-life platform for Caldwell University students.
The whole prototype currently lives in a single file: `index.html`.
It has two interfaces sharing one in-memory data store (`DB`):
- Student interface: sign-up gate (.edu email), listings feed + filters, post a room, in-app messaging, NestBot AI helper.
- Admin dashboard: approve/reject/pin listings, student + verification queues, live site editor, broadcasts, analytics, data export, health monitor.

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

## Known limitations (do NOT "fix" these silently — they're planned for Phase 3 backend)
- Data is in-memory only; it resets on browser refresh. Real persistence is a future task.
- NestBot calls the Anthropic API from the browser, so it only works inside Claude's preview, not a plain browser. A real backend will fix this later.
