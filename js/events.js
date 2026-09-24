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
// The feed's own filters (stories, date strip, filter sheet). NOT the search's state: search resets on open and
// replaces the whole feed, these narrow the feed in place. Not persisted either — a filter
// describes this visit, and a feed silently narrowed on the next launch would look as if
// events had disappeared.
let _evFeedType = null;
let _evFeedWhen = null;
let _evFeedOrg  = null;      // the club picked in the stories row, or null for every club

// Fetches this school's events into _evFeed / _evPast and loads the companion data the
// cards need. Split out of renderEvents() so the home feed can show the same events
// without painting the Events page — one query and one shape, rather than a second copy
// of the select that drifts the first time a column is added.
//
// Returns a reason rather than throwing, because "signed out" and "query failed" need
// different words on screen and only the caller knows where those words go.
async function loadEvents() {
  const eu = getEffectiveUser();
  if (!eu) return { ok: false, reason: 'signed-out' };

  const { data, error } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, description, event_type, starts_at, ends_at, location, ' +
            'poster_url, status, registration_open, capacity, cancelled_reason, ' +
            'has_ended, is_browsable, effective_ends_at, going_count, seats_left, checkin_is_open')
    .eq('school', eu.school || 'caldwell')
    .order('starts_at', { ascending: true });

  if (error) { console.error('[loadEvents]', error); return { ok: false, reason: 'error' }; }

  const rows = data || [];
  // is_browsable already means "published and not over". Filtering on it rather than on
  // status keeps the cancelled events a registrant can still reach out of the public feed
  // without a second query — the view carries both answers at once.
  _evFeed = rows.filter(e => e.is_browsable);
  _evPast = rows.filter(e => e.has_ended && e.status === 'published')
                .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

  await Promise.all([evLoadOrgs(rows), loadFavorites(true), evLoadGoing(), evLoadRated()]);
  return { ok: true };
}

async function renderEvents() {
  const wrap = document.getElementById('evFeed');
  if (!wrap) return;
  wrap.innerHTML = '<div class="ev-note">Loading…</div>';

  const res = await loadEvents();

  // Boot paints the last-visited page BEFORE the session has resolved, so this can run with no
  // user and no grant — visible_events is granted to authenticated only, so the query returns
  // nothing and the empty state would say "Nothing on yet". That is a lie: it is not that
  // there are no events, it is that we cannot see them yet. Saying so and letting boot's async
  // block re-render is both honest and correct for a genuinely signed-out visitor.
  if (!res.ok && res.reason === 'signed-out') {
    wrap.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-title">What's happening</div>
        <p>Sign in to see events posted by clubs and departments.</p>
        <button class="ev-empty-btn" onclick="requireAuth()">Sign in</button>
      </div>`;
    return;
  }
  if (!res.ok) {
    wrap.innerHTML = '<div class="ev-note">Could not load events. Pull down to try again.</div>';
    return;
  }

  _evStoryOrder = null;   // a new visit sorts the stories afresh
  evPaint();
  // The stories need who you follow and each club's logo, which the club directory loads. The
  // feed does not wait for it: the row repaints itself when it arrives.
  if (typeof loadOrgDirectory === 'function') loadOrgDirectory().then(ok => { if (ok) { evPaintStories(); evPaintSuggest(); } });
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
  // Weekday in full, as the Events board spells it ("Thursday, Sep 11").
  return d.toLocaleDateString(undefined,
    { weekday: 'long', month: 'short', day: 'numeric' });
}

function evTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------- The page (redesigned 2026-09-24) ----------
// What event apps that feel calm have in common — Luma, Partiful, DICE, Instagram, and the date
// strips in calendar and Meetup-style apps — and what this page now follows:
//   * ONE row of each kind of control, never a wall of chips. Stories answer "who", the date
//     strip answers "when", and the rarer "what kind" / "only clubs I follow" live in a sheet
//     behind the filter button in the header.
//   * The first event is visible on the first screen. The rating prompt is a slim nudge, not a
//     form (see evNudgeHTML), and on a desktop it moves to the side column with Your plans.
//   * One post at a time, like Instagram: a header naming the club, the poster, then the facts.
function evPaint() {
  const wrap = document.getElementById('evFeed');

  // Search replaces the feed rather than sitting above it. Both answer "what is on", and two
  // lists of events on one screen makes the student work out which one they are reading.
  // While searching, the page title and its buttons step aside: the search has its own header.
  document.getElementById('page-events')?.classList.toggle('is-searching', _evSearchOn);
  evPaintFilterBadge();
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

  const rows = evFeedRows();

  wrap.innerHTML = `
    <div class="ev-layout">
      <div class="ev-main">
        <div class="ev-stories" id="evStories">${evStoriesHTML()}</div>
        <div class="ev-strip" id="evStrip">${evStripHTML()}</div>
        ${evActiveHTML(rows.length)}
        ${_evFeedOrg ? evClubHeadHTML() : ''}
        <div id="evAskSlot" class="ev-ask-main"></div>
        <div id="evStream"></div>
      </div>
      <aside class="ev-side" aria-label="Plans and highlights">
        <div class="ev-side-col">
          <div id="evAskSide"></div>
          <div id="evPlans">${evPlansHTML()}</div>
          ${evPopularHTML()}
        </div>
        <div class="ev-side-col">
          ${evGlanceHTML()}
          <div id="evSuggest">${evSuggestHTML()}</div>
        </div>
      </aside>
    </div>`;

  // One post at a time, in one column, like Instagram — and drawn as the student scrolls
  // (streamSections in listings.js), 6 posters per step. Each day is a section of the stream,
  // so its heading appears with its first event and the feed is read in date order.
  const days = [];
  let lastKey = null;
  for (const e of rows) {
    const key = evDayKey(e.starts_at);
    if (key !== lastKey) {
      days.push({ items: [], cardHTML: ev => evCardHTML(ev), headHTML: evDayHeadHTML(e.starts_at) });
      lastKey = key;
    }
    days[days.length - 1].items.push(e);
  }

  // With a club picked, its past events are the interesting part of the tail too.
  const past = _evFeedOrg ? _evPast.filter(e => e.org_id === _evFeedOrg) : _evPast;
  const filtered = _evFeedOrg || _evFeedType || _evFeedWhen || _evFeedDay || _evFeedFollowing;
  // What follows the upcoming list — drawn once the stream has shown its last event, because a
  // chip below an endless list is a chip nobody can reach until the list has ended.
  const tail = () => {
    let html = '';
    if (!_evFeed.length) html += '<div class="ev-note">Nothing coming up right now.</div>';
    else if (!rows.length && _evFeedOrg && !_evFeedType && !_evFeedDay && !_evFeedFollowing) html += `<div class="ev-note">Nothing coming up from
      ${esc(evStoryOrg(_evFeedOrg).name)} right now${past.length ? ' — their past events are below' : ''}.
      <button class="ev-note-btn" onclick="evStory(null)">See every club</button></div>`;
    else if (!rows.length && filtered) html += `<div class="ev-note">Nothing matches that.
      <button class="ev-note-btn" onclick="evFeedClear()">Show everything</button></div>`;
    // Past events are behind a chip, not in the list. The photo count is the reason anyone
    // taps it — a past event with recap photos is worth looking at, and one without is not.
    if (past.length) {
      html += `
        <button class="ev-past-chip" onclick="evTogglePast(this)">
          ${_evShowPast ? 'Hide' : 'Show'} past events · ${past.length}
        </button>
        <div class="ev-past ev-grid" ${_evShowPast ? '' : 'hidden'}>
          ${past.map(e => evCardHTML(e, true)).join('')}
        </div>`;
    }
    return html;
  };
  const stream = document.getElementById('evStream');
  streamSections(stream, days, { batch: 6, gridClass: 'ev-grid',
    done: () => stream.insertAdjacentHTML('afterend', tail()) });
  evSpyWire();
  evSpy();
}

// A day heading: "Today  Thursday, Sep 24", or "Saturday  Sep 26". Shared by the feed and the
// events search, so both are read the same way.
function evDayHeadHTML(iso) {
  const label = evDayLabel(iso);
  const near = label === 'Today' || label === 'Tomorrow';
  const full = new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const [wk, ...rest] = full.split(',');
  return `<div class="ev-day" data-day="${evDayKey(iso)}"><b>${esc(near ? label : wk)}</b><span>${esc(near ? full : rest.join(',').trim())}</span></div>`;
}

// Everything that narrows the feed, in one place: the club (stories), the day (strip), and the
// sheet's kind and "clubs I follow". _evFeedWhen is still honoured for Home's "N events today".
function evFeedRows(opts = {}) {
  const follows = typeof _dirFollows !== 'undefined' ? _dirFollows : new Set();
  return evMatchEvents(_evFeed, { type: _evFeedType, when: _evFeedWhen, orgId: _evFeedOrg })
    .filter(e => opts.ignoreDay || !_evFeedDay || evDayKey(e.starts_at) === _evFeedDay)
    .filter(e => !_evFeedFollowing || follows.has(e.org_id));
}

function evFeedClear() {
  _evFeedOrg = null; _evFeedType = null; _evFeedWhen = null; _evFeedDay = null; _evFeedFollowing = false;
  evPaint();
}

// Only when something is narrowing the feed: what, and how to undo each piece.
function evActiveHTML(n) {
  const kind = _evFeedType ? (EV_TYPES.find(([v]) => v === _evFeedType) || [])[1] : '';
  const chips = [
    _evFeedDay ? [evDayLabel(evDayKeyToIso(_evFeedDay)), "evPickDay(null)"] : null,
    _evFeedWhen === 'today' && !_evFeedDay ? ['Today', "_evFeedWhen=null;evPaint()"] : null,
    kind ? [kind, "_evFeedType=null;evPaint()"] : null,
    _evFeedFollowing ? ['Clubs I follow', "_evFeedFollowing=false;evPaint()"] : null,
  ].filter(Boolean);
  if (!chips.length) return '';
  return `<div class="ev-active">${chips.map(([l, fn]) =>
    `<button class="ev-active-chip" onclick="${fn}">${esc(l)}${icon('x', 12)}</button>`).join('')}
    <span class="ev-active-n">${n} event${n === 1 ? '' : 's'}</span></div>`;
}

// ---------- The date strip ----------
// The next two weeks as a row of days, a dot for each event (up to three). Tap a day to see just
// that day; tap it again for everything. While scrolling the full feed, the strip lights the
// day being read (evSpy) — it takes over the job the sticky day headings used to do.
let _evFeedDay = null;          // 'y-m-d' key of the picked day, or null
let _evFeedFollowing = false;   // the sheet's "only clubs I follow"

function evDayKeyToIso(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m, d, 12).toISOString();
}

function evStripHTML() {
  const base = evFeedRows({ ignoreDay: true });
  const count = new Map();
  base.forEach(e => { const k = evDayKey(e.starts_at); count.set(k, (count.get(k) || 0) + 1); });
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(today.getTime() + i * 864e5));
  return `<div class="ev-strip-in">${days.map((d, i) => {
    const key = evDayKey(d.toISOString());
    const n = count.get(key) || 0;
    const wk = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
    const on = _evFeedDay === key;
    return `<button class="ev-sd${on ? ' is-on' : ''}${n ? '' : ' is-empty'}" data-day="${key}"
      ${n ? '' : 'disabled'} aria-pressed="${on}" onclick="evPickDay('${key}')"
      aria-label="${escAttr(d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}: ${n || 'no'} event${n === 1 ? '' : 's'}">
      <span class="ev-sd-w">${esc(wk)}</span><span class="ev-sd-n">${d.getDate()}</span>
      <span class="ev-sd-dots">${'<i></i>'.repeat(Math.min(n, 3))}</span>
    </button>`;
  }).join('')}</div>`;
}

function evPickDay(key) {
  _evFeedDay = key && _evFeedDay !== key ? key : null;
  _evFeedWhen = null;
  const strip = document.getElementById('evStrip');
  const top = strip ? strip.getBoundingClientRect().top + window.scrollY : null;
  evPaint();
  // Land with the strip at the top, so the picked day's events start right under it.
  const stuck = document.getElementById('evStrip');
  if (top !== null && stuck && window.scrollY > top) window.scrollTo({ top: top - 60, behavior: 'smooth' });
}

// Which day is being read: the last day heading that has scrolled up under the strip.
let _evSpyTick = false, _evSpyWired = false;
function evSpyWire() {
  if (_evSpyWired) return;
  _evSpyWired = true;
  window.addEventListener('scroll', () => {
    if (_evSpyTick) return;
    _evSpyTick = true;
    setTimeout(() => { _evSpyTick = false; evSpy(); }, 90);
  }, { passive: true });
}
function evSpy() {
  const strip = document.getElementById('evStrip');
  if (!strip || strip.offsetParent === null || _evFeedDay) {
    strip?.querySelectorAll('.ev-sd.is-here').forEach(b => b.classList.remove('is-here'));
    return;
  }
  const line = strip.getBoundingClientRect().bottom + 12;
  let current = null;
  document.querySelectorAll('#evStream .ev-day[data-day]').forEach(h => {
    if (h.getBoundingClientRect().top <= line) current = h.dataset.day;
  });
  if (!current) current = document.querySelector('#evStream .ev-day[data-day]')?.dataset.day || null;
  strip.querySelectorAll('.ev-sd').forEach(b => {
    const here = b.dataset.day === current;
    if (here && !b.classList.contains('is-here')) {
      // Keep the lit day in view inside the strip without moving the page.
      const row = strip.querySelector('.ev-strip-in');
      if (row) row.scrollTo({ left: b.offsetLeft - row.clientWidth / 2 + b.clientWidth / 2, behavior: 'smooth' });
    }
    b.classList.toggle('is-here', here);
  });
}

// ---------- The filter sheet ----------
// Kinds of event and "only clubs I follow" — the rarer questions, one tap away in the header
// instead of eight chips across the page. Changes apply as they are tapped.
function evFilterOpen() {
  let el = document.getElementById('evFilterSheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evFilterSheet';
    el.className = 'ev-sheet-wrap';
    el.addEventListener('click', ev => { if (ev.target === el) evFilterClose(); });
    document.body.appendChild(el);
  }
  el.innerHTML = evFilterSheetHTML();
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-open'));
}
function evFilterClose() {
  const el = document.getElementById('evFilterSheet');
  if (!el) return;
  el.classList.remove('is-open');
  setTimeout(() => { el.hidden = true; }, 200);
}
function evFilterSheetHTML() {
  const kinds = EV_TYPES.filter(([v]) => _evFeed.some(e => e.event_type === v));
  const n = evFeedRows().length;
  return `
    <div class="ev-sheet" role="dialog" aria-modal="true" aria-label="Filter events">
      <div class="ev-sheet-head"><h2>Filter events</h2>
        <button class="ev-sheet-x" onclick="evFilterClose()" aria-label="Close">${icon('x', 18)}</button></div>
      <label class="ev-sheet-row">
        <span><b>Only clubs I follow</b><small>Events from the clubs in your stories with a follow</small></span>
        <input type="checkbox" class="ev-switch" ${_evFeedFollowing ? 'checked' : ''} onchange="_evFeedFollowing=this.checked;evFilterRefresh()">
      </label>
      <div class="ev-sheet-lab">Kind of event</div>
      <div class="ev-sheet-kinds">
        <button class="ev-kind${_evFeedType ? '' : ' is-on'}" onclick="_evFeedType=null;evFilterRefresh()">All kinds</button>
        ${kinds.map(([v, l]) => `<button class="ev-kind ev-tone-${v}${_evFeedType === v ? ' is-on' : ''}" onclick="_evFeedType=_evFeedType==='${v}'?null:'${v}';evFilterRefresh()">${esc(l)}</button>`).join('')}
      </div>
      <div class="ev-sheet-foot">
        <button class="hn-link" onclick="_evFeedType=null;_evFeedFollowing=false;evFilterRefresh()">Clear</button>
        <button class="ld-msg" onclick="evFilterClose()">Show ${n} event${n === 1 ? '' : 's'}</button>
      </div>
    </div>`;
}
function evFilterRefresh() {
  evPaint();
  const el = document.getElementById('evFilterSheet');
  if (el) el.innerHTML = evFilterSheetHTML();
}
// The number of sheet filters on, shown on the header's filter button.
function evPaintFilterBadge() {
  const n = (_evFeedType ? 1 : 0) + (_evFeedFollowing ? 1 : 0);
  const b = document.getElementById('evFilterCount');
  if (b) { b.textContent = n; b.hidden = !n; }
}

// ---------- The discovery column (2026-09-24) ----------
// The space beside the feed on a wider screen. Beside a poster feed (read one at a time) it offers
// the OTHER ways people plan: what they already said yes to, what everyone else is going to, the
// whole week at a glance, and clubs worth following. Each card is short and ends in an action.
// It is drawn from _evFeed as a whole, not the filtered feed: it is the overview, not the result.

// The three most-attended things in the next seven days — ranked, like a chart.
function evPopularHTML() {
  const week = Date.now() + 7 * 864e5;
  const top = _evFeed.filter(e => new Date(e.starts_at).getTime() <= week && Number(e.going_count) > 0)
    .sort((a, b) => Number(b.going_count) - Number(a.going_count)).slice(0, 3);
  if (!top.length) return '';
  return `
    <div class="ev-side-card">
      <h2 class="ev-side-h">Popular this week</h2>
      ${top.map((e, i) => `
        <button class="ev-pop" onclick="evOpen(${e.id})">
          <span class="ev-pop-rank">${i + 1}</span>
          <span class="ev-pop-thumb ev-tone-${escAttr(e.event_type || 'other')}">${e.poster_url ? `<img src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}</span>
          <span class="ev-plan-text"><b>${esc(e.title)}</b><span>${Number(e.going_count)} going · ${esc(evDayLabel(e.starts_at).split(',')[0])}</span></span>
        </button>`).join('')}
    </div>`;
}

// The next seven days as a short agenda — time and title, grouped by day. Tapping a day narrows
// the feed to it (the same as the date strip); tapping an event opens it.
function evGlanceHTML() {
  const week = Date.now() + 7 * 864e5;
  const rows = _evFeed.filter(e => new Date(e.starts_at).getTime() <= week);
  if (!rows.length) return '';
  const days = [];
  rows.forEach(e => {
    const k = evDayKey(e.starts_at);
    let d = days.find(x => x.k === k);
    if (!d) { d = { k, iso: e.starts_at, items: [] }; days.push(d); }
    d.items.push(e);
  });
  let shown = 0;
  return `
    <div class="ev-side-card">
      <h2 class="ev-side-h">The week at a glance</h2>
      ${days.map(d => {
        if (shown >= 9) return '';
        const items = d.items.slice(0, 9 - shown); shown += items.length;
        return `
          <button class="ev-gl-day" onclick="evPickDay('${d.k}')">${esc(evDayLabel(d.iso).split(',')[0])}<span>${d.items.length}</span></button>
          ${items.map(e => `
            <button class="ev-gl-row" onclick="evOpen(${e.id})">
              <span class="ev-gl-time">${esc(evTime(e.starts_at))}</span>
              <span class="ev-gl-title">${esc(e.title)}</span>
            </button>`).join('')}`;
      }).join('')}
    </div>`;
}

// Clubs worth following: ones you do not follow that have the most coming up.
function evSuggestHTML() {
  const follows = typeof _dirFollows !== 'undefined' ? _dirFollows : new Set();
  const counts = new Map();
  // A club just followed from here stays in the list, now reading Following, until the next visit.
  const keep = id => !follows.has(id) || _evSugFollowed.has(id);
  _evFeed.forEach(e => { if (keep(e.org_id)) counts.set(e.org_id, (counts.get(e.org_id) || 0) + 1); });
  const picks = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!picks.length) return '';
  return `
    <div class="ev-side-card">
      <h2 class="ev-side-h">Clubs to follow</h2>
      ${picks.map(([id, n]) => {
        const o = evStoryOrg(id);
        const just = follows.has(id);
        return `
          <div class="ev-sug">
            <button class="ev-sug-club" onclick="evStory(${Number(id)})">
              <span class="ev-ch-av">${o.logo_url ? `<img src="${escAttr(o.logo_url)}" alt="">`
                : `<span class="ev-story-letter" data-tint="${((Number(id) || 0) % 6) + 1}">${esc((o.name || '?').charAt(0).toUpperCase())}</span>`}</span>
              <span class="ev-plan-text"><b>${esc(o.name)}</b><span>${n} upcoming event${n === 1 ? '' : 's'}</span></span>
            </button>
            <button class="ev-sug-follow${just ? ' is-on' : ''}" onclick="_evSugFollowed.add(${Number(id)});evStoryFollow(${Number(id)})">${just ? 'Following' : 'Follow'}</button>
          </div>`;
      }).join('')}
    </div>`;
}
let _evSugFollowed = new Set();   // followed from the suggestions during this visit
function evPaintSuggest() {
  const el = document.getElementById('evSuggest');
  if (el) el.innerHTML = evSuggestHTML();
}

// ---------- Your plans (the discovery column) ----------
function evPlansHTML() {
  const mine = _evFeed.filter(e => _evGoing.has(e.id)).slice(0, 5);
  return `
    <div class="ev-side-card">
      <h2 class="ev-side-h">Your plans</h2>
      ${mine.length ? mine.map(e => {
        const d = new Date(e.starts_at);
        return `<button class="ev-plan" onclick="evOpen(${e.id})">
          <span class="ev-plan-date ev-tone-${escAttr(e.event_type || 'other')}"><span>${esc(d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase())}</span><b>${d.getDate()}</b></span>
          <span class="ev-plan-text"><b>${esc(e.title)}</b><span>${esc(evTime(e.starts_at))}${e.location ? ' · ' + esc(e.location) : ''}</span></span>
        </button>`;
      }).join('') : `<p class="ev-side-empty">Nothing planned yet. Tap <b>I'm going</b> on anything that looks good and it shows up here.</p>`}
    </div>`;
}


function evTogglePast(btn) {
  _evShowPast = !_evShowPast;
  const el = document.querySelector('.ev-past');
  if (el) el.hidden = !_evShowPast;
  const n = _evFeedOrg ? _evPast.filter(e => e.org_id === _evFeedOrg).length : _evPast.length;
  if (btn) btn.textContent = `${_evShowPast ? 'Hide' : 'Show'} past events · ${n}`;
}

// ---------- Club stories (2026-09-24) ----------
// A row of clubs across the top, like Instagram stories: a round logo with a ring when the club
// has events you have not looked at yet, a + to follow a club you do not follow, and a tap that
// narrows the feed underneath to that club. Clubs you follow come first, then the soonest.
//
// "Seen" is only which events this device has already shown you through a club's story. It is
// kept in localStorage, never sent anywhere — a preference about this screen, not activity data.
const EV_SEEN_KEY = 'cn_ev_story_seen';
let _evJustFollowed = new Set();
const EV_PLUS_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

function evSeen() { try { return new Set(JSON.parse(localStorage.getItem(EV_SEEN_KEY) || '[]')); } catch (e) { return new Set(); } }
function evMarkSeen(ids) {
  const seen = evSeen(); ids.forEach(id => seen.add(id));
  try { localStorage.setItem(EV_SEEN_KEY, JSON.stringify([...seen].slice(-400))); } catch (e) { /* private mode */ }
}

// The club's directory row (name, logo, verified) from whichever list has it.
function evStoryOrg(id) {
  return (_dirOrgs || []).find(o => o.id === id) || _evOrgs.get(id) || { id, name: 'Club' };
}

function evStoryList() {
  const byOrg = new Map();
  _evFeed.forEach(e => {
    const c = byOrg.get(e.org_id) || { ids: [], soonest: e.starts_at };
    c.ids.push(e.id); byOrg.set(e.org_id, c);
  });
  const follows = typeof _dirFollows !== 'undefined' ? _dirFollows : new Set();
  const seen = evSeen();
  const ids = new Set([...byOrg.keys(), ...follows]);
  return [...ids].map(id => {
    const c = byOrg.get(id);
    return { id, org: evStoryOrg(id), n: c ? c.ids.length : 0, soonest: c ? c.soonest : null,
             followed: follows.has(id), fresh: !!c && c.ids.some(x => !seen.has(x)) };
  })
  // Unseen first (that is what a ring invites you to tap), followed before not, then soonest;
  // clubs you follow with nothing coming up go last.
  .sort((a, b) => {
    // The order is decided once per visit and then held: a club that just went from unseen to
    // seen must not jump along the row under the finger that tapped it.
    if (_evStoryOrder) return (_evStoryOrder.indexOf(a.id) + 1 || 999) - (_evStoryOrder.indexOf(b.id) + 1 || 999);
    return (!!b.n - !!a.n) || (b.fresh - a.fresh) || (b.followed - a.followed)
      || (a.soonest && b.soonest ? new Date(a.soonest) - new Date(b.soonest) : 0);
  })
  .slice(0, 24);
}
let _evStoryOrder = null;   // club ids in the order this visit first showed them

function evStoriesHTML() {
  const list = evStoryList();
  if (!list.length) return '';
  // Held once the follow list has arrived (before that, followed clubs could not sort first).
  if (!_evStoryOrder && typeof _dirOrgs !== 'undefined' && _dirOrgs) _evStoryOrder = list.map(x => x.id);
  const logo = o => o.logo_url
    ? `<img src="${escAttr(o.logo_url)}" alt="" loading="lazy">`
    : `<span class="ev-story-letter" data-tint="${((Number(o.id) || 0) % 6) + 1}">${esc((o.name || '?').charAt(0).toUpperCase())}</span>`;
  return `
    <div class="ev-story-wrap">
      <button class="ev-story${_evFeedOrg ? '' : ' is-on'}" onclick="evStory(null)" aria-pressed="${!_evFeedOrg}">
        <span class="ev-story-ring is-all"><span class="ev-story-av">${icon('grid', 22)}</span></span>
        <span class="ev-story-name">All clubs</span>
      </button>
    </div>
    ${list.map(x => `
      <div class="ev-story-wrap">
        <button class="ev-story${_evFeedOrg === x.id ? ' is-on' : ''}" onclick="evStory(${Number(x.id)})" aria-pressed="${_evFeedOrg === x.id}"
                aria-label="${escAttr(x.org.name)}${x.n ? `, ${x.n} upcoming` : ''}">
          <span class="ev-story-ring${x.fresh ? ' is-new' : ''}"><span class="ev-story-av">${logo(x.org)}</span></span>
          <span class="ev-story-name">${esc(x.org.name)}</span>
        </button>
        ${!x.followed
          ? `<button class="ev-story-plus" aria-label="Follow ${escAttr(x.org.name)}" onclick="evStoryFollow(${Number(x.id)})">${EV_PLUS_SVG}</button>`
          : _evJustFollowed.has(x.id) ? `<span class="ev-story-plus is-done" aria-hidden="true">${icon('check', 13)}</span>` : ''}
      </div>`).join('')}
    <div class="ev-story-wrap">
      <button class="ev-story" onclick="orgDirGo()">
        <span class="ev-story-ring is-find"><span class="ev-story-av">${icon('search', 20)}</span></span>
        <span class="ev-story-name">Find clubs</span>
      </button>
    </div>`;
}

function evPaintStories() {
  const el = document.getElementById('evStories');
  if (el) el.innerHTML = evStoriesHTML();
}

// Tap a club: the feed below becomes that club's events, and its ring goes quiet. Tap the same
// club (or All clubs) to go back to everything.
function evStory(orgId) {
  _evFeedOrg = orgId && _evFeedOrg !== orgId ? orgId : null;
  if (_evFeedOrg) evMarkSeen(_evFeed.filter(e => e.org_id === _evFeedOrg).map(e => e.id));
  const x = window.scrollY;
  evPaint();
  window.scrollTo(0, x);   // stay where the row is; only the feed below changes
}

// The + follows without leaving the row (orgDirToggleFollow is the one follow path, and it
// repaints every other Follow button for the club). A check shows for a moment where the + was.
function evStoryFollow(orgId) {
  const was = _dirFollows.has(orgId);
  const p = orgDirToggleFollow(orgId);
  if (!was) {
    _evJustFollowed.add(orgId);
    toast('Following ' + evStoryOrg(orgId).name);
    // The suggestion keeps saying Following (it would otherwise vanish mid-tap); the story's ✓ fades.
    setTimeout(() => { _evJustFollowed.delete(orgId); evPaintStories(); }, 1600);
  }
  evPaintStories(); evPaintSuggest();
  if (_evFeedOrg === orgId) evPaintClubHead();
  Promise.resolve(p).then(() => { evPaintStories(); evPaintSuggest(); if (_evFeedOrg === orgId) evPaintClubHead(); });
}

// The picked club, above its events: who they are, how much is coming up, and the two doors
// a student wants next — follow, or the club's own page.
function evClubHeadHTML() {
  const o = evStoryOrg(_evFeedOrg);
  const n = _evFeed.filter(e => e.org_id === _evFeedOrg).length;
  const on = typeof _dirFollows !== 'undefined' && _dirFollows.has(_evFeedOrg);
  return `
    <div class="ev-club-head" id="evClubHead">
      <span class="ev-club-logo">${o.logo_url ? `<img src="${escAttr(o.logo_url)}" alt="">` : `<span class="ev-story-letter" data-tint="${((Number(o.id) || 0) % 6) + 1}">${esc((o.name || '?').charAt(0).toUpperCase())}</span>`}</span>
      <span class="ev-club-text">
        <b>${esc(o.name)}${o.is_verified ? ` <span class="ld-verified">${icon('check', 11)} Verified</span>` : ''}</b>
        <span>${n ? `${n} upcoming event${n === 1 ? '' : 's'}` : 'Nothing coming up'}</span>
      </span>
      <button class="ev-club-follow${on ? ' is-on' : ''}" onclick="evStoryFollow(${Number(_evFeedOrg)})">${on ? 'Following' : 'Follow'}</button>
      <button class="ev-club-page" onclick="orgPageOpen(${Number(_evFeedOrg)})" aria-label="Club page">${icon('chevRight', 18)}</button>
    </div>`;
}
function evPaintClubHead() {
  const el = document.getElementById('evClubHead');
  if (el) el.outerHTML = evClubHeadHTML();
}

// "6:00 PM – 9:00 PM". The end is shown only when it falls on the same day: a range that
// crosses midnight, printed as two bare times, reads as if the event ends before it starts.
function evTimeRange(e) {
  const start = evTime(e.starts_at);
  if (!e.ends_at || evDayKey(e.ends_at) !== evDayKey(e.starts_at)) return start;
  return `${start} – ${evTime(e.ends_at)}`;
}

// The event card, after the Nestrel Redesign canvas (Events board), 2026-09-23, with an
// Instagram-style header row since 2026-09-24: the club and the kind of event above a full-size
// 4:5 poster with its date badge, then the details, and a footer with the going count, the
// private save and "I'm going".
//
// One tone per event type (.ev-tone-<type> in styles.css) colours the poster, the date badge and
// the tag together, so a Service event reads green all over its card.
//
// Two kinds of poster, and they carry DIFFERENT amounts of information on purpose. A photo is
// shown whole (uploads are kept at 4:5, the frame's shape) and the details go in the text under
// it. An event with no photo gets a generated poster that carries the whole answer — club, title,
// when, where — so the text under it is dropped: a card should say each thing once.
function evCardHTML(e, past = false) {
  const org = _evOrgs.get(e.org_id);
  const orgName = org?.name || 'Campus';
  const type = (EV_TYPES.find(([v]) => v === e.event_type) || [])[1] || '';
  const tone = type ? e.event_type : 'other';   // only a known type becomes a class name
  const d = new Date(e.starts_at);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();

  const made = !e.poster_url;
  // The post header, as on Instagram: who is posting, and what kind of thing it is. Tapping the
  // club does what tapping its story does — the feed becomes that club's events.
  const head = `
    <div class="ev-card-head">
      <button class="ev-ch-club" onclick="event.stopPropagation();evStory(${Number(e.org_id)})">
        <span class="ev-ch-av">${org?.logo_url ? `<img src="${escAttr(org.logo_url)}" alt="">`
          : `<span class="ev-story-letter" data-tint="${((Number(e.org_id) || 0) % 6) + 1}">${esc(orgName.charAt(0).toUpperCase())}</span>`}</span>
        <span class="ev-ch-name">${esc(orgName)}</span>
      </button>
      ${type ? `<span class="ev-ch-type">${esc(type)}</span>` : ''}
    </div>`;
  const banner = `
    <div class="ev-banner" onclick="evOpen(${e.id})">
      ${made
        ? `<div class="ev-made">
             <div class="ev-made-title">${esc(e.title)}</div>
             <span class="ev-made-rule"></span>
             <div class="ev-made-when">${esc(evTimeRange(e))}</div>
             ${e.location ? `<div class="ev-made-where">${esc(e.location)}</div>` : ''}
           </div>`
        : `<img class="ev-banner-img" src="${escAttr(e.poster_url)}" alt="" loading="lazy">`}
      <div class="ev-date-badge"><span>${esc(weekday)}</span><b>${d.getDate()}</b></div>
    </div>`;

  // The club is named once, in the header; the rows say when and where.
  const place = e.location ? esc(e.location) : '';
  // Two rows when there is a same-day end time to show ("6:00 PM – 9:00 PM" / "Student Center ·
  // SGA"); otherwise it all fits on one ("11:00 AM · Main Quad · Eco Club"), as in the mockup.
  const sameDayEnd = e.ends_at && evDayKey(e.ends_at) === evDayKey(e.starts_at);
  const rows = sameDayEnd
    ? `<div class="ev-row">${icon('clock', 14)}<span>${esc(evTimeRange(e))}</span></div>
       ${place ? `<div class="ev-row">${icon('mapPin', 14)}<span>${place}</span></div>` : ''}`
    : `<div class="ev-row">${icon('clock', 14)}<span>${esc(evTime(e.starts_at))}${place ? ' · ' + place : ''}</span></div>`;

  // seats_left is NULL for an unlimited event and 0 for a full one. They are opposites, so the
  // null check comes first — treating them alike would print "0 spots left" on an event with no
  // limit at all. Every number goes through Number(), so there is nothing here to escape.
  const counts = [];
  if (e.registration_open && e.going_count) counts.push(`<strong>${Number(e.going_count)}</strong> going`);
  const full = e.registration_open && e.seats_left === 0;
  if (full) counts.push('full');
  else if (e.registration_open && e.seats_left !== null && e.seats_left !== undefined) {
    counts.push(`<strong>${Number(e.seats_left)}</strong> spot${e.seats_left === 1 ? '' : 's'} left`);
  }

  // "I'm going" registers in one tap, and it tells the organizers the student's name and email.
  // §4.1 of the events plan requires that to be said directly under the button BEFORE the tap,
  // so the line under it is not decoration: without it, this button may not exist.
  const reg = _evGoing.get(e.id);
  let action = '', privacy = '';
  if (!past && reg) {
    action = `<button class="ev-going-pill" onclick="evOpen(${e.id})">You're going ${icon('check', 13)}</button>`;
  } else if (!past && e.registration_open && !full) {
    action = `<button class="ev-go-btn" onclick="evCardRegister(${e.id}, this)">I&rsquo;m going</button>`;
    privacy = `<p class="ev-card-privacy">Shares your name and email with ${esc(orgName)}.</p>`;
  }

  return `
    <article class="ev-card ev-tone-${tone}${past ? ' is-past' : ''}">
      ${head}
      ${banner}
      <div class="ev-body">
        ${made ? '' : `<div class="ev-title" onclick="evOpen(${e.id})">${esc(e.title)}</div>
        <div class="ev-rows" onclick="evOpen(${e.id})">${rows}</div>`}
        <div class="ev-foot">
          <span class="ev-seats">${counts.join(' · ')}</span>
          <div class="ev-foot-actions">${favButtonHTML('event', e.id, 'ev-fav')}${action}</div>
        </div>
        ${privacy}
      </div>
    </article>`;
}

// The card's "I'm going". The same RPC as the detail view's Register button (evRegister): it
// locks the event row, counts and inserts in one transaction, so two students tapping the last
// seat queue instead of both winning.
async function evCardRegister(id, btn) {
  if (!getEffectiveUser()) { requireAuth(); return; }
  btn.disabled = true; btn.textContent = 'Saving your spot…';
  const { error } = await supabaseClient.rpc('register_for_event', { p_event_id: id });
  if (error) {
    btn.disabled = false; btn.innerHTML = 'I&rsquo;m going';
    toast(error.message.includes('full') ? 'Sorry — that filled up' : 'Could not register: ' + error.message);
    console.error('[evCardRegister]', error);
    return;
  }
  toast('You are going');
  renderEvents();   // re-reads the feed, so the count and the button come from the database
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
    // Whether to offer the rating form: the officer's feedback window, and whether this student
    // has already rated it.
    data.has_ended ? evLoadFbWindows([id]) : null,
    data.has_ended ? evLoadRated() : null,
  ]);
  // A view, under the privacy rules Kal set on 2026-09-14 (sql/2026-09-15_org_analytics_and_event_views.sql):
  // counted once per student, never the club's own officers, and the link to the student erased
  // 30 days after the event. All of that is enforced inside record_event_view(); the browser only
  // asks. Fire and forget — a failed count must never get in the way of opening the event.
  supabaseClient.rpc('record_event_view', { p_event_id: id }).then(({ error: vErr }) => {
    if (vErr && vErr.code !== 'PGRST202') console.warn('[record_event_view]', vErr.message);
  });
  _evDetail._media = media || [];
  if (!_evOrgs.has(data.org_id)) await evLoadOrgs([data]);

  _ldIndex = 0;
  evPaintDetail();
  openModal('evDetailModal');
  document.querySelector('#evDetailModal .modal').scrollTop = 0;

  // Put the event in the address bar. Three things fall out of it: a refresh reopens it through
  // the cold-route path already built, the URL is shareable without anybody having to find a
  // share button, and it is the same address the QR encodes — so the deep link and an opened
  // event are not two different states.
  //
  // A PUSHED entry since 2026-09-24 (it was replaceState): the phone's back gesture now closes
  // the event instead of leaving the app, the same as a listing. Opening and closing are paired,
  // so Back never steps through every event browsed. On a cold link the entry underneath is
  // cleaned first, so closing lands on the app without the event still in the address bar.
  // Neither pushState nor replaceState fires hashchange, so the listener does not re-enter here.
  const url = `${window.location.pathname}${window.location.search}#/event/${e.id}`;
  if (history.state?.cnEvent) history.replaceState({ cnEvent: true }, '', url);
  else {
    if (evRouteFromHash()) history.replaceState(null, '', window.location.pathname + window.location.search);
    history.pushState({ cnEvent: true }, '', url);
  }
}

function evDetailOpen() { return document.getElementById('evDetailModal')?.classList.contains('open'); }

// Back arrow, X, backdrop, Esc: close, and use up the entry evOpen pushed (which takes the event
// out of the address bar with it).
function evCloseDetail() {
  closeModal('evDetailModal');
  if (history.state?.cnEvent) history.back();
  else evClearRoute();
}
// For closes that go straight on to another screen (the club's page): the entry is neutralised
// in place rather than popped, because a later pop could undo the NEXT screen's own entry.
function evDismissDetail() {
  closeModal('evDetailModal');
  if (history.state?.cnEvent) history.replaceState(null, '', window.location.pathname + window.location.search);
  else evClearRoute();
}
window.addEventListener('popstate', () => { if (evDetailOpen()) closeModal('evDetailModal'); });
document.getElementById('evDetailModal')?.addEventListener('click', ev => {
  if (ev.target.id === 'evDetailModal') evCloseDetail();
});
document.addEventListener('keydown', ev => {
  if (!evDetailOpen()) return;
  if (ev.key === 'Escape') evCloseDetail();
  else if (ev.key === 'ArrowRight') ldGo(_ldIndex + 1);
  else if (ev.key === 'ArrowLeft') ldGo(_ldIndex - 1);
});

// The detail page, redesigned 2026-09-24 onto the same page as listings and books
// (ldPageHTML in listings.js). What goes where comes from how event pages are read — Luma,
// Partiful, Eventbrite all order it the same way: the poster, WHAT it is, WHO is hosting,
// WHEN and WHERE as two scannable rows, then the one thing to do (register / I'm here) —
// pinned to the bottom on a phone, near the top on a desktop — and only then the description.
// The poster is shown whole, never cropped: a flyer is designed edge to edge.
function evPaintDetail() {
  const e = _evDetail;
  const org = _evOrgs.get(e.org_id);
  const images = e._media.filter(m => m.kind === 'image');
  // Every video href goes through safeUrl(). The console only accepts Instagram, YouTube and
  // TikTok links, which keeps javascript: out of the form — but event_media.url has no check, so a
  // direct write would put a script URL behind "Watch on …" for every visitor. A link that
  // fails the check is dropped rather than drawn broken.
  const videos = e._media.filter(m => m.kind === 'video_link');

  // The poster first, then the event's other photos, in one swipeable strip.
  const photos = [e.poster_url, ...images.map(m => m.url)].filter(Boolean)
    .filter((u, i, a) => a.indexOf(u) === i);
  const media = photos.length ? '' : `
    <div class="ld-media ld-media-made" style="background:${eventGradient(e.id)}">
      <div class="ev-p-org">${esc(org?.name || '')}</div>
      <div class="ev-p-title">${esc(e.title)}</div>
    </div>`;

  const starts = new Date(e.starts_at);
  const dayLine = starts.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const kind = EV_TYPES.find(([v]) => v === e.event_type);
  const parts = evActionParts(e);

  const badges = [];
  if (e.status === 'cancelled') badges.push('<span class="pill ld-pill-bad">Cancelled</span>');
  else if (e.has_ended) badges.push('<span class="pill">Ended</span>');
  if (e.members_only) badges.push(`<span class="pill">${icon('lock', 11)} Members only</span>`);

  const facts = [];
  if (Number(e.going_count) > 0) facts.push(['Going', String(e.going_count)]);
  if (e.seats_left !== null && e.seats_left !== undefined && e.status !== 'cancelled' && !e.has_ended) facts.push(['Spots left', String(e.seats_left)]);
  if (kind) facts.push(['Type', kind[1]]);

  const host = `
    <button class="ld-seller" onclick="evDismissDetail();orgPageOpen(${Number(e.org_id)})">
      ${org?.logo_url ? `<img class="ld-host-logo" src="${escAttr(org.logo_url)}" alt="">`
                      : `<span class="ld-host-logo dir-logo-none" data-tint="${((Number(e.org_id) || 0) % 6) + 1}">${esc((org?.name || '?').charAt(0).toUpperCase())}</span>`}
      <span class="ld-seller-text">
        <span class="ld-seller-sub">Hosted by</span>
        <span class="ld-seller-name">${esc(org?.name || 'Campus')}${org?.is_verified ? `<span class="ld-verified">${icon('check', 12)} Verified</span>` : ''}</span>
      </span>
      <span class="ld-seller-go">${icon('chevRight', 18)}</span>
    </button>`;

  document.getElementById('evDetailBody').innerHTML = ldPageHTML({
    photos, media, title: e.title, close: 'evCloseDetail()',
    kicker: `<span class="ld-cat ev-tone-${kind ? kind[0] : 'other'}">${esc(kind ? kind[1] : 'Event')}</span>`,
    badges: badges.join(''),
    where: '',
    price: `<span class="ld-when-short">${parts.label}</span>`,
    cta: parts.btn,
    facts: `
      <div class="ld-rows">
        <div class="ld-row">
          <span class="ld-row-icon">${icon('calendar', 18)}</span>
          <span class="ld-row-text"><b>${esc(dayLine)}</b><span>${esc(evTimeRange(e))}</span>
            <span class="ld-row-links"><button class="hn-link" onclick="evAddToGoogle()">Add to Google Calendar</button> · <button class="hn-link" onclick="evDownloadIcs()">Download .ics</button></span></span>
        </div>
        ${e.location ? `<div class="ld-row">
          <span class="ld-row-icon">${icon('mapPin', 18)}</span>
          <span class="ld-row-text"><b>${esc(e.location)}</b></span>
        </div>` : ''}
      </div>
      ${e.status === 'cancelled' ? `<div class="evd-cancelled"><strong>This event was cancelled.</strong>${e.cancelled_reason ? `<div>${esc(e.cancelled_reason)}</div>` : ''}</div>` : ''}
      ${parts.note}
      ${facts.length ? `<dl class="detail-specs">${facts.map(([k, v]) => `<div class="detail-spec"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}`,
    body: (e.description ? `<p class="ld-desc">${esc(e.description)}</p>` : '')
      + videos.map(v => safeUrl(v.url)).filter(Boolean).map(href => `
        <a class="evd-video" href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">
          <span class="evd-video-play">${icon('play', 13, true)}</span>
          <span>Watch on ${esc(evVideoHost(href))}</span>
        </a>`).join(''),
    seller: host,
    fav: ['event', e.id],
    report: '',
  });
  // A repaint (after Register etc.) redraws the strip at its first photo, so the counter starts there too.
  _ldPhotos = photos;
  ldMark(0);
}

// Every state the action can be in, in one place, so none of them can be reached by accident.
// Split in three since the redesign: `btn` is the one thing to do (pinned to the bottom on a
// phone), `label` sits beside it, and `note` is whatever needs explaining, shown in the page.
function evActionParts(e) {
  const mine = _evGoing.get(e.id);
  const short = new Date(e.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + '<span>' + esc(evTime(e.starts_at)) + '</span>';
  const cal = `<button class="ld-msg ld-msg-ghost" onclick="evAddToGoogle()">${icon('calendar', 17)} Add to calendar</button>`;

  if (e.status === 'cancelled') return { label: 'Cancelled', btn: '', note: '' };
  // Over: the feedback loop. Checked in and inside the officer's window -> the rating form;
  // already rated -> a thank-you; otherwise just the fact that it ended.
  if (e.has_ended) {
    const rated = _evRated.get(e.id);
    if (rated) return { label: 'Ended', btn: '', note: evRatedHTML(rated.rating) };
    if (evCanRate(e, mine)) return { label: 'Ended', btn: '', note: evRateFormHTML(e) };
    const was = mine && ['checked_in', 'walk_in'].includes(mine.status);
    return { label: 'Ended', btn: '', note: `<div class="evd-note">This event has ended.${was ? ' Feedback for it has closed.' : ''}</div>` };
  }
  if (!e.registration_open) {
    return { label: short, btn: cal, note: '<div class="evd-note">No sign-up needed — just turn up.</div>' };
  }
  // Already through the door. Nothing to offer and nothing to undo — a student who wants out
  // after arriving is talking to the officer, not to a button.
  if (mine && (mine.status === 'checked_in' || mine.status === 'walk_in')) {
    return { label: short, btn: `<div class="ld-msg ld-msg-done">${icon('check', 17)} You're checked in</div>`, note: '' };
  }
  // PERSISTENT, not a toast. The student tapped a button and now has to stand there while
  // somebody finds them on a list; a message that fades after three seconds leaves them
  // wondering whether the tap landed at all, and tapping again is the natural response.
  if (mine && mine.status === 'self_reported') {
    return { label: short, btn: `<div class="ld-msg ld-msg-done">Waiting to be confirmed</div>`, note: `
      <div class="evd-waiting">
        <strong>Waiting for the organizer to confirm you</strong>
        <div>Show them this screen if there is a queue.</div>
      </div>` };
  }
  if (mine) {
    const going = `<div class="evd-reg"><div class="evd-going">You are going ${icon('check', 14)}</div>
      <button class="evd-btn evd-btn-ghost" onclick="evUnregister()">Cancel my place</button></div>`;
    return e.checkin_is_open
      ? { label: short, btn: `<button class="ld-msg evd-btn-go" onclick="evImHere()">I'm here</button>`,
          note: going + '<p class="evd-privacy">Tell the organizers you have arrived. They confirm it at the door.</p>' }
      : { label: short, btn: `<div class="ld-msg ld-msg-done">${icon('check', 17)} You're going</div>`, note: going + evPrivacyLine() };
  }
  // Not registered, but standing at the door. This is the walk-up-and-scan case and it is most
  // of the value of the QR: one tap registers AND reports arrival, because somebody at the
  // door should not have to do two things in the right order to get in.
  if (e.checkin_is_open && e.seats_left !== 0) {
    return { label: short, btn: `<button class="ld-msg evd-btn-go" onclick="evImHere()">I'm here</button>`,
      note: `<p class="evd-privacy">This signs you up and tells the organizers you have arrived.
         They will see your name and email.</p>` };
  }
  if (e.seats_left === 0) {
    return { label: 'Full', btn: '<button class="ld-msg" disabled>Full</button>',
      note: '<div class="evd-note">Every place has been taken. There is no waiting list yet.</div>' };
  }
  const left = e.seats_left !== null && e.seats_left !== undefined ? `${e.seats_left} spots left` : '';
  return { label: left ? `${left}<span>${short.replace(/<span>.*$/, '')}</span>` : short,
    btn: `<button class="ld-msg evd-btn-go" onclick="evRegister()">Register</button>`, note: evPrivacyLine() };
}

// Stated once, plainly, directly under the button — §4.1 is explicit that it must not be
// buried. The bookmark is private and this is not, and a student is entitled to know which is
// which BEFORE they tap, not in a settings page afterwards.
function evPrivacyLine() {
  return `<p class="evd-privacy">The organizers will see your name and email. Saving it with
          the bookmark does not tell anyone.</p>`;
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
  toast('You are going');
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
  toast(data === 'checked_in' ? 'You are checked in' : 'They know you are here');
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
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nestrel//Events//EN',
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
  if (!live.length) { wrap.innerHTML = emptyHTML; pfCount('going', 0); return; }

  const { data: evs } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, starts_at, location, poster_url, status, has_ended, ' +
            'effective_ends_at, cancelled_reason')
    .in('id', live.map(r => r.event_id));

  const rows = evs || [];
  if (!rows.length) { wrap.innerHTML = emptyHTML; pfCount('going', 0); return; }
  await Promise.all([evLoadOrgs(rows), evLoadRated(), evLoadFbWindows(rows.map(e => e.id))]);

  const byId = new Map(live.map(r => [r.event_id, r]));
  const upcoming = rows.filter(e => !e.has_ended)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = rows.filter(e => e.has_ended)
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));

  wrap.innerHTML =
    upcoming.map(e => goingRowHTML(e, byId.get(e.id))).join('') +
    (past.length ? `<div class="go-head">Already happened</div>` : '') +
    past.map(e => goingRowHTML(e, byId.get(e.id))).join('');
  // The error return above leaves the count alone on purpose: a failed query is not zero events,
  // and printing 0 would state something the app does not know.
  pfCount('going', rows.length);
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
    ? `<span class="go-state go-rated">You rated it ${icon('starFill',12,true).repeat(rated.rating)}</span>`
    : evCanRate(e, reg)
      ? `<button class="go-rate-btn" onclick="event.stopPropagation();evOpen(${e.id})">${icon('starFill', 13, true)} Rate it</button>`
      : (e.has_ended && ['checked_in', 'walk_in'].includes(reg?.status)
          ? '<span class="go-state go-shut">Rating closed</span>' : '');

  const state = e.status === 'cancelled'
    ? `<span class="go-state go-off">Cancelled${e.cancelled_reason ? ' · ' + esc(e.cancelled_reason) : ''}</span>`
    : (reg?.status === 'checked_in' || reg?.status === 'walk_in')
      ? '<span class="go-state go-in">You were there ' + icon('check',12) + '</span>'
      : reg?.status === 'self_reported'
        ? '<span class="go-state">Waiting to be confirmed</span>'
        : e.has_ended ? '<span class="go-state go-off">Did not check in</span>' : '';

  // A div, not a button: the row contains a Rate it button, and a button inside a button is
  // invalid HTML that browsers resolve by dropping one of them. Rate it opens the event, whose
  // page holds the rating form (stars and an optional comment, sent together).
  return `
    <div class="go-row${e.has_ended ? ' is-past' : ''}">
      <div class="go-thumb" onclick="evOpen(${e.id})"${e.poster_url ? '' : ` style="background:${eventGradient(e.id)}"`}>
        ${e.poster_url ? `<img src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="go-text" onclick="evOpen(${e.id})">
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

// Until sql/2026-09-24_event_feedback_window.sql has run, the database's rule is the old one —
// 7 days after the event ends, always on — and this mirrors it.
const EV_FEEDBACK_DAYS = 7;

// Each event's feedback window as the officer set it (event_feedback_windows): is it on, and
// until when. Empty when that view does not exist yet, and every check below falls back to the
// old 7-day rule — so the app is right before AND after the SQL file is run.
let _evFbWin = new Map();   // event id -> { feedback_enabled, feedback_closes_at, feedback_open }
async function evLoadFbWindows(ids) {
  const want = [...new Set(ids)].filter(id => !_evFbWin.has(id));
  if (!want.length) return;
  const { data, error } = await supabaseClient.from('event_feedback_windows')
    .select('event_id, feedback_enabled, feedback_closes_at, feedback_open').in('event_id', want);
  if (error) return;                       // view not there yet: the fallback applies
  (data || []).forEach(w => _evFbWin.set(w.event_id, w));
}

// A student may read their own feedback rows and nothing else, which is exactly what this
// needs: whether THEY have already rated something.
async function evLoadRated() {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient
    .from('event_feedback').select('event_id, rating, comment').eq('user_id', eu.id);
  _evRated = new Map((data || []).map(f => [f.event_id, f]));
}

// When feedback closes for this event: the officer's deadline, or 7 days after it ended.
function evFbClosesAt(e) {
  const w = _evFbWin.get(e.id);
  if (w?.feedback_closes_at) return new Date(w.feedback_closes_at);
  return new Date(new Date(e.effective_ends_at || e.ends_at || e.starts_at).getTime() + EV_FEEDBACK_DAYS * 864e5);
}

// Mirrors the policy rather than inventing a second rule: attended, over, turned on, and before
// the deadline. If these ever disagree the database wins and the student sees a refusal, which
// is why the copy never promises the rating will be accepted before it has been.
function evCanRate(e, reg) {
  if (!e || !reg) return false;
  if (!['checked_in', 'walk_in'].includes(reg.status)) return false;
  if (!e.has_ended) return false;
  const w = _evFbWin.get(e.id);
  if (w) return !!w.feedback_open;
  return Date.now() < evFbClosesAt(e).getTime();
}

// ---------- The rating form ----------
// Stars and an optional comment, sent TOGETHER in one insert (2026-09-24). The comment used to be
// asked for afterwards and saved with an UPDATE — which event_feedback has never allowed, on
// purpose, so an officer cannot pressure anyone into changing a rating. Every one of those
// comments was refused. Now there is nothing to update: it all arrives at once.
//
// "Shared anonymously with the organizers", never "completely anonymous": at a small event a
// detailed comment can still be recognised, and the student should know that before writing it.
let _evDraft = new Map();   // event id -> the star picked but not sent yet

function evRateFormHTML(e) {
  const n = _evDraft.get(e.id) || 0;
  const closes = evFbClosesAt(e).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `
    <div class="ev-rate" data-rate="${e.id}">
      <div class="ev-rate-q">How was it?</div>
      <div class="ev-stars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map(i =>
        `<button class="ev-star-btn${i <= n ? ' is-on' : ''}" role="radio" aria-checked="${i === n}" aria-label="${i} out of 5"
                 onclick="evPickStar(${e.id}, ${i})">${icon('starFill', 26, true)}</button>`).join('')}</div>
      <textarea class="form-textarea ev-rate-note" rows="2" maxlength="500"
        placeholder="What went well? What would make it better? (optional)"></textarea>
      <button class="ld-msg ev-rate-send" onclick="evSubmitRating(${e.id}, this)"${n ? '' : ' disabled'}>Send anonymously</button>
      <p class="ev-rate-fine">Only people who checked in can rate. Organizers see the average and the comments —
        never who wrote them — though at a small event a detailed comment may still be recognisable.
        Open until ${esc(closes)}.</p>
    </div>`;
}

// Picking a star only selects it. Sending is a separate, deliberate tap, so a mis-tap on the way
// to the comment box is not an irreversible 1-star.
function evPickStar(eventId, n) {
  _evDraft.set(eventId, n);
  document.querySelectorAll(`[data-rate="${eventId}"]`).forEach(form => {
    form.querySelectorAll('.ev-star-btn').forEach((b, i) => {
      b.classList.toggle('is-on', i < n);
      b.setAttribute('aria-checked', String(i + 1 === n));
    });
    const send = form.querySelector('.ev-rate-send');
    if (send) send.disabled = false;
    // In a nudge, the first star opens the comment box and names the choice.
    const more = form.querySelector('.ev-nudge-more');
    if (more && more.hidden) { more.hidden = false; }
    const word = form.querySelector('.ev-nudge-word');
    if (word) word.textContent = EV_STAR_WORDS[n];
  });
}

// `btn` is the Send that was tapped. The form can be on Home and on the Events page at once, so
// the comment is read from THAT form, not looked up by an id two copies would share.
async function evSubmitRating(eventId, btn) {
  const eu = getEffectiveUser();
  if (!eu?.id) { requireAuth(); return; }
  const rating = _evDraft.get(eventId);
  if (!rating) { toast('Pick a star rating first'); return; }
  const comment = (btn?.closest('[data-rate]')?.querySelector('.ev-rate-note')?.value || '').trim() || null;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  // `school` is omitted deliberately: event_feedback_set_school fills it from the event, so
  // the browser cannot write a row into a school that does not exist.
  const { error } = await supabaseClient.from('event_feedback')
    .insert({ event_id: eventId, user_id: eu.id, rating, comment });

  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send anonymously'; }
    // The likely refusals are all policy: no check-in row, turned off, or past the deadline.
    // They mean the same thing to a student, and none is worth a database message.
    toast(error.code === '23505' ? 'You already rated that one'
        : 'That rating could not be saved — feedback may have closed');
    console.error('[evSubmitRating]', error);
    return;
  }
  _evRated.set(eventId, { event_id: eventId, rating, comment });
  _evDraft.delete(eventId);
  // Nudges shrink to a thank-you strip (and offer the next event, if one is waiting); the full
  // form on the event page becomes a thank-you line.
  const title = btn?.closest('[data-title]')?.dataset.title
    || _evDue.find(x => x.id === eventId)?.title || (_evDetail?.id === eventId ? _evDetail.title : 'it');
  _evDue = _evDue.filter(x => x.id !== eventId);
  _evNudgeDone = { id: eventId, title, rating };
  evNudgeRepaint();
  document.querySelectorAll(`.ev-rate[data-rate="${eventId}"]`).forEach(f => { f.outerHTML = evRatedHTML(rating); });
  if (evDetailOpen() && _evDetail?.id === eventId) evPaintDetail();
  renderGoing();
}

function evRatedHTML(rating) {
  return `<div class="ev-rated">${icon('check', 15)} You rated it ${icon('starFill', 13, true).repeat(rating)} — thank you</div>`;
}

// ---------- The nudge (2026-09-24) ----------
// On Home and the Events page the rating is a NUDGE, not a form, because prompts that people
// actually answer — Uber's stars, Airbnb's reviews, Duolingo's check-ins — share three habits:
//   1. ask one tiny thing inline: tap a star. The comment box appears only after that tap.
//   2. say what it costs and who sees it, up front: "5 seconds · anonymous".
//   3. once answered, thank and GET OUT OF THE WAY — shrink to a thin strip, never stay a big card.
// And "Not now" does not nag or vanish: it minimizes to a one-line pill that stays reachable.
// The event page keeps the full form (evRateFormHTML): someone who opened the event came for it.
const EV_NUDGE_MIN_KEY = 'cn_rate_minimized';
let _evDue = [];            // events waiting for this student's rating, most recent first
let _evNudgeDone = null;    // { id, title, rating } — the thank-you strip, until closed

function evNudgeMin() { try { return new Set(JSON.parse(localStorage.getItem(EV_NUDGE_MIN_KEY) || '[]')); } catch (e) { return new Set(); } }
function evNudgeSetMin(id, on) {
  const s = evNudgeMin(); if (on) s.add(id); else s.delete(id);
  try { localStorage.setItem(EV_NUDGE_MIN_KEY, JSON.stringify([...s].slice(-50))); } catch (e) { /* private mode */ }
}

const EV_STAR_WORDS = ['', 'Not great', 'It was okay', 'Good', 'Really good', 'Loved it!'];

function evNudgeHTML(e) {
  if (evNudgeMin().has(e.id)) {
    return `<button class="ev-nudge-pill" onclick="evNudgeSetMin(${e.id}, false);evNudgeRepaint()">
      <span class="ev-nudge-pill-star">${icon('starFill', 14, true)}</span>
      <span>Rate <b>${esc(e.title)}</b></span><span class="ev-nudge-pill-t">5 sec</span></button>`;
  }
  const n = _evDraft.get(e.id) || 0;
  const org = _evOrgs.get(e.org_id)?.name;
  return `
    <div class="ev-nudge" data-rate="${e.id}" data-title="${escAttr(e.title)}">
      <div class="ev-nudge-top">
        <span class="ev-nudge-badge">${icon('starFill', 18, true)}</span>
        <div class="ev-nudge-text">
          <div class="ev-nudge-q">How was <b>${esc(e.title)}</b>?</div>
          <div class="ev-nudge-sub">You were there · 5 seconds · anonymous${org ? `<span class="ev-nudge-helps"> · helps ${esc(org)} plan the next one</span>` : ''}</div>
        </div>
        <button class="ev-nudge-x" onclick="evNudgeSetMin(${e.id}, true);evNudgeRepaint()" aria-label="Not now" title="Not now">${icon('x', 15)}</button>
      </div>
      <div class="ev-nudge-rate">
        <div class="ev-stars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map(i =>
          `<button class="ev-star-btn${i <= n ? ' is-on' : ''}" role="radio" aria-checked="${i === n}" aria-label="${i} out of 5 — ${EV_STAR_WORDS[i]}"
                   onclick="evPickStar(${e.id}, ${i})">${icon('starFill', 30, true)}</button>`).join('')}</div>
        <span class="ev-nudge-word" aria-live="polite">${n ? EV_STAR_WORDS[n] : ''}</span>
      </div>
      <div class="ev-nudge-more"${n ? '' : ' hidden'}>
        <textarea class="form-textarea ev-rate-note" rows="2" maxlength="500"
          placeholder="Anything they should know? (optional)"></textarea>
        <button class="ld-msg ev-rate-send" onclick="evSubmitRating(${e.id}, this)"${n ? '' : ' disabled'}>Send anonymously</button>
        <p class="ev-rate-fine">Organizers see the average and comments, never who wrote them.</p>
      </div>
    </div>`;
}

function evNudgeDoneHTML() {
  const d = _evNudgeDone;
  const left = _evDue.length;
  return `
    <div class="ev-nudge-done" role="status">
      <span class="ev-nudge-burst">${icon('check', 16)}</span>
      <span class="ev-nudge-done-t">Thanks! You rated <b>${esc(d.title)}</b>
        <span class="ev-nudge-done-stars">${icon('starFill', 12, true).repeat(d.rating)}</span></span>
      ${left ? `<button class="hn-link" onclick="_evNudgeDone=null;evNudgeRepaint()">Rate the next one</button>` : ''}
      <button class="ev-nudge-x" onclick="_evNudgeDone=null;_evDueHidden=true;evNudgeRepaint()" aria-label="Close">${icon('x', 14)}</button>
    </div>`;
}
let _evDueHidden = false;   // closed the thank-you with nothing else asked for this visit

// What a nudge slot shows right now: the thank-you, or the most recent event still waiting.
function evNudgeSlotHTML() {
  if (_evNudgeDone) return evNudgeDoneHTML();
  if (_evDueHidden || !_evDue.length) return '';
  return evNudgeHTML(_evDue[0]);
}
// Every place a nudge can be: Home, and the Events page (in the feed on a phone, in the side
// column on a desktop). They show the same state, so answering in one answers everywhere.
function evNudgeRepaint() {
  ['evAskSlot', 'evAskSide', 'homeRate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = evNudgeSlotHTML();
  });
}

// The events still waiting for this student's rating: checked in, over, inside the officer's
// window, not yet rated. Most recent first — the one they remember best.
async function evPendingRatings() {
  const eu = getEffectiveUser();
  if (!eu?.id) return [];

  const { data: regs } = await supabaseClient
    .from('event_registrations').select('event_id, status').eq('user_id', eu.id)
    .in('status', ['checked_in', 'walk_in']);
  if (!regs || !regs.length) return [];

  const [{ data: evs }] = await Promise.all([
    supabaseClient.from('visible_events')
      .select('id, org_id, title, starts_at, ends_at, has_ended, effective_ends_at')
      .in('id', regs.map(r => r.event_id)),
    evLoadFbWindows(regs.map(r => r.event_id)),
    _evRated.size ? null : evLoadRated(),
  ]);
  await evLoadOrgs(evs || []);

  const byReg = new Map(regs.map(r => [r.event_id, r]));
  return (evs || [])
    .filter(e => evCanRate(e, byReg.get(e.id)) && !_evRated.has(e.id))
    .sort((a, b) => new Date(b.effective_ends_at) - new Date(a.effective_ends_at));
}

// For Home (feed.js): refreshes the list and returns what the slot should show.
async function evPendingRatingHTML() {
  _evDue = await evPendingRatings();
  return evNudgeSlotHTML();
}

async function evPaintAsk() {
  _evDue = await evPendingRatings();
  evNudgeRepaint();
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
    case 'today':   return [now, add(today, 1)];
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

// ---------- The events search, TikTok-style like the main search (2026-09-24) ----------
// Same three states as js/search.js, so the two searches feel like one app:
//   ENTRY    Recent event searches, and "Browse by" chips — when, and the kinds that have events
//   SUGGEST  typing: event titles, clubs and places that exist, the typed part in bold
//   RESULTS  after Enter, a suggestion or a chip: the matches, grouped by day like the feed,
//            with the active when / kind shown as chips you can remove
// Clubs are not in here any more: the stories row on the Events page does that job.
const EVS_RECENT_KEY = 'cn_recent_event_searches';
let _evSearchSubmitted = false;

function evsRecent() { try { return JSON.parse(localStorage.getItem(EVS_RECENT_KEY)) || []; } catch (e) { return []; } }
function evsRemember(q) {
  const t = (q || '').trim();
  if (t.length < 3) return;
  const list = [t, ...evsRecent().filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, 6);
  try { localStorage.setItem(EVS_RECENT_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
}
function evsForget(t) {
  try { localStorage.setItem(EVS_RECENT_KEY, JSON.stringify(t == null ? [] : evsRecent().filter(x => x !== t))); } catch (e) {}
  evSearchPaintBody();
}

async function evSearchOpen() {
  _evSearchOn = true;
  _evSearchQ = ''; _evSearchOrg = null; _evSearchType = null; _evSearchWhen = null; _evSearchSubmitted = false;
  evPaint();
  window.scrollTo(0, 0);
  document.getElementById('evSearchInput')?.focus();
}
function evSearchClose() { _evSearchOn = false; evPaint(); }

function evSearchHTML() {
  return `
    <div class="sq-head">
      <button class="sq-back" onclick="evSearchClose()" aria-label="Back to events">${icon('chevRight', 22)}</button>
      <div class="sq-bar">
        <span class="sq-icon">${icon('search', 17)}</span>
        <form onsubmit="return evSearchSubmit()" autocomplete="off" class="form-shell sq-form">
          <input class="sq-input" id="evSearchInput" name="cn-ev-search" autocomplete="off" enterkeyhint="search"
                 placeholder="Search events, clubs, places…" value="${escAttr(_evSearchQ)}" oninput="evSearchSet('q', this.value)">
        </form>
        <button class="sq-x" id="evsX" onclick="evSearchReset()" aria-label="Clear"${_evSearchQ ? '' : ' hidden'}>${icon('x', 14)}</button>
      </div>
      <button class="sq-cancel" onclick="evSearchClose()">Cancel</button>
    </div>
    <div id="evSearchBody"></div>`;
}

// Typing repaints only the body, so the input keeps focus and the caret stays put.
function evSearchSet(kind, value) {
  if (kind === 'q')    { _evSearchQ = value; _evSearchSubmitted = false; }
  if (kind === 'type') { _evSearchType = _evSearchType === value ? null : value; _evSearchSubmitted = true; }
  if (kind === 'when') { _evSearchWhen = _evSearchWhen === value ? null : value; _evSearchSubmitted = true; }
  const x = document.getElementById('evsX');
  if (x) x.hidden = !_evSearchQ;
  evSearchPaintBody();
}
// Kept under its old name: evPaint() calls it after drawing the search.
function evSearchPaintChips() { evSearchPaintBody(); }

function evSearchRun(term) {
  _evSearchQ = term; _evSearchSubmitted = true;
  const el = document.getElementById('evSearchInput');
  if (el) { el.value = term; el.blur(); }
  const x = document.getElementById('evsX'); if (x) x.hidden = !term;
  evsRemember(term);
  evSearchPaintBody();
}
function evSearchSubmit() { evSearchRun(document.getElementById('evSearchInput')?.value || ''); return false; }

function evSearchReset() {
  _evSearchQ = ''; _evSearchType = null; _evSearchWhen = null; _evSearchSubmitted = false;
  const el = document.getElementById('evSearchInput');
  if (el) { el.value = ''; el.focus(); }
  const x = document.getElementById('evsX'); if (x) x.hidden = true;
  evSearchPaintBody();
}

function evSearchPaintBody() {
  const body = document.getElementById('evSearchBody');
  if (!body) return;
  const q = _evSearchQ.trim().toLowerCase();
  const filtered = _evSearchType || _evSearchWhen;
  if (!q && !filtered) { body.innerHTML = evSearchEntryHTML(); return; }
  if (q && !_evSearchSubmitted) { body.innerHTML = evSearchSuggestHTML(q); return; }
  body.innerHTML = evSearchResultsHTML();
}

function evSearchEntryHTML() {
  const recent = evsRecent();
  const whens = [['today', 'Today'], ['weekend', 'This weekend'], ['week', 'This week'], ['next', 'Next week'], ['month', 'This month']];
  const kinds = EV_TYPES.filter(([v]) => _evFeed.some(e => e.event_type === v));
  return `
    ${recent.length ? `
      <div class="sq-sec">
        <div class="sq-sec-head"><h2 class="sq-h">Recent</h2><button class="hn-link" onclick="evsForget(null)">Clear all</button></div>
        <div class="sq-list">${recent.map(t => `
          <div class="sq-li">
            <button class="sq-li-go" onclick="evSearchRun(${sqJs(t)})">${icon('clock', 17)}<span>${esc(t)}</span></button>
            <button class="sq-li-x" onclick="evsForget(${sqJs(t)})" aria-label="Remove ${escAttr(t)}">${icon('x', 15)}</button>
          </div>`).join('')}</div>
      </div>` : ''}
    <div class="sq-sec">
      <h2 class="sq-h">When</h2>
      <div class="sq-chips">${whens.map(([k, l]) => `<button class="sq-pop" onclick="evSearchSet('when', '${k}')">${l}</button>`).join('')}</div>
    </div>
    ${kinds.length ? `
      <div class="sq-sec">
        <h2 class="sq-h">Kind of event</h2>
        <div class="sq-chips">${kinds.map(([v, l]) => `<button class="sq-pop" onclick="evSearchSet('type', '${v}')">${esc(l)}</button>`).join('')}</div>
      </div>` : ''}`;
}

// Things that exist: upcoming event titles, the clubs running them, and where they happen.
function evSearchSuggestHTML(q) {
  const pool = [];
  _evFeed.forEach(e => { pool.push(e.title); pool.push(_evOrgs.get(e.org_id)?.name); pool.push(e.location); });
  const seen = new Set(), rows = [];
  const rank = t => { const s = t.toLowerCase(); return s.startsWith(q) ? 0 : s.includes(' ' + q) ? 1 : 2; };
  pool.filter(Boolean).map(String).filter(t => t.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length)
    .forEach(t => { const k = t.toLowerCase(); if (!seen.has(k) && rows.length < 8) { seen.add(k); rows.push(t); } });
  const bold = t => { const i = t.toLowerCase().indexOf(q); return i < 0 ? esc(t)
    : esc(t.slice(0, i)) + '<b>' + esc(t.slice(i, i + q.length)) + '</b>' + esc(t.slice(i + q.length)); };
  return `
    <div class="sq-list">
      <div class="sq-li"><button class="sq-li-go" onclick="evSearchRun(${sqJs(_evSearchQ.trim())})">${icon('search', 17)}<span>Search for “<b>${esc(_evSearchQ.trim())}</b>”</span></button></div>
      ${rows.map(t => `<div class="sq-li"><button class="sq-li-go" onclick="evSearchRun(${sqJs(t)})">${icon('search', 17)}<span>${bold(t)}</span></button></div>`).join('')}
    </div>`;
}

function evSearchResultsHTML() {
  const hits = evMatchEvents(_evFeed, { q: _evSearchQ, type: _evSearchType, when: _evSearchWhen });
  const whenLabel = { today: 'Today', weekend: 'This weekend', week: 'This week', next: 'Next week', month: 'This month' };
  const active = [
    _evSearchWhen ? `<button class="sq-pop sq-pop-on" onclick="evSearchSet('when', '${_evSearchWhen}')">${whenLabel[_evSearchWhen]} ×</button>` : '',
    _evSearchType ? `<button class="sq-pop sq-pop-on" onclick="evSearchSet('type', '${_evSearchType}')">${esc((EV_TYPES.find(([v]) => v === _evSearchType) || [])[1] || _evSearchType)} ×</button>` : '',
  ].join('');
  const head = `<div class="evs-results-head">${active}<span class="evs-count">${hits.length} event${hits.length === 1 ? '' : 's'}</span></div>`;

  if (!hits.length) {
    // Broadening beats a bare "no results": with a dozen events, empty usually means the filters
    // are narrow, not that the campus is quiet.
    return `${head}
      <div class="evs-none">
        <div class="evs-none-t">Nothing matches yet</div>
        <p>There are ${_evFeed.length} event${_evFeed.length === 1 ? '' : 's'} coming up in total — try a shorter word or remove a filter.</p>
        <button class="sq-pop" onclick="evSearchReset()">Start again</button>
      </div>`;
  }
  // Grouped by date exactly like the feed, so a result list and the feed are read the same way.
  let html = head, lastKey = null;
  for (const e of hits) {
    const key = evDayKey(e.starts_at);
    if (key !== lastKey) {
      if (lastKey !== null) html += '</div>';
      html += `${evDayHeadHTML(e.starts_at)}<div class="ev-grid">`;
      lastKey = key;
    }
    html += evCardHTML(e);
  }
  return html + (lastKey !== null ? '</div>' : '');
}
