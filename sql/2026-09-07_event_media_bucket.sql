-- The event-media storage bucket
-- 2026-09-07  ·  Session E2 of docs/nestrel-events-door-feedback-plan.md
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
--
--
-- WHY A SECOND BUCKET AT ALL
-- listing-photos already holds three kinds of image: listing photos, avatars and org logos.
-- Adding a fourth would be the cheaper move. Event posters are portrait (~4:5) and listing
-- photos are not, and one bucket with two aspect conventions produces a grid that breaks —
-- so this is a deliberate change of house pattern, not a continuation of it.
--
--
-- THE OWNERSHIP DIFFERENCE, WHICH IS THE REAL REASON THE POLICIES DIFFER
-- The existing policies key on the uploader:
--
--   Students upload own photos   INSERT   foldername(name)[1] = auth.uid()::text
--   Students delete own photos   DELETE   foldername(name)[1] = auth.uid()::text
--
-- That is exactly right for a listing photo, which belongs to a person. It is wrong for an
-- event poster, which belongs to an ORGANIZATION. Under the uid convention, the president
-- uploads the poster, graduates, and no officer who follows them can ever delete it — the
-- club's own media is permanently owned by someone who has left.
--
-- So event media folders by ORG ID, and the gate is can_act('manage_events', org_id): the
-- same question the events table asks. Any officer who may manage the org's events may manage
-- the org's media, which is what "belongs to the organization" has to mean to be true.
--
-- Foldering by org rather than by event is deliberate too. Foldering by event would require
-- the event row to exist before its poster could be uploaded, which forces create-then-add
-- and makes an abandoned form leave an event behind. By org, the upload works from the create
-- form itself.
--
--
-- WHAT PUBLIC READ MEANS HERE, STATED SO IT IS NOT A SURPRISE LATER
-- SELECT is granted to `public`, matching listing-photos, because getPublicUrl() is how every
-- image in this app is displayed. So anyone holding the URL can fetch the file, signed in or
-- not.
--
-- That is fine for a poster advertising an event to campus. It will NOT be fine for a
-- members-only event once that gating is built: the row would be hidden by RLS while its
-- poster stayed fetchable by URL. Members-only is deferred from V1, so this is not a hole
-- today — it is a thing to fix in the same session that builds the gating, and it is written
-- down here so that session finds it.


-- ============================================================================
-- 1. The bucket
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-media', 'event-media', true, 10485760,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The size limit and the mime list are a DELIBERATE difference from listing-photos, which
-- carries neither. The browser resizes to 1600px JPEG before uploading, so nothing legitimate
-- comes close to 10 MB — the limit exists for the request that does not come from the browser.
-- Worth backporting to listing-photos, in its own change, once this shape has been used.


-- ============================================================================
-- 2. Policies on storage.objects
-- ============================================================================
-- storage.objects is one table for every bucket, so each policy names its bucket explicitly.
-- A policy that forgot the bucket_id clause would apply to listing-photos as well.

drop policy if exists "Public read event media" on storage.objects;
create policy "Public read event media" on storage.objects
  for select to public
  using (bucket_id = 'event-media');

-- The folder is the ORGANIZATION id, and can_act() answers whether this officer may write
-- there. can_act walks parent_id upward, so a school admin can post media for any club below
-- them — the same authority they already have over the events themselves.
--
-- A path whose first folder is not a number, or is an org that does not exist, makes the
-- subquery null; can_act(null) walks nothing and returns false. Refused, not errored.
drop policy if exists "Officers upload event media" on storage.objects;
create policy "Officers upload event media" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] ~ '^[0-9]+$'
    and public.can_act('manage_events', ((storage.foldername(name))[1])::bigint)
  );

drop policy if exists "Officers delete event media" on storage.objects;
create policy "Officers delete event media" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'event-media'
    and (storage.foldername(name))[1] ~ '^[0-9]+$'
    and public.can_act('manage_events', ((storage.foldername(name))[1])::bigint)
  );

-- No UPDATE policy, matching listing-photos. The app uploads with upsert:false and replaces a
-- photo by uploading a new one and deleting the old, so overwrite-in-place is never needed —
-- and without it, a stale URL can never quietly start serving different content.


notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY (read-only)
-- ============================================================================
-- Expected: event-media, public = true, 10485760, the three image types.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'event-media';

-- Expected: the three policies above, plus the three existing listing-photos ones untouched.
select policyname, cmd, roles from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;
