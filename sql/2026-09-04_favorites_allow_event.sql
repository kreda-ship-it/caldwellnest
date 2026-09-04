-- Let an event be starred
-- 2026-09-04
--
-- Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.
--
-- Papercut 5, and correction C6 from §12 of docs/nestrel-campus-engagement-plan.md.
-- favorites.item_type has been ('listing','book','service') since the table shipped on
-- 2026-09-01. §8 of the plan puts a star on every event card, and the star is this table — so
-- without 'event' the first attempt to save an event would fail on a check constraint.
--
-- Done now, before workstream 3, because the alternative is discovering it while building the
-- event card and stopping to write a migration mid-feature.
--
-- A check constraint cannot be altered in place: it is dropped and recreated. Inside one
-- transaction, so there is no moment where favorites accepts an unchecked item_type.

begin;

alter table public.favorites drop constraint if exists favorites_item_type_check;

alter table public.favorites add constraint favorites_item_type_check
  check (item_type in ('listing', 'book', 'service', 'event'));

commit;

notify pgrst, 'reload schema';

-- Expected: the four values above.
select pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'favorites_item_type_check';

-- NOTE: 'service' has been in this list since day one and nothing writes it yet — services
-- are a later feature. Left in place rather than tidied out: removing a value that a future
-- feature is already planned around would be churn, and the constraint's job is to reject
-- typos, not to be a precise inventory of what exists today.
