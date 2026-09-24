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

// The campus in the greeting banner. It is drawn to sit IN the page, not on it:
//  - the front lawn is painted in the page's own colour (.hc-ground), so the buildings rise out
//    of the page itself and there is no bottom edge to hide;
//  - the sky is not a box but soft glows behind it (.home-hero::before), which fade to nothing
//    on their own — no rectangle, so no rectangle to blur;
//  - distance is shown the way a landscape shows it: pale, low rooftops behind the campus, and
//    they thin out into the page towards both ends (#hcFarFade) — so the skyline dissolves
//    instead of stopping at the banner's edge;
//  - at dusk a few stars come out (.hc-stars, shown only in the evening).
// Inline SVG, not an image: sharp at every size, weightless, and every colour is a CSS variable,
// so the time-of-day classes on .home-hero repaint the scene (lit windows and a moon at dusk).
// 1200 x 240, main buildings on the right so the greeting has open sky; phones crop to the right
// half (preserveAspectRatio slice). Decorative, so hidden from screen readers.
function feedCampusSVG() {
  const wins = (x0, y, n, gap, w = 8, h = 13) =>
    Array.from({ length: n }, (_, i) => `<rect x="${x0 + i * gap}" y="${y}" width="${w}" height="${h}" rx="${w / 2}"/>`).join('');
  const tree = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/><circle cx="${x + r * .8}" cy="${y + r * .35}" r="${r * .75}"/>`
    + `<circle cx="${x - r * .75}" cy="${y + r * .4}" r="${r * .7}"/><rect x="${x - 2.5}" y="${y + r * .6}" width="5" height="${r * .9}"/>`;
  return `
  <svg class="home-campus" viewBox="0 0 1200 240" preserveAspectRatio="xMaxYMax slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="hcFarFade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="0">
        <stop offset="0" class="hc-fs" stop-opacity="0"/><stop offset=".28" class="hc-fs" stop-opacity=".4"/>
        <stop offset=".52" class="hc-fs" stop-opacity="1"/><stop offset=".92" class="hc-fs" stop-opacity="1"/>
        <stop offset="1" class="hc-fs" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <g class="hc-stars">
      <circle cx="742" cy="30" r="1.6"/><circle cx="806" cy="58" r="1.2"/><circle cx="958" cy="24" r="1.8"/>
      <circle cx="1010" cy="70" r="1.2"/><circle cx="1066" cy="36" r="1.4"/><circle cx="1168" cy="22" r="1.6"/>
      <circle cx="1182" cy="96" r="1.1"/><circle cx="696" cy="84" r="1.1"/>
    </g>
    <circle class="hc-sun" cx="1112" cy="62" r="19"/>
    <g class="hc-far">
      ${tree(166, 214, 12)}${tree(338, 212, 13)}${tree(492, 208, 15)}
      <rect x="18" y="196" width="58" height="40"/><rect x="84" y="182" width="40" height="54"/><path d="M80 184 L104 166 L128 184Z"/>
      <rect x="140" y="200" width="70" height="36"/><rect x="228" y="188" width="48" height="48"/>
      <rect x="296" y="198" width="84" height="38"/><rect x="404" y="174" width="42" height="62"/><rect x="421" y="156" width="8" height="20"/>
      <rect x="470" y="192" width="72" height="44"/><rect x="560" y="180" width="58" height="56"/><path d="M556 182 L589 162 L622 182Z"/>
      <rect x="700" y="150" width="38" height="86"/><path d="M696 152 L719 128 L742 152Z"/>
      <rect x="1100" y="170" width="60" height="66"/><rect x="1160" y="188" width="40" height="48"/>
    </g>
    <g class="hc-mid">
      <rect x="640" y="180" width="104" height="56"/><path d="M634 182 L692 160 L750 182Z"/>
      <rect x="770" y="150" width="200" height="86"/><path d="M760 152 L870 108 L980 152Z"/>
      <rect x="848" y="70" width="44" height="86"/><path d="M842 72 L870 34 L898 72Z"/>
      <rect x="990" y="162" width="92" height="74"/><path d="M997 163 A38 38 0 0 1 1073 163Z"/>
      <rect x="1030" y="112" width="10" height="14"/>
    </g>
    <g class="hc-win">
      ${wins(652, 196, 5, 17)}
      ${wins(784, 166, 11, 16)}${wins(784, 198, 5, 16)}${wins(900, 198, 4, 16)}
      ${wins(1004, 180, 5, 15)}
      <circle cx="870" cy="94" r="10"/>
      <path d="M862 236 L862 212 A8 8 0 0 1 878 212 L878 236Z"/>
    </g>
    <path class="hc-hands" d="M870 94 L870 87 M870 94 L876 96.5"/>
    <g class="hc-tree">
      ${tree(606, 204, 18)}${tree(752, 206, 15)}${tree(986, 208, 14)}${tree(1108, 206, 17)}${tree(1176, 210, 14)}
      <rect x="724" y="196" width="3" height="34"/><circle cx="725.5" cy="195" r="4"/>
      <rect x="1090" y="198" width="3" height="32"/><circle cx="1091.5" cy="197" r="4"/>
    </g>
    <path class="hc-ground" d="M0 226 C180 216 360 230 560 222 S900 212 1060 220 S1170 224 1200 222 L1200 240 L0 240Z"/>
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
