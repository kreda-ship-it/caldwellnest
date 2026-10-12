-- Push notifications — alerts on the phone when Nestrel is closed
-- 2026-10-12
--
-- Run in: Supabase Dashboard -> SQL Editor. Run PART 1 (the change), then PART 2 (the checks) as a
-- separate run — the editor only shows the last result. Safe to re-run.
-- Deploy the push Edge Function too (supabase/functions/dynamic-action/index.ts); until it exists,
-- the triggers below call an address that answers "not found" and nothing else happens.
-- Its name, dynamic-action, is the random one Supabase's dashboard editor gave it on 2026-10-12. A
-- function's address cannot be renamed, so the triggers call that name. Deploying it again under
-- another name means changing the url in push_notify() below to match.
--
-- WHAT THIS ADDS
--   1. push_subscriptions — one row per device a student turned notifications on for: the device's
--      push address (endpoint + its two keys, handed over by the browser) and which alerts it wants.
--   2. push_log — a private list of what has already been announced, so each message and each
--      listing is pushed at most ONCE, however many times anything asks.
--   3. push_register()  — how the app saves a device (js/push.js).
--   4. push_targets()   — who to alert and what the alert says. Only the Edge Function may call it.
--      push_forget()    — the Edge Function removing addresses the push service says are gone.
--   5. Triggers on messages and listings that ask the Edge Function to do its job.
--
-- HOW AN ALERT TRAVELS
--   a message is inserted, or a listing becomes 'approved' (on posting, or when an admin approves it)
--     -> a trigger calls the push Edge Function (dynamic-action) through pg_net. In the background: the insert
--        never waits for it, and never fails because of it.
--     -> the function calls push_targets(kind, id) and gets back the devices + the alert's words
--     -> it encrypts one alert per device and hands it to Apple's / Google's / Mozilla's push service
--     -> the phone wakes Nestrel's service worker (sw.js), which shows it
--
-- WHY THE EDGE FUNCTION IS SAFE TO LEAVE OPEN (its "Verify JWT" switch is OFF)
--   A trigger sends only an id ("message 8f3…"), never any words. The function reads the real row
--   from the database, so nobody can make it say anything. And push_targets() answers each id once
--   (push_log), and only for a message from the last 10 minutes or a listing that is live right now.
--   So someone calling the function from outside can, at most, cause an alert that was going to be
--   sent anyway — once.
--
-- PRIVACY
--   - The endpoint is an address at the push service (fcm.googleapis.com, web.push.apple.com, …), not
--     a phone number or a location. Alerts are encrypted for the device: the push service carries
--     them but cannot read them.
--   - A row goes away when the student turns notifications off, when they sign out (the browser
--     drops the address; the next send sees it gone and push_forget() removes it), and when the
--     account is deleted (on delete cascade).
--   - Nobody reads anyone else's rows. Admins included: there is no admin policy. A count for
--     Analytics, if wanted later, should be a counts-only function, not a read policy.
--   - Suspended students get no alerts and cannot register a device.


-- ============================================================================
-- PART 1 — the change
-- ============================================================================

begin;

-- ---------- 1. Devices ----------
create table if not exists public.push_subscriptions (
  id            bigint generated always as identity primary key,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  -- Only the real push services. Without this, a student could register any web address as their
  -- "device", and the Edge Function would dutifully send requests to it.
  endpoint      text not null unique check (
                  length(endpoint) <= 1000 and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)/'),
  -- The device's two encryption keys, as the browser gives them (base64url). Lengths are loose
  -- bounds, only to keep junk out: real ones are 87 and 22 characters.
  p256dh        text not null check (length(p256dh) between 80 and 100),
  auth          text not null check (length(auth) between 16 and 32),
  want_messages boolean not null default true,
  want_listings boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists push_subscriptions_profile_idx on public.push_subscriptions (profile_id);

-- ---------- 2. What has already been announced ----------
-- ref_id is text because message ids are uuids and listing ids are numbers.
create table if not exists public.push_log (
  kind    text not null check (kind in ('message', 'listing')),
  ref_id  text not null,
  sent_at timestamptz not null default now(),
  primary key (kind, ref_id)
);

-- Every listing that already went out before today counts as announced. Without this, the open
-- Edge Function could be asked about an old listing and alert everyone about it as if it were new.
-- 'pending' ones are left out on purpose: they get their alert when an admin approves them.
insert into public.push_log (kind, ref_id)
  select 'listing', id::text from public.listings where status <> 'pending'
  on conflict do nothing;

-- ---------- 3. Table permissions ----------
-- Start from nothing (CLAUDE.md: Supabase's default privileges hand every new table TRUNCATE,
-- REFERENCES and TRIGGER, and RLS does not apply to TRUNCATE), then give back only what is used.
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_log from anon, authenticated;

-- Students read and remove their own devices, and flip the two switches. No INSERT: devices come
-- in through push_register(). And UPDATE is limited to the two switches, so a student can never
-- move a row to another account or point it at a different address.
grant select, delete on public.push_subscriptions to authenticated;
grant update (want_messages, want_listings) on public.push_subscriptions to authenticated;
-- push_log: no grants to anyone. Only the functions below (which run as the owner) touch it.

-- ---------- 4. Row Level Security ----------
alter table public.push_subscriptions enable row level security;
alter table public.push_log enable row level security;   -- and no policies: closed to everyone

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
drop policy if exists push_subscriptions_update_own on public.push_subscriptions;
drop policy if exists push_subscriptions_delete_own on public.push_subscriptions;

create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (auth.uid() = profile_id);
create policy push_subscriptions_update_own on public.push_subscriptions
  for update to authenticated using (auth.uid() = profile_id) with check (auth.uid() = profile_id);
create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete to authenticated using (auth.uid() = profile_id);

-- Suspension (CLAUDE.md: every table students write). The same three RESTRICTIVE policies, with
-- the same names, as sql/changes/2026-09-28_enforce_suspension.sql — the table is also added to
-- that file's list, so re-running it later keeps them. No need to re-run it now.
drop policy if exists no_insert_while_suspended on public.push_subscriptions;
drop policy if exists no_update_while_suspended on public.push_subscriptions;
drop policy if exists no_delete_while_suspended on public.push_subscriptions;
create policy no_insert_while_suspended on public.push_subscriptions
  as restrictive for insert to authenticated with check (not public.is_suspended());
create policy no_update_while_suspended on public.push_subscriptions
  as restrictive for update to authenticated using (not public.is_suspended());
create policy no_delete_while_suspended on public.push_subscriptions
  as restrictive for delete to authenticated using (not public.is_suspended());

-- ---------- 5. push_register() — the app saving this device ----------
create or replace function public.push_register(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.is_suspended() then raise exception 'This account is suspended'; end if;

  -- One device, one owner. Whoever turns notifications on here now owns the address: a laptop
  -- shared between two students must never keep alerting the first one about the second one's
  -- conversations. (An endpoint is a long random address only that device knows, so this cannot
  -- be used to knock out someone else's notifications from afar.)
  delete from public.push_subscriptions where endpoint = p_endpoint and profile_id <> auth.uid();

  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now();

  -- At most 10 devices per student, newest kept. Real people have two or three; the cap stops one
  -- account from filling the table and making every listing alert slow for everyone.
  delete from public.push_subscriptions
   where profile_id = auth.uid()
     and id not in (select id from public.push_subscriptions
                     where profile_id = auth.uid() order by updated_at desc limit 10);
end;
$function$;

revoke all on function public.push_register(text, text, text) from public, anon;
grant execute on function public.push_register(text, text, text) to authenticated;

-- ---------- 6. push_targets() — who gets what ----------
-- Returns null when there is nothing to send, otherwise:
--   { "payload": { title, body, url, tag, urgency }, "devices": [ { endpoint, p256dh, auth }, … ] }
-- The words are decided HERE, in one readable place, so the Edge Function never has to know what
-- a listing or a message looks like.
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
                 when 'donation'   then 'Free on Nestrel'
                 else 'New on Nestrel' end;
    -- Same rules as priceLabel() in js/listings.js.
    v_price := case
                 when l.category in ('donation', 'organization_event') then null
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

-- ---------- 7. push_forget() — addresses the push service says no longer exist ----------
create or replace function public.push_forget(p_endpoints text[])
returns void
language sql
security definer
set search_path = ''
as $function$
  delete from public.push_subscriptions where endpoint = any (p_endpoints);
$function$;

revoke all on function public.push_forget(text[]) from public, anon, authenticated;
grant execute on function public.push_forget(text[]) to service_role;

-- ---------- 8. The triggers ----------
-- pg_net lets the database make a web request without waiting for the answer. Supabase ships it;
-- this only switches it on if it is not on already.
create extension if not exists pg_net with schema extensions;

-- One trigger function for both tables; the kind ('message' / 'listing') is the trigger's argument.
-- The project address below is already public (js/config.js, vercel.json).
create or replace function public.push_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    perform net.http_post(
      url     := 'https://jcbohweepdgqqntherzo.supabase.co/functions/v1/dynamic-action',
      body    := jsonb_build_object('kind', tg_argv[0], 'id', new.id::text),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 30000
    );
  exception when others then
    -- A notification problem must never stop a message from sending or a listing from posting.
    -- Worst case is a missing alert, and the warning shows in the Postgres logs.
    raise warning 'push_notify (%): %', tg_argv[0], sqlerrm;
  end;
  return null;   -- an AFTER trigger: the return value is ignored
end;
$function$;

revoke all on function public.push_notify() from public, anon, authenticated;

drop trigger if exists push_on_message on public.messages;
create trigger push_on_message
  after insert on public.messages
  for each row execute function public.push_notify('message');

-- A listing goes live in one of two ways: posted while "Require approval" is off (inserted as
-- 'approved'), or approved later by an admin (status changes to 'approved').
drop trigger if exists push_on_listing_posted on public.listings;
create trigger push_on_listing_posted
  after insert on public.listings
  for each row when (new.status = 'approved')
  execute function public.push_notify('listing');

drop trigger if exists push_on_listing_approved on public.listings;
create trigger push_on_listing_approved
  after update of status on public.listings
  for each row when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.push_notify('listing');

commit;

notify pgrst, 'reload schema';


-- ============================================================================
-- PART 2 — checks (read-only; run on their own)
-- ============================================================================

-- Expect: rls_subs = true, rls_log = true, policies = 6, triggers = 3, pg_net = true
select
  (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass) as rls_subs,
  (select relrowsecurity from pg_class where oid = 'public.push_log'::regclass)           as rls_log,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions') as policies,
  (select count(*) from pg_trigger where tgname in ('push_on_message', 'push_on_listing_posted', 'push_on_listing_approved')) as triggers,
  exists (select 1 from pg_extension where extname = 'pg_net') as pg_net;

-- Expect exactly ONE row: authenticated | DELETE, SELECT
-- (the UPDATE on the two switches is a column grant, so it does not show here). No anon row at all,
-- and nothing for push_log.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as grants
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name in ('push_subscriptions', 'push_log')
   and grantee in ('anon', 'authenticated')
 group by table_name, grantee
 order by table_name, grantee;

-- AFTER the Edge Function is deployed and a test message has been sent: the function's answers.
-- Status 200 with {"sent":1,…} means it worked. 404 = function not deployed (or a different name).
-- select id, status_code, content, created from net._http_response order by created desc limit 5;
