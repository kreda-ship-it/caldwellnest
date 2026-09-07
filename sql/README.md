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
| `2026-09-04_fix_membership_insert_guard.sql` | Closes a privilege-escalation gap in `2026-09-04_org_hierarchy.sql`: the flag guard was BEFORE UPDATE only, so `can_manage_members` was enough to INSERT a new membership carrying every flag. Now BEFORE INSERT OR UPDATE, with the SQL-editor break-glass the other guards use. **Superseded 2026-09-05 by `2026-09-05_flag_set.sql`** — do not run this one afterwards, it would restore the old flag set. |
| `2026-09-04_public_profiles_view.sql` | **STEP 1 of the F2 fix, additive.** Creates `public_profiles`, a view of the safe profile columns — no email, no `suspension_reason`, no consent columns. Protects nothing on its own. |
| `2026-09-04_restrict_profiles_select.sql` | **STEP 2 of the F2 fix — the one that can break things.** Replaces the `using (true)` read policy on `profiles` with own-row plus school-scoped admin. Run only after step 1 and after the app has been tested. |
| `2026-09-04_slug_format.sql` | Check constraints giving `schools.slug` and `organizations.slug` a shape — lowercase, digits, single hyphens. A foreign key answers "is this real"; this answers "is this the right shape". |
| `2026-09-04_normalise_identifiers.sql` | Triggers lowercasing `school_domains.domain`, `schools.slug`, `schools.email_domain` and `organizations.slug` on write. Identifiers only, never names — `Caldwell.EDU` and `caldwell.edu` are the same domain by spec, so it corrects rather than refuses. |
| `2026-09-04_tidy_view_grants.sql` | Revokes the TRUNCATE/REFERENCES/TRIGGER that Supabase's default privileges attached to `public_profiles`. Consistency rather than a hole — none is reachable on a view. |
| `2026-09-04_org_posts.sql` | Announcements and polls for organizations: `org_posts`, `poll_options`, `poll_votes`, plus `is_org_member()` and `has_voted()`. Poll results gated in RLS until you have voted; one pinned post per org via a partial unique index. Events stay their own table. |
| `2026-09-04_favorites_allow_event.sql` | Adds `'event'` to `favorites.item_type`, so an event can be starred. Papercut 5 / plan §12 C6. |
| `2026-09-04_drop_saved_listings.sql` | **The only destructive file here.** Drops `saved_listings`, the empty and ungranted predecessor of `favorites`. Four preconditions checked before writing it. |
| `2026-09-04_school_foreign_keys.sql` | Constrains `school` to a real row in `schools` on six tables, and drops the `profiles.school DEFAULT 'Caldwell'` that disagreed with every comparison in the project. `admin_activity_log` is deliberately excluded — an audit log records what was true then, not what is true now. |
| `2026-09-04_capture_table_definitions.sql` | **Capture only — do not run against the live database.** All 25 tables in `public`: part 1 the columns, part 2 all 99 keys and constraints. The rebuild reference. Records ten observations, including that nothing anywhere constrains `school`. |
| `2026-09-04_verify_can_act.sql` | **Run this to check `can_act()`.** Self-contained: builds a throwaway three-level hierarchy, impersonates a club officer / school admin / plain member, rolls everything back. Reports by raising an exception — the error message is the report. Needs two non-admin profiles, three for full coverage. **Repaired and extended 2026-09-05:** it had been unrunnable since `2026-09-04_school_foreign_keys.sql` constrained `organizations.school` — the first INSERT failed on the foreign key before any test ran. Now eleven properties, including the two new flags. |
| `2026-09-05_flag_set.sql` | **Freezes the permission flag set at eight.** Drops `can_moderate` (nothing read it), adds `can_manage_events` and `can_check_in`. Touches all five places the set is written down: the columns, the `CASE` in `can_act()`, both flag lists in the guard trigger, and the pinned-false list in the insert policy. Phase 0 of the engagement build. |
| `2026-09-05_verify_flag_guard.sql` | **Run this to check the flag guard.** The trigger had no test at all until now — `verify_can_act.sql` inserts its setup rows with no JWT, which lands in the guard's break-glass branch and walks straight past it. Ten properties, including the two that catch a flag added to the table and forgotten in the guard. Tests the trigger only; RLS is bypassed in the SQL editor. |
| `2026-09-05_seed_dev_org.sql` | **DEV ONLY, and the only file here that leaves rows behind.** Wires three signed-up test accounts into a Dev Chess Club as officer / plain member / outsider, with a public post, a members-only post and a poll — the fixtures needed to check the poll-results gate and members-only visibility by hand. Has a runbook for creating the accounts and a teardown. |
| `2026-09-06_org_public_views.sql` | **Phase 1.** Two views a student can read: `org_directory` (active orgs, follower count, breadcrumb) and `org_public_officers` (name and title, no `user_id`). Both run as owner so they read past RLS — the safety is that neither carries an identifying column. Also adds the `org_follows(org_id)` index the count needs. |
| `2026-09-06_verify_org_visibility.sql` | **Run this to check what an outsider can see.** Unlike the other verify files it does `set local role authenticated` and speaks as three students in turn — RLS is bypassed in the SQL editor, so a file that skips that step proves nothing. Eleven properties. |
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
- ✅ Table definitions — **captured 2026-09-04** in `2026-09-04_capture_table_definitions.sql`:
      all 25 tables in `public`, columns in part 1 and all 99 primary keys, foreign keys,
      unique and check constraints in part 2. Both emitted by the database rather than
      retyped. Covers far more than the eight tables originally listed here.
      Only non-constraint indexes remain uncaptured, and those are performance rather than
      correctness — a rebuild without them is correct and slow, where a rebuild without the
      constraints would have been fast and wrong.
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
- ⬜ `2026-09-04_capture_table_definitions.sql` is now **one day stale for `org_memberships`**:
      `2026-09-05_flag_set.sql` dropped `can_moderate` and added `can_manage_events` and
      `can_check_in`. A capture file is a photograph, so it goes out of date the moment
      anything changes — the fix is to re-run part 1 of that file and paste the result back,
      not to hand-edit it. Left for the next session that touches the schema.

## A rule the 2026-09-05 session learned the hard way

**A verification file is code, and a constraint added elsewhere can break it.**
`2026-09-04_verify_can_act.sql` was written at 15:28 using `school = '__verify__'` as a value
that could never collide with real data. At 17:20 the same day,
`2026-09-04_school_foreign_keys.sql` constrained `organizations.school` to `schools(slug)` —
and from that moment the verification file failed on its first INSERT, before running a single
test. Nobody noticed for a day, and the status page went on describing `can_act()` as proven
seven ways by a file that could not execute.

So: **re-run every verification file after any schema change**, not just the one for the thing
you changed. A green test you did not re-run is not evidence; it is a memory.
