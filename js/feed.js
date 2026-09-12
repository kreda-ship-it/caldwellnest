// ============================================================
// HOME FEED
// The Home tab's own page. Until now Home showed the marketplace grid, which meant two
// bottom tabs led to the same screen and only the highlight differed — the same costume
// Events was wearing before it got its own section.
//
// This owns no data. It reads what listings.js and events.js already loaded and arranges
// it: what is on this week, what was just posted, and a way into the clubs. If a section
// has nothing in it, the section is not drawn — an empty heading is worse than no heading.
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
  const type = (EV_TYPES.find(([v]) => v === e.event_type) || [])[1] || '';
  const who  = org?.name ? ' · ' + org.name : '';
  return `
    <button class="fev-card" onclick="evOpen(${e.id})">
      <div class="fev-banner"${e.poster_url ? '' : ` style="background:${eventGradient(e.id)}"`}>
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

function feedNewest(limit = 4) {
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
  const head = `
    <div class="feed-hello">
      <h1 class="feed-greet">${feedGreeting()}${first ? ', ' + esc(first) : ''}</h1>
      <p class="feed-sub">Your campus. Your community.</p>
    </div>`;

  // Painted in two passes on purpose. Listings are already in memory, so the marketplace
  // section can be on screen immediately; events need a query. Holding the whole feed back
  // for that query would make the fast half feel as slow as the slow half.
  const listings = feedNewest();
  const market = listings.length
    ? feedSection('New in marketplace', 'See all', "showPage('listings')",
        `<div class="listings-grid feed-grid">${listings.map(l => listingCardHTML(l, false)).join('')}</div>`)
    : '';

  const clubs = `
    <button class="feed-clubs" onclick="orgDirGo()">
      <span class="feed-clubs-icon">${icon('school', 22)}</span>
      <span class="feed-clubs-body">
        <span class="feed-clubs-title">Clubs &amp; organizations</span>
        <span class="feed-clubs-sub">Browse every club and department, and follow the ones you care about</span>
      </span>
      ${icon('chevRight', 16)}
    </button>`;

  body.innerHTML = head + '<div id="feedEvents"></div>' + market + clubs;

  // Second pass: events.
  const slot = document.getElementById('feedEvents');
  if (!slot) return;
  const res = await loadEvents();
  // Silence is right for a failure here. The marketplace half of the feed is already on
  // screen and useful; an error strip about a section the student cannot see yet would be
  // noise about nothing.
  if (!res.ok) return;

  const soon = feedUpcoming();
  if (!soon.length) return;
  slot.innerHTML = feedSection('Happening this week', 'All events', "showPage('events')",
    `<div class="feed-events">${soon.map(e => feedEventCardHTML(e)).join('')}</div>`);
}
