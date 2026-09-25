// ============================================================
// HOME FEED
// The Home tab's own page. Until now Home showed the marketplace grid, which meant two
// bottom tabs led to the same screen and only the highlight differed — the same costume
// Events was wearing before it got its own section.
//
// "Today at Caldwell" (2026-09-23). Home is the lobby, not a third browse page: the Marketplace
// has every listing and Events every event, so Home shows what matters to THIS student right
// now — each section short, each ending in a doorway to the full page — and it has a bottom.
// Top to bottom: a greeting over a campus illustration with at-a-glance chips, at most one
// urgent banner, your next RSVP, Campus news (club posts and polls, official announcements),
// Featured listings, this week's events, the newest listings, and clubs you do not follow yet
// (moved up for a student who follows none, because an empty campus is the worst first
// impression).
//
// Mostly this owns no data: it reads what listings.js, events.js and orgdir.js already load and
// arranges it. Campus news is the exception — nothing else loads club posts for a student's
// followed clubs, or official announcements, so feedLoadNews() does. If a section has nothing in it, the section is not drawn — an empty heading is
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

// The newest live listings, for Home's short "Fresh on the Market" row. Featured (pinned) listings
// are left out: they already have their own row above, and one listing twice on one page reads as
// a duplicate (fixed 2026-09-25).
function feedNewest(limit = 10) {
  return browseItems()
    .filter(isListingLive)
    .filter(l => !l.pinned)
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
  if (unread) chips.push([`${unread} unread message${unread === 1 ? '' : 's'}`, "openInbox('messages')", 'message']);
  // From Campus news, once it has loaded: club posts from the last three days, and open polls
  // you have not answered. Both scroll down to the news rather than opening another page.
  const recent = _feedNews.filter(x => x.kind === 'club' && Date.now() - new Date(x.at).getTime() < 3 * _feedDay).length;
  if (recent) chips.push([`${recent} new from your clubs`, 'feedGoNews()', 'bell']);
  const waiting = _feedNews.filter(x => x.isPoll && !feedPollClosed(x) && !x.votes.some(v => v.user_id === _feedMe)).length;
  if (waiting) chips.push([`${waiting} poll${waiting === 1 ? '' : 's'} waiting for you`, 'feedGoNews()', 'check']);
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
  // The date strip's Today, so the strip shows it picked and a tap on it undoes it.
  _evFeedType = null; _evFeedWhen = null; _evFeedDay = evDayKey(new Date().toISOString());
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

// ============================================================
// CAMPUS NEWS, THE URGENT BANNER AND FEATURED (2026-09-24)
// ============================================================
// Built from the approved Home design. Three sources, one list:
//  - club posts (org_posts) from the clubs you follow — announcements and polls, pinned first;
//  - official announcements (broadcasts) written by admins — everyone at the school sees them;
//  - listings an admin has pinned, as the Featured row.
// And at most ONE urgent banner above everything: an official broadcast of type 'warning'
// (the admin form calls it Urgent), or a club post marked urgent by a club you follow. It lasts
// until its end date, or 3 days when it has none, and dismissing it hides it on this device —
// after which it sits in Campus news like any other post.
//
// This replaces the thin broadcast bar that used to run across the top of every page.
//
// Who sees what is decided by the database, not here: members-only posts reach members only
// (org_posts RLS), and poll results arrive only after you have voted (poll_votes RLS). So a
// student who has not voted cannot know the tally — the card says "results show after you
// vote" instead of a vote count, because the count is not ours to show them yet.

const FEED_URGENT_DAYS = 3;       // an urgent post with no end date leaves the banner after this
const FEED_NEWS_DAYS = 30;        // club posts older than this are the club page's business
const FEED_OFFICIAL_DAYS = 14;    // an official card with no end date leaves Home after this
const FEED_CLOSED_POLL_DAYS = 3;  // a closed poll leaves Home this long after it closes
const FEED_NEWS_SHOWN = 3;        // cards before "See all"
const FEED_DISMISS_KEY = 'cn_dismissed_bcast';  // the old bar's key, so a banner dismissed there stays dismissed

let _feedNews = [];               // [{ key, kind:'club'|'official', ... }] — see feedLoadNews
let _feedUrgent = null;           // the one item in the banner, or null
let _feedNewsAll = false;         // "See all" pressed
let _feedRevote = new Set();      // poll ids whose "Change my vote" is open
let _feedMe = null;               // the signed-in user's id, for "is this my vote"

const _feedDay = 864e5;

function feedDismissed() {
  try { return JSON.parse(localStorage.getItem(FEED_DISMISS_KEY) || '[]'); } catch (e) { return []; }
}

// "5m", "2h", "3d", then a date. Short, because it sits in a line with the club's name.
function feedAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 6e4));
  if (m < 60) return (m || 1) + 'm';
  if (m < 1440) return Math.round(m / 60) + 'h';
  if (m < 10080) return Math.round(m / 1440) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function feedClosesLabel(ts) {
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return 'closed ' + new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const h = ms / 36e5;
  if (h < 1) return 'closes within the hour';
  if (h < 24) return `closes in ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `closes in ${d} day${d === 1 ? '' : 's'}`;
}

function feedPollClosed(item) {
  return !!(item.closesAt && new Date(item.closesAt).getTime() <= Date.now());
}

// Loads all three sources. Needs the club directory already loaded (the follow set, and each
// club's name and logo), which is why renderFeed calls it after loadOrgDirectory.
async function feedLoadNews() {
  const eu = getEffectiveUser();
  const { data: { session } } = await supabaseClient.auth.getSession();
  _feedMe = session?.user?.id || null;
  const now = new Date();
  const nowIso = now.toISOString();
  const follows = [..._dirFollows];

  const [postsRes, bcastRes] = await Promise.all([
    follows.length
      ? supabaseClient.from('org_posts')
          .select('id, org_id, type, title, body, is_pinned, is_urgent, members_only, poll_closes_at, created_at')
          .in('org_id', follows).eq('status', 'published')
          .gte('created_at', new Date(now - FEED_NEWS_DAYS * _feedDay).toISOString())
          .order('created_at', { ascending: false }).limit(40)
      : Promise.resolve({ data: [] }),
    // The same rule the old bar used: sent, or scheduled and its time has come; not expired.
    // display_type 'notification' was never meant for the page, so it stays off Home too.
    supabaseClient.from('broadcasts')
      .select('id, subject, body, type, display_type, school, landing_title, landing_body, created_at, scheduled_at, expires_at')
      .in('status', ['sent', 'scheduled'])
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: false }).limit(20),
  ]);
  if (postsRes.error) console.error('[feedLoadNews posts]', postsRes.error);
  if (bcastRes.error) console.error('[feedLoadNews broadcasts]', bcastRes.error);

  const posts = postsRes.data || [];
  const pollIds = posts.filter(p => p.type === 'poll').map(p => p.id);
  let options = [], votes = [];
  if (pollIds.length) {
    const [o, v] = await Promise.all([
      supabaseClient.from('poll_options').select('id, post_id, label, position').in('post_id', pollIds).order('position'),
      supabaseClient.from('poll_votes').select('post_id, option_id, user_id').in('post_id', pollIds),
    ]);
    options = o.data || []; votes = v.data || [];
  }

  const orgs = new Map((_dirOrgs || []).map(o => [o.id, o]));
  const clubItems = posts.map(p => ({
    key: 'p' + p.id, kind: 'club', id: p.id, org: orgs.get(p.org_id) || { id: p.org_id, name: 'A club' },
    title: p.title, body: p.body, at: p.created_at, pinned: p.is_pinned, urgent: p.is_urgent,
    membersOnly: p.members_only, isPoll: p.type === 'poll', closesAt: p.poll_closes_at,
    options: options.filter(o => o.post_id === p.id),
    votes: votes.filter(v => v.post_id === p.id),
  }))
    // A closed poll stays a few days so its voters see the final result; one you never voted
    // in has nothing left to show you (the results were never yours to see), so it goes at once.
    .filter(x => {
      if (!x.isPoll || !feedPollClosed(x)) return true;
      const mine = x.votes.some(v => v.user_id === _feedMe);
      return mine && Date.now() - new Date(x.closesAt).getTime() < FEED_CLOSED_POLL_DAYS * _feedDay;
    });

  const officialItems = (bcastRes.data || [])
    .filter(b => !b.school || b.school === eu?.school)
    .filter(b => b.display_type !== 'notification')
    .map(b => ({
      key: String(b.id), kind: 'official', id: b.id, title: b.subject, body: b.body,
      at: b.scheduled_at || b.created_at, urgent: b.type === 'warning', expires: b.expires_at, raw: b,
    }))
    .filter(x => x.expires || Date.now() - new Date(x.at).getTime() < FEED_OFFICIAL_DAYS * _feedDay);
  officialItems.forEach(x => { _bcastCache[x.id] = x.raw; });   // openBcastLanding reads it

  // The banner: official first (it speaks for the school), then the newest club alarm.
  const dismissed = feedDismissed();
  const inWindow = x => x.expires ? true : Date.now() - new Date(x.at).getTime() < FEED_URGENT_DAYS * _feedDay;
  const urgent = [...officialItems, ...clubItems]
    .filter(x => x.urgent && inWindow(x) && !dismissed.includes(x.kind === 'club' ? x.key : String(x.id)));
  _feedUrgent = urgent[0] || null;

  // Pinned club posts first, then everything newest first. The banner's item is not repeated
  // below it; once dismissed it joins the list.
  const byDate = (a, b) => new Date(b.at) - new Date(a.at);
  const all = [...clubItems, ...officialItems].filter(x => x !== _feedUrgent);
  _feedNews = [...all.filter(x => x.pinned).sort(byDate), ...all.filter(x => !x.pinned).sort(byDate)];
}

function feedUrgentHTML() {
  const x = _feedUrgent;
  if (!x) return '';
  const who = x.kind === 'official' ? feedSchoolName() : x.org.name;
  const more = x.kind === 'official'
    ? (x.raw.landing_body ? `<button class="hu-more" onclick="openBcastLanding(_bcastCache['${escAttr(String(x.id))}'])">Read more</button>` : '')
    : `<button class="hu-more" onclick="orgPageOpen(${Number(x.org.id)})">Read more</button>`;
  return `
    <div class="home-urgent" role="alert">
      <span class="hu-icon">${icon('alert', 18)}</span>
      <div class="hu-text">
        <div class="hu-kicker">${esc(who)} · Urgent</div>
        <div class="hu-title">${esc(x.title)}</div>
        ${x.body || more ? `<div class="hu-body">${x.body ? esc(x.body) : ''} ${more}</div>` : ''}
      </div>
      <button class="hu-close" aria-label="Dismiss" onclick="feedDismissUrgent()">${icon('x', 15)}</button>
    </div>`;
}

function feedDismissUrgent() {
  const x = _feedUrgent;
  if (!x) return;
  const list = feedDismissed();
  list.push(x.kind === 'club' ? x.key : String(x.id));
  try { localStorage.setItem(FEED_DISMISS_KEY, JSON.stringify(list)); } catch (e) {}
  // Into Campus news with the rest, in date order.
  _feedUrgent = null;
  _feedNews.push(x);
  const byDate = (a, b) => new Date(b.at) - new Date(a.at);
  _feedNews = [..._feedNews.filter(n => n.pinned).sort(byDate), ..._feedNews.filter(n => !n.pinned).sort(byDate)];
  feedPaintNews();
}

function feedSchoolName() {
  const u = getEffectiveUser();
  return (_schoolsList || []).find(s => s.slug === u?.school)?.name || 'Your school';
}

// A poll on Home, in three moods (2026-09-24):
//   ASKING   the options, one tap each — "One tap · see what everyone picked right after"
//   JUST     the moment after voting: the results, with the bars growing in. For a few seconds.
//   SETTLED  voted (or closed): ONE line — what you picked and how it is going — that opens to
//            the full results on a tap. A poll you have answered should not keep its full height
//            in the feed; it is done, and the feed should say so and move on.
let _feedPollOpen = new Set();   // poll ids opened back up to full results
let _feedPollJust = new Set();   // poll ids voted on a moment ago (full results, animated)

function feedPollHTML(x) {
  const mine = x.votes.find(v => v.user_id === _feedMe) || null;
  const closed = feedPollClosed(x);
  const showResults = (mine && !_feedRevote.has(x.id)) || closed;
  const total = x.votes.length;

  if (!showResults) {
    return `
      <div class="hn-opts">
        ${x.options.map(o => `<button class="hn-opt${mine && mine.option_id === o.id ? ' is-mine' : ''}"
          onclick="feedVote(${x.id}, ${o.id})">${esc(o.label)}</button>`).join('')}
      </div>
      <div class="hn-foot">${x.membersOnly ? 'Only members see this' : 'One tap · see what everyone picked right after'}${
        mine ? ` · <button class="hn-link" onclick="feedRevote(${x.id}, false)">Keep my vote</button>` : ''}</div>`;
  }

  const counted = x.options.map(o => ({ o, n: x.votes.filter(v => v.option_id === o.id).length }));
  const byVotes = counted.slice().sort((a, b) => b.n - a.n);
  const top = byVotes.length ? byVotes[0].n : 0;
  const tie = byVotes.length > 1 && byVotes[1].n === top;
  const pctOf = n => (total ? Math.round(n / total * 100) : 0);
  const myOpt = mine ? x.options.find(o => o.id === mine.option_id) : null;

  // SETTLED: one line. What you picked, and where it stands — "you're with the majority" when you
  // are, because a poll that tells you something back is one people answer next time too.
  if (!_feedPollJust.has(x.id) && !_feedPollOpen.has(x.id)) {
    const lead = top > 0 && !tie ? byVotes[0] : null;
    let line;
    if (closed) {
      line = lead ? `Final: <b>${esc(lead.o.label)}</b> won with ${pctOf(lead.n)}%` : 'Final results: a tie';
      if (myOpt) line += ` · you picked ${esc(myOpt.label)}`;
    } else if (myOpt && lead && lead.o.id === myOpt.id) {
      line = `You voted <b>${esc(myOpt.label)}</b> · you're with the majority (${pctOf(lead.n)}%)`;
    } else if (myOpt && lead) {
      line = `You voted <b>${esc(myOpt.label)}</b> · ${esc(lead.o.label)} leads with ${pctOf(lead.n)}%`;
    } else {
      line = myOpt ? `You voted <b>${esc(myOpt.label)}</b> · it's close` : `${total} vote${total === 1 ? '' : 's'}`;
    }
    return `
      <button class="hn-poll-min" onclick="feedPollToggle(${x.id}, true)" aria-expanded="false">
        <span class="hn-poll-check">${icon(closed ? 'flag' : 'check', 13)}</span>
        <span class="hn-poll-line">${line}</span>
        <span class="hn-poll-more">${total} vote${total === 1 ? '' : 's'}${icon('chevDown', 14)}</span>
      </button>`;
  }

  const winner = closed && top > 0 && !tie;
  const rows = closed ? byVotes : counted;
  return `
    <div class="hn-results${_feedPollJust.has(x.id) ? ' is-fresh' : ''}">
      ${rows.map((c, i) => {
        const isMine = mine && mine.option_id === c.o.id;
        const lead = closed ? (winner && i === 0) : false;
        return `<div class="hn-res${isMine ? ' is-mine' : ''}${lead ? ' is-lead' : ''}">
          <span class="hn-bar" style="--pct:${pctOf(c.n)}%"></span>
          <span class="hn-res-label">${esc(c.o.label)}${isMine ? ' ✓' : ''}${lead ? ' · winner' : ''}</span>
          <span class="hn-res-pct">${pctOf(c.n)}%</span>
        </div>`;
      }).join('')}
    </div>
    <div class="hn-foot">${total} vote${total === 1 ? '' : 's'} · ${closed
      ? 'final results'
      : `<button class="hn-link" onclick="feedRevote(${x.id}, true)">Change my vote</button>`}
      · <button class="hn-link" onclick="feedPollToggle(${x.id}, false)">Done</button></div>`;
}

function feedPollToggle(id, open) {
  _feedPollJust.delete(id);
  if (open) _feedPollOpen.add(id); else _feedPollOpen.delete(id);
  feedPaintNews();
}

function feedNewsCardHTML(x) {
  let head;
  if (x.kind === 'official') {
    head = `<span class="hn-logo hn-logo-official">${icon('school', 16)}</span>
      <span class="hn-who"><b>${esc(feedSchoolName())}</b> <span class="hn-official">· Official</span> <span class="hn-meta">· ${esc(feedAgo(x.at))}</span></span>`;
  } else {
    const meta = x.isPoll ? `Poll · ${x.closesAt ? feedClosesLabel(x.closesAt) : feedAgo(x.at)}` : feedAgo(x.at);
    head = `<span class="hn-org" onclick="orgPageOpen(${Number(x.org.id)})">${_dirLogoHTML(x.org, 'hn-logo')}</span>
      <span class="hn-who"><b class="hn-org" onclick="orgPageOpen(${Number(x.org.id)})">${esc(x.org.name)}</b> <span class="hn-meta">· ${esc(meta)}</span></span>
      ${x.membersOnly ? `<span class="hn-badge hn-badge-members">${icon('lock', 11)}Members</span>` : ''}
      ${x.pinned ? `<span class="hn-badge hn-badge-pin">${icon('star', 11)}Pinned</span>` : ''}`;
  }
  // Long text stops at three lines; a tap on it opens the rest in place.
  const body = x.body
    ? `<div class="hn-body" onclick="this.classList.toggle('is-open')">${esc(x.body)}</div>` : '';
  const more = x.kind === 'official' && x.raw.landing_body
    ? `<button class="hn-link hn-read" onclick="openBcastLanding(_bcastCache['${escAttr(String(x.id))}'])">Read more</button>` : '';
  return `
    <article class="hn-card${x.kind === 'official' ? ' hn-card-official' : ''}" id="hn-${escAttr(x.key)}">
      <div class="hn-head">${head}</div>
      <div class="hn-title">${esc(x.title)}</div>
      ${body}${more}
      ${x.isPoll ? feedPollHTML(x) : ''}
    </article>`;
}

function feedPaintNews() {
  const urgent = document.getElementById('homeUrgent');
  if (urgent) urgent.innerHTML = feedUrgentHTML();
  const host = document.getElementById('homeNews');
  if (!host) return;
  const top = host.closest('.home-top');
  if (!_feedNews.length) { host.innerHTML = ''; top?.classList.remove('has-news'); return; }
  top?.classList.add('has-news');
  const shown = _feedNewsAll ? _feedNews : _feedNews.slice(0, FEED_NEWS_SHOWN);
  const extra = _feedNews.length - FEED_NEWS_SHOWN;
  host.innerHTML = feedSection('Campus news',
    extra > 0 ? (_feedNewsAll ? 'Show less' : 'See all') : '', extra > 0 ? 'feedToggleNews()' : '',
    `<div class="hn-list">${shown.map(feedNewsCardHTML).join('')}</div>`);
  const chips = document.getElementById('homeChips');
  if (chips) chips.innerHTML = feedChipsHTML();
}

function feedToggleNews() { _feedNewsAll = !_feedNewsAll; feedPaintNews(); }
function feedGoNews() { document.getElementById('homeNews')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function feedRevote(postId, open) {
  if (open) _feedRevote.add(postId); else _feedRevote.delete(postId);
  feedPaintNews();
}

// One vote per person per poll: an upsert on (post_id, user_id), so voting again changes your
// answer. Then this poll's votes are fetched again — now that you have voted, RLS lets you see
// everyone's, which is the moment the results appear.
async function feedVote(postId, optionId) {
  const x = _feedNews.find(n => n.kind === 'club' && n.id === postId);
  if (!x || !_feedMe) { requireAuth?.(); return; }
  if (feedPollClosed(x)) { toast('This poll has closed'); return; }
  const { error } = await supabaseClient.from('poll_votes')
    .upsert({ post_id: postId, option_id: optionId, user_id: _feedMe }, { onConflict: 'post_id,user_id' });
  if (error) { toast('Could not record your vote'); console.error('[feedVote]', error); return; }
  const { data } = await supabaseClient.from('poll_votes').select('post_id, option_id, user_id').eq('post_id', postId);
  x.votes = data || [{ post_id: postId, option_id: optionId, user_id: _feedMe }];
  _feedRevote.delete(postId);
  _feedPollOpen.delete(postId);
  // The results grow in for a few seconds, then the card settles into its one-line summary.
  _feedPollJust.add(postId);
  feedPaintNews();
  setTimeout(() => { if (_feedPollJust.delete(postId)) feedPaintNews(); }, 4000);
}

// Listings an admin has pinned. They also lead the Marketplace; here they get their own row.
function feedFeaturedHTML() {
  const pins = browseItems().filter(isListingLive).filter(l => l.pinned)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  if (!pins.length) return '';
  return feedSection('Featured', 'Browse all', "showPage('listings')", `
    <div class="home-row home-market home-featured">
      ${pins.map(l => listingCardHTML(l, true)).join('')}
    </div>`);
}

// The open beta, said where every student lands (2026-09-25): one quiet line under the greeting,
// with the two things a tester needs — where to report a problem, and what "beta" means for them
// (the Terms' beta section). Always there rather than dismissible: a beta notice you can close is
// one a student can say they never saw.
function feedBetaHTML() {
  return `
    <p class="home-beta">
      <span class="home-beta-tag">Open beta</span>
      <span class="home-beta-text">Everything here is real — the people, listings and plans. Something broken?
        <a href="mailto:amahledigitalcreatives@gmail.com?subject=Nestrel%20beta%20feedback">Tell us</a>
        · <a href="terms.html#beta" target="_blank" rel="noopener">What this means</a></span>
    </p>`;
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
        ${feedBetaHTML()}
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
  // then clubs, then Campus news). Holding the page back for the slowest part would make all of
  // it feel slow. Two club slots, because where the section goes depends on how many clubs you
  // follow — which is only known once the directory has loaded.
  //
  // .home-top is two columns on a wide screen — Campus news, and beside it Up next and This week.
  // On a phone it dissolves (display:contents) and CSS `order` stacks every slot in the design's
  // order: urgent, Up next, Campus news, Featured, This week, Fresh on the Market.
  body.innerHTML = hero + '<div id="homeUrgent"></div><div id="homeRate"></div><div id="homeClubsTop"></div>'
    + '<div class="home-top"><div id="homeNews"></div>'
    + '<aside class="home-aside"><div id="homeUpNext"></div><div id="feedEvents"></div></aside></div>'
    + `<div id="homeFeatured">${feedFeaturedHTML()}</div><div id="homeRecaps"></div>`
    + `<div id="homeMarket">${market}</div><div id="homeClubsBottom"></div>`;
  feedPaintNews();   // anything already loaded from a previous visit, straight away

  const res = await loadEvents();
  // Silence is right for a failure here: the rest of Home is already on screen and useful.
  if (res.ok) {
    const chips = document.getElementById('homeChips');
    if (chips) chips.innerHTML = feedChipsHTML();          // now counts today's events too
    const upNext = document.getElementById('homeUpNext');
    if (upNext) upNext.innerHTML = feedUpNextHTML();
    // The feedback loop's prompt: the last event you checked into that still wants a rating, with
    // the stars and an optional comment right here (evPendingRatingHTML in events.js).
    evPendingRatingHTML().then(html => {
      const rate = document.getElementById('homeRate');
      if (rate) rate.innerHTML = html;
    });
    // Recaps from recent events: photo tiles from what clubs shared after their events, in a short
    // sideways row like Fresh on the Market (evRecentRecapList in events.js — school-wide, so a
    // student also meets clubs they do not follow yet). Tapping one opens the event, recap first.
    const recaps = document.getElementById('homeRecaps');
    const rows = typeof evRecentRecapList === 'function' ? evRecentRecapList() : [];
    if (recaps) recaps.innerHTML = rows.length ? feedSection(EV_RECAPS_TITLE, '', '',
      `<div class="home-row home-recaps">${rows.map(([e]) => evPastTileHTML(e)).join('')}</div>`) : '';
    const soon = feedUpcoming();
    const slot = document.getElementById('feedEvents');
    if (slot && soon.length) slot.innerHTML = feedSection('Happening this week', 'All events', "showPage('events')",
      `<div class="feed-events">${soon.map(e => feedEventCardHTML(e)).join('')}</div>`);
  }

  if (await loadOrgDirectory() !== true) return;
  const followsNone = _dirFollows.size === 0;
  const clubsSlot = document.getElementById(followsNone ? 'homeClubsTop' : 'homeClubsBottom');
  if (clubsSlot) clubsSlot.innerHTML = feedClubsHTML(followsNone);

  await feedLoadNews();
  feedPaintNews();
}
