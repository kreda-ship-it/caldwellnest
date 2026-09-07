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
let _evSaved  = new Set(); // event ids this student has starred
let _evShowPast = false;

async function renderEvents() {
  const wrap = document.getElementById('evFeed');
  if (!wrap) return;
  wrap.innerHTML = '<div class="ev-note">Loading…</div>';

  const eu = getEffectiveUser();
  const { data, error } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, description, event_type, starts_at, ends_at, location, ' +
            'poster_url, status, registration_open, capacity, cancelled_reason, ' +
            'has_ended, is_browsable, effective_ends_at')
    .eq('school', eu?.school || 'caldwell')
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

  await Promise.all([evLoadOrgs(rows), evLoadSaved()]);
  evPaint();
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

// The star is PRIVATE. favorites has accepted 'event' since 2026-09-04, so saving an event
// needed no migration. Registering is the public one, and the detail page says so.
async function evLoadSaved() {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient
    .from('favorites').select('item_id').eq('user_id', eu.id).eq('item_type', 'event');
  _evSaved = new Set((data || []).map(f => Number(f.item_id)));
}

async function evToggleSave(id, btn) {
  const eu = getEffectiveUser();
  if (!eu?.id) { requireAuth(); return; }
  const on = _evSaved.has(id);
  // Painted before the round trip. A star that waits for the network feels broken on a phone,
  // and the worst case is a star that flips back — which is the truth arriving late.
  if (on) _evSaved.delete(id); else _evSaved.add(id);
  if (btn) btn.classList.toggle('is-on', !on);

  const q = on
    ? supabaseClient.from('favorites').delete()
        .eq('user_id', eu.id).eq('item_type', 'event').eq('item_id', String(id))
    : supabaseClient.from('favorites')
        .insert({ user_id: eu.id, item_type: 'event', item_id: String(id) });
  const { error } = await q;
  if (error) {
    if (on) _evSaved.add(id); else _evSaved.delete(id);
    if (btn) btn.classList.toggle('is-on', on);
    toast('Could not save that — try again');
    console.error('[evToggleSave]', error);
  }
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

  if (!_evFeed.length && !_evPast.length) {
    wrap.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-title">Nothing on yet</div>
        <p>When a club posts an event it shows up here, soonest first.</p>
        <button class="ev-empty-btn" onclick="orgDirGo()">Find clubs to follow</button>
      </div>`;
    return;
  }

  let html = '';
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

function evTogglePast(btn) {
  _evShowPast = !_evShowPast;
  const el = document.querySelector('.ev-past');
  if (el) el.hidden = !_evShowPast;
  if (btn) btn.textContent = `${_evShowPast ? 'Hide' : 'Show'} past events · ${_evPast.length}`;
}

function evCardHTML(e, past = false) {
  const org = _evOrgs.get(e.org_id);
  const saved = _evSaved.has(e.id);

  // Poster or a generated one. Never blank: a feed of empty rectangles reads as a feed that
  // failed to load, and most clubs will not have a poster for most events.
  const poster = e.poster_url
    ? `<img class="ev-poster-img" src="${escAttr(e.poster_url)}" alt="" loading="lazy">`
    : `<div class="ev-poster-made" style="background:${eventGradient(e.id)}">
         <div class="ev-p-org">${esc(org?.name || '')}</div>
         <div class="ev-p-title">${esc(e.title)}</div>
       </div>`;

  const seats = (e.registration_open && e.capacity)
    ? `<span class="ev-seats">${e.capacity} places</span>` : '';

  return `
    <article class="ev-card${past ? ' is-past' : ''}">
      <button class="ev-org" onclick="event.stopPropagation();orgDirGo()">
        ${org?.logo_url
          ? `<img class="ev-org-logo" src="${escAttr(org.logo_url)}" alt="">`
          : `<span class="ev-org-logo ev-org-logo-blank"></span>`}
        <span class="ev-org-name">${esc(org?.name || 'Campus')}</span>
        ${org?.is_verified ? '<span class="ev-verified" title="Verified organization">&#10003;</span>' : ''}
      </button>

      <div class="ev-poster" onclick="evOpen(${e.id})">${poster}</div>

      <div class="ev-meta">
        <div class="ev-meta-text" onclick="evOpen(${e.id})">
          <div class="ev-title">${esc(e.title)}</div>
          <div class="ev-when">${esc(evTime(e.starts_at))} · ${esc(e.location)}</div>
          ${seats}
        </div>
        <button class="ev-star${saved ? ' is-on' : ''}" aria-label="Save"
                onclick="event.stopPropagation();evToggleSave(${e.id}, this)">&#9733;</button>
      </div>
    </article>`;
}

// The detail page arrives with registration. Until then, tapping a card says so rather than
// doing nothing — a card that swallows a tap reads as broken, not as unfinished.
function evOpen(id) {
  const e = [..._evFeed, ..._evPast].find(x => x.id === id);
  toast(e ? `“${e.title}” — the full page is coming next` : 'Event not found');
}
