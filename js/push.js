// ============================================================
// PUSH NOTIFICATIONS — alerts on the phone, even when Nestrel is closed (2026-10-12)
//
// The whole journey, in four places:
//   sql/changes/2026-10-12_push_notifications.sql   who gets which alert, the words, the triggers
//   supabase/functions/dynamic-action/index.ts           encrypts each alert and sends it
//   sw.js                                           shows the alert, and handles the tap
//   this file                                       turning alerts on and off, and opening what was tapped
//
//  - pushInit()            called once from boot.js. Listens for taps on alerts while Nestrel is
//                          open, stops this device's alerts when someone signs out, and a few seconds
//                          into a signed-in visit checks this device and considers the offer card.
//  - the offer card        "Get a heads-up…": only where alerts can work (on an iPhone that means the
//                          Home Screen app), only while the phone has never been asked. "Not now":
//                          quiet for 14 days. Twice: never again. Edit profile always has the switch.
//  - pushTurnOn()          asks the phone's permission (it must come straight from a tap), gets this
//                          device's push address and saves it with push_register().
//  - pushRenderSettings()  the Notifications block in Edit profile: on/off for this device, then a
//                          Messages and a New listings switch. They save straight away.
//  - the routes            an alert opens #/chat/<student id> or #/listing/<id>. When Nestrel was
//                          closed, boot.js calls pushHandleColdRoute(); when it was open, sw.js sends
//                          a message instead of reloading the app.
//
// What is remembered, and where: the device itself is a row in Supabase (push_subscriptions, only
// ever visible to its owner). This browser keeps flags only, per account, in localStorage
// nestrel_push_<user id> = { on, dismissed, dismissedAt }. "on" means "this student wants alerts on
// this device", so signing out and back in quietly turns them back on, and a different student
// signing in here never inherits them.
// ============================================================

// Nestrel's VAPID public key: the half of the signing key pair every browser is given, so it is
// public on purpose. Its private half is a Supabase secret (VAPID_PRIVATE_KEY) and must never be in
// this repo. While this is empty, alerts are not set up: nothing is offered and Edit profile shows
// nothing.
const PUSH_PUBLIC_KEY = 'BLkGpS0l9VPggOaEK7CcMXWBQ9vo9INsn6x0bM0uMOGm1H-1p7aRXjMCjZ0M76UMJH3JeGLhbLHOFO8LGarhluA';

let _pushRow = null;        // this device's row once known: { id, want_messages, want_listings }
let _pushSynced = null;     // { id: user id, p: promise } — one check of this device per account per page
let _pushOffered = null;    // the user id the offer card was last considered for, this page

function pushSupported() {
  return !!PUSH_PUBLIC_KEY && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    && (location.protocol === 'https:' || location.hostname === 'localhost');
}
// iPhone and iPad allow alerts only inside the Home Screen app, never in a Safari tab.
function pushNeedsInstall() { return !!PUSH_PUBLIC_KEY && pwaPlatform() === 'ios' && !pwaInstalled(); }

function pushKey(id) { return 'nestrel_push_' + id; }
function pushLoad(id) { try { return JSON.parse(localStorage.getItem(pushKey(id))) || {}; } catch { return {}; } }
function pushSave(id, st) { try { localStorage.setItem(pushKey(id), JSON.stringify(st)); } catch { /* private mode: just don't remember */ } }

function pushKeyBytes() {
  const s = PUSH_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
// The service worker pwaInit() registered. navigator.serviceWorker.ready never settles when there
// is none (http, file://), so give up after a few seconds instead of waiting forever.
function pushReg() {
  return Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 5000))]);
}
function pushIsStudent() {
  return !!getEffectiveUser() && currentRole === 'student' && !(typeof adminPreviewMode !== 'undefined' && adminPreviewMode);
}

function pushInit() {
  if ('serviceWorker' in navigator) {
    // A tap on an alert while Nestrel is open (sw.js notificationclick).
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type !== 'nestrel-open') return;
      const route = pushRouteFromUrl(e.data.url);
      if (route) pushOpenRoute(route);
    });
  }
  supabaseClient.auth.onAuthStateChange(event => {
    // Signing out stops this device's alerts at once. The session is already gone, so the row cannot
    // be deleted from here; dropping the address is enough — the next send finds it gone and the
    // Edge Function removes the row.
    if (event === 'SIGNED_OUT') pushForgetDevice();
    if (event === 'SIGNED_IN') setTimeout(pushStart, 4000);
  });
  window.addEventListener('hashchange', () => {
    const route = pushRouteFromHash(location.hash);
    if (!route || !getEffectiveUser()) return;
    history.replaceState(null, '', location.pathname + location.search);
    pushOpenRoute(route);
  });
  setTimeout(pushStart, 8000);   // after the install reminder (6 s), so the two never collide
}

async function pushStart() {
  if (!pushIsStudent()) return;
  const u = getEffectiveUser();
  if (pushSupported()) await pushEnsureSynced(u);
  if (_pushOffered !== u.id) { _pushOffered = u.id; pushMaybeOffer(u); }
}

function pushEnsureSynced(u) {
  if (!_pushSynced || _pushSynced.id !== u.id) {
    _pushSynced = { id: u.id, p: pushSync(u).catch(e => console.warn('[push] check', e.message)) };
  }
  return _pushSynced.p;
}

// Makes this browser and Supabase agree about this device.
async function pushSync(u) {
  const reg = await pushReg();
  if (!reg) return;
  const st = pushLoad(u.id);
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const { data } = await supabaseClient.from('push_subscriptions')
      .select('id, want_messages, want_listings').eq('endpoint', sub.endpoint).maybeSingle();
    if (data) {
      _pushRow = data;
      if (!st.on) pushSave(u.id, { ...st, on: true });
      return;
    }
    if (!st.on) {
      // Not this student's: left behind by whoever used this browser before. Stop it alerting them here.
      await sub.unsubscribe().catch(() => {});
      return;
    }
    // This student turned alerts on here, but the row is gone (the address was renewed, or someone
    // else turned alerts on in this browser since): claim it again below.
  }
  if (st.on && Notification.permission === 'granted') await pushSubscribeAndSave(u, reg, sub);
  else if (st.on && Notification.permission === 'denied') pushSave(u.id, { ...st, on: false });   // blocked in Settings since
}

async function pushSubscribeAndSave(u, reg, existing) {
  let sub = existing;
  // An address made with an older key would be refused by every push service: start fresh.
  const had = sub?.options?.applicationServerKey;
  if (sub && had && !pushSameKey(new Uint8Array(had), pushKeyBytes())) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes() });
  const keys = sub.toJSON().keys || {};
  const { error } = await supabaseClient.rpc('push_register', { p_endpoint: sub.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
  if (error) throw error;
  const { data } = await supabaseClient.from('push_subscriptions')
    .select('id, want_messages, want_listings').eq('endpoint', sub.endpoint).maybeSingle();
  _pushRow = data || null;
  pushSave(u.id, { ...pushLoad(u.id), on: true });
}
function pushSameKey(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

// Called from a tap: the offer card's "Turn on", or the switch in Edit profile.
async function pushTurnOn() {
  const u = getEffectiveUser();
  if (!u || !pushSupported()) return false;
  // Ask first, and before anything else waits: an iPhone only shows the question when it comes
  // straight from a tap.
  let perm = Notification.permission;
  const asked = perm === 'default';
  if (asked) perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast(asked ? 'No notifications. You can turn them on later in Edit profile.'
                : 'Notifications are blocked for Nestrel in your settings');
    return false;
  }
  try {
    const reg = await pushReg();
    if (!reg) throw new Error('no service worker');
    await pushSubscribeAndSave(u, reg, await reg.pushManager.getSubscription());
    _pushSynced = { id: u.id, p: Promise.resolve() };
    toast('Notifications are on');
    return true;
  } catch (e) {
    console.warn('[push] turn on', e.message);
    toast('Couldn\'t turn on notifications. Try again in a moment.');
    return false;
  }
}

async function pushTurnOff() {
  const u = getEffectiveUser();
  if (!u) return;
  pushSave(u.id, { ...pushLoad(u.id), on: false });
  try {
    const reg = await pushReg();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await supabaseClient.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (e) { console.warn('[push] turn off', e.message); }
  _pushRow = null;
  toast('Notifications are off on this device');
}

async function pushForgetDevice() {
  _pushRow = null; _pushSynced = null; _pushOffered = null;
  document.getElementById('pushOffer')?.setAttribute('hidden', '');
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}

// ---- The offer card ----
function pushMaybeOffer(u) {
  if (!pushSupported() || Notification.permission !== 'default') return;   // already asked, either way
  const st = pushLoad(u.id);
  if (st.on || (st.dismissed || 0) >= 2) return;
  if (st.dismissedAt && Date.now() - st.dismissedAt < 14 * 864e5) return;
  // Never on top of the install card or the "Keep Nestrel close" screen.
  if (document.getElementById('pwaReminder')?.hidden === false) return;
  if (document.getElementById('keepCloseModal')?.classList.contains('open')) return;
  const el = document.getElementById('pushOffer');
  if (el) el.hidden = false;
}
function pushHideOffer() { document.getElementById('pushOffer')?.setAttribute('hidden', ''); }
function pushOfferAccept() { pushHideOffer(); pushTurnOn(); }
function pushOfferDismiss() {
  const u = getEffectiveUser();
  if (u) { const st = pushLoad(u.id); pushSave(u.id, { ...st, dismissed: (st.dismissed || 0) + 1, dismissedAt: Date.now() }); }
  pushHideOffer();
}

// ---- Edit profile → Notifications ----
async function pushRenderSettings() {
  const box = document.getElementById('epPush');
  if (!box) return;
  const u = getEffectiveUser();
  if (!PUSH_PUBLIC_KEY || !u || !pushIsStudent()) { box.hidden = true; return; }
  box.hidden = false;
  const head = '<div class="push-head">Notifications</div>';
  if (pushNeedsInstall()) {
    box.innerHTML = head + `<p class="push-note">On iPhone, notifications work in the Nestrel app on your Home Screen.</p>
      <button type="button" class="push-link" onclick="closeModal('editProfileModal');pwaReminderHow()">Show me how</button>`;
    return;
  }
  if (!pushSupported()) { box.innerHTML = head + '<p class="push-note">This browser can\'t show notifications.</p>'; return; }
  if (Notification.permission === 'denied') {
    box.innerHTML = head + `<p class="push-note">Notifications are blocked for Nestrel. To get them, allow them in your
      ${pwaPlatform() === 'desktop' ? 'browser\'s site settings' : 'phone\'s Settings → Notifications'}, then come back here.</p>`;
    return;
  }
  box.innerHTML = head + '<p class="push-note">Checking this device…</p>';
  await pushEnsureSynced(u);
  const on = !!_pushRow && Notification.permission === 'granted';
  const row = (b, small, attrs) => `<label class="push-row"><span><b>${b}</b><small>${small}</small></span>
      <input type="checkbox" class="ev-switch" ${attrs}></label>`;
  box.innerHTML = head
    + row('On this device', 'Alerts even when Nestrel is closed', `${on ? 'checked' : ''} onchange="pushToggleMain(this)"`)
    + (on ? `<div class="push-kinds">
        ${row('Messages', 'When someone messages you', `${_pushRow.want_messages ? 'checked' : ''} onchange="pushToggleKind('want_messages', this)"`)}
        ${row('New listings', 'When something new goes up on Nestrel', `${_pushRow.want_listings ? 'checked' : ''} onchange="pushToggleKind('want_listings', this)"`)}
      </div>` : '')
    + '<p class="push-note">These save straight away.</p>';
}

async function pushToggleMain(el) {
  el.disabled = true;
  if (el.checked) await pushTurnOn(); else await pushTurnOff();
  pushRenderSettings();
}

async function pushToggleKind(col, el) {
  if (!_pushRow || !['want_messages', 'want_listings'].includes(col)) return;
  const prev = _pushRow[col];
  _pushRow[col] = el.checked;
  const { error } = await supabaseClient.from('push_subscriptions').update({ [col]: el.checked }).eq('id', _pushRow.id);
  if (error) { _pushRow[col] = prev; el.checked = prev; toast('Couldn\'t save that. Try again.'); }
}

// ---- Where a tapped alert leads ----
// #/chat/<student id> and #/listing/<id>. The same two rules as evRouteFromHash() in js/events.js:
// a route starts with #/, and a hash carrying a Supabase sign-in marker is never a route.
function pushRouteFromHash(h) {
  h = h || '';
  if (!h.startsWith('#/') || AUTH_HASH_MARKERS.test(h)) return null;
  let m = h.match(/^#\/chat\/([0-9a-f-]{36})$/i);
  if (m) return { name: 'chat', id: m[1].toLowerCase() };
  m = h.match(/^#\/listing\/(\d{1,15})$/);
  if (m) return { name: 'listing', id: Number(m[1]) };
  return null;
}
function pushRouteFromUrl(url) {
  try { const x = new URL(url); return x.origin === location.origin ? pushRouteFromHash(x.hash) : null; }
  catch { return null; }
}

// boot.js, when Nestrel was opened BY the tap. Returns true when it has taken the screen.
function pushHandleColdRoute(signedIn) {
  const route = pushRouteFromHash(location.hash);
  if (!route) return false;
  history.replaceState(null, '', location.pathname + location.search);   // a reload must not reopen it
  if (!signedIn) return false;   // signed out: the usual login shows (signing out stopped the alerts anyway)
  pushOpenRoute(route);
  return true;
}

async function pushOpenRoute(route) {
  if (!getEffectiveUser()) return;
  if (route.name === 'chat') {
    showPage('messages');
    let info = sConvoCache[route.id];
    if (!info?.name) {
      const { data: p } = await supabaseClient.from('public_profiles')
        .select('first_name, last_name, display_name, initials, color').eq('id', route.id).maybeSingle();
      if (!p) return;
      info = { name: p.display_name || (p.first_name + ' ' + p.last_name), initials: p.initials, color: p.color };
    }
    openConvo(route.id, info);
  } else if (route.name === 'listing') {
    // A brand-new listing is not in the feed this page loaded, so fetch again before giving up.
    if (!DB.listings.some(x => x.id === route.id)) await loadListings();
    if (DB.listings.some(x => x.id === route.id)) openDetail(route.id);
    else toast('That listing isn\'t available any more');
  }
}
