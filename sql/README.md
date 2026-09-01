# sql/

The database side of CaldwellNest, in files instead of only inside Supabase.

Until 2026-08-08 every schema change was typed straight into the Supabase SQL editor and
never written down. That is how the listing-lifecycle bug survived: a trigger and a
function that contradicted each other, with nothing in the repo to read or diff. If this
project were rebuilt from a fresh Supabase instance today, it would come back **broken**,
because the only correct copy of these rules lives in one hosted database.

This folder is the beginning of the fix. It is **not yet complete** — see "Still missing".

## How to run one

Supabase Dashboard → SQL Editor → paste the whole file → Run.

**Then always run this**, in the same editor:

```sql
NOTIFY pgrst, 'reload schema';
```

Supabase's API caches the database schema. Without the reload it keeps serving the old
one and rejects your new columns or functions with errors that read as though they don't
exist. Every file here ends with that line already — it is repeated in case you run only
part of a file.

## Safe to re-run

Every file uses `CREATE OR REPLACE`, so running one twice does nothing the first run
didn't already do. If you are unsure whether a fix was applied, **just run it again** —
that is cheaper than trying to remember.

## Files

| File | What it does |
|---|---|
| `2026-08-08_fix_owner_lifecycle_guard.sql` | Repairs the trigger function that blocked every owner status change on `listings`. |
| `2026-08-08_change_listing_status_any_transition.sql` | The lifecycle RPC. Lets any status move to any other; whitelists the legal values. |
| `2026-08-08_check_book_listings_guard.sql` | The `book_listings` owner guard as it really is. **Checked 2026-08-08: not affected, nothing to run.** Records why `current_user` must never be used in these functions. |
| `2026-08-08_align_owner_guards.sql` | Applied 2026-08-08. Makes both guards trust the caller's JWT role claim instead of a NULL user id. Its own test block needs ids filled in — prefer the verify file below. |
| `2026-08-08_verify_owner_guards.sql` | **Run this to check the guards.** Self-contained: finds its own ids, impersonates each caller type, rolls everything back. Reports by raising an exception — the error message is the report. |
| `2026-09-01_record_signup_consent.sql` | Adds `profiles.terms_accepted_at` / `terms_version` and teaches `handle_new_user` to record consent at signup. Applied 2026-09-01. |
| `2026-09-01_guard_consent_columns.sql` | Adds the consent columns to the privileged-columns guard, so a student cannot erase their own consent record. Also captures `guard_profile_privileged_columns` in full. |
| `2026-09-01_capture_profiles_triggers.sql` | **Capture only, no change.** The `.edu` email gate (`enforce_school_email` + its trigger), written down for the first time. |

## Naming

`YYYY-MM-DD_short_description.sql`, so the folder reads chronologically. These are not
numbered migrations — there is no migration runner. They are the real current definitions,
kept so they can be read, reviewed, and re-applied.

## Still missing

These were never captured and are needed before this folder can rebuild the database:

- ✅ The `book_listings` guard — trigger *and* function — captured 2026-08-08.
- ⬜ The real `CREATE TRIGGER` statement for `trg_guard_owner_listing_update`. Only the
      *function* it calls was ever read. Capture it with:
      ```sql
      SELECT pg_get_triggerdef(t.oid)
      FROM pg_trigger t
      WHERE t.tgrelid = 'public.listings'::regclass AND NOT t.tgisinternal;
      ```
- ✅ The three triggers on `profiles` — `enforce_school_email`,
      `guard_profile_privileged_columns`, `handle_new_user` — captured 2026-09-01.
- ⬜ Table definitions: `listings`, `book_listings`, `profiles`, `messages`, `appeals`,
      `user_roles`, `schools`, `activity_log`.
- ⬜ All RLS policies and `GRANT`s. (RLS is still listed as unverified in the roadmap's
      LAUNCH BLOCKERS — writing the policies down here is how that gets verified.)
- ⬜ The `appeals` table, which shipped 2026-08-07 with no SQL file at all.
