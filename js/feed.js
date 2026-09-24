// ============================================================
// HOME FEED
// The Home tab's own page. Until now Home showed the marketplace grid, which meant two
// bottom tabs led to the same screen and only the highlight differed — the same costume
// Events was wearing before it got its own section.
//
// "Today at Caldwell" (2026-09-23). Home is the lobby, not a third browse page: the Marketplace
// has every listing and Events every event, so Home shows what matters to THIS student right
// now — each section short, each ending in a doorway to the full page — and it has a bottom.
// Top to bottom: a greeting over a campus illustration with at-a-glance chips, your next RSVP,
// this week's events, the newest listings, and clubs you do not follow yet (moved up for a
// student who follows none, because an empty campus is the worst first impression).
//
// This owns no data. It reads what listings.js, events.js and orgdir.js already load and
// arranges it. If a section has nothing in it, the section is not drawn — an empty heading is
// worse than no heading.
//
// Loaded as a plain script (not a module) so every function stays global; the HTML's
// onclick handlers depend on that. boot.js must stay last.
// ============================================================

// Local time, not UTC — "Good evening" has to agree with the window the student is
// looking out of.
function feedGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The feed's own event card, and deliberately NOT evCardHTML.
//
// The Events page shows a 4:5 portrait poster, which is right there — an event flyer is a
// portrait thing and that page is where you go to look at them. On the feed it was wrong: a
// column of tall posters next to a 2-up grid of short landscape listing cards made one page
// look like two pages stitched together.
//
// This is the compact card from the approved feed mockup: a short banner carrying the date,
// then title, time, host and type. Same card language as the marketplace grid beside it.
function feedEventCardHTML(e) {
  const org = _evOrgs.get(e.org_id);
  const d = new Date(e.starts_at);
  // Explicit short weekday rather than evDayLabel(), which says "Today"/"Tomorrow" — useful
  // in a sentence, but this is a date block where the day number sits underneath.
  const dow = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const kind = EV_TYPES.find(([v]) => v === e.event_type);
  const type = kind ? kind[1] : '';
  const who  = org?.name ? ' · ' + org.name : '';
  // Toned by event type (.ev-tone-*), like the Events page and Up next, so one event wears the
  // same colours everywhere it appears.
  return `
    <button class="fev-card ev-tone-${kind ? kind[0] : 'other'}" onclick="evOpen(${e.id})">
      <div class="fev-banner">
        ${e.poster_url ? `<img class="fev-img" src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}
        <span class="fev-date"><span class="fev-dow">${esc(dow)}</span><span class="fev-day">${d.getDate()}</span></span>
      </div>
      <div class="fev-body">
        <span class="fev-title">${esc(e.title)}</span>
        <span class="fev-when">${esc(evTime(e.starts_at) + who)}</span>
        ${type ? `<span class="fev-type">${esc(type)}</span>` : ''}
      </div>
    </button>`;
}

// Events inside the next seven days. Anything further out belongs on the Events page:
// a home feed that lists something three weeks away is padding, not news.
//
// Six rather than two now that the row scrolls sideways — a horizontal strip that cannot be
// scrolled is just two cards with wasted space to their right.
function feedUpcoming(limit = 6) {
  const now = Date.now();
  const week = now + 7 * 24 * 60 * 60 * 1000;
  return (_evFeed || [])
    .filter(e => {
      const t = new Date(e.starts_at).getTime();
      return t >= now && t <= week;
    })
    .slice(0, limit);
}

// The newest live listings, for Home's short "Fresh on the Market" row.
function feedNewest(limit = 10) {
  return browseItems()
    .filter(isListingLive)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, limit);
}

function feedSection(title, moreLabel, moreFn, bodyHtml) {
  return `
    <section class="feed-sec">
      <div class="feed-head">
        <h2 class="feed-title">${title}</h2>
        ${moreFn ? `<button class="feed-more" onclick="${moreFn}">${moreLabel}${icon('chevRight', 13)}</button>` : ''}
      </div>
      ${bodyHtml}
    </section>`;
}

// The time of day decides the greeting AND the sky over the campus illustration.
function feedDaypart() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

// The campus in the greeting banner: a hall with a clock tower, a domed building, smaller halls
// and trees, drawn as flat layers. Inline SVG, not an image file: it is sharp at every size,
// weighs nothing, and its colours are CSS variables, so the time-of-day classes on .home-hero
// repaint the whole scene (lit windows and a moon in the evening) without a second drawing.
// Decorative, so hidden from screen readers.
function feedCampusSVG() {
  const win = (x, y) => `<rect x="${x}" y="${y}" width="9" height="14" rx="4.5"/>`;
  const row = (x0, y, n, gap) => Array.from({ length: n }, (_, i) => win(x0 + i * gap, y)).join('');
  return `
  <svg class="home-campus" viewBox="0 0 640 220" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
    <circle class="hc-sun" cx="566" cy="52" r="17"/>
    <g class="hc-far">
      <rect x="278" y="150" width="52" height="60"/><rect x="336" y="136" width="44" height="74"/>
      <path d="M336 136 L358 118 L380 136Z"/><rect x="578" y="138" width="62" height="72"/>
      <rect x="612" y="112" width="10" height="30"/><path d="M609 112 L617 96 L625 112Z"/>
    </g>
    <g class="hc-mid">
      <rect x="296" y="160" width="74" height="50"/>
      <rect x="398" y="128" width="154" height="82"/><path d="M392 130 L475 96 L558 130Z"/>
      <rect x="455" y="64" width="40" height="72"/><path d="M449 66 L475 34 L501 66Z"/>
      <rect x="560" y="152" width="72" height="58"/><path d="M566 153 A30 30 0 0 1 626 153Z"/>
      <rect x="592" y="115" width="8" height="10"/>
    </g>
    <g class="hc-win">
      ${row(306, 172, 5, 13)}${row(412, 146, 10, 13.6)}${row(412, 176, 4, 13.6)}${row(508, 176, 3, 13.6)}
      ${row(570, 166, 4, 15)}
      <circle cx="475" cy="86" r="9"/>
      <path d="M470 190 L470 178 A5 5 0 0 1 480 178 L480 210 L470 210Z"/>
    </g>
    <path class="hc-hands" d="M475 86 L475 80 M475 86 L480 88"/>
    <g class="hc-near">
      <path d="M0 214 Q170 196 330 204 T640 198 L640 220 L0 220Z"/>
      <circle cx="252" cy="186" r="16"/><circle cx="270" cy="178" r="20"/><circle cx="288" cy="190" r="13"/>
      <rect x="266" y="192" width="6" height="18"/>
      <circle cx="376" cy="190" r="12"/><circle cx="390" cy="182" r="15"/><rect x="386" y="194" width="5" height="14"/>
      <circle cx="636" cy="184" r="16"/><rect x="633" y="196" width="5" height="12"/>
      <rect x="352" y="176" width="3" height="30"/><circle cx="353.5" cy="175" r="4"/>
    </g>
  </svg>`;
}

// At-a-glance chips: what is waiting for you, each one a doorway. Only chips with something to
// say are drawn — "0 unread messages" is noise, not information.
function feedChipsHTML() {
  const chips = [];
  const unread = typeof sUnreadCount === 'number' ? sUnreadCount : 0;
  if (unread) chips.push([`${unread} unread message${unread === 1 ? '' : 's'}`, "showPage('messages')", 'message']);
  const todayKey = evDayKey(new Date().toISOString());
  const today = (_evFeed || []).filter(e => evDayKey(e.starts_at) === todayKey).length;
  if (today) chips.push([`${today} event${today === 1 ? '' : 's'} today`, 'feedGoToday()', 'calendar']);
  const dayAgo = Date.now() - 864e5;
  const fresh = browseItems().filter(isListingLive).filter(l => new Date(l.created_at || 0).getTime() > dayAgo).length;
  if (fresh) chips.push([`${fresh} new listing${fresh === 1 ? '' : 's'} today`, "showPage('listings')", 'grid']);
  return chips.map(([label, fn, ic]) => `<button class="home-chip" onclick="${fn}">${icon(ic, 14)}<span>${esc(label)}</span></button>`).join('');
}

// "N events today" opens Events already narrowed to today.
function feedGoToday() {
  _evFeedType = null; _evFeedWhen = 'today';
  showPage('events');
}

// Your next event: the soonest upcoming one you registered for. The detail view has the
// calendar buttons and, once the door opens, "I'm here" — so the card leads there.
function feedUpNextHTML() {
  const next = (_evFeed || []).filter(e => _evGoing.has(e.id))
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  if (!next) return '';
  const org = _evOrgs.get(next.org_id);
  const d = new Date(next.starts_at);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const type = (EV_TYPES.find(([v]) => v === next.event_type) || [])[0];
  const where = [next.location, org?.name].filter(Boolean).join(' · ');
  return feedSection('Up next for you', '', '', `
    <button class="home-next ev-tone-${type || 'other'}" onclick="evOpen(${next.id})">
      <span class="ev-date-badge home-next-date"><span>${esc(weekday)}</span><b>${d.getDate()}</b></span>
      <span class="home-next-body">
        <span class="home-next-title">${esc(next.title)}</span>
        <span class="home-next-when">${esc(evDayLabel(next.starts_at) + ' · ' + evTimeRange(next))}</span>
        ${where ? `<span class="home-next-where">${esc(where)}</span>` : ''}
      </span>
      <span class="home-next-go">${next.checkin_is_open ? "I'm here" : 'Details'}${icon('chevRight', 14)}</span>
    </button>`);
}

// Clubs this student does not follow yet, most-followed first — the ones their classmates
// already found worth following. The Follow button is the directory's own (orgDirToggleFollow),
// so following here repaints every Follow button for that club, everywhere.
function feedClubsHTML(followsNone) {
  const suggest = (_dirOrgs || []).filter(o => !_dirFollows.has(o.id))
    .sort((a, b) => (b.follower_count || 0) - (a.follower_count || 0)).slice(0, 8);
  if (!suggest.length) return '';
  const cards = suggest.map(o => {
    const n = o.follower_count || 0;
    return `
      <div class="home-club" onclick="orgPageOpen(${Number(o.id)})">
        ${_dirLogoHTML(o, 'home-club-logo')}
        <div class="home-club-name">${esc(o.name)}</div>
        <div class="home-club-meta" data-count="${Number(o.id)}">${n === 1 ? '1 follower' : n + ' followers'}</div>
        <button class="dir-follow home-club-follow" data-follow="${Number(o.id)}"
          onclick="event.stopPropagation();orgDirToggleFollow(${Number(o.id)})">${_dirFollowLabel(false)}</button>
      </div>`;
  }).join('');
  return feedSection(followsNone ? 'Find your people' : 'Clubs to follow', 'All clubs', 'orgDirGo()', `
    ${followsNone ? '<p class="home-sub">Follow a few clubs and their events and news will show up here.</p>' : ''}
    <div class="home-row">${cards}</div>`);
}

async function renderFeed() {
  const body = document.getElementById('feedBody');
  if (!body) return;

  const u = getEffectiveUser();

  // A signed-out visitor should not be here — goHome() sends strangers to the landing
  // page. This is the boot-order case: the page can paint before the session resolves.
  if (!u) {
    body.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-title">Your campus, in one place</div>
        <p>Sign in to see what is happening and what has just been posted.</p>
        <button class="ev-empty-btn" onclick="requireAuth()">Sign in</button>
      </div>`;
    return;
  }

  const first = (u.display_name || u.first || u.name || '').split(' ')[0];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const schoolName = (_schoolsList || []).find(s => s.slug === u.school)?.name || '';
  const hero = `
    <section class="home-hero is-${feedDaypart()}">
      <div class="home-hero-text">
        <p class="home-date">${esc([today, schoolName].filter(Boolean).join(' · '))}</p>
        <h1 class="home-greet">${feedGreeting()}${first ? ', ' + esc(first) : ''}</h1>
        <div class="home-chips" id="homeChips">${feedChipsHTML()}</div>
      </div>
      ${feedCampusSVG()}
    </section>`;

  // A short row, not the whole Marketplace: ten of the newest, then a doorway to the rest.
  const listings = feedNewest();
  const market = listings.length
    ? feedSection('Fresh on the Market', 'Browse all', "showPage('listings')", `
        <div class="home-row home-market">
          ${listings.map(l => listingCardHTML(l, false)).join('')}
          <button class="home-more-tile" onclick="showPage('listings')">${icon('grid', 22)}<span>Browse the Market</span></button>
        </div>`)
    : '';

  // Painted in passes: everything already in memory first, then what needs a query (events,
  // then clubs). Holding the page back for the slowest part would make all of it feel slow.
  // Two club slots, because where the section goes depends on how many clubs you follow —
  // which is only known once the directory has loaded.
  body.innerHTML = hero + '<div id="homeClubsTop"></div><div id="homeUpNext"></div><div id="feedEvents"></div>'
    + market + '<div id="homeClubsBottom"></div>';

  const res = await loadEvents();
  // Silence is right for a failure here: the rest of Home is already on screen and useful.
  if (res.ok) {
    const chips = document.getElementById('homeChips');
    if (chips) chips.innerHTML = feedChipsHTML();          // now counts today's events too
    const upNext = document.getElementById('homeUpNext');
    if (upNext) upNext.innerHTML = feedUpNextHTML();
    const soon = feedUpcoming();
    const slot = document.getElementById('feedEvents');
    if (slot && soon.length) slot.innerHTML = feedSection('Happening this week', 'All events', "showPage('events')",
      `<div class="feed-events">${soon.map(e => feedEventCardHTML(e)).join('')}</div>`);
  }

  if (await loadOrgDirectory() !== true) return;
  const followsNone = _dirFollows.size === 0;
  const clubsSlot = document.getElementById(followsNone ? 'homeClubsTop' : 'homeClubsBottom');
  if (clubsSlot) clubsSlot.innerHTML = feedClubsHTML(followsNone);
}
