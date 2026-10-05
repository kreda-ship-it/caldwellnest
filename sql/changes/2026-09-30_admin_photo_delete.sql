-- Admins can delete files in the listing-photos bucket
-- 2026-09-30
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run (the policy is dropped and recreated).
--
-- WHY
-- The listing-photos bucket holds listing photos, book photos, profile photos and club logos.
-- Its delete policy ("Students delete own photos", recorded 2026-09-28) lets a person delete files
-- in their OWN folder only. Nothing lets an admin delete a file in someone else's folder. So when
-- an admin deletes a listing forever, or (from 2026-09-30) removes one photo or a profile photo,
-- the database row changes but the file stays in storage, still public to anyone who kept its
-- address. Supabase answers a refused delete with "success, 0 files removed", not an error, which
-- is why it went unnoticed. js/media.js now reports that count, and the admin is told.
--
-- WHAT THIS ADDS
-- One PERMISSIVE delete policy: an admin may delete any file in listing-photos. Permissive means
-- it adds a way to be allowed; it loosens nothing that exists, and nothing is dropped.
--   - The restrictive "No file removals while suspended" (2026-09-28_enforce_suspension.sql) still
--     applies on top of it.
--   - Supabase also requires SELECT before it removes a file. Admins already have it through
--     "Photo bucket rows: owners, event managers, admins" (2026-09-28_storage_no_listing.sql).
--   - event-media (event posters and recaps) is a different bucket and is not touched.
--
-- SUB-ADMINS (planned): user_is_admin() means ANY admin today, and today there is one. When
-- sub-admin permissions land, this check becomes the photo-moderation permission instead.
--
-- UNDO, if anything misbehaves:
--   drop policy "Admins delete listing photos" on storage.objects;


begin;

drop policy if exists "Admins delete listing photos" on storage.objects;
create policy "Admins delete listing photos" on storage.objects
  as permissive for delete to authenticated
  using (bucket_id = 'listing-photos' and public.user_is_admin());

commit;

notify pgrst, 'reload schema';


-- CHECK (run after): expect "Admins delete listing photos" next to "Students delete own photos",
-- plus the restrictive "No file removals while suspended".
select policyname, permissive, roles, cmd, qual
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and cmd in ('DELETE', 'ALL')
order by policyname;
