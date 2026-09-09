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

function sqClear() {
  _sqQuery = '';
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
      ${_sqQuery ? `<button class="sq-x" onclick="sqClear()" aria-label="Clear">&times;</button>` : ''}
    </div>
    <div id="sqBody"></div>`;
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

    <div class="sq-sec">
      <div class="sq-lab">Browse</div>
      <div class="sq-tiles">
        ${[['housing', 'Housing'], ['books', 'Books'], ['technology', 'Technology'],
           ['clothing', 'Clothing'], ['donation', 'Free items'], ['other', 'Other']]
          .map(([v, l]) => `<button class="sq-tile" onclick="sqBrowse('${v}')">
             <span class="sq-tile-i" style="color:${(CATEGORY_COLORS[v] || CATEGORY_COLORS.other).text}">${catIcon(v, 18)}</span>
             ${l}</button>`).join('')}
        <button class="sq-tile" onclick="showPage('events')">
          <span class="sq-tile-i">&#128197;</span>Events</button>
      </div>
    </div>

    ${courses.length ? `
      <div class="sq-sec">
        <div class="sq-lab">Courses with books listed</div>
        <div class="sq-chips">${courses.map(c =>
          `<button class="sq-chip" onclick="sqRun('${escAttr(c)}')">${esc(c)}</button>`).join('')}</div>
      </div>` : ''}`;
}

function sqBrowse(cat) {
  setListingCat(cat);
  showPage('listings');
}

// ---------- Results ----------
function sqPaintResults() {
  const body = document.getElementById('sqBody');
  if (!body) return;

  const q = _sqQuery.trim().toLowerCase();
  if (!q) { body.innerHTML = sqEntryHTML(); return; }

  // Marketplace rows come from browseItems(), which is listings + books already shaped the
  // same way, filtered by the one visibility rule the feed uses. Search must never show
  // something the feed would hide.
  const items = browseItems().filter(isListingLive).filter(l => matchItemKeyword(l, q));
  // isBook, not category === 'books'. bookAsListing() sets both, but the flag is the one that
  // says WHICH TABLE the row came from — and that is what decides which detail opener works.
  const books = items.filter(l => l.isBook);
  const goods = items.filter(l => !l.isBook);
  const events = evMatchEvents(_sqEvents, { q });

  const total = goods.length + books.length + events.length;
  if (!total) {
    body.innerHTML = `
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
  body.innerHTML = `
    <div class="sq-count">${total} result${total === 1 ? '' : 's'}</div>
    ${sqSection('Listings', goods, l => sqRowHTML(l, `openDetail(${l.id})`))}
    ${sqSection('Books', books, l => sqRowHTML(l, `openBookDetail(${l.id})`))}
    ${sqSection('Events', events, e => sqEventRowHTML(e))}`;
}

function sqSection(label, rows, render) {
  if (!rows.length) return '';
  return `<div class="sq-lab sq-lab-res">${label} · ${rows.length}</div>${rows.map(render).join('')}`;
}

// One compact row shape for all three types. Search results are SCANNED and compared across
// categories; the feed is where things are browsed. Full cards here would make three
// different-looking lists out of one answer.
// A div, not a button: it carries a star, and a button inside a button is invalid HTML that
// browsers resolve by dropping one — usually the inner one, which is the control that matters.
// Same correction the Going rows needed when they gained their rating stars.
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
      ${favStarHTML(l.isBook ? 'book' : 'listing', l.id)}
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
      ${favStarHTML('event', e.id)}
    </div>`;
}
