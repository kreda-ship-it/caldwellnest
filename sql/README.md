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
| `2026-09-01_saved_items.sql` | Creates the `favorites` table (private per-student saved items) with its RLS policies and GRANTs. Reads are own-rows-only by design — no admin read policy. |
| `2026-09-03_capture_rls_and_grants.sql` | **Read only, changes nothing.** Nine numbered introspection queries that dump every policy, GRANT, view, function, trigger and column definition. Run it any time you want to re-check what the database actually enforces. |
| `2026-09-03_fix_rls_and_grants.sql` | Applied 2026-09-03. Enables RLS on `admin_activity_log` (it was **off**, with three policies that were therefore never consulted) and revokes dead `anon` write grants on `listings` and `reports`. Lists seven remaining follow-ups. |
| `2026-09-04_capture_permission_functions.sql` | **Capture only.** `is_super_admin()`, `get_admin_school()` and `user_is_admin()` — every admin permission routes through one of the three, and none had been written down. |
| `2026-09-04_capture_rls_policies.sql` | **Capture.** All 67 RLS policies, emitted by the database itself rather than retyped. Records reality including its duplicates, and lists five findings — notably that both `notifications` INSERT policies check `true`. |
| `2026-09-04_harden_policies.sql` | Closes four of those five findings: notification forgery, the world-readable admin roster, nine duplicate policies, and unpinned `search_path` on the three permission functions. Explains why the fifth (profile columns) needs code, not a policy. |
| `2026-09-04_fix_membership_insert_guard.sql` | Closes a privilege-escalation gap in `2026-09-04_org_hierarchy.sql`: the flag guard was BEFORE UPDATE only, so `can_manage_members` was enough to INSERT a new membership carrying every flag. Now BEFORE INSERT OR UPDATE, with the SQL-editor break-glass the other guards use. |
| `2026-09-04_public_profiles_view.sql` | **STEP 1 of the F2 fix, additive.** Creates `public_profiles`, a view of the safe profile columns — no email, no `suspension_reason`, no consent columns. Protects nothing on its own. |
| `2026-09-04_restrict_profiles_select.sql` | **STEP 2 of the F2 fix — the one that can break things.** Replaces the `using (true)` read policy on `profiles` with own-row plus school-scoped admin. Run only after step 1 and after the app has been tested. |
| `2026-09-04_capture_table_definitions.sql` | **Capture only — do not run.** All 25 tables in `public`, as CREATE TABLE. Columns, types, nullability and defaults only: **no keys or constraints yet**, and the query that gets those is at the bottom of the file. |
| `2026-09-04_verify_can_act.sql` | **Run this to check `can_act()`.** Self-contained: builds a throwaway three-level hierarchy, impersonates a club officer / school admin / plain member, checks seven properties, rolls everything back. Reports by raising an exception — the error message is the report. Needs two non-admin profiles. |
| `2026-09-04_org_hierarchy.sql` | Campus engagement workstream 1 stage 1: `organizations`, `org_memberships`, `org_follows`, the `can_act()` permission rule, a flag guard trigger, RLS and GRANTs. Creates no rows — see its BOOTSTRAP section. **Run after the hardening file.** |

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
- 🟡 Table definitions — **columns captured 2026-09-04** for all 25 tables in
      `2026-09-04_capture_table_definitions.sql`, which covers far more than the eight
      originally listed here. Still missing the KEYS: no primary keys, foreign keys, unique
      or check constraints, and no indexes. Running the capture on an empty database would
      produce tables that accept duplicate ids, orphan rows and invalid statuses. The query
      that finishes it is at the bottom of that file — one run and this line can close.
- ✅ All RLS policies — captured 2026-09-04 in `2026-09-04_capture_rls_policies.sql`, all 67
      of them, generated by the database rather than transcribed.
- ⬜ `GRANT`s are still not captured. The audit read them and fixed what was wrong, but no
      file records the intended grant per table, so a rebuild would restore the policies and
      not the table permissions that sit in front of them.
- ✅ `user_is_admin()` — captured 2026-09-04. It turned out to be identical to the inline
      `exists (select 1 from user_roles ...)` that most policies use, so there are **two**
      admin checks, not three: broad (any role row) and narrow (`is_super_admin()`).
      Duplication rather than disagreement.
- ⬜ Four function bodies remain uncaptured: `check_email_available`,
      `check_username_available`, `update_own_poster_name` and `fn_sync_listing_id`.
      `guard_message_immutable` and `fn_guard_owner_book_update` were read 2026-09-04 and
      still need writing down.
- ⬜ The `appeals` table, which shipped 2026-08-07 with no SQL file at all.
