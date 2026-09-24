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
  if (name === 'listings') renderListings();
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

function toggleDFSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : '';
  if (id === 'dfPrice') _dfPriceOpen = !open;
  if (id === 'dfCat')   _dfCatOpen   = !open;
  const btn = el.previousElementSibling;
  if (btn) btn.querySelector('.df-chevron').textContent = open ? '›' : '▾';
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

function buildScopeSectionHTML() {
  const s = _filters.schoolScope;
  const opt = (val, label) => `<button class="filter-chip${s === val ? ' active' : ''}" onclick="setSchoolScope('${val}')" aria-pressed="${s === val}">${label}</button>`;
  return `<div class="df-section"><div class="df-static-label">Scope</div><div class="df-body" style="padding-top:0"><div class="df-chips">${opt('mine', 'My school')}${opt('10mi', 'Within 10 mi')}${opt('25mi', 'Within 25 mi')}${opt('all', 'All schools')}</div></div></div>`;
}

function buildSortSectionHTML() {
  const s = _filters.sort || 'newest';
  const opt = (val, label) => `<button class="filter-chip${s === val ? ' active' : ''}" onclick="setSort('${val}')" aria-pressed="${s === val}">${label}</button>`;
  return `<div class="df-section"><div class="df-static-label">Sort by</div><div class="df-body" style="padding-top:0"><div class="df-chips">${opt('newest', 'Newest')}${opt('price_asc', 'Price ↑')}${opt('price_desc', 'Price ↓')}${opt('closest', 'Closest')}</div></div></div>`;
}

function renderDeepFilters() {
  const panel = document.getElementById('filterDrawerBody');
  if (!panel) return;
  const cat = _filters.category;

  // Compute price max from listings in current category (books included via browseItems)
  const catListings = browseItems().filter(l => isListingLive(l) && (cat === 'all' || l.category === cat));
  const prices = catListings.map(l => l.rent || 0).filter(p => p > 0);
  _pMax = prices.length ? Math.ceil(Math.max(...prices) / 50) * 50 : 2000;
  _pMax = Math.max(_pMax, 100);

  const curMin = _filters.minPrice || 0;
  const curMax = _filters.maxPrice !== null ? _filters.maxPrice : _pMax;
  const fillLeft  = (curMin / _pMax * 100).toFixed(1) + '%';
  const fillWidth = ((curMax - curMin) / _pMax * 100).toFixed(1) + '%';
  const minLabel  = curMin === 0     ? 'Min'  : '$' + curMin;
  const maxLabel  = curMax >= _pMax  ? 'Max'  : '$' + curMax;

  const priceSection = `
    <div class="df-section">
      <button class="df-toggle" onclick="toggleDFSection('dfPrice')" aria-expanded="${_dfPriceOpen}">
        <span>Price range</span><span class="df-chevron">${_dfPriceOpen ? '▾' : '›'}</span>
      </button>
      <div id="dfPrice" class="df-body" style="${_dfPriceOpen ? '' : 'display:none'}">
        <div class="price-labels"><span id="priceMinLabel">${minLabel}</span><span id="priceMaxLabel">${maxLabel}</span></div>
        <div class="price-range-wrap">
          <div class="price-range-track"><div class="price-range-fill" id="priceRangeFill" style="left:${fillLeft};width:${fillWidth}"></div></div>
          <input type="range" id="priceMin" min="0" max="${_pMax}" value="${curMin}" oninput="onPriceRange()" style="z-index:${curMin > _pMax * 0.9 ? 5 : 3}">
          <input type="range" id="priceMax" min="0" max="${_pMax}" value="${curMax}" oninput="onPriceRange()" style="z-index:4">
        </div>
      </div>
    </div>`;

  const catSection = buildCatFiltersHTML(cat);
  panel.innerHTML = `<div class="df-panel">${buildScopeSectionHTML()}${priceSection}${catSection}${buildSortSectionHTML()}</div>`;
  if (cat === 'books') attachDrawerCourseAC(); // typeahead needs a live DOM node — attach after innerHTML
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
  const minLbl = document.getElementById('priceMinLabel');
  const maxLbl = document.getElementById('priceMaxLabel');
  if (minLbl) minLbl.textContent = minV === 0    ? 'Min' : '$' + minV;
  if (maxLbl) maxLbl.textContent = maxV >= _pMax ? 'Max' : '$' + maxV;
  _filters.minPrice = minV === 0    ? null : minV;
  _filters.maxPrice = maxV >= _pMax ? null : maxV;
  clearTimeout(_kwTimer);
  _kwTimer = setTimeout(() => renderListings(), 80);
}

function buildCatFiltersHTML(cat) {
  const d = _filters.details;
  const chip = (key, val, label) => {
    const active = d[key] === val ? ' active' : '';
    return `<button class="filter-chip${active}" onclick="setDeepFilter('${key}','${val}')" aria-pressed="${!!active}">${label}</button>`;
  };
  let html = '';
  if (cat === 'housing') {
    html = `
      <div style="margin-bottom:12px">
        <div class="df-label">Room type</div>
        <div class="df-chips">
          ${chip('room_type','Private Room','Private')}
          ${chip('room_type','Shared Room','Shared')}
          ${chip('room_type','Full Apartment','Full Apt')}
          ${chip('room_type','Looking for Room','Looking')}
        </div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div>
          <div class="df-label">Amenities</div>
          <div class="df-chips">
            ${chip('furnished','yes','Furnished')}
            ${chip('petOk','yes','Pets OK')}
          </div>
        </div>
      </div>`;
  } else if (cat === 'clothing') {
    html = `
      <div style="margin-bottom:12px">
        <div class="df-label">Condition</div>
        <div class="df-chips">
          ${chip('condition','New','New')}
          ${chip('condition','Like New','Like New')}
          ${chip('condition','Used','Used')}
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div class="df-label">Size</div>
        <div class="df-chips">
          ${chip('size','XS','XS')}${chip('size','S','S')}${chip('size','M','M')}${chip('size','L','L')}${chip('size','XL','XL')}${chip('size','XXL','XXL')}
        </div>
      </div>
      <div>
        <div class="df-label">Pickup / delivery</div>
        <div class="df-chips">
          ${chip('delivery','Pickup only','Pickup only')}
          ${chip('delivery','Delivery available','Delivery')}
          ${chip('delivery','Either','Either')}
        </div>
      </div>`;
  } else if (cat === 'technology') {
    html = `
      <div>
        <div class="df-label">Condition</div>
        <div class="df-chips">
          ${chip('condition','New','New')}
          ${chip('condition','Like New','Like New')}
          ${chip('condition','Used','Used')}
          ${chip('condition','For Parts','For Parts')}
        </div>
      </div>`;
  } else if (cat === 'donation') {
    html = `
      <div>
        <div class="df-label">Condition</div>
        <div class="df-chips">
          ${chip('condition','Good','Good')}
          ${chip('condition','Fair','Fair')}
          ${chip('condition','Worn','Worn')}
        </div>
      </div>`;
  } else if (cat === 'organization_event') {
    const fromVal = d.eventDateFrom || '';
    const toVal   = d.eventDateTo   || '';
    html = `
      <div>
        <div class="df-label">Event date</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)">
            From <input type="date" class="form-input" style="width:auto;padding:6px 10px;font-size:13px" value="${fromVal}" oninput="setDeepDate('eventDateFrom',this.value)">
          </div>
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)">
            To <input type="date" class="form-input" style="width:auto;padding:6px 10px;font-size:13px" value="${toVal}" oninput="setDeepDate('eventDateTo',this.value)">
          </div>
        </div>
      </div>`;
  } else if (cat === 'books') {
    const editions = [...new Set(_books.map(b => (b.edition || '').trim()).filter(Boolean))].sort();
    html = `
      <div style="margin-bottom:12px">
        <div class="df-label">Book type</div>
        <div class="df-chips">
          ${chip('bookType','course','Textbooks')}
          ${chip('bookType','other','Other books')}
        </div>
      </div>
      <div style="margin-bottom:12px">
        <div class="df-label">Course</div>
        <div style="position:relative">
          <input class="form-input" id="dfCourseInput" placeholder="e.g. NU 301..." autocomplete="off" value="${escAttr(d.courseCode || '')}" style="margin-bottom:0">
          <div class="course-ac-list" id="dfCourseList" style="display:none"></div>
        </div>
      </div>
      ${editions.length ? `<div>
        <div class="df-label">Edition</div>
        <select class="form-select" onchange="setDeepEdition(this.value)" style="margin-bottom:0;max-width:200px">
          <option value="">All editions</option>
          ${editions.map(e => `<option${d.edition === e ? ' selected' : ''}>${esc(e)}</option>`).join('')}
        </select>
      </div>` : ''}`;
  }

  if (!html) return '';
  return `
    <div class="df-section">
      <button class="df-toggle" onclick="toggleDFSection('dfCat')" aria-expanded="${_dfCatOpen}">
        <span>${CATEGORY_LABELS[cat] || cat} filters</span><span class="df-chevron">${_dfCatOpen ? '▾' : '›'}</span>
      </button>
      <div id="dfCat" class="df-body" style="${_dfCatOpen ? '' : 'display:none'}">${html}</div>
    </div>`;
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
    if (d.room_type  && l.details.room_type !== d.room_type)     return false;
    if (d.furnished  && !l.tags.includes('Furnished'))            return false;
    if (d.petOk      && !l.tags.includes('Pet friendly'))         return false;
    if (d.condition  && l.details.condition !== d.condition)      return false;
    if (d.delivery   && l.details.delivery !== d.delivery)        return false;
    if (d.size       && !(l.details.size || '').toLowerCase().includes(d.size.toLowerCase())) return false;
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
    const label = detailTagLabels[k] || k;
    const prettyVal = k === 'bookType' ? (v === 'course' ? 'Textbooks' : 'Other books') : v;
    const display = (k === 'furnished' || k === 'petOk') ? label : `${label}: ${prettyVal}`;
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
    host.innerHTML = mkSectionHTML('results', label, all, `${all.length} listing${all.length !== 1 ? 's' : ''}`);
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

  host.innerHTML =
      mkSectionHTML('featured', 'Featured', sortListings(pinnedFiltered))
    + mkSectionHTML('school', mySchool ? 'At your school' : 'All listings', atMine)
    + mkSectionHTML('nearby', 'From nearby campuses', nearby);
}

// How many cards a section shows before "See all". Three rows of two on a phone, two rows of
// three on a desktop — enough to be worth scrolling, short enough that the next heading is
// reachable without committing to the whole list.
const MK_PREVIEW = 6;
// Which sections the student has unfolded. Not persisted: it describes this visit to the
// page, not a preference, and a section silently already-open on next launch would be a
// small mystery rather than a convenience.
const _mkOpen = {};

function mkToggleSection(key) {
  _mkOpen[key] = !_mkOpen[key];
  renderListings();
}

function mkSectionHTML(key, title, items, meta) {
  // A heading over nothing is worse than no heading — same rule the home feed follows.
  if (!items.length) return '';
  const open  = !!_mkOpen[key];
  const more  = items.length > MK_PREVIEW;
  const shown = open ? items : items.slice(0, MK_PREVIEW);
  // Inside a section called Featured every card is featured, so the per-card badge would be
  // repeating the heading. In the flat results list there is no heading saying it, so there
  // the badge earns its place.
  const badge = l => key === 'results' && l.pinned;
  return `
    <section class="mk-sec">
      <div class="mk-sec-head">
        <h2 class="mk-sec-title">${esc(title)}</h2>
        ${meta ? `<span class="mk-sec-meta">${esc(meta)}</span>` : ''}
        ${more ? `<button class="mk-sec-more${open ? ' open' : ''}" onclick="mkToggleSection('${key}')"
            aria-expanded="${open}">${open ? 'Show less' : 'See all'}${icon('chevDown', 13)}</button>` : ''}
      </div>
      <div class="listings-grid">${shown.map(l => listingCardHTML(l, badge(l))).join('')}</div>
    </section>`;
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
  closeModal('detailModal');
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
// as its height needs (masonryFit). Used by the Marketplace and Home (.listings-grid), search
// results (.sq-grid) and the Events page (.ev-grid, one per day).
//
// A ResizeObserver re-measures a card whenever its size changes — which covers its photo loading,
// fonts arriving and the window being resized — and a MutationObserver picks up new cards when a
// feed is re-rendered, so no render function has to remember to call anything.
// Phones keep the even 4:5 grid; below the breakpoint the spans are cleared and the class removed.
// If this never runs, .is-masonry is never added and the page is the ordinary even grid.
const MASONRY_ROW = 4;    // must match grid-auto-rows in styles.css
const MASONRY_GAP = 12;   // must match column-gap in styles.css (rows get the same space)
const MASONRY_GRIDS = '.listings-grid, .sq-grid, .ev-grid';
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

// Rich poster section for the detail view (larger avatar, trust badge, year/major/school, member-since).
function detailPosterHTML(l) {
  const p = l.poster;
  const clickable = !p.official && l.poster_id;
  const bits = [p.year, p.major].filter(Boolean);
  const school = schoolBadgeHTML(l);
  const trust = p.official ? `<span class="trust-official">Official</span>` : '';
  const since = p.memberSince
    ? `On Nestrel since ${new Date(p.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
    : (p.official ? 'Official account' : '');
  return `<div class="detail-poster"${clickable ? ` onclick="viewStudentProfile('${l.poster_id}')" style="cursor:pointer"` : ''}>
    ${avatarHTML(p, 46)}
    <div style="min-width:0">
      <div class="detail-poster-name">${esc(p.name)}${trust}</div>
      ${bits.length || school ? `<div class="detail-poster-sub">${esc(bits.join(' · '))}${bits.length && school ? ' · ' : ''}${school}</div>` : ''}
      ${since ? `<div class="detail-poster-since">${since}</div>` : ''}
    </div>
  </div>`;
}

function openDetail(id) {
  const l = DB.listings.find(x => x.id === id) || DB.pending.find(x => x.id === id); if (!l) return;
  const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
  const hero = l.photo_urls?.length
    ? photoGalleryHtml(l.photo_urls, { natural: true, maxHeight: '60vh', radius: '0', mainId: 'detailGalMain', alt: l.title })
    : `<div class="detail-noimg" style="background:${cat.bg};color:${cat.text}">
         <div class="detail-noimg-cat">${CATEGORY_LABELS[l.category] || 'Listing'}</div>
         <div class="detail-noimg-title">${esc(l.title)}</div>
       </div>`;
  const messageBtn = !l.poster.official
    ? `<button class="btn-full btn-brand" onclick="closeModal('detailModal');sContact(${l.id})">Message ${esc(l.poster.name)}</button>` : '';
  document.getElementById('detailContent').innerHTML = `
    <div class="detail-top">${detailPosterHTML(l)}</div>
    ${hero}
    <div class="detail-body">
      ${l.photo_urls?.length ? `<div class="detail-title">${esc(l.title)}</div>` : ''}
      ${l.location ? `<div style="color:var(--text-muted);font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:5px">${icon('pin', 14)} ${esc(l.location)}</div>` : ''}
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <div class="detail-price">${priceLabel(l)}</div>
        <span class="pill pill-active">${esc(l.type)}</span>
        ${l.pinned ? '<span class="pill pill-pinned">' + icon('star',11) + ' Featured</span>' : ''}
        ${(() => { if (l.status !== 'approved' || (l.lifecycle_status && l.lifecycle_status !== 'active')) { const [bg, col, label] = listingLifecycleBadge(l); return `<span class="pill" style="background:${bg};color:${col}">${label}</span>`; } return ''; })()}
      </div>
      ${l.tags && l.tags.length ? `<div class="detail-tags">${l.tags.map(t => `<span class="detail-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div style="font-size:14px;line-height:1.7;color:var(--text-muted);margin-bottom:18px;">${esc(l.desc)}</div>
      ${messageBtn}
      ${(() => { const eu = getEffectiveUser(); return eu && eu.id !== l.poster_id && !l.poster.official; })() ? `<div style="text-align:center;margin-top:12px;"><button onclick="closeModal('detailModal');openReportModal(${l.id})" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-faint);font-family:'DM Sans',sans-serif;" onmouseover="this.style.color='var(--danger)'" onmouseout="this.style.color='var(--text-faint)'">${icon('flag',14)} Report this listing</button></div>` : ''}
      ${ownerManagePanelHtml(l)}
    </div>`;
  openModal('detailModal');
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
  closeModal('detailModal');
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
  closeModal('detailModal');
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
  closeModal('detailModal');
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
  closeModal('detailModal');
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
    if (!price || isNaN(price)) { toast('Please enter monthly rent'); return; }
    if (!location) { toast('Please enter a location'); return; }
  } else if (cat === 'clothing') {
    price = parseInt(document.getElementById('pCL_price').value);
    details.condition = document.getElementById('pCL_cond').value;
    details.size = document.getElementById('pCL_size').value.trim();
    details.brand = document.getElementById('pCL_brand').value.trim();
    details.delivery = document.getElementById('pCL_delivery').value;
    if (!price || isNaN(price)) { toast('Please enter a price'); return; }
  } else if (cat === 'technology') {
    price = parseInt(document.getElementById('pTK_price').value);
    details.condition = document.getElementById('pTK_cond').value;
    details.brand_model = document.getElementById('pTK_brand').value.trim();
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
