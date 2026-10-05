-- ============================================================
-- One-off repair: events whose uploaded photo never became their poster
-- ============================================================
-- Events saved before the 2026-09-12 fix kept their photos — the files are in the
-- event-media bucket and the rows are in event_media — but events.poster_url was never
-- written, because ocSaveEvent() set it on the row object AFTER sending that row to the
-- database. Every surface that shows an event picture reads events.poster_url, so those
-- events still draw their generated gradient.
--
-- This sets poster_url from each event's own first promo image.
--
-- Safe to run twice: it only touches rows where poster_url IS NULL, so it can never
-- overwrite a cover an officer has chosen since, and a second run changes nothing.
-- Recap photos (phase = 'recap') are never used as a poster — they are what happened
-- afterwards, not the flyer.
--
-- Data only. No schema change, so no NOTIFY pgrst is needed.

-- 1. Before: how many events are waiting for this, and which.
select e.id, e.title, e.starts_at, count(m.id) as promo_images
from public.events e
join public.event_media m
  on m.event_id = e.id and m.kind = 'image' and m.phase = 'promo'
where e.poster_url is null
group by e.id, e.title, e.starts_at
order by e.starts_at desc;

-- 2. The repair. "distinct on (event_id) ... order by sort_order, id" picks each event's
--    cover: sort_order 0 is the photo the officer put first in the strip.
update public.events e
set poster_url = m.url
from (
  select distinct on (event_id) event_id, url
  from public.event_media
  where kind = 'image' and phase = 'promo'
  order by event_id, sort_order, id
) m
where m.event_id = e.id
  and e.poster_url is null;

-- 3. After: this should return no rows. Any that remain are events with no promo image at
--    all, which is correct — they are meant to draw the gradient.
select e.id, e.title
from public.events e
join public.event_media m
  on m.event_id = e.id and m.kind = 'image' and m.phase = 'promo'
where e.poster_url is null;
