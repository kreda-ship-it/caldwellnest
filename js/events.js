// ============================================================
// STUDENT — THE EVENTS SECTION
// ============================================================
// Its own page, its own file. Events left the marketplace on 2026-09-07: they are not a
// category of thing for sale. An event has a start, an end, a host, a door and an afterwards,
// and none of that fits a listing card.
//
// Reads visible_events and NOTHING else. The view answers three questions as columns —
// is_browsable, has_ended, effective_ends_at — so nothing in this file compares a time to
// now() or filters on status. If that ever creeps back in, the feed and the officer console
// can disagree about whether an event is over, which is the bug the view exists to prevent.

let _evFeed   = [];        // upcoming, ascending
let _evPast   = [];        // ended, newest first
let _evOrgs   = new Map(); // org id -> directory row, for the card's header
let _evGoing  = new Map(); // event id -> this student's own registration row
let _evDetail = null;      // the event currently open in the detail modal
let _evRated  = new Map(); // event id -> this student's own feedback row
let _evShowPast = false;

async function renderEvents() {
  const wrap = document.getElementById('evFeed');
  if (!wrap) return;
  wrap.innerHTML = '<div class="ev-note">Loading…</div>';

  // Boot paints the last-visited page BEFORE the session has resolved, so this can run with no
  // user and no grant — visible_events is granted to authenticated only, so the query returns
  // nothing and the empty state would say "Nothing on yet". That is a lie: it is not that
  // there are no events, it is that we cannot see them yet. Saying so and letting boot's async
  // block re-render is both honest and correct for a genuinely signed-out visitor.
  const eu = getEffectiveUser();
  if (!eu) {
    wrap.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-title">What's happening</div>
        <p>Sign in to see events posted by clubs and departments.</p>
        <button class="ev-empty-btn" onclick="requireAuth()">Sign in</button>
      </div>`;
    return;
  }

  const { data, error } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, description, event_type, starts_at, ends_at, location, ' +
            'poster_url, status, registration_open, capacity, cancelled_reason, ' +
            'has_ended, is_browsable, effective_ends_at, going_count, seats_left, checkin_is_open')
    .eq('school', eu.school || 'caldwell')
    .order('starts_at', { ascending: true });

  if (error) {
    wrap.innerHTML = '<div class="ev-note">Could not load events. Pull down to try again.</div>';
    console.error('[renderEvents]', error); return;
  }

  const rows = data || [];
  // is_browsable already means "published and not over". Filtering on it rather than on
  // status keeps the cancelled events a registrant can still reach out of the public feed
  // without a second query — the view carries both answers at once.
  _evFeed = rows.filter(e => e.is_browsable);
  _evPast = rows.filter(e => e.has_ended && e.status === 'published')
                .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

  await Promise.all([evLoadOrgs(rows), loadFavorites(true), evLoadGoing(), evLoadRated()]);
  evPaint();
  // Painted after the feed rather than inside it: it needs two more queries, and holding the
  // whole feed back for a prompt would make the common case — nothing to rate — slower for
  // everybody.
  evPaintAsk();
}

// Org name, logo and verified badge come from org_directory — the same public view the Clubs
// page reads. The verified badge is the answer to "is this a real club or someone's
// Instagram", so it belongs on the card, not only on the org's own page.
async function evLoadOrgs(rows) {
  const ids = [...new Set(rows.map(e => e.org_id))];
  if (!ids.length) return;
  const { data } = await supabaseClient
    .from('org_directory').select('id, name, logo_url, is_verified').in('id', ids);
  (data || []).forEach(o => _evOrgs.set(o.id, o));
}

// The star is PRIVATE, and the calendar/register action is not — the detail page says so
// directly under the button. Saving itself lives in js/favorites.js, which owns the star for
// listings, books and events alike: three copies of "is this saved" is three sources of truth.

// A student may read their OWN registration rows and no one else's, which is exactly what
// this needs. The count of everybody else arrives as going_count on the view, computed by a
// definer function — the rows stay private, the number does not.
async function evLoadGoing() {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient
    .from('event_registrations').select('event_id, status').eq('user_id', eu.id);
  _evGoing = new Map();
  (data || []).filter(r => r.status !== 'cancelled').forEach(r => _evGoing.set(r.event_id, r));
}

// ---------- Date grouping ----------
// Chronology is the product (§1.1), so the feed is grouped by day rather than ranked. Today
// and Tomorrow are named because that is how a student thinks about the next two days; after
// that a date is clearer than a countdown.
function evDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function evDayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const midnight = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(now)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
}

function evTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function evPaint() {
  const wrap = document.getElementById('evFeed');

  // Search replaces the feed rather than sitting above it. Both answer "what is on", and two
  // lists of events on one screen makes the student work out which one they are reading.
  if (_evSearchOn) { wrap.innerHTML = evSearchHTML(); evSearchPaintChips(); return; }

  if (!_evFeed.length && !_evPast.length) {
    wrap.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-title">Nothing on yet</div>
        <p>When a club posts an event it shows up here, soonest first.</p>
        <button class="ev-empty-btn" onclick="orgDirGo()">Find clubs to follow</button>
      </div>`;
    return;
  }

  let html = '<div id="evAskSlot"></div>';
  let lastKey = null;
  for (const e of _evFeed) {
    const key = evDayKey(e.starts_at);
    if (key !== lastKey) {
      html += `<div class="ev-day">${esc(evDayLabel(e.starts_at))}</div>`;
      lastKey = key;
    }
    html += evCardHTML(e);
  }

  if (!_evFeed.length) html += '<div class="ev-note">Nothing coming up right now.</div>';

  // Past events are behind a chip, not in the list. The photo count is the reason anyone
  // taps it — a past event with recap photos is worth looking at, and one without is not.
  if (_evPast.length) {
    html += `
      <button class="ev-past-chip" onclick="evTogglePast(this)">
        ${_evShowPast ? 'Hide' : 'Show'} past events · ${_evPast.length}
      </button>
      <div class="ev-past" ${_evShowPast ? '' : 'hidden'}>
        ${_evPast.map(e => evCardHTML(e, true)).join('')}
      </div>`;
  }

  wrap.innerHTML = html;
}

async function evPaintAsk() {
  const slot = document.getElementById('evAskSlot');
  if (!slot) return;
  slot.innerHTML = await evPendingRatingHTML();
}

function evTogglePast(btn) {
  _evShowPast = !_evShowPast;
  const el = document.querySelector('.ev-past');
  if (el) el.hidden = !_evShowPast;
  if (btn) btn.textContent = `${_evShowPast ? 'Hide' : 'Show'} past events · ${_evPast.length}`;
}

function evCardHTML(e, past = false) {
  const org = _evOrgs.get(e.org_id);

  const dayTime = `${evDayLabel(e.starts_at)} · ${evTime(e.starts_at)}`;

  // Two posters, and they carry DIFFERENT amounts of information on purpose.
  //
  // A photo is a composition somebody chose, so nothing is written over it and the details go
  // in the text row beneath.
  //
  // A generated poster has nothing to protect, so it carries the whole answer — who, what,
  // when, where — and the text row beneath drops the title and the time rather than printing
  // them twice. A card should say each thing once.
  const poster = e.poster_url
    ? `<img class="ev-poster-img" src="${escAttr(e.poster_url)}" alt="" loading="lazy">`
    : `<div class="ev-poster-made" style="background:${eventGradient(e.id)}">
         <div class="ev-p-org">${esc(org?.name || '')}</div>
         <div class="ev-p-title">${esc(e.title)}</div>
         <div class="ev-p-foot">
           <span class="ev-p-rule"></span>
           <div class="ev-p-when">${esc(dayTime)}</div>
           <div class="ev-p-where">${esc(e.location)}</div>
         </div>
       </div>`;

  // seats_left is NULL for an unlimited event and 0 for a full one. They are opposites, so
  // the null check comes first — treating them alike would print "0 spots left" on an event
  // with no limit at all.
  const bits = [];
  if (e.registration_open && e.going_count) bits.push(`${e.going_count} going`);
  if (e.registration_open && e.seats_left !== null && e.seats_left !== undefined) {
    bits.push(e.seats_left === 0 ? 'full' : `${e.seats_left} spot${e.seats_left === 1 ? '' : 's'} left`);
  }
  if (_evGoing.has(e.id)) bits.unshift('You are going');
  const seats = bits.length ? `<span class="ev-seats">${esc(bits.join(' · '))}</span>` : '';

  return `
    <article class="ev-card${past ? ' is-past' : ''}">
      <button class="ev-org" onclick="event.stopPropagation();orgPageOpen(${e.org_id})">
        ${org?.logo_url
          ? `<img class="ev-org-logo" src="${escAttr(org.logo_url)}" alt="">`
          : `<span class="ev-org-logo ev-org-logo-blank"></span>`}
        <span class="ev-org-name">${esc(org?.name || 'Campus')}</span>
        ${org?.is_verified ? '<span class="ev-verified" title="Verified organization">&#10003;</span>' : ''}
      </button>

      <div class="ev-poster" onclick="evOpen(${e.id})">${poster}</div>

      <div class="ev-meta">
        <div class="ev-meta-text" onclick="evOpen(${e.id})">
          ${e.poster_url ? `
            <div class="ev-title">${esc(e.title)}</div>
            <div class="ev-when">${esc(evTime(e.starts_at))} · ${esc(e.location)}</div>` : ''}
          ${seats}
        </div>
        ${favStarHTML('event', e.id, 'ev-star')}
      </div>
    </article>`;
}

// ============================================================
// DETAIL
// ============================================================
// A modal, matching how a listing opens, rather than a separate page. When the #/event/:id
// deep link arrives it opens this same modal on load, so there is one detail view and not a
// second one that drifts.

async function evOpen(id) {
  // Re-read the row rather than trusting the feed's copy. A student can arrive here from a
  // deep link with no feed loaded at all, and an event opened from a stale feed could show a
  // seat that was taken two minutes ago.
  const { data, error } = await supabaseClient
    .from('visible_events')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    toast(error ? 'Could not open that event' : 'That event is no longer available');
    if (error) console.error('[evOpen]', error);
    return;
  }
  _evDetail = data;
  const e = data;

  const [{ data: media }] = await Promise.all([
    supabaseClient.from('event_media')
      .select('kind, url, caption, phase, sort_order').eq('event_id', id).order('sort_order'),
    evLoadGoing(),
  ]);
  _evDetail._media = media || [];
  if (!_evOrgs.has(data.org_id)) await evLoadOrgs([data]);

  evPaintDetail();
  openModal('evDetailModal');

  // Put the event in the address bar. Three things fall out of one line: a refresh reopens it
  // through the cold-route path already built, the URL is shareable without anybody having to
  // find a share button, and it is the same address the QR encodes — so the deep link and an
  // opened modal are not two different states.
  //
  // replaceState, not pushState: pushState would make Back step through every event the
  // student browsed rather than leaving the feed. Neither fires hashchange, so the listener
  // does not re-enter this function.
  if (`#/event/${e.id}` !== window.location.hash) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/event/${e.id}`);
  }
}

function evPaintDetail() {
  const e = _evDetail;
  const org = _evOrgs.get(e.org_id);
  const images = e._media.filter(m => m.kind === 'image');
  const videos = e._media.filter(m => m.kind === 'video_link');

  const starts = new Date(e.starts_at);
  const whenFull = starts.toLocaleString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const endBit = e.ends_at
    ? ' – ' + new Date(e.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';

  document.getElementById('evDetailBody').innerHTML = `
    ${e.status === 'cancelled' ? `
      <div class="evd-cancelled">
        <strong>This event was cancelled.</strong>
        ${e.cancelled_reason ? `<div>${esc(e.cancelled_reason)}</div>` : ''}
      </div>` : ''}

    <div class="evd-poster">
      ${e.poster_url
        ? `<img src="${escAttr(e.poster_url)}" alt="">`
        : `<div class="ev-poster-made" style="background:${eventGradient(e.id)}">
             <div class="ev-p-org">${esc(org?.name || '')}</div>
             <div class="ev-p-title">${esc(e.title)}</div>
           </div>`}
    </div>

    <button class="ev-org evd-org" onclick="closeModal('evDetailModal');evClearRoute();orgPageOpen(${e.org_id})">
      ${org?.logo_url ? `<img class="ev-org-logo" src="${escAttr(org.logo_url)}" alt="">`
                      : `<span class="ev-org-logo ev-org-logo-blank"></span>`}
      <span class="ev-org-name">${esc(org?.name || 'Campus')}</span>
      ${org?.is_verified ? '<span class="ev-verified">&#10003;</span>' : ''}
    </button>

    <h2 class="evd-title">${esc(e.title)}</h2>

    <div class="evd-when">${esc(whenFull + endBit)}</div>
    <div class="evd-where">${esc(e.location)}</div>

    <div class="evd-cal">
      <button class="evd-cal-btn" onclick="evAddToGoogle()">Add to Google Calendar</button>
      <button class="evd-cal-btn" onclick="evDownloadIcs()">Download .ics</button>
    </div>

    ${e.description ? `<p class="evd-desc">${esc(e.description)}</p>` : ''}

    ${images.length > 1 ? `<div class="evd-gallery">${
      images.map(m => `<img src="${escAttr(m.url)}" alt="${escAttr(m.caption || '')}" loading="lazy">`).join('')
    }</div>` : ''}

    ${videos.map(v => `
      <a class="evd-video" href="${escAttr(v.url)}" target="_blank" rel="noopener noreferrer">
        <span class="evd-video-play">&#9654;</span>
        <span>Watch on ${esc(evVideoHost(v.url))}</span>
      </a>`).join('')}

    ${evRegisterBlockHTML(e)}`;
}

// Every state the button can be in, in one place, so none of them can be reached by accident.
function evRegisterBlockHTML(e) {
  const mine = _evGoing.get(e.id);

  if (e.status === 'cancelled') return '';
  if (e.has_ended) return '<div class="evd-note">This event has ended.</div>';
  if (!e.registration_open) {
    return '<div class="evd-note">No sign-up needed — just turn up.</div>';
  }
  // Already through the door. Nothing to offer and nothing to undo — a student who wants out
  // after arriving is talking to the officer, not to a button.
  if (mine && (mine.status === 'checked_in' || mine.status === 'walk_in')) {
    return '<div class="evd-here">You are checked in &#10003;</div>';
  }

  // PERSISTENT, not a toast. The student tapped a button and now has to stand there while
  // somebody finds them on a list; a message that fades after three seconds leaves them
  // wondering whether the tap landed at all, and tapping again is the natural response.
  if (mine && mine.status === 'self_reported') {
    return `
      <div class="evd-waiting">
        <strong>Waiting for the organizer to confirm you</strong>
        <div>Show them this screen if there is a queue.</div>
      </div>`;
  }

  if (mine) {
    return `
      ${e.checkin_is_open ? `
        <div class="evd-reg">
          <button class="evd-btn evd-btn-go" onclick="evImHere()">I'm here</button>
        </div>
        <p class="evd-privacy">Tell the organizers you have arrived. They confirm it at the door.</p>` : ''}
      <div class="evd-reg">
        <div class="evd-going">You are going &#10003;</div>
        <button class="evd-btn evd-btn-ghost" onclick="evUnregister()">Cancel my place</button>
      </div>
      ${evPrivacyLine()}`;
  }

  // Not registered, but standing at the door. This is the walk-up-and-scan case and it is most
  // of the value of the QR: one tap registers AND reports arrival, because somebody at the
  // door should not have to do two things in the right order to get in.
  if (e.checkin_is_open && e.seats_left !== 0) {
    return `
      <div class="evd-reg">
        <button class="evd-btn evd-btn-go" onclick="evImHere()">I'm here</button>
      </div>
      <p class="evd-privacy">This signs you up and tells the organizers you have arrived.
         They will see your name and email.</p>`;
  }
  if (e.seats_left === 0) {
    return `<div class="evd-reg"><button class="evd-btn" disabled>Full</button></div>
            <div class="evd-note">Every place has been taken. There is no waiting list yet.</div>`;
  }
  return `
    <div class="evd-reg">
      <button class="evd-btn evd-btn-go" onclick="evRegister()">Register</button>
      ${e.seats_left !== null && e.seats_left !== undefined
        ? `<span class="evd-seats">${e.seats_left} left</span>` : ''}
    </div>
    ${evPrivacyLine()}`;
}

// Stated once, plainly, directly under the button — §4.1 is explicit that it must not be
// buried. The star is private and this is not, and a student is entitled to know which is
// which BEFORE they tap, not in a settings page afterwards.
function evPrivacyLine() {
  return `<p class="evd-privacy">The organizers will see your name and email. Saving with the
          star does not tell anyone.</p>`;
}

function evVideoHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'video'; }
}

async function evRegister() {
  const e = _evDetail;
  if (!getEffectiveUser()) { requireAuth(); return; }
  const btn = document.querySelector('.evd-btn-go');
  if (btn) { btn.disabled = true; btn.textContent = 'Registering…'; }

  // The RPC, never a direct insert. It locks the event row, counts and inserts in one
  // transaction, so two students tapping the last seat queue instead of both winning.
  const { error } = await supabaseClient.rpc('register_for_event', { p_event_id: e.id });
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Register'; }
    // "This event is full" is the message the RPC raises when it loses the race, and it is
    // worth showing as-is: it is accurate, and it is the one refusal a student will actually
    // want explained.
    toast(error.message.includes('full') ? 'Sorry — that filled up' : 'Could not register: ' + error.message);
    console.error('[evRegister]', error);
    await evRefreshDetail();
    return;
  }
  toast('✓ You are going');
  await evRefreshDetail();
  renderEvents();
}

// One RPC for all three outcomes, because from the student's side it is one tap. The function
// decides: trusted event -> checked in; normal event -> waiting for an officer; not registered
// -> registers first, then either of those.
//
// The window is checked in the database, not here. The button is only OFFERED when
// checkin_is_open says so, but a phone with a wrong clock, a page left open since yesterday,
// or anyone reading the network tab all reach the same refusal.
async function evImHere() {
  const e = _evDetail;
  if (!getEffectiveUser()) { requireAuth(); return; }
  const btn = document.querySelector('.evd-btn-go');
  if (btn) { btn.disabled = true; btn.textContent = 'Telling them…'; }

  const { data, error } = await supabaseClient.rpc('self_report_arrival', { p_event_id: e.id });
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = "I'm here"; }
    toast(error.message.includes('full') ? 'Sorry — that filled up'
        : error.message.includes('not open') ? 'Check-in is not open yet'
        : 'Could not check you in: ' + error.message);
    console.error('[evImHere]', error);
    await evRefreshDetail();
    return;
  }
  toast(data === 'checked_in' ? '✓ You are checked in' : '✓ They know you are here');
  await evRefreshDetail();
  renderEvents();
}

async function evUnregister() {
  const e = _evDetail;
  if (!confirm('Cancel your place? Someone else can take it.')) return;
  const { error } = await supabaseClient.rpc('cancel_registration', { p_event_id: e.id });
  if (error) { toast('Could not cancel: ' + error.message); console.error('[evUnregister]', error); return; }
  toast('Your place has been cancelled');
  await evRefreshDetail();
  renderEvents();
}

// Re-reads the row so the seat count and the button state come from the database rather than
// from what this browser assumed happened.
async function evRefreshDetail() {
  const { data } = await supabaseClient.from('visible_events').select('*').eq('id', _evDetail.id).maybeSingle();
  if (data) { data._media = _evDetail._media; _evDetail = data; }
  await evLoadGoing();
  evPaintDetail();
}

// ---------- Add to calendar ----------
// The classic bug in this feature is a time that lands hours off. Both formats below want UTC
// with a Z, and toISOString() is the only thing here that produces it — building the string
// from getHours() would emit local time labelled as UTC, which is the shift.
function evUtcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function evCalRange() {
  const start = new Date(_evDetail.starts_at);
  // Falls back to the same effective end the view computes, so an event with no end time
  // still lands in a calendar as a block rather than a zero-length instant.
  const end = new Date(_evDetail.ends_at || _evDetail.effective_ends_at);
  return `${evUtcStamp(start)}/${evUtcStamp(end)}`;
}

function evAddToGoogle() {
  const e = _evDetail;
  const url = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(e.title)
    + '&dates=' + evCalRange()
    + '&location=' + encodeURIComponent(e.location || '')
    + '&details=' + encodeURIComponent(e.description || '');
  window.open(url, '_blank', 'noopener');
}

function evDownloadIcs() {
  const e = _evDetail;
  // CRLF line endings are required by the iCalendar spec, and some calendar apps genuinely
  // reject a file that uses bare newlines.
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CaldwellNest//Events//EN',
    'BEGIN:VEVENT',
    `UID:event-${e.id}@caldwellnest`,
    `DTSTAMP:${evUtcStamp(new Date())}`,
    `DTSTART:${evUtcStamp(new Date(e.starts_at))}`,
    `DTEND:${evUtcStamp(new Date(e.ends_at || e.effective_ends_at))}`,
    `SUMMARY:${evIcsEscape(e.title)}`,
    `LOCATION:${evIcsEscape(e.location || '')}`,
    `DESCRIPTION:${evIcsEscape(e.description || '')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${String(e.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'event'}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Commas, semicolons and backslashes are field separators in iCalendar. An unescaped comma in
// a title silently truncates the rest of it in some calendar apps.
function evIcsEscape(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}


// ============================================================
// THE DEEP LINK  —  #/event/:id
// ============================================================
// A QR on a poster encodes this URL. The phone's own camera is the scanner, so the entire
// scanning half of the feature is free — but only if the URL actually resolves, cold, in a
// tab that has never opened the app.
//
// ############################################################
// THE HASH IS NOT FREE. READ THIS BEFORE CHANGING evRouteFromHash().
// ############################################################
// Supabase returns auth tokens in the fragment, and js/boot.js already reads them:
//     boot.js:25   if (/[#&]type=recovery/.test(location.hash)) showResetScreen();
//     boot.js:132  if (/[#&]type=signup/.test(location.hash))  … verified toast
//
// A real reset link arrives looking like:
//     #access_token=ey…&refresh_token=…&expires_in=3600&type=recovery
//
// A router that treats the whole fragment as its own would swallow that, and password reset —
// still the last unverified item on the v1 launch-blocker list — would break in a way that
// looks like Supabase's fault. So the rule is narrow and it is enforced twice:
//
//   1. A hash is a ROUTE only if it starts with `#/`. Supabase's never does; it starts with
//      the token name.
//   2. Even then, a hash carrying any auth marker is refused outright. Belt and braces,
//      because rule 1 is a prefix test and prefixes are easy to loosen by accident later.
//
// If a future route needs a different shape, it still has to pass BOTH.
const AUTH_HASH_MARKERS = /access_token|refresh_token|type=recovery|type=signup|error_code|error_description/;

function evRouteFromHash() {
  const h = window.location.hash || '';
  if (!h.startsWith('#/')) return null;          // rule 1
  if (AUTH_HASH_MARKERS.test(h)) return null;    // rule 2
  const m = h.match(/^#\/event\/(\d+)\b/);
  return m ? { name: 'event', id: Number(m[1]) } : null;
}

// Where a signed-out visitor's destination is kept while they log in. sessionStorage rather
// than a variable: the login flow can involve a page load, and a variable does not survive one.
const EV_INTENT_KEY = 'cn_pending_route';

function evStoreIntent() {
  const route = evRouteFromHash();
  if (!route) return false;
  try { sessionStorage.setItem(EV_INTENT_KEY, JSON.stringify(route)); } catch (e) { /* private mode */ }
  return true;
}

// Called from enterStudentSession(), the one place login and signup share. A student who
// scanned a poster, hit the login screen and signed in lands on THAT EVENT — not on the home
// feed, which is the single most likely thing to make a QR feel broken at a real door.
function evResumeIntent() {
  let route = null;
  try {
    const raw = sessionStorage.getItem(EV_INTENT_KEY);
    if (raw) route = JSON.parse(raw);
    sessionStorage.removeItem(EV_INTENT_KEY);
  } catch (e) { /* corrupt or unavailable — fall through to the normal landing */ }
  if (!route) route = evRouteFromHash();
  if (!route || route.name !== 'event') return false;
  showPage('events');
  evOpen(route.id);
  return true;
}

// Entry point for a cold load. Returns true when it has taken responsibility for the screen,
// so boot.js can skip its own "restore the last page" logic rather than painting twice.
//
// The signed-out case does NOT silently drop the intent. It stores it first and then asks for
// a login, so the round trip ends where it started.
function evHandleColdRoute(signedIn) {
  const route = evRouteFromHash();
  if (!route) return false;
  if (!signedIn) {
    evStoreIntent();
    openModal('loginModal');
    return true;
  }
  showPage('events');
  evOpen(route.id);
  return true;
}

// Navigating within the app once it is already open — a shared link pasted into the address
// bar of a live tab, or the back button after closing the modal.
window.addEventListener('hashchange', () => {
  const route = evRouteFromHash();
  if (!route) return;
  if (!getEffectiveUser()) { evStoreIntent(); openModal('loginModal'); return; }
  showPage('events');
  evOpen(route.id);
});

// Closing the modal clears the route from the address bar, so a reload does not reopen an
// event the student has already dismissed. replaceState rather than assigning location.hash:
// assigning would push a history entry and make Back re-open it.
function evClearRoute() {
  if (evRouteFromHash()) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}


// ============================================================
// GOING  —  the student's own registrations, on their profile
// ============================================================
// §4.6. Upcoming first, then what already happened, because the question a student opens this
// for is "what have I said yes to" and only afterwards "what did I go to".
//
// This is the ONLY surface that starts from event_registrations rather than from
// visible_events, and it has to: an event the student registered for and then had cancelled
// is still theirs, and a feed built from browsable events would silently drop it. So it reads
// their own rows — which RLS allows and nothing else — and fetches the events by id.

async function renderGoing() {
  const wrap = document.getElementById('myGoing');
  if (!wrap) return;

  // A TAB now, not a section that hides when empty. See renderSaved() for why.
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const emptyHTML = `<div class="sq-empty"><div class="sq-empty-t">Nothing yet</div>
    <p>Events you register for show up here, and stay afterwards so you can rate them.</p></div>`;

  const { data: regs, error } = await supabaseClient
    .from('event_registrations')
    .select('event_id, status, created_at')
    .eq('user_id', eu.id);

  if (error) { console.error('[renderGoing]', error); return; }

  // Cancelled registrations are dropped: the student withdrew, and a list of things you
  // decided not to do is not a useful part of your own profile. A cancelled EVENT is a
  // different thing entirely and stays — see below.
  const live = (regs || []).filter(r => r.status !== 'cancelled');
  if (!live.length) { wrap.innerHTML = emptyHTML; return; }

  const { data: evs } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, starts_at, location, poster_url, status, has_ended, ' +
            'effective_ends_at, cancelled_reason')
    .in('id', live.map(r => r.event_id));

  const rows = evs || [];
  if (!rows.length) { wrap.innerHTML = emptyHTML; return; }
  await Promise.all([evLoadOrgs(rows), evLoadRated()]);

  const byId = new Map(live.map(r => [r.event_id, r]));
  const upcoming = rows.filter(e => !e.has_ended)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = rows.filter(e => e.has_ended)
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

  wrap.innerHTML =
    upcoming.map(e => goingRowHTML(e, byId.get(e.id))).join('') +
    (past.length ? `<div class="go-head">Already happened</div>` : '') +
    past.map(e => goingRowHTML(e, byId.get(e.id))).join('');
}

function goingRowHTML(e, reg) {
  const org = _evOrgs.get(e.org_id);
  const when = new Date(e.starts_at).toLocaleString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // A cancelled event the student registered for stays on this list, loudly. It is the one
  // place they will look, there is no notification layer to tell them any other way, and
  // quietly removing it would mean they turn up.
  const rated = _evRated.get(e.id);
  const rate = rated
    ? `<span class="go-state go-rated">You rated it ${'&#9733;'.repeat(rated.rating)}</span>`
    : evCanRate(e, reg)
      ? `<div class="go-rate"><span class="go-rate-q">Rate it</span>${evStarsHTML(e.id, 0)}</div>`
      : (e.has_ended && ['checked_in', 'walk_in'].includes(reg?.status)
          ? '<span class="go-state go-shut">Rating closed</span>' : '');

  const state = e.status === 'cancelled'
    ? `<span class="go-state go-off">Cancelled${e.cancelled_reason ? ' · ' + esc(e.cancelled_reason) : ''}</span>`
    : (reg?.status === 'checked_in' || reg?.status === 'walk_in')
      ? '<span class="go-state go-in">You were there &#10003;</span>'
      : reg?.status === 'self_reported'
        ? '<span class="go-state">Waiting to be confirmed</span>'
        : e.has_ended ? '<span class="go-state go-off">Did not check in</span>' : '';

  // A div, not a button. The row now contains star buttons, and nesting a button inside a
  // button is invalid HTML that browsers resolve by dropping one of them — usually the inner
  // one, which is exactly the control that matters here. The thumbnail and the text open the
  // event; the stars do their own thing.
  return `
    <div class="go-row${e.has_ended ? ' is-past' : ''}">
      <div class="go-thumb" onclick="evOpen(${e.id})"${e.poster_url ? '' : ` style="background:${eventGradient(e.id)}"`}>
        ${e.poster_url ? `<img src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="go-text" onclick="if(!event.target.closest('.ev-stars'))evOpen(${e.id})">
        <div class="go-title">${esc(e.title)}</div>
        <div class="go-when">${esc(when)}</div>
        <div class="go-where">${esc(org?.name ? org.name + " · " : "")}${esc(e.location)}</div>
        ${state}
        ${rate}
      </div>
    </div>`;
}


// ============================================================
// FEEDBACK  —  gated on attendance
// ============================================================
// §1.6. Anyone can have an opinion about a party they did not attend; only a student with a
// CHECK-IN row can rate an event. One rule, three jobs: the feedback means something because
// it comes from people who were there, check-in gains a reason to exist for the STUDENT
// rather than only for the org, and the loop that makes staffing a door worthwhile closes.
//
// The rule is enforced by the event_feedback INSERT policy — check-in row, event ended,
// ended within seven days — not here. Everything below decides what to OFFER; the database
// decides what to accept, and a student reading the network tab reaches the same answer.

const EV_FEEDBACK_DAYS = 7;

// A student may read their own feedback rows and nothing else, which is exactly what this
// needs: whether THEY have already rated something.
async function evLoadRated() {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient
    .from('event_feedback').select('event_id, rating, comment').eq('user_id', eu.id);
  _evRated = new Map((data || []).map(f => [f.event_id, f]));
}

// Mirrors the policy rather than inventing a second rule: attended, over, and inside the
// window. If these ever disagree the database wins and the student sees a refusal, which is
// why the copy never promises the rating will be accepted before it has been.
function evCanRate(e, reg) {
  if (!e || !reg) return false;
  if (!['checked_in', 'walk_in'].includes(reg.status)) return false;
  if (!e.has_ended) return false;
  const ended = new Date(e.effective_ends_at || e.ends_at || e.starts_at).getTime();
  return Date.now() - ended < EV_FEEDBACK_DAYS * 864e5;
}

// ---------- The one contextual slot ----------
// §4.1 allows AT MOST ONE card above the first date group, and this is its correct first use.
// There is no notification layer, so a passive prompt in the place the student already looks
// is the whole delivery mechanism — and the most recent event is the one they remember.
async function evPendingRatingHTML() {
  const eu = getEffectiveUser();
  if (!eu?.id) return '';

  const { data: regs } = await supabaseClient
    .from('event_registrations').select('event_id, status').eq('user_id', eu.id)
    .in('status', ['checked_in', 'walk_in']);
  if (!regs || !regs.length) return '';

  const { data: evs } = await supabaseClient
    .from('visible_events')
    .select('id, title, has_ended, effective_ends_at')
    .in('id', regs.map(r => r.event_id));

  const byReg = new Map(regs.map(r => [r.event_id, r]));
  const due = (evs || [])
    .filter(e => evCanRate(e, byReg.get(e.id)) && !_evRated.has(e.id))
    .sort((a, b) => new Date(b.effective_ends_at) - new Date(a.effective_ends_at));

  if (!due.length) return '';
  const e = due[0];
  return `
    <div class="ev-ask">
      <div class="ev-ask-q">How was ${esc(e.title)}?</div>
      ${evStarsHTML(e.id, 0)}
      <div class="ev-ask-note">Shared anonymously with the organizers.</div>
    </div>`;
}

function evStarsHTML(eventId, value) {
  return `<div class="ev-stars" id="evStars-${eventId}">${
    [1, 2, 3, 4, 5].map(n =>
      `<button class="ev-star-btn${n <= value ? ' is-on' : ''}" aria-label="${n} out of 5"
               onclick="evRate(${eventId}, ${n})">&#9733;</button>`).join('')
  }</div>`;
}

// One tap submits the rating. The comment is a SECOND, optional step offered afterwards,
// because asking for words up front is what stops most people answering at all — and a rating
// with no comment is still the number the officer needs.
async function evRate(eventId, rating) {
  const eu = getEffectiveUser();
  if (!eu?.id) { requireAuth(); return; }

  // `school` is omitted deliberately: event_feedback_set_school fills it from the event, so
  // the browser cannot write a row into a school that does not exist.
  const { error } = await supabaseClient.from('event_feedback')
    .insert({ event_id: eventId, user_id: eu.id, rating });

  if (error) {
    // The likely refusals are all policy: no check-in row, or outside the seven days. Both
    // mean the same thing to a student, and neither is worth a database message.
    toast(error.code === '23505' ? 'You already rated that one'
        : 'That rating could not be saved — the window may have closed');
    console.error('[evRate]', error);
    return;
  }
  _evRated.set(eventId, { event_id: eventId, rating, comment: null });
  toast('✓ Thank you');
  evAskComment(eventId, rating);
  renderEvents();
  renderGoing();
}

// Offered once, immediately after the star, and never again. The card does not come back:
// §4.5 says submitting replaces it with a thank-you, and a prompt that reappears is a prompt
// people learn to dismiss without reading.
async function evAskComment(eventId, rating) {
  const note = prompt('Anything you want to tell the organizers? (optional)\n\nShared anonymously — though at a small event a detailed comment may still be recognisable.');
  if (note === null || !note.trim()) return;
  const { error } = await supabaseClient.from('event_feedback')
    .update({ comment: note.trim() }).eq('event_id', eventId).eq('user_id', getEffectiveUser().id);
  if (error) { console.error('[evAskComment]', error); return; }
  const row = _evRated.get(eventId); if (row) row.comment = note.trim();
  toast('✓ Sent');
}


// ============================================================
// EVENTS SEARCH
// ============================================================
// §1.2 and §4.2. Scoped to events, opened from the events header, and separate from the
// marketplace search on purpose: that one answers "what is available", this one answers "when
// is it and who is running it". Two axes, two surfaces.
//
// THE ENTRY STATE MATTERS MORE THAN THE QUERY STATE, and that is not a stylistic claim. With
// a dozen events in a semester, a typed query returns nothing most of the time. Zero results
// is Tuesday, not an error. So what fills the screen before anybody types — the orgs you
// follow, the date chips, the type tiles — is the product, and the text box is the fallback.

let _evSearchOn   = false;
let _evSearchQ    = '';
let _evSearchOrg  = null;
let _evSearchType = null;
let _evSearchWhen = null;
let _evFollowed   = [];

const EV_TYPES = [
  ['social', 'Social'], ['academic', 'Academic'], ['sports', 'Sports'],
  ['service', 'Service'], ['career', 'Career'], ['arts', 'Arts'], ['meeting', 'Meeting'],
];

// Named ranges, resolved against the student's own clock because "this weekend" is a fact
// about where they are, not about the server. A user-chosen range is a QUERY, not one of the
// app's visibility rules — those stay in the view as columns; this is the student asking a
// question and it belongs where the question is asked.
function evWhenRange(key) {
  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const add = (d, n) => new Date(d.getTime() + n * 864e5);
  const today = startOfDay(now);
  // getDay(): 0 is Sunday. Days until the coming Saturday, and 0 when it already is Saturday.
  const toSat = (6 - today.getDay() + 7) % 7;
  switch (key) {
    case 'week':    return [now, add(today, 7)];
    case 'weekend': return [add(today, toSat), add(today, toSat + 2)];
    case 'next':    return [add(today, 7), add(today, 14)];
    case 'month':   return [now, new Date(now.getFullYear(), now.getMonth() + 1, 1)];
    default:        return null;
  }
}

// THE one matching function. §1.2 requires it to be written once and called from both
// surfaces, because the scoped search and the marketplace's Events section diverging is
// exactly the bug already flagged for book_listings bypassing visible_listings.
//
// Takes rows that came from visible_events and never re-queries: whatever RLS refused the
// caller is already absent, so a filter here can only narrow what they were entitled to see.
// That is why it is safe for this to be JavaScript at all — a filter is not a permission,
// and this one is not being asked to be.
function evMatchEvents(rows, { q, orgId, type, when } = {}) {
  const needle = (q || '').trim().toLowerCase();
  const range = when ? evWhenRange(when) : null;

  return (rows || []).filter(e => {
    if (orgId && e.org_id !== orgId) return false;
    if (type && e.event_type !== type) return false;
    if (range) {
      const t = new Date(e.starts_at);
      if (t < range[0] || t >= range[1]) return false;
    }
    if (!needle) return true;
    // Org name is searched too, because "chess" is as likely to be the club as the event.
    const org = _evOrgs.get(e.org_id);
    return [e.title, e.location, e.description, org?.name]
      .some(v => (v || '').toLowerCase().includes(needle));
  });
}

async function evSearchOpen() {
  _evSearchOn = true;
  _evSearchQ = ''; _evSearchOrg = null; _evSearchType = null; _evSearchWhen = null;
  await evLoadFollowed();
  evPaint();
  document.getElementById('evSearchInput')?.focus();
}

function evSearchClose() { _evSearchOn = false; evPaint(); }

// The orgs a student follows, which on a campus feed is the most-used control on this screen
// and is not a search at all. Fetched once per open rather than cached, because following
// happens on another page and a stale row here would offer the wrong shortcuts.
async function evLoadFollowed() {
  const eu = getEffectiveUser();
  if (!eu?.id) { _evFollowed = []; return; }
  const { data: f } = await supabaseClient.from('org_follows').select('org_id').eq('user_id', eu.id);
  const ids = (f || []).map(x => x.org_id);
  if (!ids.length) { _evFollowed = []; return; }
  const { data } = await supabaseClient.from('org_directory')
    .select('id, name, logo_url, is_verified').in('id', ids);
  _evFollowed = data || [];
}

function evSearchSet(kind, value) {
  if (kind === 'q')    _evSearchQ = value;
  if (kind === 'org')  _evSearchOrg = _evSearchOrg === value ? null : value;
  if (kind === 'type') _evSearchType = _evSearchType === value ? null : value;
  if (kind === 'when') _evSearchWhen = _evSearchWhen === value ? null : value;
  // Only the results repaint. Rebuilding the panel would recreate the input being typed into
  // and drop focus after the first character — the same bug the door's search box had.
  const out = document.getElementById('evSearchResults');
  if (out) out.innerHTML = evSearchResultsHTML();
  if (kind !== 'q') evSearchPaintChips();
}

function evSearchPaintChips() {
  document.querySelectorAll('[data-evchip]').forEach(el => {
    const [kind, value] = el.getAttribute('data-evchip').split(':');
    const on = (kind === 'org'  && String(_evSearchOrg)  === value)
            || (kind === 'type' && _evSearchType === value)
            || (kind === 'when' && _evSearchWhen === value);
    el.classList.toggle('is-on', on);
  });
}

function evSearchHTML() {
  const anyFilter = _evSearchQ || _evSearchOrg || _evSearchType || _evSearchWhen;
  return `
    <div class="evs-bar">
      <input class="evs-input" id="evSearchInput" autocomplete="off"
             placeholder="Search events, clubs, places…"
             value="${escAttr(_evSearchQ)}" oninput="evSearchSet('q', this.value)">
      <button class="evs-close" onclick="evSearchClose()">Done</button>
    </div>

    ${_evFollowed.length ? `
      <div class="evs-sec">
        <div class="evs-lab">Clubs you follow</div>
        <div class="evs-orgs">${_evFollowed.map(o => `
          <button class="evs-org" data-evchip="org:${o.id}" onclick="evSearchSet('org', ${o.id})">
            ${o.logo_url ? `<img src="${escAttr(o.logo_url)}" alt="">`
                         : `<span class="evs-org-blank">${esc((o.name || '?').charAt(0).toUpperCase())}</span>`}
            <span class="evs-org-name">${esc(o.name)}</span>
          </button>`).join('')}</div>
      </div>` : ''}

    <div class="evs-sec">
      <div class="evs-lab">When</div>
      <div class="evs-chips">
        ${[['week', 'This week'], ['weekend', 'This weekend'], ['next', 'Next week'], ['month', 'This month']]
          .map(([k, l]) => `<button class="evs-chip" data-evchip="when:${k}"
                 onclick="evSearchSet('when', '${k}')">${l}</button>`).join('')}
      </div>
    </div>

    <div class="evs-sec">
      <div class="evs-lab">Kind</div>
      <div class="evs-chips">
        ${EV_TYPES.map(([v, l]) => `<button class="evs-chip" data-evchip="type:${v}"
             onclick="evSearchSet('type', '${v}')">${l}</button>`).join('')}
      </div>
    </div>

    <div id="evSearchResults">${anyFilter ? evSearchResultsHTML() : ''}</div>`;
}

function evSearchResultsHTML() {
  const anyFilter = _evSearchQ || _evSearchOrg || _evSearchType || _evSearchWhen;
  if (!anyFilter) return '';

  const hits = evMatchEvents(_evFeed, {
    q: _evSearchQ, orgId: _evSearchOrg, type: _evSearchType, when: _evSearchWhen,
  });

  if (!hits.length) {
    // Suggests broadening rather than showing a bare "no results". With a dozen events, an
    // empty result is usually the filters being narrow, not the campus being quiet — and the
    // student cannot see which of their four choices did it.
    const tried = [
      _evSearchWhen ? 'the date' : '', _evSearchType ? 'the kind' : '',
      _evSearchOrg ? 'the club' : '', _evSearchQ ? `“${esc(_evSearchQ)}”` : '',
    ].filter(Boolean);
    return `
      <div class="evs-none">
        <div class="evs-none-t">Nothing matches yet</div>
        <p>Try clearing ${tried.length > 1 ? 'one of ' : ''}${tried.join(' or ')}.
           There are ${_evFeed.length} event${_evFeed.length === 1 ? '' : 's'} coming up in total.</p>
        <button class="evs-chip" onclick="evSearchReset()">Clear all filters</button>
      </div>`;
  }

  // Grouped by date exactly like the feed, so a result list and the feed are read the same way.
  let html = `<div class="evs-count">${hits.length} event${hits.length === 1 ? '' : 's'}</div>`;
  let lastKey = null;
  for (const e of hits) {
    const key = evDayKey(e.starts_at);
    if (key !== lastKey) { html += `<div class="ev-day">${esc(evDayLabel(e.starts_at))}</div>`; lastKey = key; }
    html += evCardHTML(e);
  }
  return html;
}

function evSearchReset() {
  _evSearchQ = ''; _evSearchOrg = null; _evSearchType = null; _evSearchWhen = null;
  evPaint();
  document.getElementById('evSearchInput')?.focus();
}
