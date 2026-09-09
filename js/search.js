// ============================================================
// STUDENT — SEARCH
// ============================================================
// Its own page since 2026-09-08. Before that goSearch() showed page-listings, which is what
// goHome() shows, so two of the five bottom tabs led to the same screen and only the
// highlight differed.
//
// THE CORPUS IS TINY, AND EVERY DECISION HERE FOLLOWS FROM THAT. Forty listings, twenty
// books, a dozen events. A typed query returns nothing most of the time — zero results is
// Tuesday, not a failure. So what fills the screen BEFORE anybody types is the product, and
// the text box is the fallback rather than the point.
//
// Nothing here defines what a match is. Marketplace items go through matchItemKeyword() in
// js/listings.js — the same function the feed uses — and events through evMatchEvents() in
// js/events.js. Two copies of "what counts as a match" is the book_listings-bypassing-
// visible_listings bug one layer up.

let _sqQuery = '';
// Set by goSearch() and consumed once. A flag rather than a call from goSearch() because the
// input is created by renderSearch(), which is async — focusing before it paints would find
// nothing, and focusing on every render would steal the cursor back from a student who had
// tapped elsewhere on the page.
let _sqAutoFocus = false;
let _sqEvents = [];
let _sqTimer = null;

// RECENT SEARCHES LIVE IN localStorage, and that is a deliberate exception to the rule the
// rest of this app follows. Everything else we remember is WHERE YOU WERE, which should die
// with the tab — sessionStorage. What you searched for last week is different: it is still
// useful when you come back, and re-typing "nu 301" every session is the papercut this
// feature exists to remove. The inconsistency is the decision, not an oversight.
const SQ_RECENT_KEY = 'cn_recent_searches';
const SQ_RECENT_MAX = 6;

function sqRecent() {
  try { return JSON.parse(localStorage.getItem(SQ_RECENT_KEY)) || []; } catch (e) { return []; }
}

function sqRemember(q) {
  const term = (q || '').trim();
  // Two characters is not a search, it is somebody still typing. Storing it would fill the
  // list with prefixes of the thing they actually looked for.
  if (term.length < 3) return;
  const list = [term, ...sqRecent().filter(x => x.toLowerCase() !== term.toLowerCase())]
    .slice(0, SQ_RECENT_MAX);
  try { localStorage.setItem(SQ_RECENT_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
}

function sqForget(term) {
  try {
    localStorage.setItem(SQ_RECENT_KEY,
      JSON.stringify(sqRecent().filter(x => x !== term)));
  } catch (e) { /* private mode */ }
  renderSearch();
}

async function renderSearch() {
  const wrap = document.getElementById('searchBody');
  if (!wrap) return;

  // Same honesty as the events feed: boot paints the last page before the session resolves,
  // and every corpus here is behind a grant. "Nothing found" would be a lie about the
  // marketplace when the truth is that we cannot see it yet.
  if (!getEffectiveUser()) {
    wrap.innerHTML = `
      <div class="sq-empty">
        <div class="sq-empty-t">Search CaldwellNest</div>
        <p>Sign in to search listings, books and events.</p>
        <button class="ev-empty-btn" onclick="requireAuth()">Sign in</button>
      </div>`;
    return;
  }

  wrap.innerHTML = sqShellHTML();
  sqPaintResults();

  if (_sqAutoFocus) {
    _sqAutoFocus = false;
    const el = document.getElementById('sqInput');
    // preventScroll keeps the page where showPage() put it. Focusing an input near the top of
    // a freshly painted page can otherwise scroll it under the sticky header on iOS.
    el?.focus({ preventScroll: true });
  }
  // Events are fetched once per visit rather than on every keystroke. The marketplace is
  // already in memory (browseItems), events are not, and a query per character would be a
  // request per character.
  if (!_sqEvents.length) { _sqEvents = await sqLoadEvents(); sqPaintResults(); }
}

async function sqLoadEvents() {
  const eu = getEffectiveUser();
  if (!eu) return [];
  const { data } = await supabaseClient
    .from('visible_events')
    .select('id, org_id, title, description, location, event_type, starts_at, poster_url, ' +
            'is_browsable, has_ended, going_count, seats_left, registration_open')
    .eq('school', eu.school || 'caldwell')
    .order('starts_at', { ascending: true });
  const rows = (data || []).filter(e => e.is_browsable);
  // evMatchEvents searches the ORG NAME too, and it reads that from _evOrgs. Without this the
  // org half of the match would silently never fire for a student who has not opened Events.
  await evLoadOrgs(rows);
  return rows;
}

function sqSet(v) {
  _sqQuery = v;
  clearTimeout(_sqTimer);
  // Only the results repaint, so the input keeps focus and the caret stays put. Rebuilding the
  // shell on every keystroke is the bug the door's search box and the events search both had.
  sqPaintResults();
  // Remembered on a pause, not on every character: saving as they type would store "n", "nu",
  // "nu 3" and push the real search off the end of a six-item list.
  _sqTimer = setTimeout(() => sqRemember(_sqQuery), 900);
}

function sqRun(term) {
  _sqQuery = term;
  const el = document.getElementById('sqInput');
  if (el) el.value = term;
  sqRemember(term);
  sqPaintResults();
  el?.focus();
}

// Clears the CATEGORY as well as the text. To a student the × means "start again", and
// leaving a category chip lit while the box empties would return them to an entry state that
// is quietly still narrowed.
function sqClear() {
  _sqQuery = '';
  if (_filters.category !== 'all') setListingCat('all');
  const el = document.getElementById('sqInput');
  if (el) { el.value = ''; el.focus(); }
  sqPaintResults();
}

function sqShellHTML() {
  return `
    <div class="sq-bar">
      <span class="sq-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg></span>
      <!-- Its own form, for the reason the listings search box documents: Chrome pools every
           input NOT inside a form and autofills the saved credential into the first visible
           one. autocomplete="off" has not stopped that for years. -->
      <form onsubmit="return false" autocomplete="off" class="form-shell sq-form">
        <input class="sq-input" id="sqInput" name="cn-search" autocomplete="off"
               placeholder="Search listings, books and events…"
               value="${escAttr(_sqQuery)}" oninput="sqSet(this.value)">
      </form>
      ${(_sqQuery || _filters.category !== 'all')
        ? `<button class="sq-x" onclick="sqClear()" aria-label="Clear">&times;</button>` : ''}
    </div>

    <div id="sqBody"></div>`;
}

// Filters and the layout switch belong WITH the results, not above the entry state. On the
// entry state there is nothing to filter and nothing laid out, so both were controls acting on
// nothing — and the Filters button carrying a count while no results were shown was actively
// confusing. They appear on the empty-result state too, because a filter is precisely the
// thing to change when nothing came back.
//
// The drawer itself is the same one Browse used, over the same _filters object: a cap set here
// is the cap Browse shows. One marketplace, one state.
function sqToolsHTML() {
  return `
    <div class="sq-tools">
      <button class="filters-btn" id="filtersBtn" onclick="openFilterDrawer()"
              aria-haspopup="dialog" aria-label="Open filters">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
        <span>Filters</span><span class="filters-btn-count" id="filtersBtnCount" style="display:none"></span>
      </button>
      ${sqViewToggleHTML()}
    </div>`;
}

// ---------- How results are laid out ----------
// GRID OR LIST, and the choice is remembered. A student looking for a desk wants to see
// things; a student looking for a textbook wants to read titles. Neither is the right default
// for the other, and the app cannot tell which one they are today.
//
// localStorage, not sessionStorage, and that is now a RULE rather than the exception recent
// searches used to be: sessionStorage remembers WHERE YOU WERE and dies with the tab;
// localStorage remembers WHAT YOU PREFER and does not. A layout preference is not a position.
const SQ_VIEW_KEY = 'cn_search_view';
function sqView() {
  try { return localStorage.getItem(SQ_VIEW_KEY) === 'grid' ? 'grid' : 'list'; }
  catch (e) { return 'list'; }
}
function sqSetView(v) {
  try { localStorage.setItem(SQ_VIEW_KEY, v); } catch (e) { /* private mode */ }
  document.querySelectorAll('[data-sqview]').forEach(b =>
    b.classList.toggle('is-on', b.getAttribute('data-sqview') === v));
  sqPaintResults();
}
function sqViewToggleHTML() {
  const v = sqView();
  return `
    <div class="sq-view" role="group" aria-label="Result layout">
      <button data-sqview="list" class="${v === 'list' ? 'is-on' : ''}" onclick="sqSetView('list')"
              aria-label="List view" title="List">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>
      <button data-sqview="grid" class="${v === 'grid' ? 'is-on' : ''}" onclick="sqSetView('grid')"
              aria-label="Grid view" title="Grid">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      </button>
    </div>`;
}

// ---------- Entry state ----------
function sqEntryHTML() {
  const recent = sqRecent();

  // Courses that actually have a book listed, not the whole catalogue. A list of every course
  // at the university is a directory; a list of the ones somebody is selling a book for is a
  // shortcut. Sorted so it reads predictably rather than by whoever posted last.
  const courses = [...new Set((_books || [])
    .filter(b => b.course_code && isListingLive(bookAsListing(b)))
    .map(b => b.course_code))].sort().slice(0, 12);

  const cats = [['housing', 'Housing'], ['books', 'Books'], ['technology', 'Technology'],
                ['clothing', 'Clothing'], ['donation', 'Free items'], ['other', 'Other']];

  return `
    ${recent.length ? `
      <div class="sq-sec">
        <div class="sq-lab">Recent</div>
        <div class="sq-chips">${recent.map(t => `
          <span class="sq-recent">
            <button class="sq-recent-go" onclick="sqRun('${escAttr(t)}')">${esc(t)}</button>
            <button class="sq-recent-x" onclick="sqForget('${escAttr(t)}')" aria-label="Forget">&times;</button>
          </span>`).join('')}</div>
      </div>` : ''}

    <!-- Chips that NARROW, not tiles that leave. The previous version made the biggest block
         on this page six buttons that all navigated to Browse — you tapped Search and the
         dominant element said "go somewhere else". A category here filters the results below
         it, which is what makes Search answer a question on its own rather than act as a
         launcher for another page. -->
    <div class="sq-sec">
      <div class="sq-lab">Category</div>
      <div class="sq-chips">${cats.map(([v, l]) =>
        `<button class="sq-chip${_filters.category === v ? ' is-on' : ''}"
                 onclick="sqCat('${v}')">${l}</button>`).join('')}</div>
    </div>

    ${courses.length ? `
      <div class="sq-sec">
        <div class="sq-lab">Courses with books listed</div>
        <div class="sq-chips">${courses.map(c =>
          `<button class="sq-chip" onclick="sqRun('${escAttr(c)}')">${esc(c)}</button>`).join('')}</div>
      </div>` : ''}

    <!-- One line out, at the bottom, where a way out belongs. Browsing the whole feed is a
         different act from searching it and it has its own tab; it does not need six buttons
         at the top of this one. -->
    <button class="sq-out" onclick="showPage('listings')">Browse everything instead &rsaquo;</button>`;
}

// Tapping a category chip narrows in place. Toggling it off returns to the entry state, which
// is why the same chip sets 'all' when it is already on — a chip that only ever turns on is a
// chip you cannot undo without hunting for a Clear button.
function sqCat(cat) {
  setListingCat(_filters.category === cat ? 'all' : cat);
  renderSearch();
}

// ---------- Results ----------
function sqPaintResults() {
  const body = document.getElementById('sqBody');
  if (!body) return;

  // A category on its own is enough to show results. Without this the chips would set a
  // filter and leave the student looking at the entry state, wondering what the tap did.
  const q = _sqQuery.trim().toLowerCase();
  const narrowed = q || _filters.category !== 'all';
  if (!narrowed) { body.innerHTML = sqEntryHTML(); return; }

  // Marketplace rows come from browseItems(), which is listings + books already shaped the
  // same way, filtered by the one visibility rule the feed uses. Search must never show
  // something the feed would hide.
  const items = browseItems().filter(isListingLive)
    .filter(l => _filters.category === 'all' || l.category === _filters.category)
    .filter(l => matchItemKeyword(l, q));
  // isBook, not category === 'books'. bookAsListing() sets both, but the flag is the one that
  // says WHICH TABLE the row came from — and that is what decides which detail opener works.
  const books = items.filter(l => l.isBook);
  const goods = items.filter(l => !l.isBook);
  // Events are excluded once a MARKETPLACE category is chosen. "Housing" is not a kind of
  // event, and showing events under it would answer a question nobody asked.
  const events = _filters.category === 'all' ? evMatchEvents(_sqEvents, { q }) : [];

  const total = goods.length + books.length + events.length;
  if (!total) {
    body.innerHTML = `
      ${sqToolsHTML()}
      <div class="sq-empty">
        <div class="sq-empty-t">Nothing for “${esc(_sqQuery)}”</div>
        <p>Try a shorter word, or browse instead — there are ${browseItems().filter(isListingLive).length}
           items and ${_sqEvents.length} event${_sqEvents.length === 1 ? '' : 's'} to look through.</p>
        <button class="sq-chip" onclick="sqClear()">Clear</button>
      </div>`;
    return;
  }

  // SECTIONS, NOT TABS. At this corpus size a tab hides results behind a guess about which
  // one holds the answer; sections show all three counts at once and cost one scroll.
  // The toggle changes LISTINGS AND BOOKS only. Events stay rows whichever is chosen: an event
  // is identified by when it is and who is running it, and a grid tile has room for a picture
  // and a title but not for a date, a place and an organization.
  const grid = sqView() === 'grid';
  body.innerHTML = `
    ${sqToolsHTML()}
    <div class="sq-count">${total} result${total === 1 ? '' : 's'}</div>
    ${sqSection('Listings', goods, l => grid ? sqTileHTML(l, `openDetail(${l.id})`) : sqRowHTML(l, `openDetail(${l.id})`), grid)}
    ${sqSection('Books', books, l => grid ? sqTileHTML(l, `openBookDetail(${l.id})`) : sqRowHTML(l, `openBookDetail(${l.id})`), grid)}
    ${sqSection('Events', events, e => sqEventRowHTML(e))}`;
}

function sqSection(label, rows, render, grid = false) {
  if (!rows.length) return '';
  const inner = rows.map(render).join('');
  return `<div class="sq-lab sq-lab-res">${label} · ${rows.length}</div>${
    grid ? `<div class="sq-grid">${inner}</div>` : inner}`;
}

// The grid tile. Picture-led — that is the whole reason to choose this view — so the image is
// the tile and the text sits under it rather than inside a second box.
//
// A KICKER above the title, not an overlay on the image. The list view carries "Books ·
// Library" as a subtitle and the grid had dropped it, so a textbook and a desk looked
// identical; an overlay would have said it but fought the photo and broken the alignment that
// makes a grid read as a grid.
function sqTileHTML(l, onclick) {
  const photo = (l.photo_urls && l.photo_urls[0]) || (l.photos && l.photos[0]) || null;
  const price = l.rent ? `$${l.rent}` : (l.category === 'donation' ? 'Free' : '');
  const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
  return `
    <div class="sq-tile-card">
      <div class="sq-tile-img" onclick="${onclick}"${photo ? '' : ` style="background:${cat.bg};color:${cat.text}"`}>
        ${photo ? `<img src="${escAttr(photo)}" alt="" loading="lazy">`
                : `<span class="sq-tile-glyph">${catIcon(l.category, 44)}</span>`}
        ${favButtonHTML(l.isBook ? 'book' : 'listing', l.id, 'sq-tile-fav')}
      </div>
      <div class="sq-tile-body" onclick="${onclick}">
        <div class="sq-tile-kicker">${esc(CATEGORY_LABELS[l.category] || l.category)}</div>
        <div class="sq-tile-title">${esc(l.title)}</div>
        <div class="sq-tile-price">${esc(price || '—')}</div>
      </div>
    </div>`;
}

function sqRowHTML(l, onclick) {
  const photo = (l.photo_urls && l.photo_urls[0]) || (l.photos && l.photos[0]) || null;
  const price = l.rent ? `$${l.rent}` : (l.category === 'donation' ? 'Free' : '');
  return `
    <div class="sq-row" onclick="${onclick}">
      <div class="sq-thumb">${photo
        ? `<img src="${escAttr(photo)}" alt="" loading="lazy">`
        : `<span class="sq-thumb-i">${catIcon(l.category, 18)}</span>`}</div>
      <div class="sq-row-text">
        <div class="sq-row-title">${esc(l.title)}</div>
        <div class="sq-row-sub">${esc([CATEGORY_LABELS[l.category] || l.category, l.location].filter(Boolean).join(' · '))}</div>
      </div>
      ${price ? `<div class="sq-row-price">${esc(price)}</div>` : ''}
      ${favButtonHTML(l.isBook ? 'book' : 'listing', l.id)}
    </div>`;
}

function sqEventRowHTML(e) {
  const org = _evOrgs.get(e.org_id);
  const when = new Date(e.starts_at).toLocaleString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `
    <div class="sq-row" onclick="evOpen(${e.id})">
      <div class="sq-thumb"${e.poster_url ? '' : ` style="background:${eventGradient(e.id)}"`}>
        ${e.poster_url ? `<img src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="sq-row-text">
        <div class="sq-row-title">${esc(e.title)}</div>
        <div class="sq-row-sub">${esc([org?.name, when, e.location].filter(Boolean).join(' · '))}</div>
      </div>
      ${favButtonHTML('event', e.id)}
    </div>`;
}
