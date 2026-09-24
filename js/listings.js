// ============================================================
// LISTINGS
// The browse feed: pages, mobile chrome, filters, listing cards, the detail modal, owner lifecycle actions, and posting a listing.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ============================================================
// STUDENT — PAGES & LISTINGS
// ============================================================
function showPage(name) {
  // Navigating anywhere else must exit conversation mode, or the full-screen
  // chat overlay would keep covering the new page with the chrome hidden.
  if (name !== 'messages' && document.body.classList.contains('chat-open')) closeConvo();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (name !== 'maintenance') sessionStorage.setItem('cn_last_page', name);
  if (name === 'messages') { renderConvos(); markActiveConvoSeen(); } // returning to an already-open thread reads it; badges come from refreshUnread (DB)
  if (name === 'profile') renderProfile();
  if (name === 'listings') { renderListings(); renderDeepFilters(); }
  // Same shape as messages and events: page-feed is an empty shell until renderFeed()
  // fills it, so a bare showPage() would restore a page that looks like a feed with
  // nothing in it.
  if (name === 'feed') renderFeed();
  // Same shape as messages and profile above: page-events is an empty div until renderEvents()
  // fills it, so a bare showPage() would restore a page that looks like a feed with nothing
  // in it. boot.js's page restore needs the same line for the same reason.
  if (name === 'events') renderEvents();
  if (name === 'search') renderSearch();
  updateMTabbar(name);
  document.querySelector('.s-nav')?.classList.remove('m-hidden'); // navigating always reveals the top bar
  if (window.innerWidth <= 768) window.scrollTo(0, 0); // app-style: each page opens at its top
}

// The Home tab. The question here is "does this device know you?" — the same question
// boot and logout ask — NOT "are you signed in this second". A student who logged out is
// still a student: the "Join us" landing has nothing left to tell them, so their home base
// stays the live feed. Only a genuine stranger gets the pitch.
//
// Deliberately does NOT re-open the login modal. It has already been offered at logout and
// at app open; popping it again on every Home tap reads as the app refusing to let you
// browse. The wordmark in the top bar remains the way back to the landing page.
function goHome() {
  const known = getEffectiveUser() || getPriorUser();
  // Home is its own page now. It used to be the marketplace grid, which made Home and
  // Market the same screen with a different tab lit — the thing this bar is being fixed
  // to stop. Strangers still get the landing page: they have nothing to have a feed of.
  showPage(known ? 'feed' : 'home');
}

// Search is its own page since 2026-09-08. It used to show page-listings — the same screen
// Home shows — so two of the five bottom tabs did the same thing and only the highlight
// differed. That is the costume Events was in before it got its own section.
function goSearch(focus = true) {
  // Arriving with the cursor already in the box. Somebody who taps a search control has
  // decided to type — asking them to tap a second time inside the page they just opened is a
  // tap that carries no decision. renderSearch() does the focusing, because the input does
  // not exist until it has painted.
  _sqAutoFocus = focus;
  showPage('search');
}

// Highlights the mobile bottom-bar tab matching the current page. A plain name match
// now: every tab has its own page, so nothing has to be inferred from what the student
// last tapped.
function updateMTabbar(name) {
  const tabId = (name === 'home' || name === 'feed') ? 'mtab-home'
    : name === 'listings' ? 'mtab-market'
    : name === 'events'   ? 'mtab-events'
    : name === 'profile'  ? 'mtab-you'
    : null; // search, messages, org pages: reached from the top bar, so no tab lights
  document.querySelectorAll('#mTabbar .m-tab').forEach(t => t.classList.toggle('active', t.id === tabId));
  // The desktop sidebar marks the page you are on too. Its items name their page in data-page;
  // Home is 'feed' for a signed-in student, and the landing page counts as Home.
  const current = name === 'home' ? 'feed' : name;
  document.querySelectorAll('#navUser [data-page]').forEach(b => b.classList.toggle('is-current', b.dataset.page === current));
}


// One source of truth for the unread-message count on both the desktop nav badge
// and the mobile Messages tab badge.
function updateMsgBadges() {
  const show = sUnreadCount > 0;
  ['msgBadge'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.textContent = sUnreadCount; b.style.display = show ? 'inline' : 'none'; }
  });
}

// ── Mobile top bar hide-on-scroll (≤768px only) ─────────────
// Scrolling down tucks the bar away; any scroll up brings it back; it is always
// visible near the very top. The messages page is naturally exempt because it
// scrolls inside its own panes, not the window.
(function initTopbarHideOnScroll() {
  const MOBILE_MAX = 768;  // must match the styles.css media query
  const JITTER = 6;        // ignore scroll wiggle smaller than this (px)
  const MIN_HIDE_Y = 80;   // never hide within this distance of the top
  const nav = document.querySelector('.s-nav');
  if (!nav) return;
  let lastY = Math.max(0, window.scrollY);
  window.addEventListener('scroll', () => {
    if (window.innerWidth > MOBILE_MAX) return;
    const y = Math.max(0, window.scrollY);  // iOS rubber-banding can report negative values
    const dy = y - lastY;
    if (Math.abs(dy) < JITTER) return;
    if (y <= 8) nav.classList.remove('m-hidden');
    else if (dy > 0 && y > MIN_HIDE_Y) nav.classList.add('m-hidden');
    else if (dy < 0) nav.classList.remove('m-hidden');
    lastY = y;
  }, { passive: true });
})();

function requireAuth(action) {
  if (!getEffectiveUser()) { openModal('loginModal'); return false; }
  if (action === 'postListing') openModal('postModal');
  return true;
}

// Restores the filters a refresh would otherwise throw away: the category you were browsing,
// what you had typed, the sort and the scope. Called once from boot before the first paint.
//
// Chip state and the input's value are set here too. _filters alone would filter correctly and
// LOOK wrong — the grid showing housing while every chip says "All" is worse than not
// restoring at all, because the student cannot tell why the results are narrow.
function restoreListingFilters() {
  const f = loadUiState('filters');
  if (!f) return;
  Object.assign(_filters, f);

  // The KEYWORD is deliberately not restored, and is dropped if an older session saved one.
  // Browse lost its search box on 2026-09-09 — the query belongs to the search page now, in
  // _sqQuery. A keyword restored here would narrow the feed with no box to show it in, and
  // the only way out would be a tag most people would not connect to a search they made
  // yesterday. Filters are a preference and are shared; a query is a question asked once.
  _filters.keyword = '';

  document.querySelectorAll('#sCategoryChips .cat-pill').forEach(c =>
    c.classList.toggle('active', c.dataset.cat === (_filters.category || 'all')));
  renderDeepFilters();
}

// Builds the category strip once, then keeps the highlight in step with _filters.category.
// Rebuilding on every render would be cheap enough, but it would also throw away the button
// the student just tapped mid-click.
function renderCategoryChips() {
  const wrap = document.getElementById('sCategoryChips');
  if (!wrap) return;
  if (!wrap.children.length) {
    // "All" carries no icon on purpose — it is not a category, it is the absence of one, and
    // giving it a glyph would make it look like a seventh thing to choose between.
    wrap.innerHTML = [['all', 'All'], ...BROWSE_CATEGORIES.map(c => [c, catShort(c)])]
      .map(([v, label]) => `<button class="cat-pill" data-cat="${v}" onclick="setListingCat('${v}',this)">` +
        (v === 'all' ? '' : catIcon(v, 14)) + `<span>${esc(label)}</span></button>`)
      .join('');
  }
  const active = _filters.category || 'all';
  wrap.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === active));
  // Bring the selected pill into view. Restoring a saved category would otherwise leave the
  // highlight somewhere off the right edge, on a row whose scroll position starts at zero.
  wrap.querySelector('.cat-pill.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setListingCat(cat, el) {
  _filters.category = cat;
  _filters.details = {};  // clear category-specific filters on category switch
  // The highlight is not set here. renderListings() below calls renderCategoryChips(), which
  // derives it from _filters.category — one place that decides, instead of four that guess.
  renderDeepFilters();
  renderListings();
}
function clearListingCat() {
  _filters.category = 'all';
  _filters.details = {};
  renderDeepFilters();
  renderListings();
}
function clearListingKeyword() {
  _filters.keyword = '';
  const el = document.getElementById('listingSearch'); if (el) el.value = '';
  renderListings();
}
function clearListingFilters() {
  _filters.category = 'all'; _filters.keyword = ''; _filters.schoolScope = '25mi'; _filters.sort = 'newest';
  const el = document.getElementById('listingSearch'); if (el) el.value = '';
  clearDeepFilters(false);
  renderDeepFilters();
  renderListings();
}

function clearDeepFilters(rerender = true) {
  _filters.minPrice = null; _filters.maxPrice = null; _filters.details = {};
  if (rerender) { renderDeepFilters(); renderListings(); }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function schoolsInScope() {
  const scope = _filters.schoolScope;
  if (scope === 'all') return null;
  const eu = getEffectiveUser();
  const mySlug = eu?.school || null;
  if (scope === 'mine') return mySlug ? new Set([mySlug]) : null;
  const radiusMi = scope === '10mi' ? 10 : 25;
  const mySchool = mySlug ? _schoolsList.find(s => s.slug === mySlug) : null;
  if (!mySchool?.lat) return null; // no coords for my school → show all
  const slugs = new Set();
  if (mySlug) slugs.add(mySlug); // always include my school
  _schoolsList.forEach(s => {
    if (s.lat && haversineDistance(mySchool.lat, mySchool.lng, s.lat, s.lng) <= radiusMi) slugs.add(s.slug);
  });
  return slugs;
}

function setSchoolScope(scope) {
  _filters.schoolScope = scope;
  renderDeepFilters();
  renderListings();
}

function setSort(sort) {
  _filters.sort = sort;
  renderDeepFilters();
  renderListings();
}

const SORT_LABELS = { newest: 'Newest first', price_asc: 'Price: low to high', price_desc: 'Price: high to low', closest: 'Closest to campus' };

// Sorts a filtered listing array per _filters.sort (does not mutate the input).
function sortListings(arr) {
  const s = _filters.sort || 'newest';
  const copy = [...arr];
  if (s === 'price_asc')  copy.sort((a, b) => (a.rent || 0) - (b.rent || 0));
  else if (s === 'price_desc') copy.sort((a, b) => (b.rent || 0) - (a.rent || 0));
  else if (s === 'closest') {
    const eu = getEffectiveUser();
    const mine = eu?.school ? _schoolsList.find(x => x.slug === eu.school) : null;
    const dist = l => {
      const ts = _schoolsList.find(x => x.slug === l.school);
      if (!mine?.lat || !ts?.lat) return Infinity;
      return haversineDistance(mine.lat, mine.lng, ts.lat, ts.lng);
    };
    copy.sort((a, b) => dist(a) - dist(b));
  }
  // 'newest' = keep incoming order (DB.listings is already created_at desc)
  return copy;
}

let _drawerTouchStartY = 0;

function _drawerEscHandler(e) { if (e.key === 'Escape') closeFilterDrawer(); }

// Which button opened the drawer, so closing can hand focus back to it. Two buttons now
// open this one drawer — the Marketplace's own and the one search.js renders onto the Search
// page — and they are never both on screen. Sending focus to a fixed id would drop it onto an
// element inside a hidden page for whichever route did not match.
let _drawerOpener = null;

function openFilterDrawer(openerEl) {
  renderDeepFilters();
  const drawer   = document.getElementById('filterDrawer');
  const backdrop = document.getElementById('filterDrawerBackdrop');
  if (!drawer) return;
  // The event's own target when available; the Search button by name otherwise, which keeps
  // the old programmatic callers behaving exactly as before.
  _drawerOpener = openerEl || (typeof event !== 'undefined' && event?.currentTarget) || document.getElementById('filtersBtn');
  backdrop.classList.add('open');
  drawer.classList.add('open');
  _drawerOpener?.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', _drawerEscHandler);
  document.querySelector('.filter-drawer-close')?.focus();
  // Swipe-to-close on the grip
  const grip = document.getElementById('filterDrawerGrip');
  if (grip && !grip._swipeReady) {
    grip._swipeReady = true;
    grip.addEventListener('touchstart', e => { _drawerTouchStartY = e.touches[0].clientY; drawer.style.transition = 'none'; }, { passive: true });
    grip.addEventListener('touchmove', e => {
      const dy = Math.max(0, e.touches[0].clientY - _drawerTouchStartY);
      drawer.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    grip.addEventListener('touchend', e => {
      drawer.style.transition = '';
      drawer.style.transform = '';
      if (e.changedTouches[0].clientY - _drawerTouchStartY > 80) closeFilterDrawer();
    });
  }
}

function closeFilterDrawer() {
  const drawer   = document.getElementById('filterDrawer');
  const backdrop = document.getElementById('filterDrawerBackdrop');
  if (!drawer) return;
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  _drawerOpener?.classList.remove('open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _drawerEscHandler);
  // Only if it is still on screen. A button on a page that has since been hidden cannot take
  // focus, and asking it to would leave focus on <body> with no visible ring at all.
  if (_drawerOpener?.offsetParent) _drawerOpener.focus();
  _drawerOpener = null;
}


function setDeepFilter(key, val) {
  if (_filters.details[key] === val) {
    delete _filters.details[key];
  } else {
    _filters.details[key] = val;
  }
  renderDeepFilters();
  renderListings();
}

function setDeepDate(key, val) {
  if (val) _filters.details[key] = val;
  else delete _filters.details[key];
  renderListings();
}




// ============================================================
// THE FILTER PANEL (2026-09-24)
// ============================================================
// One panel, two homes. On a desktop Marketplace it is docked to the left of the listings
// (#mkFilterRail) and every change applies at once, so a student refines while browsing and can
// open listings without closing anything. On a phone — and wherever the rail is not showing (the
// Search page, a narrow window, a student who hid it) — it lives in the bottom sheet
// (#filterDrawerBody), whose "Show N listings" button closes it.
// ONE host holds the panel at a time: its inputs have ids (the price slider, the course box), and
// two copies in the document would leave getElementById answering for the hidden one.
//
// Each control fits the kind of choice, instead of a pill for everything:
//   pick one  -> a list with radio dots, "Any" first     (category, room type, distance, lease)
//   a number  -> one segmented bar, "Any | 1+ | 2+"      (bedrooms, bathrooms, size)
//   pick many -> checkboxes                              (housing amenities)
//   a range   -> the slider plus Min / Max boxes you can type in
// Sections collapse, and each header names its current choice, so a closed section still says
// what it is doing. Sort is not a filter — it only reorders — so on the Marketplace it is a menu
// above the grid (#mkSort). The sheet keeps a Sort section on the Search page, which has no menu.
const FX_RAIL_MQ = window.matchMedia('(min-width: 1024px)');
const FX_RAIL_KEY = 'cn_filters_rail';     // a device preference, so localStorage (see utils.js)
let _fxOpen = { scope: false, sort: false };   // sections not listed here start open

function fxRailHidden() {
  try { return localStorage.getItem(FX_RAIL_KEY) === 'hidden'; } catch (e) { return false; }
}
function fxRailActive() {
  return FX_RAIL_MQ.matches && !fxRailHidden()
    && !!document.getElementById('page-listings')?.classList.contains('active');
}
function fxSetRail(hidden) {
  try { localStorage.setItem(FX_RAIL_KEY, hidden ? 'hidden' : 'shown'); } catch (e) { /* private mode */ }
  renderDeepFilters();
}
// The Marketplace's filter button: on a desktop it brings a hidden rail back; on a phone it
// opens the sheet.
function mkFiltersClick(btn) {
  if (FX_RAIL_MQ.matches) fxSetRail(false); else openFilterDrawer(btn);
}

function renderDeepFilters() {
  if (!renderDeepFilters._wired) {   // crossing the desktop breakpoint moves the panel
    renderDeepFilters._wired = true;
    FX_RAIL_MQ.addEventListener('change', () => { closeFilterDrawer(); renderDeepFilters(); });
  }
  const rail  = document.getElementById('mkFilterRail');
  const sheet = document.getElementById('filterDrawerBody');
  const useRail = !!rail && fxRailActive();
  const host  = useRail ? rail : sheet;
  const other = useRail ? sheet : rail;
  if (other) other.innerHTML = '';
  document.getElementById('page-listings')?.classList.toggle('rail-on', useRail);
  if (!host) return;

  const cat = _filters.category;
  // The price slider's top end: the dearest live listing in this category, rounded up.
  const catListings = browseItems().filter(l => isListingLive(l) && (cat === 'all' || l.category === cat));
  const prices = catListings.map(l => l.rent || 0).filter(p => p > 0);
  _pMax = prices.length ? Math.ceil(Math.max(...prices) / 50) * 50 : 2000;
  _pMax = Math.max(_pMax, 100);

  const onSearch = document.getElementById('page-search')?.classList.contains('active');
  host.innerHTML = (useRail ? fxRailHeadHTML() : '')
    + fxCategoryHTML() + fxDetailsHTML(cat) + fxPriceHTML(cat) + fxScopeHTML()
    + (!useRail && onSearch ? fxSortHTML() : '');
  if (cat === 'books') attachDrawerCourseAC(); // typeahead needs a live DOM node — attach after innerHTML
}

// How many panel filters are on (scope, price, category details, sort) — the same count the
// filter button's badge shows.
function fxActiveCount() {
  return (_filters.schoolScope !== '25mi' ? 1 : 0)
    + ((_filters.minPrice !== null || _filters.maxPrice !== null) ? 1 : 0)
    + Object.keys(_filters.details).length + (_filters.category !== 'all' ? 1 : 0);
}

function fxRailHeadHTML() {
  return `<div class="fx-rail-head">
    <span class="fx-rail-title">Filters</span>
    ${fxActiveCount() ? `<button class="fx-link" onclick="clearListingFilters()">Clear all</button>` : ''}
    <button class="fx-icon-btn" onclick="fxSetRail(true)" aria-label="Hide filters" title="Hide filters">${icon('chevRight', 16)}</button>
  </div>`;
}

function fxSection(id, title, summary, body) {
  const open = _fxOpen[id] !== false;
  return `<section class="fx-sec${open ? ' is-open' : ''}">
    <button class="fx-head" onclick="fxToggle('${id}')" aria-expanded="${open}">
      <span class="fx-title">${esc(title)}</span>
      <span class="fx-sum">${summary ? esc(summary) : ''}</span>
      <span class="fx-chev">${icon('chevDown', 16)}</span>
    </button>
    <div class="fx-body"${open ? '' : ' hidden'}>${body}</div>
  </section>`;
}
function fxToggle(id) { _fxOpen[id] = _fxOpen[id] === false; renderDeepFilters(); }

// A pick-one list. opts: [value, label, count?, iconHTML?]; value '' is "Any".
function fxRadioList(opts, current, pick) {
  return `<div class="fx-list" role="radiogroup">${opts.map(([v, label, n, ic]) => {
    const on = String(current ?? '') === String(v);
    const action = pick(v);   // built first: the markup should only ever hold a finished handler
    return `<button class="fx-opt${on ? ' is-on' : ''}" role="radio" aria-checked="${on}" onclick="${action}">`
      + `<span class="fx-dot" aria-hidden="true"></span>${ic ? `<span class="fx-ic">${ic}</span>` : ''}`
      + `<span class="fx-opt-l">${esc(label)}</span>${n !== undefined ? `<span class="fx-n">${n}</span>` : ''}</button>`;
  }).join('')}</div>`;
}
// One segmented bar for short, ordered choices.
function fxSeg(opts, current, pick) {
  return `<div class="fx-seg" role="radiogroup">${opts.map(([v, label]) => {
    const on = String(current ?? '') === String(v);
    const action = pick(v);
    return `<button class="${on ? 'is-on' : ''}" role="radio" aria-checked="${on}" onclick="${action}">${esc(label)}</button>`;
  }).join('')}</div>`;
}

// Set (or with '' clear) one category-detail filter.
function fxSet(key, val) {
  if (val === '' || val === null || val === undefined) delete _filters.details[key];
  else _filters.details[key] = val;
  renderDeepFilters();
  renderListings();
}

function fxCategoryHTML() {
  const live = browseItems().filter(isListingLive);
  const count = c => c === 'all' ? live.length : live.filter(l => l.category === c).length;
  const opts = [['all', 'All listings', count('all')],
    ...BROWSE_CATEGORIES.map(c => [c, CATEGORY_LABELS[c] || catShort(c), count(c), catIcon(c, 15)])];
  const cur = _filters.category || 'all';
  return fxSection('cat', 'Category', cur === 'all' ? '' : (CATEGORY_LABELS[cur] || cur),
    fxRadioList(opts, cur, v => `setListingCat('${v}')`));
}

function fxDetailsHTML(cat) {
  const d = _filters.details;
  const n = Object.keys(d).length;
  const summary = n ? `${n} selected` : '';
  const any = [['', 'Any']];
  if (LISTING_SPECS[cat]) {
    let body = LISTING_SPECS[cat].filter(s => s.filter).map(s => {
      const pick = v => `fxSet('${s.key}','${escAttr(v)}')`;
      const opts = any.concat(s.filterLabels || s.options);
      const ctl = s.filter === 'by'
        ? `<input type="date" class="fx-input fx-date" id="df-${s.key}" value="${escAttr(d[s.key] || '')}" onchange="fxSet('${s.key}',this.value)">`
        : (s.control === 'seg' || s.filter === 'atleast')
          ? fxSeg(opts, d[s.key], pick)
          : fxRadioList(opts, d[s.key], pick);
      return `<div class="fx-field"><label class="fx-label"${s.filter === 'by' ? ` for="df-${s.key}"` : ''}>${esc(s.filterLabel || s.label)}</label>${ctl}</div>`;
    }).join('');
    if (cat === 'housing') {
      body += `<div class="fx-field"><div class="fx-label">Includes</div><div class="fx-checks">${HOUSING_AMENITIES.map(([k, , label]) =>
        `<button class="fx-opt fx-check${d[k] ? ' is-on' : ''}" role="checkbox" aria-checked="${!!d[k]}" onclick="setDeepFilter('${k}','yes')">`
        + `<span class="fx-box" aria-hidden="true">${icon('check', 12)}</span><span class="fx-opt-l">${esc(label)}</span></button>`).join('')}</div></div>`;
    }
    return fxSection('details', `${CATEGORY_LABELS[cat] || cat} details`, summary, body);
  }
  if (cat === 'books') {
    const editions = [...new Set(_books.map(b => (b.edition || '').trim()).filter(Boolean))].sort();
    const body = `
      <div class="fx-field"><div class="fx-label">Book type</div>${fxRadioList([['', 'Any'], ['course', 'Textbooks'], ['other', 'Other books']], d.bookType, v => `fxSet('bookType','${v}')`)}</div>
      <div class="fx-field"><label class="fx-label" for="dfCourseInput">Course</label>
        <div class="fx-course"><input class="fx-input" id="dfCourseInput" placeholder="e.g. NU 301" autocomplete="off" value="${escAttr(d.courseCode || '')}">
        <div class="course-ac-list" id="dfCourseList" hidden></div></div></div>
      ${editions.length ? `<div class="fx-field"><label class="fx-label" for="dfEdition">Edition</label>
        <select class="fx-input" id="dfEdition" onchange="setDeepEdition(this.value)"><option value="">Any edition</option>
        ${editions.map(e => `<option${d.edition === e ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select></div>` : ''}`;
    return fxSection('details', 'Book details', summary, body);
  }
  return '';
}

function fxPriceHTML(cat) {
  const curMin = _filters.minPrice || 0;
  const curMax = _filters.maxPrice !== null ? _filters.maxPrice : _pMax;
  const fillLeft  = (curMin / _pMax * 100).toFixed(1) + '%';
  const fillWidth = ((curMax - curMin) / _pMax * 100).toFixed(1) + '%';
  const set = _filters.minPrice !== null || _filters.maxPrice !== null;
  const summary = set ? `$${_filters.minPrice || 0} – ${_filters.maxPrice !== null ? '$' + _filters.maxPrice : 'any'}` : '';
  return fxSection('price', cat === 'housing' ? 'Monthly rent' : 'Price', summary, `
    <div class="price-range-wrap fx-range">
      <div class="price-range-track"><div class="price-range-fill" id="priceRangeFill" style="left:${fillLeft};width:${fillWidth}"></div></div>
      <input type="range" id="priceMin" min="0" max="${_pMax}" value="${curMin}" oninput="onPriceRange()" aria-label="Minimum price" style="z-index:${curMin > _pMax * 0.9 ? 5 : 3}">
      <input type="range" id="priceMax" min="0" max="${_pMax}" value="${curMax}" oninput="onPriceRange()" aria-label="Maximum price" style="z-index:4">
    </div>
    <div class="fx-price-boxes">
      <label class="fx-pbox"><span>Min</span><span class="fx-pbox-in">$<input type="number" inputmode="numeric" min="0" id="fxPriceMinBox" placeholder="0" value="${_filters.minPrice ?? ''}" onchange="fxPriceBox()"></span></label>
      <span class="fx-dash" aria-hidden="true">–</span>
      <label class="fx-pbox"><span>Max</span><span class="fx-pbox-in">$<input type="number" inputmode="numeric" min="0" id="fxPriceMaxBox" placeholder="Any" value="${_filters.maxPrice ?? ''}" onchange="fxPriceBox()"></span></label>
    </div>`);
}
// Typed prices: an empty box means no limit on that side; min above max swaps them.
function fxPriceBox() {
  const read = id => { const v = parseInt(document.getElementById(id)?.value, 10); return isNaN(v) || v < 0 ? null : v; };
  let lo = read('fxPriceMinBox'), hi = read('fxPriceMaxBox');
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  _filters.minPrice = lo || null;
  _filters.maxPrice = hi;
  renderDeepFilters();
  renderListings();
}

function fxScopeHTML() {
  const labels = { mine: 'My school', '10mi': 'Within 10 miles', '25mi': 'Within 25 miles', all: 'All schools' };
  const s = _filters.schoolScope;
  return fxSection('scope', 'Schools', s === '25mi' ? '' : labels[s],
    fxRadioList(Object.entries(labels), s, v => `setSchoolScope('${v}')`));
}

function fxSortHTML() {
  const s = _filters.sort || 'newest';
  return fxSection('sort', 'Sort by', s === 'newest' ? '' : SORT_LABELS[s],
    fxRadioList(Object.entries(SORT_LABELS), s, v => `setSort('${v}')`));
}

// Course typeahead inside the filter drawer (books category only). Re-attached on every
// drawer render because innerHTML replaces the input node. Courses catalog loads lazily.
async function attachDrawerCourseAC() {
  const input = document.getElementById('dfCourseInput');
  const list  = document.getElementById('dfCourseList');
  if (!input || !list) return;
  if (!_courses) await loadCourses();
  attachCourseAC(input, list, {
    allowNotListed: false,
    onSelect: code => { _filters.details.courseCode = code; renderListings(); }
  });
}

function setDeepEdition(v) {
  if (v) _filters.details.edition = v;
  else delete _filters.details.edition;
  renderListings();
}

function onPriceRange() {
  const minEl = document.getElementById('priceMin');
  const maxEl = document.getElementById('priceMax');
  if (!minEl || !maxEl) return;
  let minV = parseInt(minEl.value);
  let maxV = parseInt(maxEl.value);
  if (minV > maxV) { minV = maxV; minEl.value = minV; }
  const fill = document.getElementById('priceRangeFill');
  if (fill) {
    fill.style.left  = (minV / _pMax * 100).toFixed(1) + '%';
    fill.style.width = ((maxV - minV) / _pMax * 100).toFixed(1) + '%';
  }
  const minBox = document.getElementById('fxPriceMinBox');
  const maxBox = document.getElementById('fxPriceMaxBox');
  if (minBox) minBox.value = minV === 0     ? '' : minV;
  if (maxBox) maxBox.value = maxV >= _pMax  ? '' : maxV;
  _filters.minPrice = minV === 0    ? null : minV;
  _filters.maxPrice = maxV >= _pMax ? null : maxV;
  clearTimeout(_kwTimer);
  _kwTimer = setTimeout(() => renderListings(), 80);
}

// ---- What a listing can say about itself, per category (2026-09-23) ----
// ONE definition, read by three places: the posting form fills its dropdowns from it
// (fillSpecSelects), the filter drawer builds its chips from it (buildSpecFiltersHTML) and
// matches with it (specMatch), and the detail view lists it (listingSpecsHTML). Before this each
// place kept its own list and they drifted — "Full Apt" here, "Full Apartment" there, tags a
// seller could set that no buyer could filter on, and details nobody could see at all.
// Add a detail HERE and it appears in all three.
//
//   key       where it lives in listings.details (jsonb — no schema change for a new key)
//   options   [stored value, label]; the order matters for 'within' and reads left to right
//   filter    'one'     the listing's value equals the chosen chip
//             'within'  the listing is at or before the chosen option (distance)
//             'atleast' the listing's number is >= the chosen chip (bedrooms, bathrooms)
//             'by'      a date on or before the chosen one (available from)
//             absent    shown on the listing, not filterable (free text like brand)
//   control:'seg' a segmented bar in the filter panel even for a 'one' filter (short, ordered)
//   filterLabels  chip labels when they differ from the posting labels ("2+" rather than "2")
//   filterLabel   the drawer's heading when it reads better than the posting label
//   detail:false  not listed on the detail view (room type is already its headline pill)
//
// Every detail is OPTIONAL for the seller, and a listing that does not state a detail is hidden
// when a buyer filters on it (Kal, 2026-09-23): a filter means "only listings that match".
const LISTING_SPECS = {
  housing: [
    { key: 'room_type', label: 'Room type', filter: 'one', detail: false, options: [
      ['Private Room', 'Private room'], ['Shared Room', 'Shared room'],
      ['Full Apartment', 'Full apartment'], ['Looking for Room', 'Looking for a room']] },
    { key: 'distance', label: 'Distance to campus', filter: 'within', options: [
      ['walk', 'Walking distance'], ['1mi', 'Under 1 mile'], ['3mi', '1–3 miles'], ['far', '3+ miles (car needed)']],
      filterLabels: [['walk', 'Walking distance'], ['1mi', 'Under 1 mile'], ['3mi', 'Under 3 miles']] },
    { key: 'bedrooms', label: 'Bedrooms', filter: 'atleast', options: [
      ['0', 'Studio'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4+']],
      filterLabels: [['1', '1+'], ['2', '2+'], ['3', '3+'], ['4', '4+']] },
    { key: 'bathrooms', label: 'Bathrooms', filter: 'atleast', options: [
      ['1', '1'], ['1.5', '1.5'], ['2', '2'], ['2.5', '2.5+']],
      filterLabels: [['1', '1+'], ['1.5', '1.5+'], ['2', '2+']] },
    { key: 'lease', label: 'Lease', filter: 'one', options: [
      ['semester', 'One semester'], ['academic', 'Academic year'], ['12mo', '12 months'],
      ['monthly', 'Month-to-month'], ['summer', 'Summer sublet']] },
    { key: 'available_from', label: 'Available from', filterLabel: 'Move in by', filter: 'by', type: 'date' },
  ],
  clothing: [
    { key: 'item_type', label: 'Type', filter: 'one', options: [
      ['tops', 'Tops'], ['bottoms', 'Bottoms'], ['dresses', 'Dresses'], ['outerwear', 'Outerwear'],
      ['shoes', 'Shoes'], ['accessories', 'Accessories'], ['other', 'Other']] },
    { key: 'size', label: 'Size', filter: 'one', control: 'seg', options: [
      ['XS', 'XS'], ['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL'], ['XXL', 'XXL'], ['One size', 'One size']] },
    { key: 'condition', label: 'Condition', filter: 'one', options: [['New', 'New'], ['Like New', 'Like new'], ['Used', 'Used']] },
    { key: 'delivery', label: 'Pickup / delivery', filter: 'one', options: [
      ['Pickup only', 'Pickup only'], ['Delivery available', 'Delivery'], ['Either', 'Either']] },
    { key: 'brand', label: 'Brand' },
  ],
  technology: [
    { key: 'device', label: 'Device', filter: 'one', options: [
      ['laptop', 'Laptop'], ['phone', 'Phone'], ['tablet', 'Tablet'], ['monitor', 'Monitor'],
      ['audio', 'Audio'], ['gaming', 'Gaming'], ['accessory', 'Accessory'], ['other', 'Other']] },
    { key: 'condition', label: 'Condition', filter: 'one', options: [
      ['New', 'New'], ['Like New', 'Like new'], ['Used', 'Used'], ['For Parts', 'For parts']] },
    { key: 'brand_model', label: 'Brand / model' },
  ],
  donation: [
    { key: 'condition', label: 'Condition', filter: 'one', options: [['Good', 'Good'], ['Fair', 'Fair'], ['Worn', 'Worn']] },
    { key: 'pickup_info', label: 'Pickup' },
  ],
};

// Housing amenities are the listing's TAGS (checkboxes when posting), not details.
// [filter key, stored tag, chip label]. furnished/petOk keep their old keys so a filter a
// student had saved before this change still means the same thing.
const HOUSING_AMENITIES = [
  ['utilities', 'Utilities included', 'Utilities included'], ['furnished', 'Furnished', 'Furnished'],
  ['parking', 'Parking', 'Parking'], ['petOk', 'Pet friendly', 'Pets OK'],
  ['laundry', 'Laundry', 'Laundry'], ['privateBath', 'Private bathroom', 'Private bathroom'],
  ['quiet', 'Quiet', 'Quiet'],
];

function specOf(cat, key) { return (LISTING_SPECS[cat] || []).find(s => s.key === key); }
function specLabel(spec, v, forFilter) {
  const list = (forFilter && spec.filterLabels) || spec.options || [];
  return (list.find(o => o[0] === String(v)) || [])[1] || String(v);
}

// Does listing l pass the category-detail filters in d?
function specMatch(l, cat, d) {
  const ld = l.details || {};
  for (const s of LISTING_SPECS[cat] || []) {
    const want = d[s.key];
    if (!s.filter || want === undefined || want === null || want === '') continue;
    const have = ld[s.key];
    if (have === undefined || have === null || have === '') return false;   // not stated: hidden
    if (s.filter === 'one' && String(have).toLowerCase() !== String(want).toLowerCase()) return false;
    if (s.filter === 'within') {
      const order = s.options.map(o => o[0]);
      const at = order.indexOf(String(have));
      if (at === -1 || at > order.indexOf(String(want))) return false;
    }
    if (s.filter === 'atleast' && !(parseFloat(have) >= parseFloat(want))) return false;
    // ISO dates (YYYY-MM-DD) order correctly as plain strings.
    if (s.filter === 'by' && !(String(have) <= String(want))) return false;
  }
  if (cat === 'housing') {
    for (const [k, tag] of HOUSING_AMENITIES) if (d[k] && !(l.tags || []).includes(tag)) return false;
  }
  return true;
}


// The listing's details as a list on its detail view — every detail it states, in the order
// the specs give them. Details it does not state are simply absent.
function listingSpecsHTML(l) {
  const ld = l.details || {};
  const rows = (LISTING_SPECS[l.category] || []).filter(s => s.detail !== false).map(s => {
    const v = ld[s.key];
    if (v === undefined || v === null || v === '') return '';
    const shown = s.type === 'date'
      ? new Date(v + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : specLabel(s, v, false);
    return `<div class="detail-spec"><dt>${esc(s.label)}</dt><dd>${esc(shown)}</dd></div>`;
  }).join('');
  return rows ? `<dl class="detail-specs">${rows}</dl>` : '';
}

// Fills the posting form's spec dropdowns (<select data-spec="cat.key">) from LISTING_SPECS, so
// the form offers exactly what the filters can find. Run each time a category is chosen; it only
// fills a select that is still empty, so a half-filled form keeps its answers.
function fillSpecSelects() {
  document.querySelectorAll('select[data-spec]').forEach(sel => {
    if (sel.options.length) return;
    const [cat, key] = sel.dataset.spec.split('.');
    const spec = specOf(cat, key);
    if (!spec) return;
    sel.innerHTML = `<option value="">Not specified</option>`
      + spec.options.map(([v, label]) => `<option value="${escAttr(v)}">${esc(label)}</option>`).join('')
      + (sel.dataset.other ? `<option value="__other">Other…</option>` : '');
  });
}

// Clothing size: the chips cover letter sizes; "Other…" reveals a text box for shoe and waist
// sizes, which are shown on the listing but cannot be matched by a chip.
function onClothingSize(sel) {
  document.getElementById('pCL_size')?.classList.toggle('is-hidden', sel.value !== '__other');
}


// ---- LOADING SKELETONS -------------------------------------------------
// The feed's listings come from Supabase, so on a slow connection there is a gap
// between the page appearing and the cards arriving. Without these the grid is a
// blank white rectangle for that whole time, which reads as broken rather than
// loading. We paint placeholder cards the moment this file loads; renderListings()
// overwrites them when the real data lands. Shapes/shimmer live in styles.css.

// Varied hero heights so the masonry columns look natural rather than a grid of
// identical blocks. Cycled over however many cards we draw.
// Mirrors listingCardHTML's shape, and has to keep doing so. A skeleton shaped differently
// from what replaces it is worse than no skeleton: the page visibly jumps at the moment it
// finishes loading, which reads as a glitch rather than as progress.
//
// The heroes used to come in three heights, because the old layout was masonry and uneven
// heights were the whole point of it. They are one shape now, like the cards.
function feedSkeletonHTML(n = 6) {
  return Array.from({ length: n }, () => `<div class="sk-card" aria-hidden="true">
    <div class="sk sk-hero"></div>
    <div class="sk-body">
      <div class="sk sk-badge"></div>
      <div class="sk sk-title"></div>
      <div class="sk sk-sub"></div>
      <div class="sk sk-price"></div>
    </div>
  </div>`).join('');
}

function showFeedSkeletons() {
  const host = document.getElementById('mkSections');
  if (!host || host.children.length) return;  // never clobber cards that are already up
  host.setAttribute('aria-busy', 'true');     // screen readers announce "busy", not the fake cards
  // Wrapped in a grid of its own: #mkSections is a plain column of sections now, so
  // skeletons dropped straight into it would stack one per row instead of filling a grid.
  host.innerHTML = `<div class="listings-grid">${feedSkeletonHTML()}</div>`;
}
// Runs at load. Safe here because every <script> tag sits at the bottom of
// index.html, so #mkSections already exists by the time this file executes.
showFeedSkeletons();

// THE keyword rule for a marketplace item, extracted so the feed and the search page cannot
// drift apart. Two copies of "what counts as a match" is the same bug as book_listings
// bypassing visible_listings, one layer up.
//
// The ISBN branch strips hyphens and spaces from BOTH sides, because a student copying a
// number off the back of a book types it however it is printed and expects it to be found.
// That single line is most of what makes book search work on a campus.
function matchItemKeyword(l, keyword) {
  if (!keyword) return true;
  const k = String(keyword).toLowerCase();
  return (l.title || '').toLowerCase().includes(k)
    || (l.desc || '').toLowerCase().includes(k)
    || (l.author || '').toLowerCase().includes(k)
    || (l.course_code || '').toLowerCase().includes(k)
    || (l.isbn || '').replace(/[- ]/g, '').includes(k.replace(/[- ]/g, ''));
}

function renderListings() {
  renderCategoryChips();
  // Saved HERE rather than in each setter, and that is the point: six functions change
  // _filters and every one of them ends by calling this. A save in each would be six places
  // to keep in step, and the seventh filter somebody adds would be the one that forgets.
  saveUiState('filters', _filters);

  // Keep the mobile tab highlight honest when the category changes *within* the Browse
  // page (e.g. tapping the Events chip should light up the Events tab, not Search).
  if (document.getElementById('page-listings').classList.contains('active')) updateMTabbar('listings');
  // Books mix into the one grid like any other category (separate table underneath,
  // same cards + filters up here). Newest-first across BOTH sources.
  const approved = browseItems().filter(isListingLive)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const pinned   = approved.filter(l => l.pinned);
  const rest     = approved.filter(l => !l.pinned);

  const catMatch = l => _filters.category === 'all' || l.category === _filters.category;
  const kwMatch  = l => matchItemKeyword(l, _filters.keyword);
  const priceMatch = l => {
    const p = l.rent || 0;
    if (_filters.minPrice !== null && p < _filters.minPrice) return false;
    if (_filters.maxPrice !== null && p > _filters.maxPrice) return false;
    return true;
  };
  const detailsMatch = l => {
    const d = _filters.details;
    // Housing, clothing, tech and free items: the shared specs (LISTING_SPECS) decide.
    if (!specMatch(l, _filters.category, d)) return false;
    if (d.eventDateFrom && l.details.event_date && l.details.event_date < d.eventDateFrom) return false;
    if (d.eventDateTo   && l.details.event_date && l.details.event_date > d.eventDateTo)   return false;
    // Book filters exclude non-books by design: course/type/edition only exist on books.
    if (d.bookType   && l.book_type !== d.bookType)               return false;
    if (d.courseCode && l.course_code !== d.courseCode)           return false;
    if (d.edition    && (l.edition || '').trim() !== d.edition)   return false;
    return true;
  };
  const _scope = schoolsInScope();
  const schoolMatch = l => !_scope || !l.school || _scope.has(l.school);
  const allMatch = l => catMatch(l) && kwMatch(l) && priceMatch(l) && detailsMatch(l) && schoolMatch(l);

  const filtered       = rest.filter(allMatch);
  const pinnedFiltered = pinned.filter(allMatch);

  // Active filter bar
  const sortEl = document.getElementById('mkSort');
  if (sortEl) sortEl.value = _filters.sort || 'newest';
  const tagsEl   = document.getElementById('sActiveTags');
  const clearBtn = document.getElementById('sClearAll');
  const countEl  = document.getElementById('sResultCount');
  const tags = [];
  if (_filters.category !== 'all') {
    const label = CATEGORY_LABELS[_filters.category] || _filters.category;
    tags.push(`<span class="active-filter-tag">${label} <button onclick="clearListingCat()">&#215;</button></span>`);
  }
  if (_filters.keyword) {
    tags.push(`<span class="active-filter-tag">&ldquo;${esc(_filters.keyword)}&rdquo; <button onclick="clearListingKeyword()">&#215;</button></span>`);
  }
  if (_filters.minPrice !== null || _filters.maxPrice !== null) {
    const lo = _filters.minPrice !== null ? '$' + _filters.minPrice : 'Min';
    const hi = _filters.maxPrice !== null ? '$' + _filters.maxPrice : 'Max';
    tags.push(`<span class="active-filter-tag">${lo} – ${hi} <button onclick="_filters.minPrice=null;_filters.maxPrice=null;renderDeepFilters();renderListings()">&#215;</button></span>`);
  }
  const d = _filters.details;
  const detailTagLabels = { room_type:'Room', condition:'Condition', size:'Size', delivery:'Delivery', furnished:'Furnished', petOk:'Pets OK', eventDateFrom:'From', eventDateTo:'To', bookType:'Type', courseCode:'Course', edition:'Edition' };
  Object.entries(d).forEach(([k, v]) => {
    const spec  = specOf(_filters.category, k);
    const amen  = HOUSING_AMENITIES.find(a => a[0] === k);
    const label = spec ? (spec.filterLabel || spec.label) : detailTagLabels[k] || k;
    const prettyVal = k === 'bookType' ? (v === 'course' ? 'Textbooks' : 'Other books')
      : spec ? (spec.type === 'date' ? new Date(v + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : specLabel(spec, v, true))
      : v;
    const display = amen ? amen[2] : `${label}: ${prettyVal}`;
    tags.push(`<span class="active-filter-tag">${display} <button onclick="delete _filters.details['${k}'];renderDeepFilters();renderListings()">&#215;</button></span>`);
  });
  if (_filters.schoolScope !== '25mi') {
    const scopeLabels = { mine: 'My school', '10mi': 'Within 10 mi', '25mi': 'Within 25 mi', all: 'All schools' };
    tags.push(`<span class="active-filter-tag">${scopeLabels[_filters.schoolScope]} <button onclick="setSchoolScope('25mi')">&#215;</button></span>`);
  }
  if (_filters.sort && _filters.sort !== 'newest') {
    tags.push(`<span class="active-filter-tag">${SORT_LABELS[_filters.sort]} <button onclick="setSort('newest')">&#215;</button></span>`);
  }
  if (tagsEl)   tagsEl.innerHTML = tags.join('');
  if (clearBtn) clearBtn.style.display = tags.length ? 'inline' : 'none';
  const total      = approved.length;
  const matchCount = filtered.length + pinnedFiltered.length;
  if (countEl) countEl.textContent = tags.length
    ? `Showing ${matchCount} of ${total} listing${total !== 1 ? 's' : ''}`
    : (total > 0 ? `${total} listing${total !== 1 ? 's' : ''}` : '');

  // Drawer apply button count
  const applyBtn = document.getElementById('filterDrawerApply');
  if (applyBtn) applyBtn.textContent = `Show ${matchCount} listing${matchCount !== 1 ? 's' : ''}`;
  // Filters button badge — counts PANEL filters (scope, price, category-specifics, sort), not category/keyword
  const panelCount =
    (_filters.schoolScope !== '25mi' ? 1 : 0) +
    ((_filters.minPrice !== null || _filters.maxPrice !== null) ? 1 : 0) +
    Object.keys(_filters.details).length +
    ((_filters.sort && _filters.sort !== 'newest') ? 1 : 0);
  // Two buttons open the same drawer over the same _filters object — search.js renders one
  // onto the Search page, index.html carries the other on the Marketplace — so both badges are
  // set here. They need separate ids because both pages sit in the DOM at once, and
  // getElementById would otherwise always answer with whichever is higher in the document.
  ['filtersBtnCount', 'mkFilterCount'].forEach(id => {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = panelCount;
    badge.style.display = panelCount ? 'inline-flex' : 'none';
  });

  // ---------------------------------------------------------------- sections
  // One flat grid when the student has narrowed something, sections when they have not.
  // Someone who picked a category asked a question and wants the answer in one list;
  // splitting that answer across headings makes them read three lists to find out how many
  // results there were.
  const noFilters = _filters.category === 'all' && !_filters.keyword && _filters.minPrice === null && _filters.maxPrice === null && !Object.keys(_filters.details).length;
  const host = document.getElementById('mkSections');
  if (!host) return;
  host.removeAttribute('aria-busy'); // real content from here on — skeletons are done

  if (!filtered.length && !pinnedFiltered.length) {
    host.innerHTML = mkEmptyHTML(approved.length === 0, noFilters);
    return;
  }

  if (!noFilters) {
    const label = _filters.category !== 'all' ? (CATEGORY_LABELS[_filters.category] || 'Results') : 'Results';
    const all = sortListings([...pinnedFiltered, ...filtered]);
    // In the flat results list there is no "Featured" heading, so the per-card badge earns its place.
    streamSections(host, [mkSection(label, all, `${all.length} listing${all.length !== 1 ? 's' : ''}`, true)]);
    return;
  }

  // The school split. Coordinates live on SCHOOLS, not on listings, so nothing here can rank
  // one listing as physically nearer than another — "at your school" is the honest version of
  // that idea, and it is the only one the data can actually answer. It also makes the school
  // scope filter visible: without it, listings pulled in from a university 20 miles away sit
  // in the same grid as ones from your own campus with nothing to tell them apart.
  const mySchool = getEffectiveUser()?.school || null;
  const atMine  = sortListings(filtered.filter(l => !mySchool || !l.school || l.school === mySchool));
  const nearby  = sortListings(filtered.filter(l => mySchool && l.school && l.school !== mySchool));

  // One continuous feed, no "See all": Featured, then your school, then nearby campuses, each
  // under its heading, drawn a batch at a time as the student scrolls (streamSections).
  streamSections(host, [
    mkSection('Featured', sortListings(pinnedFiltered)),
    mkSection(mySchool ? 'At your school' : 'All listings', atMine),
    mkSection('From nearby campuses', nearby),
  ]);
}

// A Marketplace section for streamSections(). Inside a section called Featured every card is
// featured, so the per-card badge would repeat the heading; only the flat results list shows it.
function mkSection(title, items, meta, badgePinned = false) {
  return {
    items,
    headHTML: `<div class="mk-sec-head"><h2 class="mk-sec-title">${esc(title)}</h2>
      ${meta ? `<span class="mk-sec-meta">${esc(meta)}</span>` : ''}</div>`,
    cardHTML: l => listingCardHTML(l, badgePinned && l.pinned),
  };
}

// ---- Endless scroll (2026-09-23) ----
// Home, the Marketplace and Events no longer stop at a preview with "See all". The first batch
// is drawn, and the next is appended whenever the bottom of the list comes within a screen of
// the viewport, until everything is shown and "You're all caught up" closes the list.
//
// Everything is already in the browser — loadListings() and loadEvents() fetch the whole school
// — so "loading more" is drawing more: no request per scroll, nothing to wait for. When the
// catalogue outgrows that, fetching the next page belongs inside addMore() and the three pages
// calling this do not change.
//
// sections: [{ items, headHTML, cardHTML(item) }], shown in order as ONE stream: a section's
// heading appears when its first card does. A section with no items is skipped, heading and all.
// opts.batch   cards per step (20 fills whole rows at 2, 4 and 5 columns)
// opts.gridClass  the class of each section's card container
// opts.done(host)  called once the last card is drawn (Events puts its past-events chip here)
//
// Re-rendering the same host (a filter change, a realtime update) redraws at least as many
// cards as were showing, so the page does not shrink under a student who had scrolled down.
const _streams = new Map();   // host id -> stop() for the stream currently drawing into it

function streamSections(host, sections, opts = {}) {
  _streams.get(host.id)?.();
  const batch = opts.batch || 20;
  const already = Number(host.dataset.shown || 0);
  host.innerHTML = '';
  const sentinel = document.createElement('div');
  sentinel.className = 'stream-sentinel';
  host.appendChild(sentinel);

  let si = 0, ii = 0, grid = null, shown = 0, ticking = false;
  const finish = () => {
    stop();
    sentinel.remove();
    if (shown) host.insertAdjacentHTML('beforeend', `<div class="stream-end">You're all caught up</div>`);
    opts.done?.(host);
  };
  const addMore = n => {
    while (n > 0 && si < sections.length) {
      const sec = sections[si];
      if (!grid) {
        if (!sec.items.length) { si++; continue; }
        if (sec.headHTML) sentinel.insertAdjacentHTML('beforebegin', sec.headHTML);
        grid = document.createElement('div');
        grid.className = opts.gridClass || 'listings-grid';
        host.insertBefore(grid, sentinel);
      }
      const take = sec.items.slice(ii, ii + n);
      grid.insertAdjacentHTML('beforeend', take.map(sec.cardHTML).join(''));
      ii += take.length; n -= take.length; shown += take.length;
      if (ii >= sec.items.length) { si++; ii = 0; grid = null; }
    }
    host.dataset.shown = shown;
    if (si >= sections.length) finish();
  };
  // Near = the sentinel is less than a screen below the fold. A host on a hidden page has no
  // layout (offsetParent null) and must not count as near, or it would draw everything at once.
  const check = () => {
    ticking = false;
    if (!sentinel.isConnected || host.offsetParent === null) return;
    if (sentinel.getBoundingClientRect().top < window.innerHeight * 2) addMore(batch);
  };
  // Throttled with a short timer rather than requestAnimationFrame: a frame callback never runs
  // in a tab that is not painting (a background tab, a headless test), and a stream waiting on
  // one would stop loading for good.
  const poke = () => { if (!ticking) { ticking = true; setTimeout(check, 80); } };
  // Scroll and resize move the sentinel; a photo finishing loading can too (it grows its card).
  // `load` does not bubble, so it is caught on the way down (capture: true).
  const stop = () => {
    window.removeEventListener('scroll', poke);
    window.removeEventListener('resize', poke);
    document.removeEventListener('load', poke, true);
    _streams.delete(host.id);
  };
  window.addEventListener('scroll', poke, { passive: true });
  window.addEventListener('resize', poke);
  document.addEventListener('load', poke, true);
  _streams.set(host.id, stop);
  addMore(Math.max(batch, already));
}

function mkEmptyHTML(nothingAtAll, noFilters) {
  return `<div class="lc-empty">
    <div class="lc-empty-icon">${nothingAtAll ? icon('inbox', 38) : icon('search', 38)}</div>
    <div class="lc-empty-title">${nothingAtAll ? 'No listings yet — be the first to post one!' : 'No listings match these filters.'}</div>
    ${!noFilters ? `<div class="lc-empty-sub">Try widening the price range or clearing a filter.</div>
      <button class="lc-empty-btn" onclick="clearListingFilters()">Clear filters</button>` : ''}
  </div>`;
}

// esc() and escAttr() live in js/utils.js so every file can use them.

// Small Lucide-style line icons. stroke=currentColor so each inherits its context's color.
// icon(), CATEGORY_ICON and catIcon() moved to js/config.js, which now holds the
// single icon registry for the app. Same names, same behaviour — icon() replaces
// icon() and keeps its default size of 16.

// Cross-school badge (school name + distance) — '' when the listing is from the viewer's own school.
function schoolBadgeHTML(l) {
  const eu = getEffectiveUser();
  if (!(eu && l.school && l.school !== eu.school)) return '';
  const theirSchool = _schoolsList.find(s => s.slug === l.school);
  const mySchool    = _schoolsList.find(s => s.slug === eu.school);
  const name = theirSchool?.name || (l.school.charAt(0).toUpperCase() + l.school.slice(1));
  let distLabel = '';
  if (mySchool?.lat && theirSchool?.lat) {
    const mi = haversineDistance(mySchool.lat, mySchool.lng, theirSchool.lat, theirSchool.lng);
    distLabel = `<span class="school-dist">· ${mi.toFixed(0)} mi</span>`;
  }
  return `<span class="school-badge">${icon('school', 10)} ${name}${distLabel}</span>`;
}

// A small avatar (live profile picture, else initials-on-color). Never a generic "missing user" icon.
function avatarHTML(p, size) {
  const fs = Math.round(size * 0.4);
  return p.avatar_url
    ? `<img src="${escAttr(p.avatar_url)}" alt="${escAttr(p.name)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0">`
    : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${escAttr(p.color || '#888')};color:#fff;display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:600;flex-shrink:0">${esc(p.initials || '?')}</div>`;
}

// The small trust marker shown after a poster's name (Official only — every student is verified, so no tick on listings).
function trustBadgeHTML(p) {
  if (p.official) return `<span class="trust-official" title="Official Nestrel account">Official</span>`;
  return '';
}

// Plain muted school text under a poster's name (name, plus distance only when cross-school).
function posterSchoolLine(l) {
  if (!l.school) return '';
  const eu = getEffectiveUser();
  const theirs = _schoolsList.find(s => s.slug === l.school);
  const name = theirs?.name || (l.school.charAt(0).toUpperCase() + l.school.slice(1));
  let dist = '';
  if (eu && l.school !== eu.school) {
    const mine = _schoolsList.find(s => s.slug === eu.school);
    if (mine?.lat && theirs?.lat) {
      const mi = haversineDistance(mine.lat, mine.lng, theirs.lat, theirs.lng);
      dist = ` · ${mi.toFixed(0)} mi`;
    }
  }
  return name + dist;
}

// ---- Appealing a moderated listing ----
// Reuses the existing appeals table and admin queue rather than building a parallel system:
// same row shape as a suspension appeal, with listing_id set instead of suspension_history_id.
let _appealListingId = null;

function openListingAppeal(id) {
  const eu = getEffectiveUser();
  if (!eu) { openModal('loginModal'); return; }
  const l = browseItems().find(x => x.id === id && !x.isBook) || DB.listings.find(x => x.id === id);
  if (!l || l.poster_id !== eu.id) return; // only your own listing, and only if it still exists
  _appealListingId = id;
  document.getElementById('laListingTitle').textContent = l.title;
  document.getElementById('laMessage').value = '';
  const err = document.getElementById('laErr');
  err.textContent = ''; err.style.display = 'none';
  const btn = document.getElementById('laSubmitBtn');
  btn.disabled = false; btn.textContent = 'Submit appeal';
  dismissDetail();
  openModal('listingAppealModal');
}

async function submitListingAppeal() {
  const eu = getEffectiveUser();
  if (!eu || !_appealListingId) return;
  const message = document.getElementById('laMessage').value.trim();
  const err = document.getElementById('laErr');
  const btn = document.getElementById('laSubmitBtn');
  if (!message) { err.textContent = 'Please tell us why you are appealing.'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Submitting…';

  const { error } = await supabaseClient.from('appeals').insert({
    profile_id: eu.id,
    email: eu.email || null,
    message,
    status: 'open',
    listing_id: _appealListingId
  });
  if (error) {
    console.error('[listing appeal]', error.message);
    err.textContent = 'Could not submit your appeal just now. Please try again.';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Submit appeal';
    return;
  }
  closeModal('listingAppealModal');
  toast('Appeal submitted — a moderator will review it.');
  _appealListingId = null;
}

// Price line — category aware (Free for donations and $0 books, Event for org posts, /mo only for housing).
function priceLabel(l) {
  if (l.category === 'organization_event') return `<span class="lc-soft">Event</span>`;
  if (l.category === 'donation') return `<span class="lc-soft">Free</span>`;
  if (l.category === 'books' && !(l.rent > 0)) return `<span class="lc-soft">Free</span>`;
  if (l.rent == null || l.rent === '' || isNaN(l.rent)) return `<span class="lc-soft">Contact</span>`;
  const per = l.category === 'housing' ? '<span>/mo</span>' : '';
  const prefix = l.type === 'Looking for Room' ? 'Up to ' : '';
  return `${prefix}$${l.rent}${per}`;
}

// ---- Desktop masonry (2026-09-23) ----
// Wider than a phone, cards pack into the columns like Pinterest. CSS can't size a grid row to its
// content AND pack the columns, so this tells the grid how tall each card is: every grid named in
// MASONRY_GRIDS gets .is-masonry, its rows become 4px tall, and each child spans as many of them
// as its height needs (masonryFit). Used by the Marketplace and Home (.listings-grid) and search
// results (.sq-grid). Not Events: that is one post at a time, in one column.
//
// A ResizeObserver re-measures a card whenever its size changes — which covers its photo loading,
// fonts arriving and the window being resized — and a MutationObserver picks up new cards when a
// feed is re-rendered, so no render function has to remember to call anything.
// Phones keep the even 4:5 grid; below the breakpoint the spans are cleared and the class removed.
// If this never runs, .is-masonry is never added and the page is the ordinary even grid.
const MASONRY_ROW = 4;    // must match grid-auto-rows in styles.css
const MASONRY_GAP = 12;   // must match column-gap in styles.css (rows get the same space)
const MASONRY_GRIDS = '.listings-grid, .sq-grid';
const _masonryWide = window.matchMedia('(min-width: 681px)');
let _masonryRO = null;

function masonryFit(card) {
  const grid = card.parentElement;
  if (!grid || !grid.matches(MASONRY_GRIDS)) return;
  grid.classList.toggle('is-masonry', _masonryWide.matches);
  if (!_masonryWide.matches) { card.style.gridRowEnd = ''; return; }
  const h = card.getBoundingClientRect().height;
  card.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((h + MASONRY_GAP) / MASONRY_ROW));
}

function masonryScan() {
  document.querySelectorAll(':is(' + MASONRY_GRIDS + ') > :not([data-mz])').forEach(card => {
    card.dataset.mz = '1';
    _masonryRO.observe(card);   // observe() also fires once straight away, which does the first fit
  });
}

// Called once from boot.js.
function masonryInit() {
  if (!('ResizeObserver' in window)) return;   // very old browser: keep the even grid
  _masonryRO = new ResizeObserver(entries => entries.forEach(e => masonryFit(e.target)));
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; masonryScan(); });
  }).observe(document.body, { childList: true, subtree: true });
  // Crossing the breakpoint changes the rules, not necessarily any card's size, so refit all.
  _masonryWide.addEventListener('change', () =>
    document.querySelectorAll(':is(' + MASONRY_GRIDS + ') > *').forEach(masonryFit));
  masonryScan();
}

function listingCardHTML(l, isPinned) {
  const catLabel  = catShort(l.category);
  const photoCount = l.photo_urls?.length || 0;
  // Books route to their own detail + contact path — ids are per-table sequences.
  const openFn = l.isBook ? 'openBookDetail' : 'openDetail';
  const fav    = favButtonHTML(l.isBook ? 'book' : 'listing', l.id, 'lc-fav');

  // Buyers should see a deal is already in progress BEFORE they open or message.
  const badge = isPinned
    ? `<span class="pin-badge">${icon('star', 10)} Featured</span>`
    : l.lifecycle_status === 'pending_sale'
      ? '<span class="pin-badge pin-badge-pending">Pending sale</span>' : '';

  // HERO: a photo, or (no photo) a tinted panel where the title IS the design. Both are the
  // same shape so the grid stays even — the old masonry let them be any height, which is
  // exactly what made two columns impossible to line up.
  //
  // The category tint comes from data-cat on the card, not an inline style attribute. The
  // colours still resolve to the --cat-* tokens; they are just applied by a stylesheet rule
  // instead of being pasted into markup.
  const hero = photoCount
    ? `<div class="lc-photo">
         <img src="${escAttr(l.photo_urls[0])}" alt="${escAttr(l.title)}" loading="lazy" class="lc-photo-img">
         ${photoCount > 1 ? `<span class="lc-count">${icon('image', 12)} ${photoCount}</span>` : ''}
         ${badge}${fav}
       </div>`
    : `<div class="lc-noimg">
         <div class="lc-noimg-title">${esc(l.title)}</div>
         ${badge}${fav}
       </div>`;

  // What is NOT here, and where it went: the poster's avatar and name, the description, and
  // the Message button. At two columns on a phone a card is about 170px wide, and all three
  // were illegible or untappable at that size. Every one of them is on the detail view, which
  // is one tap away and has the room to show them properly — including who posted it, which
  // is the thing you actually want to check at the moment you are interested, not while
  // scanning. The report flag went with the poster header; detail carries that too.
  return `<div class="listing-card${isPinned ? ' pinned-card' : ''}" data-cat="${escAttr(l.category)}"
      tabindex="0" role="button" aria-label="${escAttr(l.title)}"
      onclick="${openFn}(${l.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${openFn}(${l.id})}">
    ${hero}
    <div class="lc-body">
      <span class="lc-badge">${esc(catLabel)}</span>
      ${photoCount ? `<div class="lc-title">${esc(l.title)}</div>` : ''}
      ${l.location ? `<div class="lc-loc">${icon('pin', 11)}<span>${esc(l.location)}</span></div>` : ''}
      <div class="lc-price">${priceLabel(l)}</div>
    </div>
  </div>`;
}

// ============================================================
// LISTING DETAIL (redesigned 2026-09-24)
// ============================================================
// Phone and desktop get different shapes, because they are used differently — the pattern
// Facebook Marketplace, Depop and Airbnb all settle on:
//
//  PHONE — a full-screen page, not a pop-up. The photos run edge to edge and swipe sideways
//  (scroll-snap, so it is the phone's own swipe), the details sit on a sheet that overlaps
//  the photo's foot, and the price and "Message" are pinned to the bottom where a thumb
//  already is. Back (the arrow, or the phone's back gesture) closes it: a history entry is
//  pushed on open, the same way the full-screen chat does it (messages.js), so the gesture
//  leaves the listing instead of the app.
//
//  DESKTOP — a wide window: the photo on the left at full height, the details beside it,
//  scrolling on their own, with the price and Message near the top where the eye starts.
//  Arrows and thumbnails move between photos; ← / → and Esc work from the keyboard.
//
// THE WHOLE PHOTO IS SHOWN, never cropped (object-fit: contain). Photos come in every shape,
// and a crop can hide the thing being sold. The space a photo does not fill is painted with a
// blurred, dimmed copy of the same photo, so a tall phone picture on a wide panel reads as a
// frame rather than as grey bars.
let _ldPhotos = [];
let _ldIndex = 0;

function detailOpen() { return document.getElementById('detailModal')?.classList.contains('open'); }

// The arrow, the X, the backdrop and Esc: close, and use up the history entry openDetail
// pushed, so the next Back does not land on an already-closed listing.
function closeDetail() {
  closeModal('detailModal');
  if (history.state?.cnDetail) history.back();
}

// For closes that go straight on to something else (Message, Report, owner actions). NOT
// history.back(): that runs later, after the next screen may have pushed its own entry (the
// chat does), and would pop THAT one instead. The entry is neutralised in place.
function dismissDetail() {
  closeModal('detailModal');
  if (history.state?.cnDetail) history.replaceState(null, '');
}

window.addEventListener('popstate', () => {
  if (detailOpen()) closeModal('detailModal');
});
document.getElementById('detailModal')?.addEventListener('click', e => {
  if (e.target.id === 'detailModal') closeDetail();
});
document.addEventListener('keydown', e => {
  if (!detailOpen()) return;
  if (e.key === 'Escape') { if (document.querySelector('.ld-menu:not([hidden])')) ldMenu(false); else closeDetail(); }
  else if (e.key === 'ArrowRight') ldGo(_ldIndex + 1);
  else if (e.key === 'ArrowLeft') ldGo(_ldIndex - 1);
});

// "posted 2 days ago", from created_at.
function ldPosted(l) {
  if (!l.created_at) return l.posted ? 'posted ' + l.posted : '';
  const d = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 864e5);
  if (d <= 0) return 'posted today';
  if (d === 1) return 'posted yesterday';
  if (d < 30) return `posted ${d} days ago`;
  return 'posted ' + new Date(l.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ldMediaHTML(l) {
  const urls = l.photo_urls || [];
  if (!urls.length) {
    return `<div class="ld-media ld-media-empty" data-cat="${escAttr(l.category)}">
      <div class="detail-noimg-cat">${esc(CATEGORY_LABELS[l.category] || 'Listing')}</div>
      <div class="detail-noimg-title">${esc(l.title)}</div>
    </div>`;
  }
  const many = urls.length > 1;
  return `<div class="ld-media">
    <div class="ld-track" id="ldTrack" onscroll="ldOnScroll()">
      ${urls.map((u, i) => `<figure class="ld-slide">
        <img class="ld-slide-bg" src="${escAttr(u)}" alt="" aria-hidden="true" loading="lazy">
        <img class="ld-slide-img" src="${escAttr(u)}" alt="${escAttr(l.title)}${many ? ` — photo ${i + 1} of ${urls.length}` : ''}"${i ? ' loading="lazy"' : ''}>
      </figure>`).join('')}
    </div>
    ${many ? `
      <button class="ld-arrow ld-prev" aria-label="Previous photo" onclick="ldGo(_ldIndex - 1)">${icon('chevRight', 20)}</button>
      <button class="ld-arrow ld-next" aria-label="Next photo" onclick="ldGo(_ldIndex + 1)">${icon('chevRight', 20)}</button>
      <span class="ld-count" id="ldCount">1 / ${urls.length}</span>` : ''}
  </div>
  ${many ? `<div class="ld-thumbs">${urls.map((u, i) =>
    `<button class="ld-thumb${i ? '' : ' is-on'}" onclick="ldGo(${i})" aria-label="Photo ${i + 1}"><img src="${escAttr(u)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}`;
}

function ldGo(i) {
  const track = document.getElementById('ldTrack');
  if (!track || !_ldPhotos.length) return;
  const n = Math.max(0, Math.min(_ldPhotos.length - 1, i));
  track.scrollTo({ left: n * track.clientWidth, behavior: 'smooth' });
  ldMark(n);
}
function ldOnScroll() {
  const track = document.getElementById('ldTrack');
  if (!track) return;
  const n = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  if (n !== _ldIndex) ldMark(n);
}
function ldMark(n) {
  _ldIndex = n;
  const count = document.getElementById('ldCount');
  if (count) count.textContent = `${n + 1} / ${_ldPhotos.length}`;
  document.querySelectorAll('.ld-thumb').forEach((t, i) => t.classList.toggle('is-on', i === n));
  document.querySelector('.ld-prev')?.toggleAttribute('disabled', n === 0);
  document.querySelector('.ld-next')?.toggleAttribute('disabled', n === _ldPhotos.length - 1);
}

// The seller as one tappable card: who they are, that they are a verified student, and since
// when. Tapping opens their profile — the thing you want to check before messaging a stranger.
function ldSellerHTML(l) {
  const p = l.poster;
  const clickable = !p.official && l.poster_id;
  const trust = p.official ? '<span class="trust-official">Official</span>'
    : p.verified ? `<span class="ld-verified">${icon('check', 12)} Verified</span>` : '';
  const school = schoolBadgeHTML(l) || esc((_schoolsList || []).find(s => s.slug === l.school)?.name || '');
  const since = p.memberSince
    ? 'joined ' + new Date(p.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : (p.official ? 'Official account' : '');
  const sub = [[p.year, p.major].filter(Boolean).map(esc).join(' · '), school, since].filter(Boolean).join(' · ');
  const tag = clickable ? 'button' : 'div';
  return `<${tag} class="ld-seller"${clickable ? ` onclick="viewStudentProfile('${escAttr(l.poster_id)}')"` : ''}>
    ${avatarHTML(p, 50)}
    <span class="ld-seller-text">
      <span class="ld-seller-name">${esc(p.name)}${trust}</span>
      ${sub ? `<span class="ld-seller-sub">${sub}</span>` : ''}
    </span>
    ${clickable ? `<span class="ld-seller-go">${icon('chevRight', 18)}</span>` : ''}
  </${tag}>`;
}

function ldMenu(open) {
  const m = document.getElementById('ldMenu');
  if (!m) return;
  m.hidden = open === undefined ? !m.hidden : !open;
}

function openDetail(id) {
  const l = DB.listings.find(x => x.id === id) || DB.pending.find(x => x.id === id); if (!l) return;
  const eu = getEffectiveUser();
  const mine = !!eu && eu.id === l.poster_id;
  const canReport = !!eu && !mine && !l.poster.official;
  const canMessage = !l.poster.official && !mine;
  const first = (l.poster.name || '').split(' ')[0];
  _ldPhotos = l.photo_urls || [];
  _ldIndex = 0;

  const status = [];
  if (l.pinned) status.push(`<span class="pill pill-pinned">${icon('star', 11)} Featured</span>`);
  if (l.status !== 'approved' || (l.lifecycle_status && l.lifecycle_status !== 'active')) {
    const [bg, col, label] = listingLifecycleBadge(l);
    status.push(`<span class="pill" style="background:${bg};color:${col}">${label}</span>`);
  }
  const where = [l.location ? esc(l.location) : '', esc(ldPosted(l))].filter(Boolean).join(' · ');

  document.getElementById('detailContent').innerHTML = `
    <div class="ld">
      <div class="ld-top">
        <button class="ld-round ld-back" aria-label="Back" onclick="closeDetail()">${icon('chevRight', 20)}</button>
        <span class="ld-top-end">
          ${favButtonHTML('listing', l.id, 'ld-round ld-fav')}
          ${canReport ? `<button class="ld-round" aria-label="More" onclick="ldMenu()">${icon('more', 20)}</button>` : ''}
          <button class="ld-round ld-x" aria-label="Close" onclick="closeDetail()">${icon('x', 18)}</button>
        </span>
        ${canReport ? `<div class="ld-menu" id="ldMenu" hidden>
          <button onclick="dismissDetail();openReportModal(${l.id})">${icon('flag', 15)} Report this listing</button>
        </div>` : ''}
      </div>
      <div class="ld-gallery">${ldMediaHTML(l)}</div>
      <div class="ld-info">
        <div class="ld-kicker"><span class="ld-cat" data-cat="${escAttr(l.category)}">${esc(CATEGORY_LABELS[l.category] || 'Listing')}</span>${status.join('')}</div>
        <h2 class="ld-title">${esc(l.title)}</h2>
        ${where ? `<div class="ld-where">${l.location ? icon('pin', 15) : ''}<span>${where}</span></div>` : ''}
        <div class="ld-action">
          <div class="ld-price">${priceLabel(l)}</div>
          ${canMessage ? `<button class="ld-msg" onclick="dismissDetail();sContact(${l.id})">${icon('message', 18)} Message ${esc(first)}</button>` : ''}
        </div>
        ${listingSpecsHTML(l)}
        ${l.desc ? `<p class="ld-desc">${esc(l.desc)}</p>` : ''}
        ${l.tags && l.tags.length ? `<div class="detail-tags">${l.tags.map(t => `<span class="detail-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${ldSellerHTML(l)}
        ${ownerManagePanelHtml(l)}
      </div>
    </div>`;

  openModal('detailModal');
  document.querySelector('#detailModal .modal').scrollTop = 0;
  ldMark(0);
  if (!history.state?.cnDetail) history.pushState({ cnDetail: true }, '');
}

// Owner-only "manage this listing" panel — mark sold/claimed, withdraw, reactivate,
// set/extend a deadline. Only shown for the poster's own approved listing; only the
// change_listing_status() RPC can write these fields (students have no direct UPDATE
// grant on `listings`, by design — see the guard rationale in listing_lifecycle memory).
function ownerManagePanelHtml(l) {
  const eu = getEffectiveUser();
  if (!eu || eu.id !== l.poster_id) return '';

  // Moderated out of the feed — show the owner the status AND the reason. This used to
  // return nothing at all for any non-approved listing, so a student whose post was
  // rejected or removed watched it disappear with no explanation anywhere in the app.
  // Book listings already did this (see books.js); marketplace listings did not.
  if (l.status !== 'approved') {
    const [bg, col, label] = listingLifecycleBadge(l);
    // Appealable once a moderator has acted. Not offered for 'pending', where there is no
    // decision to contest yet — it is simply still in the queue.
    const canAppeal = l.status === 'removed' || l.status === 'rejected';
    return `<div class="owner-moderated">
      <div>Status: <span class="pill" style="background:${bg};color:${col}">${label}</span></div>
      ${l.rejection_reason ? `<div class="owner-moderated-reason">${esc(l.rejection_reason)}</div>` : ''}
      ${canAppeal ? `<button class="owner-appeal-btn" onclick="openListingAppeal(${l.id})">Appeal this decision</button>` : ''}
    </div>`;
  }

  const ls = l.lifecycle_status || 'active';
  const isExpired = (ls === 'active' || ls === 'pending_sale') && l.expires_at && new Date(l.expires_at) <= new Date();
  const soldLabel = l.rent ? 'Mark as sold' : 'Mark as claimed';
  // Format in LOCAL time — toISOString() would show the UTC date, which rolls to the
  // next day for a deadline stored as 23:59:59 local in any UTC-negative timezone.
  const deadlineVal = l.expires_at ? (d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)(new Date(l.expires_at)) : '';

  let actions;
  if (isExpired) {
    actions = `
      <button class="btn-sm-a btn-a-success" onclick="renewListing(${l.id})">&#8635; Renew with new deadline</button>
      <button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','sold')">${soldLabel}</button>
      <button class="btn-sm-a btn-a-danger" onclick="lifecycleAction(${l.id},'listings','withdrawn')">Withdraw</button>`;
  } else if (ls === 'pending_sale') {
    actions = `
      <button class="btn-sm-a btn-a-success" onclick="lifecycleAction(${l.id},'listings','sold')">${soldLabel}</button>
      <button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','active')">Back to active</button>
      <button class="btn-sm-a btn-a-danger" onclick="lifecycleAction(${l.id},'listings','withdrawn')">Withdraw</button>`;
  } else if (ls === 'sold') {
    // Sold and withdrawn used to offer only "back to active", so every other move cost two
    // hops. change_listing_status() now accepts any of the four states directly (see
    // sql/2026-08-08_change_listing_status_any_transition.sql), so the buttons can match.
    actions = `
      <button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','active')">Mark active again</button>
      <button class="btn-sm-a btn-a-danger" onclick="lifecycleAction(${l.id},'listings','withdrawn')">Withdraw</button>`;
  } else if (ls === 'withdrawn') {
    // Reachable directly because an item withdrawn from the feed can still sell offline —
    // the exact case that used to strand a seller.
    actions = `
      <button class="btn-sm-a btn-a-success" onclick="lifecycleAction(${l.id},'listings','active')">Reactivate</button>
      <button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','sold')">${soldLabel}</button>`;
  } else {
    actions = `
      <button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','pending_sale')">Mark pending sale</button>
      <button class="btn-sm-a btn-a-success" onclick="lifecycleAction(${l.id},'listings','sold')">${soldLabel}</button>
      <button class="btn-sm-a btn-a-danger" onclick="lifecycleAction(${l.id},'listings','withdrawn')">Withdraw</button>`;
  }

  return `<div style="border-top:1px solid var(--border);margin-top:16px;padding-top:16px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:10px">Manage this listing</div>
    <div class="arow" style="flex-wrap:wrap;margin-bottom:14px">${actions}</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <label style="font-size:12px;color:var(--text-muted)">Deadline</label>
      <input type="date" id="deadlineInput-${l.id}" value="${deadlineVal}" style="font-size:13px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-family:inherit">
      ${!isExpired ? `<button class="btn-sm-a btn-a-neutral" onclick="setListingDeadline(${l.id})">${l.expires_at ? 'Update' : 'Set'} deadline</button>
      ${l.expires_at ? `<button class="btn-sm-a btn-a-neutral" onclick="clearListingDeadline(${l.id})">Clear</button>` : ''}` : ''}
    </div>
  </div>`;
}

// Applies an RPC-confirmed lifecycle change to the local cache + re-renders affected views.
function applyLocalLifecycleChange(id, changes) {
  const l = DB.listings.find(x => x.id === id);
  if (!l) return;
  Object.assign(l, changes);
  renderListings();
  if (document.getElementById('page-profile')?.classList.contains('active')) renderProfile();
}

const LIFECYCLE_EVENT_TYPES = { sold: 'listing_sold', pending_sale: 'listing_pending_sale', withdrawn: 'listing_withdrawn', active: 'listing_relisted' };

async function lifecycleAction(id, table, newStatus) {
  const l = DB.listings.find(x => x.id === id);
  const prev = l?.lifecycle_status || 'active';
  const { error } = await supabaseClient.rpc('change_listing_status', { p_listing_id: id, p_new_status: newStatus, p_table: table });
  if (error) { toast('Could not update — please try again.'); console.error(error.message); return; }
  applyLocalLifecycleChange(id, { lifecycle_status: newStatus });
  logEvent(LIFECYCLE_EVENT_TYPES[newStatus] || 'listing_relisted', { targetType: 'listing', targetId: id, targetLabel: l?.title, school: l?.school, category: l?.category, before: { lifecycle_status: prev }, after: { lifecycle_status: newStatus } });
  dismissDetail();
  toast('Listing updated');
}

async function setListingDeadline(id) {
  const l = DB.listings.find(x => x.id === id); if (!l) return;
  const input = document.getElementById(`deadlineInput-${id}`);
  const val = input?.value;
  if (!val) { toast('Pick a date first.'); return; }
  const iso = new Date(val + 'T23:59:59').toISOString();
  const { error } = await supabaseClient.rpc('change_listing_status', {
    p_listing_id: id, p_new_status: l.lifecycle_status || 'active', p_table: 'listings',
    p_expires_at: iso, p_set_expires: true
  });
  if (error) { toast('Could not set deadline — please try again.'); console.error(error.message); return; }
  const prevDeadline = l.expires_at || null;
  applyLocalLifecycleChange(id, { expires_at: iso });
  logEvent('listing_deadline_set', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { expires_at: prevDeadline }, after: { expires_at: iso } });
  dismissDetail();
  toast('Deadline set');
}

async function clearListingDeadline(id) {
  const l = DB.listings.find(x => x.id === id); if (!l) return;
  const { error } = await supabaseClient.rpc('change_listing_status', {
    p_listing_id: id, p_new_status: l.lifecycle_status || 'active', p_table: 'listings',
    p_expires_at: null, p_set_expires: true
  });
  if (error) { toast('Could not clear deadline — please try again.'); console.error(error.message); return; }
  const prevDeadline = l.expires_at || null;
  applyLocalLifecycleChange(id, { expires_at: null });
  logEvent('listing_deadline_set', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { expires_at: prevDeadline }, after: { expires_at: null } });
  dismissDetail();
  toast('Deadline cleared');
}

async function renewListing(id) {
  const input = document.getElementById(`deadlineInput-${id}`);
  const val = input?.value;
  if (!val) { toast('Pick a new deadline date first.'); return; }
  const iso = new Date(val + 'T23:59:59').toISOString();
  const { error } = await supabaseClient.rpc('change_listing_status', {
    p_listing_id: id, p_new_status: 'active', p_table: 'listings',
    p_expires_at: iso, p_set_expires: true
  });
  if (error) { toast('Could not renew — please try again.'); console.error(error.message); return; }
  const l = DB.listings.find(x => x.id === id);
  applyLocalLifecycleChange(id, { lifecycle_status: 'active', expires_at: iso });
  logEvent('listing_renewed', { targetType: 'listing', targetId: id, targetLabel: l?.title, school: l?.school, category: l?.category, after: { lifecycle_status: 'active', expires_at: iso } });
  dismissDetail();
  toast('Listing renewed');
}

async function sContact(listingId) {
  const eu = getEffectiveUser();
  if (!eu) { openModal('loginModal'); return; }
  const l = DB.listings.find(x => x.id === listingId) || DB.pending.find(x => x.id === listingId);
  if (!l) return;
  if (!l.poster_id) { toast('Messaging not available for this listing yet.'); return; }
  if (l.poster_id === eu.id) { toast("That's your own listing!"); return; }
  const cached = sConvoCache[l.poster_id];
  let posterInfo = cached || { name: l.poster.name, initials: l.poster.initials, color: l.poster.color };
  if (!cached) {
    const { data: prof } = await supabaseClient.from('public_profiles').select('display_name, first_name, last_name, initials, color').eq('id', l.poster_id).single();
    if (prof) posterInfo = { name: prof.display_name || (prof.first_name + ' ' + prof.last_name), initials: prof.initials, color: prof.color };
  }
  showPage('messages');
  setTimeout(() => openConvo(l.poster_id, posterInfo, l.id), 100);
}

// REPORT A LISTING
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

let _reportTarget = null;

function openReportModal(listingId) {
  const eu = getEffectiveUser();
  if (!eu) { openModal('loginModal'); return; }
  const l = DB.listings.find(x => x.id === listingId);
  if (!l) return;
  _reportTarget = { id: listingId, title: l.title };
  document.getElementById('reportListingTitle').textContent = l.title;
  document.getElementById('reportCategory').value = '';
  document.getElementById('reportDetails').value = '';
  const errEl = document.getElementById('reportErr');
  errEl.style.display = 'none'; errEl.textContent = '';
  document.getElementById('reportFormWrap').style.display = 'block';
  document.getElementById('reportSuccess').style.display = 'none';
  openModal('reportModal');
}

async function submitReport() {
  const eu = getEffectiveUser();
  if (!eu) return;
  const category = document.getElementById('reportCategory').value;
  const details = document.getElementById('reportDetails').value.trim();
  const errEl = document.getElementById('reportErr');
  const showErr = msg => { errEl.textContent = msg; errEl.style.display = 'block'; };
  errEl.style.display = 'none';

  if (!category) { showErr('Please select a reason.'); return; }

  const { error } = await supabaseClient.from('reports').insert({
    listing_id: _reportTarget?.id,
    listing_title_snapshot: _reportTarget?.title,
    reporter_id: eu.id,
    category,
    details: details || null,
    status: 'open'
  });

  if (error) {
    if (error.code === '23505') {
      showErr("You've already reported this listing.");
    } else {
      showErr('Could not submit — please try again.');
      console.error(error);
    }
    return;
  }

  logEvent('report_submitted', { targetType: 'listing', targetId: _reportTarget?.id, targetLabel: _reportTarget?.title, school: eu.school });
  document.getElementById('reportFormWrap').style.display = 'none';
  document.getElementById('reportSuccess').style.display = 'block';
}

function selectCategory(cat) {
  _postCategory = cat;
  document.getElementById('postStep1').style.display = 'none';
  document.getElementById('postStep2').style.display = '';
  const _catC = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
  document.getElementById('postCatBadge').innerHTML = `<span style="color:${_catC.text};margin-right:6px">${catIcon(cat, 13)}</span>${CATEGORY_LABELS[cat]}`;
  document.querySelectorAll('[id^="catFields-"]').forEach(el => el.style.display = 'none');
  // Guarded: not every category has an extra-fields block, and one of them stopped having
  // one when events left this form. An unknown category should open the plain form, not
  // throw on a null and leave the modal half-drawn.
  const cf = document.getElementById('catFields-' + cat);
  if (cf) cf.style.display = '';
  fillSpecSelects();   // the new detail dropdowns come from LISTING_SPECS
}

function backToCategories() {
  _postCategory = null;
  document.getElementById('postStep1').style.display = '';
  document.getElementById('postStep2').style.display = 'none';
}

function closePostModal() {
  closeModal('postModal');
  _pendingPhotoFiles = [];
  const inp = document.getElementById('pPhotoInput');
  if (inp) inp.value = '';
  const prev = document.getElementById('pPhotoPreview');
  if (prev) prev.innerHTML = '';
  setTimeout(() => {
    _postCategory = null;
    document.getElementById('postStep1').style.display = '';
    document.getElementById('postStep2').style.display = 'none';
  }, 200);
}

// ---- Photo upload helpers ----
function pickListingPhoto(input) {
  const files = [...input.files];
  input.value = ''; // reset so the same file can be re-picked after removal
  if (!files.length) return;
  for (const file of files) {
    if (_pendingPhotoFiles.length >= MAX_LISTING_PHOTOS) {
      toast(`You can add up to ${MAX_LISTING_PHOTOS} photos.`);
      break;
    }
    const isHEIC = file.type === 'image/heic' || file.type === 'image/heif'
      || /\.(heic|heif)$/i.test(file.name);
    if (isHEIC) { toast(`"${file.name}" is HEIC — not supported yet, skipped.`); continue; }
    if (!file.type.startsWith('image/')) { toast(`"${file.name}" isn't an image — skipped.`); continue; }
    if (file.size > 10 * 1024 * 1024) { toast(`"${file.name}" is over 10 MB — skipped.`); continue; }
    _pendingPhotoFiles.push(file);
  }
  renderPhotoPreviews();
}

function renderPhotoPreviews() {
  const prev = document.getElementById('pPhotoPreview');
  if (!prev) return;
  if (!_pendingPhotoFiles.length) { prev.innerHTML = ''; return; }
  prev.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;gap:8px;">` +
    _pendingPhotoFiles.map((file, i) => {
      const objUrl = URL.createObjectURL(file);
      return `<div style="position:relative;display:inline-block;">
        <img src="${objUrl}" style="width:84px;height:64px;object-fit:cover;border-radius:6px;display:block;">
        ${i === 0 ? '<span style="position:absolute;bottom:3px;left:3px;background:rgba(0,0,0,.6);color:#fff;font-size:9px;font-weight:600;padding:1px 5px;border-radius:8px;">Cover</span>' : ''}
        <button type="button" onclick="removeListingPhoto(${i})" style="position:absolute;top:-7px;right:-7px;background:#fff;border:1px solid var(--border);border-radius:50%;width:22px;height:22px;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.15);">&#215;</button>
      </div>`;
    }).join('') +
    `</div>
    <div style="font-size:11px;color:var(--text-faint);margin-top:6px;">${_pendingPhotoFiles.length} of ${MAX_LISTING_PHOTOS} photos · first photo is the cover · compressed before upload</div>`;
}

function removeListingPhoto(i) {
  _pendingPhotoFiles.splice(i, 1);
  renderPhotoPreviews();
}

async function submitListing() {
  const cat = _postCategory;
  if (!cat) { toast('Please select a category'); return; }
  const title = document.getElementById('pTitle').value.trim();
  const desc = document.getElementById('pDesc').value.trim();
  if (!title) { toast('Please add a title'); return; }
  // No signed-in user should be able to reach this — the post modal sits behind
  // requireAuth() — but never invent a poster identity as a fallback.
  const u = getEffectiveUser();
  if (!u) { toast('Please log in to post a listing.'); return; }
  const emoji = CATEGORY_EMOJI[cat];

  let price = null, location = '', details = {}, tags = [];

  if (cat === 'housing') {
    price = parseInt(document.getElementById('pH_price').value);
    location = document.getElementById('pH_loc').value.trim();
    details.room_type = document.getElementById('pH_type').value;
    tags = [...document.querySelectorAll('#pTags input:checked')].map(c => c.value);
    // Optional details (LISTING_SPECS.housing). Only what the student actually chose is saved:
    // an unstated detail is absent, never an empty string pretending to be an answer.
    for (const [id, key] of [['pH_distance', 'distance'], ['pH_available', 'available_from'],
        ['pH_lease', 'lease'], ['pH_beds', 'bedrooms'], ['pH_baths', 'bathrooms']]) {
      const v = document.getElementById(id)?.value;
      if (v) details[key] = v;
    }
    if (!price || isNaN(price)) { toast('Please enter monthly rent'); return; }
    if (!location) { toast('Please enter a location'); return; }
  } else if (cat === 'clothing') {
    price = parseInt(document.getElementById('pCL_price').value);
    details.condition = document.getElementById('pCL_cond').value;
    const itemType = document.getElementById('pCL_type')?.value;
    if (itemType) details.item_type = itemType;
    // A size from the list, or — with "Other…" — whatever the student typed (shoe 10, 32x32).
    const sizeSel = document.getElementById('pCL_sizeSel')?.value || '';
    const size = sizeSel === '__other' ? document.getElementById('pCL_size').value.trim() : sizeSel;
    if (size) details.size = size;
    details.brand = document.getElementById('pCL_brand').value.trim();
    details.delivery = document.getElementById('pCL_delivery').value;
    if (!price || isNaN(price)) { toast('Please enter a price'); return; }
  } else if (cat === 'technology') {
    price = parseInt(document.getElementById('pTK_price').value);
    details.condition = document.getElementById('pTK_cond').value;
    details.brand_model = document.getElementById('pTK_brand').value.trim();
    const device = document.getElementById('pTK_device')?.value;
    if (device) details.device = device;
    if (!price || isNaN(price)) { toast('Please enter a price'); return; }
  } else if (cat === 'donation') {
    details.condition = document.getElementById('pDN_cond').value;
    details.pickup_info = document.getElementById('pDN_pickup').value.trim();
  } else if (cat === 'other') {
    const p = parseInt(document.getElementById('pOT_price').value);
    if (!isNaN(p)) price = p;
  }

  // Soft photo nudge: for categories where a photo really helps, gently warn if there's none.
  // The student can still proceed — it's encouragement, not a hard block.
  const PHOTO_NUDGE_CATS = ['housing', 'clothing', 'technology'];
  if (!_pendingPhotoFiles.length && PHOTO_NUDGE_CATS.includes(cat)) {
    if (!confirm('Listings with a photo get far more interest from other students.\n\nPost without a photo?')) return;
  }

  const initialStatus = DB.settings.requireApproval ? 'pending' : 'approved';
  const submitBtn = document.getElementById('pSubmitBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  // Upload photos first so the URLs can be included in the insert (avoids a separate update call).
  // All-or-nothing: if any photo in the batch fails, clean up the ones already uploaded and
  // save the listing without photos, so we never end up with a half-uploaded gallery.
  let photoUrls = [];
  if (_pendingPhotoFiles.length) {
    try {
      for (let i = 0; i < _pendingPhotoFiles.length; i++) {
        if (submitBtn) submitBtn.textContent = `Uploading photo ${i + 1} of ${_pendingPhotoFiles.length}…`;
        const blob = await resizeImage(_pendingPhotoFiles[i]);
        const url  = await uploadListingPhoto(blob, u.id);
        photoUrls.push(url);
      }
    } catch (err) {
      console.error('[photo upload]', err);
      if (photoUrls.length) deleteListingPhotos(photoUrls); // remove any already uploaded this batch
      photoUrls = [];
      toast('Photos could not be uploaded — listing will be saved without them.');
    }
    if (submitBtn) submitBtn.textContent = 'Saving…';
  }

  const { data, error } = await supabaseClient
    .from('listings')
    .insert({ title, category: cat, price, location, description: desc || 'No description.', details, tags, poster_name: u.display_name || u.name, poster_initials: u.initials, poster_email: u.email, poster_color: u.color, poster_id: u.id || null, emoji, status: initialStatus, pinned: false, school: u.school || 'caldwell', photo_urls: photoUrls })
    .select().single();
  if (error) {
    toast('Could not save listing — please try again.');
    console.error(error.message);
    if (photoUrls.length) deleteListingPhotos(photoUrls); // remove orphaned uploads
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit for review'; }
    return;
  }
  logEvent('listing_submitted', { targetType: 'listing', targetId: data.id, targetLabel: title, school: u.school || 'caldwell', category: cat, after: { status: initialStatus, hasPhoto: photoUrls.length > 0, photoCount: photoUrls.length } });

  const typeLabel = details.room_type || CATEGORY_LABELS[cat];
  // Canonical poster object for the just-posted listing (matches posterFromRow's shape).
  const isOfficialPost = u.email === OFFICIAL_POSTER_EMAIL;
  const newPoster = {
    name: isOfficialPost ? u.name : (u.display_name || u.first || u.name),
    fullName: u.name, initials: u.initials, color: u.color, email: u.email,
    avatar_url: isOfficialPost ? null : (u.avatar_url || null),
    verified: !isOfficialPost, official: isOfficialPost,
    year: u.year || null, major: u.major || null, memberSince: u.created_at || null
  };
  if (initialStatus === 'pending') {
    DB.pending.push({ id: data.id, title, category: cat, type: typeLabel, rent: price, location, desc: desc || 'No description.', tags, details, poster: newPoster, submitted: 'Just now', created_at: data.created_at || new Date().toISOString(), emoji, status: 'pending', pinned: false, school: u.school || 'caldwell', photo_urls: photoUrls });
  } else {
    DB.listings.unshift({ id: data.id, title, category: cat, type: typeLabel, rent: price, location, desc: desc || 'No description.', tags, details, poster: newPoster, posted: 'Just now', created_at: data.created_at || new Date().toISOString(), emoji, status: 'approved', lifecycle_status: 'active', expires_at: null, pinned: false, school: u.school || 'caldwell', photo_urls: photoUrls });
    renderListings();
  }
  closePostModal();
  toast(initialStatus === 'pending' ? 'Listing submitted for admin review!' : 'Listing posted!');
  if (currentRole === 'admin') updateAdminBadges();
}
