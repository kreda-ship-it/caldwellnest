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
  updateMTabbar(name);
  document.querySelector('.s-nav')?.classList.remove('m-hidden'); // navigating always reveals the top bar
  if (window.innerWidth <= 768) window.scrollTo(0, 0); // app-style: each page opens at its top
}

// Highlights the mobile bottom-bar tab matching the current page. Search and Events
// share page-listings; the active category decides which of the two lights up.
function updateMTabbar(name) {
  const tabId = name === 'home' ? 'mtab-home'
    : name === 'listings' ? (_filters.category === 'organization_event' ? 'mtab-events' : 'mtab-search')
    : name === 'messages' ? 'mtab-messages'
    : null; // profile & other pages: no tab highlighted
  document.querySelectorAll('#mTabbar .m-tab').forEach(t => t.classList.toggle('active', t.id === tabId));
}

// One source of truth for the unread-message count on both the desktop nav badge
// and the mobile Messages tab badge.
function updateMsgBadges() {
  const show = sUnreadCount > 0;
  ['msgBadge', 'mMsgBadge'].forEach(id => {
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

function guestBrowse() { showPage('listings'); }
function requireAuth(action) {
  if (!getEffectiveUser()) { openModal('loginModal'); return false; }
  if (action === 'postListing') openModal('postModal');
  return true;
}

function setListingCat(cat, el) {
  _filters.category = cat;
  _filters.details = {};  // clear category-specific filters on category switch
  document.querySelectorAll('#sCategoryChips .cat-tab').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  else { const t = [...document.querySelectorAll('#sCategoryChips .cat-tab')].find(b => b.getAttribute('onclick')?.includes(`'${cat}'`)); if (t) t.classList.add('active'); }
  renderDeepFilters();
  renderListings();
}
function onListingSearch(val) {
  clearTimeout(_kwTimer);
  _kwTimer = setTimeout(() => { _filters.keyword = val.trim().toLowerCase(); renderListings(); }, 250);
}
function clearListingCat() {
  _filters.category = 'all';
  _filters.details = {};
  document.querySelectorAll('#sCategoryChips .cat-tab').forEach(c => c.classList.remove('active'));
  const allChip = document.querySelector('#sCategoryChips .cat-tab');
  if (allChip) allChip.classList.add('active');
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
  document.querySelectorAll('#sCategoryChips .cat-tab').forEach(c => c.classList.remove('active'));
  const allChip = document.querySelector('#sCategoryChips .cat-tab');
  if (allChip) allChip.classList.add('active');
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

function openFilterDrawer() {
  renderDeepFilters();
  const drawer   = document.getElementById('filterDrawer');
  const backdrop = document.getElementById('filterDrawerBackdrop');
  if (!drawer) return;
  backdrop.classList.add('open');
  drawer.classList.add('open');
  document.getElementById('filtersBtn')?.classList.add('open');
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
  document.getElementById('filtersBtn')?.classList.remove('open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _drawerEscHandler);
  document.getElementById('filtersBtn')?.focus();
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

function renderListings() {
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
  const kwMatch  = l => !_filters.keyword ||
    (l.title || '').toLowerCase().includes(_filters.keyword) ||
    (l.desc || '').toLowerCase().includes(_filters.keyword) ||
    (l.author || '').toLowerCase().includes(_filters.keyword) ||
    (l.isbn || '').replace(/[- ]/g, '').includes(_filters.keyword.replace(/[- ]/g, ''));
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
  const badge = document.getElementById('filtersBtnCount');
  if (badge) {
    badge.textContent = panelCount;
    badge.style.display = panelCount ? 'inline-flex' : 'none';
  }

  // Pinned strip — only when no filters active
  const noFilters = _filters.category === 'all' && !_filters.keyword && _filters.minPrice === null && _filters.maxPrice === null && !Object.keys(_filters.details).length;
  const strip = document.getElementById('pinnedStrip');
  if (pinnedFiltered.length && noFilters) {
    strip.style.display = 'block';
    document.getElementById('pinnedGrid').innerHTML = pinnedFiltered.map(l => listingCardHTML(l, true)).join('');
  } else { strip.style.display = 'none'; }

  // Regular grid
  const grid = document.getElementById('listingsGrid');
  if (filtered.length === 0) {
    grid.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--text-faint);column-span:all">
      <div style="margin-bottom:12px;color:var(--text-faint)">${approved.length === 0 ? ico('inbox', 38) : ico('search', 38)}</div>
      <div style="font-size:15px;font-weight:500;margin-bottom:6px;color:var(--text)">${approved.length === 0 ? 'No listings yet — be the first to post one!' : 'No listings match these filters.'}</div>
      ${!noFilters ? `<div style="font-size:13px;margin-bottom:16px">Try widening the price range or clearing a filter.</div><button onclick="clearListingFilters()" style="background:none;border:1px solid var(--border);border-radius:20px;padding:6px 18px;font-size:13px;color:var(--text-muted);cursor:pointer;font-family:inherit;">Clear filters</button>` : ''}
    </div>`;
    return;
  }
  grid.innerHTML = sortListings(filtered).map(l => listingCardHTML(l, false)).join('');
}

// esc() and escAttr() live in js/utils.js so every file can use them.

// Small Lucide-style line icons. stroke=currentColor so each inherits its context's color.
function ico(name, size = 16) {
  const p = {
    search:  '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/>',
    image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    pin:     '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    school:  '<path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/>',
    inbox:   '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    // Category line-art (one per listing category — use these app-wide, not emojis)
    home:    '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    shirt:   '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    gift:    '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    calendar:'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    tag:     '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><circle cx="7" cy="7" r="1"/>',
    book:    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'
  }[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0">${p}</svg>`;
}

// Category → line-art icon name. For compact spots where the full word doesn't fit
// (chat cards, picker thumbs) — never emojis. NOT used in the post modal (Kal's call:
// its tiles stay text-only).
const CATEGORY_ICON = { housing:'home', clothing:'shirt', technology:'monitor', donation:'gift', organization_event:'calendar', other:'tag' };
function catIcon(category, size = 18) { return ico(CATEGORY_ICON[category] || 'tag', size); }

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
  return `<span class="school-badge">${ico('school', 10)} ${name}${distLabel}</span>`;
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
  if (p.official) return `<span class="trust-official" title="Official CaldwellNest account">Official</span>`;
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

// Instagram-style poster header that sits on TOP of each card. Compact, supporting — never the hero.
function posterHeaderHTML(l) {
  const p = l.poster;
  const eu = getEffectiveUser();
  const clickable = !p.official && l.poster_id;
  const schoolLine = posterSchoolLine(l);
  return `<div class="poster-head"${clickable ? ` onclick="event.stopPropagation();viewStudentProfile('${l.poster_id}')" style="cursor:pointer"` : ''}>
    ${avatarHTML(p, 32)}
    <div style="min-width:0">
      <div class="poster-head-name">${esc(p.name)}${trustBadgeHTML(p)}</div>
      ${schoolLine ? `<div class="poster-head-sub">${schoolLine}</div>` : ''}
    </div>
    ${eu && eu.id !== l.poster_id && !p.official && !l.isBook ? `<button class="lc-report" onclick="event.stopPropagation();openReportModal(${l.id})" title="Report this listing" aria-label="Report listing">&#9873;</button>` : ''}
  </div>`;
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

function listingCardHTML(l, isPinned) {
  const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
  const catLabel = CATEGORY_LABELS[l.category] || 'Listing';
  const photoCount = l.photo_urls?.length || 0;
  // Books route to their own detail + contact path — ids are per-table sequences.
  const openFn    = l.isBook ? 'openBookDetail' : 'openDetail';
  const contactFn = l.isBook ? 'bContact' : 'sContact';
  const messageBtn = !l.poster.official
    ? `<button class="btn-contact" onclick="event.stopPropagation();${contactFn}(${l.id})">Message</button>` : '';
  // Buyers should see a deal is already in progress BEFORE they open/message (Facebook
  // Marketplace behavior — pending stays visible, badged, so people know to hurry or move on).
  const pendingBadge = l.lifecycle_status === 'pending_sale'
    ? '<span class="pin-badge" style="background:#3B5BA5">Pending sale</span>' : '';

  // HERO: a natural-ratio photo, or (no photo) a colored typographic panel where the title IS the design.
  const hero = photoCount
    ? `<div class="lc-photo" style="background:${cat.bg}">
         <img src="${escAttr(l.photo_urls[0])}" alt="${escAttr(l.title)}" loading="lazy" class="lc-photo-img">
         ${photoCount > 1 ? `<span class="lc-count">${ico('image', 12)} ${photoCount}</span>` : ''}
         ${isPinned ? '<span class="pin-badge">&#128204; Featured</span>' : pendingBadge}
       </div>`
    : `<div class="lc-noimg" style="background:${cat.bg};color:${cat.text}">
         <div class="lc-noimg-cat">${catLabel}</div>
         <div class="lc-noimg-title">${esc(l.title)}</div>
         ${isPinned ? '<span class="pin-badge">&#128204; Featured</span>' : pendingBadge}
       </div>`;

  return `<div class="listing-card${isPinned ? ' pinned-card' : ''}" tabindex="0" role="button" aria-label="${escAttr(l.title)}"
      onclick="${openFn}(${l.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${openFn}(${l.id})}">
    ${posterHeaderHTML(l)}
    ${hero}
    <div class="lc-body">
      <div class="lc-meta">${photoCount ? `${catLabel} · ` : ''}${l.posted}</div>
      ${photoCount ? `<div class="lc-title">${esc(l.title)}</div>` : ''}
      ${l.location ? `<div class="lc-loc">${ico('pin', 13)} ${esc(l.location)}</div>` : ''}
      ${l.desc && l.desc !== 'No description.' ? `<div class="lc-desc${photoCount ? '' : ' lc-desc-tall'}">${esc(l.desc)}</div>` : ''}
      <div class="lc-foot">
        <div class="lc-price"${!photoCount ? ` style="color:${cat.text}"` : ''}>${priceLabel(l)}</div>
        ${messageBtn}
      </div>
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
    ? `On CaldwellNest since ${new Date(p.memberSince).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
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
      ${l.location ? `<div style="color:var(--text-muted);font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:5px">${ico('pin', 14)} ${esc(l.location)}</div>` : ''}
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <div class="detail-price">${priceLabel(l)}</div>
        <span class="pill pill-active">${esc(l.type)}</span>
        ${l.pinned ? '<span class="pill pill-pinned">&#128204; Featured</span>' : ''}
        ${(() => { if (l.status !== 'approved' || (l.lifecycle_status && l.lifecycle_status !== 'active')) { const [bg, col, label] = listingLifecycleBadge(l); return `<span class="pill" style="background:${bg};color:${col}">${label}</span>`; } return ''; })()}
      </div>
      ${l.tags && l.tags.length ? `<div class="detail-tags">${l.tags.map(t => `<span class="detail-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div style="font-size:14px;line-height:1.7;color:var(--text-muted);margin-bottom:18px;">${esc(l.desc)}</div>
      ${messageBtn}
      ${(() => { const eu = getEffectiveUser(); return eu && eu.id !== l.poster_id && !l.poster.official; })() ? `<div style="text-align:center;margin-top:12px;"><button onclick="closeModal('detailModal');openReportModal(${l.id})" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-faint);font-family:'DM Sans',sans-serif;" onmouseover="this.style.color='var(--danger)'" onmouseout="this.style.color='var(--text-faint)'">&#9873; Report this listing</button></div>` : ''}
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
  if (!eu || eu.id !== l.poster_id || l.status !== 'approved') return '';
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
    actions = `<button class="btn-sm-a btn-a-neutral" onclick="lifecycleAction(${l.id},'listings','active')">Mark active again</button>`;
  } else if (ls === 'withdrawn') {
    actions = `<button class="btn-sm-a btn-a-success" onclick="lifecycleAction(${l.id},'listings','active')">Reactivate</button>`;
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
  toast('✓ Listing updated');
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
  toast('✓ Deadline set');
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
  toast('✓ Deadline cleared');
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
  toast('✓ Listing renewed');
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
    const { data: prof } = await supabaseClient.from('profiles').select('display_name, first_name, last_name, initials, color').eq('id', l.poster_id).single();
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
  document.getElementById('catFields-' + cat).style.display = '';
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

function clearListingPhoto() {
  _pendingPhotoFiles = [];
  const inp = document.getElementById('pPhotoInput');
  if (inp) inp.value = '';
  const prev = document.getElementById('pPhotoPreview');
  if (prev) prev.innerHTML = '';
}

async function submitListing() {
  const cat = _postCategory;
  if (!cat) { toast('Please select a category'); return; }
  const title = document.getElementById('pTitle').value.trim();
  const desc = document.getElementById('pDesc').value.trim();
  if (!title) { toast('Please add a title'); return; }
  const u = getEffectiveUser() || { name: 'Demo User', initials: 'DU', email: 'demo@caldwell.edu', color: AC[5] };
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
  } else if (cat === 'organization_event') {
    details.org_name = document.getElementById('pEV_org').value.trim();
    details.event_date = document.getElementById('pEV_date').value;
    details.event_time = document.getElementById('pEV_time').value;
    details.event_contact = document.getElementById('pEV_contact').value.trim();
    location = document.getElementById('pEV_loc').value.trim();
  } else if (cat === 'other') {
    const p = parseInt(document.getElementById('pOT_price').value);
    if (!isNaN(p)) price = p;
  }

  // Soft photo nudge: for categories where a photo really helps, gently warn if there's none.
  // The student can still proceed — it's encouragement, not a hard block.
  const PHOTO_NUDGE_CATS = ['housing', 'clothing', 'technology', 'organization_event'];
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
    DB.log.unshift({ type: 'listing', text: `New listing submitted: "${title}"`, time: 'Just now', color: '#d4860a' });
  } else {
    DB.listings.unshift({ id: data.id, title, category: cat, type: typeLabel, rent: price, location, desc: desc || 'No description.', tags, details, poster: newPoster, posted: 'Just now', created_at: data.created_at || new Date().toISOString(), emoji, status: 'approved', lifecycle_status: 'active', expires_at: null, pinned: false, school: u.school || 'caldwell', photo_urls: photoUrls });
    DB.log.unshift({ type: 'listing', text: `New listing posted (auto-approved): "${title}"`, time: 'Just now', color: '#1a7a45' });
    renderListings();
  }
  closePostModal();
  toast(initialStatus === 'pending' ? '✓ Listing submitted for admin review!' : '✓ Listing posted!');
  if (currentRole === 'admin') updateAdminBadges();
}
