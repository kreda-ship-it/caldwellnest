-- Storage: nobody can list the photo buckets; the photos themselves stay public
-- 2026-09-28
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- Safe to re-run (each policy is dropped and recreated).
--
-- WHY (second audit, S1)
-- Both buckets could be LISTED by a logged-out visitor: every folder and file, with upload times.
-- listing-photos folders are named after the uploader's account id, and the buckets are public,
-- so every listed photo could then be opened — including ones from pending or rejected listings,
-- and posters of draft or members-only events.
--
-- WHY THIS IS SAFE
-- - The app never lists or downloads through the storage API. It uploads, removes, and builds
--   public addresses (/storage/v1/object/public/...). Public buckets serve those addresses
--   without consulting these policies, so every photo on the site keeps showing.
-- - Nothing existing is dropped. These two policies are RESTRICTIVE: an extra condition that
--   must ALSO pass, on top of whatever SELECT policies already exist (the listing-photos ones were
--   never captured in sql/, so this avoids needing their names).
-- - Supabase requires SELECT before it allows a remove, so the people who remove files keep it:
--     listing-photos  your own folder (every upload goes into the uploader's own id folder),
--                     plus admins (deleting a listing removes its photos)
--     event-media     the club's event managers (folders are the club's id) — the same rule as the
--                     existing upload and delete policies
-- - One accepted side effect: replacing a club logo or cover that a DIFFERENT officer uploaded
--   leaves the old file in storage (the app already treats that clean-up as best-effort).
--
-- UNDO, if anything misbehaves:
--   drop policy "Visitors cannot read photo bucket rows" on storage.objects;
--   drop policy "Photo bucket rows: owners, event managers, admins" on storage.objects;


begin;

drop policy if exists "Visitors cannot read photo bucket rows" on storage.objects;
create policy "Visitors cannot read photo bucket rows" on storage.objects
  as restrictive for select to anon
  using (bucket_id not in ('listing-photos', 'event-media'));

drop policy if exists "Photo bucket rows: owners, event managers, admins" on storage.objects;
create policy "Photo bucket rows: owners, event managers, admins" on storage.objects
  as restrictive for select to authenticated
  using (
    case bucket_id
      when 'listing-photos' then
        (storage.foldername(name))[1] = auth.uid()::text or public.user_is_admin()
      when 'event-media' then
        case when (storage.foldername(name))[1] ~ '^[0-9]+$'
             then public.can_act('manage_events', ((storage.foldername(name))[1])::bigint)
             else false
        end
      else true
    end
  );

commit;

notify pgrst, 'reload schema';


-- VERIFY — expected: the two new RESTRICTIVE policies, alongside the existing permissive ones.
select policyname, permissive, roles, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by permissive, policyname;
