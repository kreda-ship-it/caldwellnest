-- Push alerts for services — "New in Services" and the service's price wording
-- 2026-10-12
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the checks) as a
-- separate run — the editor only shows the last result. Safe to re-run.
--
-- WHAT THIS CHANGES
--   Only the WORDS of a new-listing alert, and only for services (js/services.js, 2026-10-12).
--   Before: "New on Nestrel"   ·  "Calculus tutoring · $20"
--   After:  "New in Services"  ·  "Calculus tutoring · $20/hr"
--   The price follows priceLabel() in js/listings.js: $20/hr, $30/session, $40 (flat), from $80
--   ("depends on the job" with a starting price), Free, or no price at all (the app's "Ask for price").
--   Who gets alerts, when, and every other alert stay exactly as they were.
--
-- WHY THE WHOLE FUNCTION IS HERE
--   Postgres cannot edit part of a function: CREATE OR REPLACE sends all of it. So below is
--   push_targets() exactly as sql/changes/2026-10-12_push_notifications.sql created it, with lines added
--   only to the listing part: the Services headline and its price. That file stays the record of how alerts work;
--   this one is the record of the change.
--
-- THE SAFETY CHECK AT THE TOP
--   The database is the ground truth, not this repo. Before replacing anything, PART 1 checks that the
--   push_targets() in the database is byte-for-byte the version this file was written against (or this
--   file's own version, so re-running is safe). If someone has changed it since — in the dashboard, or
--   in another file — it stops with an error and changes nothing, instead of silently undoing that.
--   If that happens: don't force it. Run the query in PART 0 and bring the result to a Claude session.
--
-- Grants and ownership survive CREATE OR REPLACE; they are restated anyway so this file says the
-- whole truth about who may call it (only the Edge Function, as service_role).


-- ============================================================================
-- PART 0 — only if PART 1 stopped with "not the version this file was written against"
-- ============================================================================
-- select md5(prosrc), prosrc from pg_proc where oid = 'public.push_targets(text, text)'::regprocedure;


-- ============================================================================
-- PART 1 — the change
-- ============================================================================
begin;

do $check$
declare
  v_md5 text;
begin
  select md5(prosrc) into v_md5 from pg_proc where oid = 'public.push_targets(text, text)'::regprocedure;
  -- 91df0e4bd86eac64aedae506f06fb76e = 2026-10-12_push_notifications.sql; 1f138c2ee9e604bf340bfaebffec9eca = this file (a re-run)
  if v_md5 is distinct from '91df0e4bd86eac64aedae506f06fb76e' and v_md5 is distinct from '1f138c2ee9e604bf340bfaebffec9eca' then
    raise exception 'push_targets() in the database is not the version this file was written against (md5 %). Nothing was changed. See PART 0.', v_md5;
  end if;
end
$check$;

create or replace function public.push_targets(p_kind text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  m        public.messages;
  l        public.listings;
  v_n      int;
  v_title  text;
  v_body   text;
  v_price  text;
  v_url    text;
  v_tag    text;
  v_urgent text;
  v_devs   jsonb;
begin
  -- Housekeeping: a message entry is only needed while that message is "fresh" (10 minutes).
  delete from public.push_log where kind = 'message' and sent_at < now() - interval '1 day';

  if p_kind = 'message' then
    if p_id !~ '^[0-9a-fA-F-]{36}$' then return null; end if;
    select * into m from public.messages x
     where x.id = p_id::uuid and x.created_at > now() - interval '10 minutes';
    if not found then return null; end if;

    insert into public.push_log (kind, ref_id) values ('message', p_id) on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then return null; end if;          -- already announced

    -- The name the app shows: display name if they chose one, otherwise first + last.
    -- Official Nestrel accounts are just "Nestrel".
    select case when p.is_admin_account then 'Nestrel'
                else coalesce(nullif(trim(p.display_name), ''), p.first_name || ' ' || p.last_name) end
      into v_title
      from public.profiles p where p.id = m.sender_id;
    v_title  := coalesce(v_title, 'New message');
    v_body   := case when m.message_type = 'listing' then 'Shared a listing: ' || m.content else m.content end;
    v_body   := case when length(v_body) > 140 then left(v_body, 139) || '…' else v_body end;
    v_url    := '/#/chat/' || m.sender_id;
    v_tag    := 'chat-' || m.sender_id;           -- a newer message from the same person replaces the older alert
    v_urgent := 'high';

    select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
      into v_devs
      from public.push_subscriptions s
      join public.profiles p on p.id = s.profile_id
     where s.profile_id = m.receiver_id
       and s.want_messages
       and p.status = 'active';

  elsif p_kind = 'listing' then
    if p_id !~ '^[0-9]{1,18}$' then return null; end if;
    -- "Live" the way isListingLive() in js/data.js means it.
    select * into l from public.listings x
     where x.id = p_id::bigint
       and x.status = 'approved'
       and x.lifecycle_status in ('active', 'pending_sale')
       and (x.expires_at is null or x.expires_at > now());
    if not found then return null; end if;
    -- A suspended student's listings are hidden from the feed (loadListings), so no alert either.
    if exists (select 1 from public.profiles p where p.id = l.poster_id and p.status = 'suspended') then
      return null;
    end if;

    insert into public.push_log (kind, ref_id) values ('listing', p_id) on conflict do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then return null; end if;          -- already announced: renewals and re-approvals stay quiet

    -- Same words as CATEGORY_LABELS in js/config.js, phrased for a headline.
    v_title := case l.category
                 when 'housing'    then 'New in Housing'
                 when 'clothing'   then 'New in Clothing'
                 when 'technology' then 'New in Technology'
                 when 'services'   then 'New in Services'
                 when 'donation'   then 'Free on Nestrel'
                 else 'New on Nestrel' end;
    -- Same rules as priceLabel() in js/listings.js.
    v_price := case
                 when l.category in ('donation', 'organization_event') then null
                 -- Services (2026-10-12): how it is charged is details.price_unit. No price on a
                 -- "depends on the job" service means the app says "Ask for price"; the alert says nothing.
                 when l.category = 'services' then
                   case
                     when l.details ->> 'price_unit' = 'free' then 'Free'
                     when coalesce(l.price, 0) <= 0 then null
                     when l.details ->> 'price_unit' = 'varies'  then 'from $' || l.price
                     when l.details ->> 'price_unit' = 'hour'    then '$' || l.price || '/hr'
                     when l.details ->> 'price_unit' = 'session' then '$' || l.price || '/session'
                     else '$' || l.price end
                 when l.price > 0 then
                   case when l.details ->> 'room_type' = 'Looking for Room' then 'up to ' else '' end
                   || '$' || l.price || case when l.category = 'housing' then '/mo' else '' end
                 else null end;
    v_body   := left(coalesce(nullif(trim(l.title), ''), 'A new listing'), 100) || coalesce(' · ' || v_price, '');
    v_url    := '/#/listing/' || l.id;
    v_tag    := 'listing-' || l.id;
    v_urgent := 'normal';

    -- Everyone at the listing's school who wants listing alerts, except the person who posted it.
    select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
      into v_devs
      from public.push_subscriptions s
      join public.profiles p on p.id = s.profile_id
     where s.want_listings
       and s.profile_id is distinct from l.poster_id
       and p.status = 'active'
       and (l.school is null or lower(p.school) = lower(l.school));

  else
    return null;
  end if;

  if jsonb_array_length(v_devs) = 0 then return null; end if;
  return jsonb_build_object(
    'payload', jsonb_build_object('title', v_title, 'body', v_body, 'url', v_url, 'tag', v_tag, 'urgency', v_urgent),
    'devices', v_devs);
end;
$function$;

revoke all on function public.push_targets(text, text) from public, anon, authenticated;
grant execute on function public.push_targets(text, text) to service_role;

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — checks (read-only; run on their own)
-- ============================================================================

-- Expect: has_services_wording = true, version = 'this file', students_can_call = false,
-- edge_function_can_call = true
select
  position('New in Services' in prosrc) > 0                                        as has_services_wording,
  case md5(prosrc) when '1f138c2ee9e604bf340bfaebffec9eca' then 'this file' else 'something else: ' || md5(prosrc) end as version,
  has_function_privilege('authenticated', oid, 'execute')                           as students_can_call,
  has_function_privilege('service_role', oid, 'execute')                            as edge_function_can_call
from pg_proc where oid = 'public.push_targets(text, text)'::regprocedure;
