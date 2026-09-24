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
        <div class="sq-empty-t">Search Nestrel</div>
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
  // Club names feed the suggestions; the directory may not have been opened yet.
  if (typeof loadOrgDirectory === 'function' && !_dirOrgs) loadOrgDirectory();
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

// ---------- Three states, the way TikTok's search works (2026-09-24) ----------
//   ENTRY    nothing typed: your recent searches as a list, and what is popular on campus
//   SUGGEST  typing: a live list of things that exist here, the typed part in bold
//   RESULTS  after Enter or a tap: tabs — All, Listings, Books, Events — each with its count
// Suggesting before searching matters more on a small campus than a big platform: a student
// sees at once whether "fridge" exists here, instead of submitting and finding nothing.
// A term inside an onclick="…": JSON makes it a valid JS string (quotes, backslashes, newlines
// all escaped), escAttr keeps it inside the attribute. Titles are typed by students, so this is
// the difference between a suggestion and a script — escAttr alone does not escape a ' .
function sqJs(t) { return escAttr(JSON.stringify(String(t))); }

let _sqSubmitted = false;
let _sqTab = 'all';
let _sqFrom = 'feed';     // the page ← goes back to; goSearch() records it

function sqSet(v) {
  _sqQuery = v;
  _sqSubmitted = false;
  // Only the body repaints, so the input keeps focus and the caret stays put. Rebuilding the
  // shell on every keystroke is the bug the door's search box and the events search both had.
  sqPaintResults();
  sqPaintX();
}

// Enter, a suggestion, a recent search or a popular chip. Remembered HERE, when the student
// commits to a search — not on a typing pause, which stored half-typed words.
function sqRun(term) {
  _sqQuery = term;
  _sqSubmitted = !!term.trim();
  _sqTab = 'all';
  const el = document.getElementById('sqInput');
  if (el) { el.value = term; el.blur(); }
  sqRemember(term);
  sqPaintResults();
  sqPaintX();
}
function sqSubmit() { sqRun(document.getElementById('sqInput')?.value || ''); return false; }

// ↖ on a suggestion: put it in the box and keep typing, without searching yet.
function sqFill(term) {
  const el = document.getElementById('sqInput');
  if (el) { el.value = term + ' '; el.focus(); }
  sqSet(term + ' ');
}

// Clears the CATEGORY as well as the text. To a student the × means "start again", and
// leaving a category narrowed while the box empties would return them to an entry state that
// is quietly still narrowed.
function sqClear() {
  _sqQuery = ''; _sqSubmitted = false; _sqTab = 'all';
  if (_filters.category !== 'all') setListingCat('all');
  const el = document.getElementById('sqInput');
  if (el) { el.value = ''; el.focus(); }
  sqPaintResults();
  sqPaintX();
}
// Cancel: stop searching — empty box, keyboard down, back to the entry state.
function sqCancel() { sqClear(); document.getElementById('sqInput')?.blur(); }
function sqBack() { sqCancel(); showPage(_sqFrom && _sqFrom !== 'search' ? _sqFrom : 'feed'); }

function sqPaintX() {
  const x = document.getElementById('sqX');
  if (x) x.hidden = !_sqQuery;
}

function sqForgetAll() {
  try { localStorage.removeItem(SQ_RECENT_KEY); } catch (e) { /* private mode */ }
  sqPaintResults();
}

function sqShellHTML() {
  return `
    <div class="sq-head">
      <button class="sq-back" onclick="sqBack()" aria-label="Back">${icon('chevRight', 22)}</button>
      <div class="sq-bar">
        <span class="sq-icon">${icon('search', 17)}</span>
        <!-- Its own form, for the reason the listings search box documents: Chrome pools every
             input NOT inside a form and autofills the saved credential into the first visible
             one. autocomplete="off" has not stopped that for years. -->
        <form onsubmit="return sqSubmit()" autocomplete="off" class="form-shell sq-form">
          <input class="sq-input" id="sqInput" name="cn-search" autocomplete="off" enterkeyhint="search"
                 placeholder="Search rooms, books, free stuff…"
                 value="${escAttr(_sqQuery)}" oninput="sqSet(this.value)">
        </form>
        <button class="sq-x" id="sqX" onclick="sqClear()" aria-label="Clear"${_sqQuery ? '' : ' hidden'}>${icon('x', 14)}</button>
      </div>
      <button class="sq-cancel" onclick="sqCancel()">Cancel</button>
    </div>

    <div id="sqBody"></div>`;
}

// ---------- Entry state ----------
function sqEntryHTML() {
  const recent = sqRecent();
  const popular = sqPopular();
  return `
    ${recent.length ? `
      <div class="sq-sec">
        <div class="sq-sec-head"><h2 class="sq-h">Recent</h2><button class="hn-link" onclick="sqForgetAll()">Clear all</button></div>
        <div class="sq-list">${recent.map(t => `
          <div class="sq-li">
            <button class="sq-li-go" onclick="sqRun(${sqJs(t)})">${icon('clock', 17)}<span>${esc(t)}</span></button>
            <button class="sq-li-x" onclick="sqForget(${sqJs(t)})" aria-label="Remove ${escAttr(t)}">${icon('x', 15)}</button>
          </div>`).join('')}</div>
      </div>` : ''}

    ${popular.length ? `
      <div class="sq-sec">
        <h2 class="sq-h">Popular on campus</h2>
        <div class="sq-chips">${popular.map(t =>
          `<button class="sq-pop" onclick="sqRun(${sqJs(t)})">${esc(t)}</button>`).join('')}</div>
      </div>` : ''}

    ${!recent.length && !popular.length ? `<div class="sq-empty"><p>Search listings, books and events at your school.</p></div>` : ''}`;
}

// "Popular on campus", worked out from what is ACTUALLY listed right now — this app keeps no
// log of what other students search, and inventing one would be a lie. The words that appear in
// the most live listing, book and event titles, plus the course codes somebody has a book for.
const SQ_STOP = new Set(('the and for with from this that your you are new used like good great sale '
  + 'free near campus room caldwell student students size one two all our its it is in on of to a an '
  + 'at by or my me we us') .split(' '));
function sqPopular() {
  const titles = [...browseItems().filter(isListingLive).map(l => l.title), ..._sqEvents.map(e => e.title)];
  const count = new Map();
  titles.forEach(t => new Set(String(t || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || [])
    .forEach(w => { if (!SQ_STOP.has(w)) count.set(w, (count.get(w) || 0) + 1); }));
  const words = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  const courses = [...new Set((_books || []).filter(b => b.course_code).map(b => b.course_code))].sort().slice(0, 4);
  return [...words, ...courses].slice(0, 9);
}

// ---------- Suggest state ----------
// Things that exist here and contain what was typed: listing, book and event titles, course
// codes, club names. Ones that START with it first, then ones with a word starting with it.
function sqSuggestions(q) {
  const pool = [];
  browseItems().filter(isListingLive).forEach(l => { pool.push(l.title); if (l.course_code) pool.push(l.course_code); });
  _sqEvents.forEach(e => pool.push(e.title));
  (_dirOrgs || []).forEach(o => pool.push(o.name));
  const seen = new Set(), out = [];
  const rank = t => { const s = t.toLowerCase(); return s.startsWith(q) ? 0 : s.includes(' ' + q) ? 1 : 2; };
  pool.filter(Boolean).map(String).filter(t => t.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length)
    .forEach(t => { const k = t.toLowerCase(); if (!seen.has(k) && out.length < 8) { seen.add(k); out.push(t); } });
  return out;
}

function sqBold(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<b>' + esc(text.slice(i, i + q.length)) + '</b>' + esc(text.slice(i + q.length));
}

function sqSuggestHTML(q) {
  const raw = _sqQuery.trim();
  const rows = sqSuggestions(q);
  return `
    <div class="sq-list">
      <div class="sq-li"><button class="sq-li-go" onclick="sqRun(${sqJs(raw)})">${icon('search', 17)}<span>Search for “<b>${esc(raw)}</b>”</span></button></div>
      ${rows.map(t => `
        <div class="sq-li">
          <button class="sq-li-go" onclick="sqRun(${sqJs(t)})">${icon('search', 17)}<span>${sqBold(t, q)}</span></button>
          <button class="sq-li-x sq-li-fill" onclick="sqFill(${sqJs(t)})" aria-label="Use ${escAttr(t)}">${icon('up', 15)}</button>
        </div>`).join('')}
    </div>`;
}

// ---------- Results ----------
function sqSetTab(t) { _sqTab = t; sqPaintResults(); }

function sqPaintResults() {
  const body = document.getElementById('sqBody');
  if (!body) return;
  const q = _sqQuery.trim().toLowerCase();
  if (!q) { body.innerHTML = sqEntryHTML(); return; }
  if (!_sqSubmitted) { body.innerHTML = sqSuggestHTML(q); return; }

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

  const tabs = [['all', 'All', total], ['listings', 'Listings', goods.length], ['books', 'Books', books.length], ['events', 'Events', events.length]];
  const tabRow = `<div class="sq-tabs" role="tablist">${tabs.map(([v, l, n]) =>
    `<button role="tab" aria-selected="${_sqTab === v}" class="sq-tab${_sqTab === v ? ' is-on' : ''}" onclick="sqSetTab('${v}')">${l}<span>${n}</span></button>`).join('')}</div>`;
  const catNote = _filters.category !== 'all'
    ? `<button class="sq-pop sq-pop-on" onclick="setListingCat('all');sqPaintResults()">${esc(CATEGORY_LABELS[_filters.category] || _filters.category)} ×</button>` : '';

  if (!total) {
    body.innerHTML = `${tabRow}
      <div class="sq-empty">
        <div class="sq-empty-t">Nothing for “${esc(_sqQuery)}”</div>
        <p>Try a shorter word, or browse instead — there are ${browseItems().filter(isListingLive).length}
           items and ${_sqEvents.length} event${_sqEvents.length === 1 ? '' : 's'} to look through.</p>
        ${catNote}
        <button class="sq-pop" onclick="showPage('listings')">Browse the Market</button>
      </div>`;
    return;
  }

  // "All" keeps the sections (every count at once, one scroll); a tab narrows to one kind.
  // The grid / list toggle changes listings and books only — an event is identified by when it
  // is and who runs it, which a tile has no room for.
  const grid = sqView() === 'grid';
  const show = t => _sqTab === 'all' || _sqTab === t;
  body.innerHTML = `
    ${tabRow}
    ${_sqTab !== 'events' ? `<div class="sq-tools-row">${catNote}${sqToolsHTML()}</div>` : ''}
    ${show('listings') ? sqSection('Listings', goods, l => grid ? sqTileHTML(l, `openDetail(${l.id})`) : sqRowHTML(l, `openDetail(${l.id})`), grid) : ''}
    ${show('books') ? sqSection('Books', books, l => grid ? sqTileHTML(l, `openBookDetail(${l.id})`) : sqRowHTML(l, `openBookDetail(${l.id})`), grid) : ''}
    ${show('events') ? sqSection('Events', events, e => sqEventRowHTML(e)) : ''}
    ${_sqTab !== 'all' && !({ listings: goods, books, events }[_sqTab] || []).length
      ? `<div class="sq-empty"><p>No ${_sqTab} for “${esc(_sqQuery)}”.</p></div>` : ''}`;
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
      <button class="filters-btn" id="filtersBtn" onclick="openFilterDrawer(this)"
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
