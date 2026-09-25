-- Club cover photos, and event recaps that are shared on purpose
-- 2026-09-25
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run. Safe to re-run.
-- Run AFTER 2026-09-07_events_schema.sql (event_media and its policies must exist).
--
-- WHAT THIS ADDS
--   organizations.cover_url   the wide photo across the top of a club's page (was a plain tinted band)
--   events.recap_note         a line or two from the officers about how the event went
--   events.recap_shared_at    when the recap was shared; NULL means it is still a draft
--   event_media_select        now hides RECAP photos from students until the recap is shared
--
-- WHY RECAPS NEED A "SHARED" STATE
-- Until now a recap photo was visible to every student the moment an officer uploaded it, one
-- photo at a time, before the officer had chosen which ones to keep. Now the officer adds photos
-- and a note in private, then presses "Share recap". Only then do students see it — on the event,
-- on the club page, on the Events page and on followers' Home.
--
-- NOTHING DISAPPEARS: any event that already has recap photos is marked as shared (step 3), so
-- what students can see today, they can still see after this runs.
--
-- NO NEW TABLES OR VIEWS, so no new grants or revokes: the columns are covered by the grants the
-- two tables already have. Students read organizations and events directly, under their existing
-- RLS (organizations_select: active clubs; events_select: published, not members-only events).
-- visible_events is NOT rebuilt — it expands e.* at creation, so it will not carry the two new
-- event columns; the app reads them from events itself.

begin;

-- ============================================================================
-- 1. The columns
-- ============================================================================
alter table public.organizations add column if not exists cover_url text;

alter table public.events add column if not exists recap_note      text;
alter table public.events add column if not exists recap_shared_at timestamptz;

-- A recap is about something that happened. Sharing one before the event started is a mistake.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_recap_after_start') then
    alter table public.events
      add constraint events_recap_after_start
      check (recap_shared_at is null or recap_shared_at >= starts_at);
  end if;
end $$;


-- ============================================================================
-- 2. Recap photos: hidden from students until the recap is shared
-- ============================================================================
-- Same rule as before for promo photos (published, not members-only, or you manage the club's
-- events). Recap photos additionally need recap_shared_at. Officers who manage events always see
-- them — that is how they build the draft.
drop policy if exists event_media_select on public.event_media;
create policy event_media_select on public.event_media
  as permissive for select to authenticated
  using (exists (select 1 from public.events e
                 where e.id = event_media.event_id
                   and ((e.status = 'published' and e.members_only = false
                         and (event_media.phase <> 'recap' or e.recap_shared_at is not null))
                        or public.can_act('manage_events', e.org_id))));


-- ============================================================================
-- 3. Keep what students can already see
-- ============================================================================
-- Events that already have recap photos count as shared, dated when their last photo was added
-- (never earlier than the event's start, for the check above).
update public.events e
   set recap_shared_at = greatest(e.starts_at,
         (select max(m.created_at) from public.event_media m
           where m.event_id = e.id and m.phase = 'recap'))
 where e.recap_shared_at is null
   and exists (select 1 from public.event_media m where m.event_id = e.id and m.phase = 'recap');

commit;

-- Supabase's API caches the schema. Without this it rejects the new columns with an error that
-- looks exactly like "the column does not exist".
notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY
-- ============================================================================

-- Expected: three rows — cover_url on organizations; recap_note and recap_shared_at on events.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'organizations' and column_name = 'cover_url')
    or (table_name = 'events' and column_name in ('recap_note', 'recap_shared_at')))
order by table_name, column_name;

-- Expected: one row; the USING text mentions recap_shared_at.
select policyname, qual
from pg_policies
where schemaname = 'public' and tablename = 'event_media' and cmd = 'SELECT';

-- For interest: events whose recaps were already visible, now marked as shared.
select id, title, recap_shared_at
from public.events
where recap_shared_at is not null
order by recap_shared_at desc
limit 20;
