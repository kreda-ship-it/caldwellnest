// ============================================================
// FAVORITES — one owner for the star, wherever it appears
// ============================================================
// The `favorites` table has existed since 2026-09-01 and permits listing, book, service and
// event. Until now only js/events.js used it, with its own _evSaved set and its own toggle —
// so adding the star to listings would have been a second copy of the same logic, and the
// third would have been books.
//
// One set, keyed "type:id", and one toggle. The alternative is three sources of truth for
// "is this saved", which is the shape of every consistency bug this project has recorded.
//
// Nothing here defines who may save what: favorites_select_own, favorites_insert_own and
// favorites_delete_own do, and item_id is text in the table so every caller passes a string.

let _favs = new Set();
let _favsLoaded = false;

function favKey(type, id) { return `${type}:${id}`; }
function isFav(type, id) { return _favs.has(favKey(type, id)); }

// Loaded once per session and kept in memory. Every surface that draws a star needs the whole
// set, and a query per card would be one request per row on a feed.
async function loadFavorites(force = false) {
  if (_favsLoaded && !force) return;
  const eu = getEffectiveUser();
  if (!eu?.id) { _favs = new Set(); _favsLoaded = false; return; }
  const { data, error } = await supabaseClient
    .from('favorites').select('item_type, item_id').eq('user_id', eu.id);
  if (error) { console.error('[loadFavorites]', error.message); return; }
  _favs = new Set((data || []).map(f => favKey(f.item_type, f.item_id)));
  _favsLoaded = true;
}

function clearFavorites() { _favs = new Set(); _favsLoaded = false; }

// Painted before the round trip. A star that waits for the network feels broken on a phone,
// and the worst case is a star that flips back — which is the truth arriving late rather than
// a lie being told. On failure it reverts and says so, because a save that silently did not
// happen is worse than one that visibly did not.
async function toggleFav(type, id, btn) {
  const eu = getEffectiveUser();
  if (!eu?.id) { requireAuth(); return; }

  const key = favKey(type, id);
  const was = _favs.has(key);
  if (was) _favs.delete(key); else _favs.add(key);
  favPaint(type, id);

  const q = was
    ? supabaseClient.from('favorites').delete()
        .eq('user_id', eu.id).eq('item_type', type).eq('item_id', String(id))
    : supabaseClient.from('favorites')
        .insert({ user_id: eu.id, item_type: type, item_id: String(id) });

  const { error } = await q;
  // 23505 is unique_violation: already saved, in another tab or on another device. The row we
  // wanted exists, which is what we asked for — a success wearing an error code.
  if (error && error.code !== '23505') {
    if (was) _favs.add(key); else _favs.delete(key);
    favPaint(type, id);
    toast('Could not ' + (was ? 'remove that' : 'save that') + ' — try again');
    console.error('[toggleFav]', error);
  }
}

// Repaints every star for this item wherever it is on the page. Attributes rather than ids,
// because the same listing can be on screen twice — a search result and a feed card, or two
// pages the router has hidden rather than removed. That duplicate-id bug cost an afternoon on
// the follow button; this is the same shape and it is not being repeated.
// Note what this deliberately does NOT do: re-render the Saved list. Un-starring a row there
// leaves it in place, unstarred, until the next visit. Removing it under the finger that just
// tapped it makes the list jump and takes away the only way to undo the tap.
function favPaint(type, id) {
  const on = isFav(type, id);
  document.querySelectorAll(`[data-fav="${favKey(type, id)}"]`).forEach(el => {
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', on ? 'Saved' : 'Save');
    // The fill is an attribute, not a class, because `fill` on the element beats any
    // stylesheet rule targeting it. Setting one and not the other leaves an outline heart
    // coloured as though it were filled.
    el.querySelector('svg')?.setAttribute('fill', on ? 'currentColor' : 'none');
  });
}

// A HEART, drawn as an SVG, and both halves of that are deliberate.
//
// SVG because every other icon in this app is one, at stroke-width 2. The star was a text
// glyph (&#9733;), which is why it sat heavier than everything around it and rendered
// differently on each platform — it was never part of the icon language, it was a character
// that happened to look like an icon.
//
// A heart because a star already means something else here. Event ratings ARE stars, and a
// saved star beside a rating star is two different actions wearing one symbol. Saving is a
// heart, rating is stars, and neither has to be explained.
//
// Filled when on, outline when off: the fill IS the state, so nothing depends on colour alone.
// event.stopPropagation keeps the tap off the card underneath, which is always a link to the
// thing being saved.
function favStarHTML(type, id, extraClass = '') {
  const on = isFav(type, id);
  return `<button class="fav-star${on ? ' is-on' : ''} ${extraClass}" data-fav="${favKey(type, id)}"
    aria-pressed="${on}" aria-label="${on ? 'Saved' : 'Save'}"
    onclick="event.stopPropagation();toggleFav('${type}', '${id}', this)"><svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/></svg></button>`;
}


// ============================================================
// THE SAVED LIST
// ============================================================
// One list, sectioned by type, on the profile beside Listings and Going. Saved things are
// yours, and the profile is already where your things are — a sixth bottom tab for a list
// most students open occasionally is the opposite of the trade we just made removing one.
//
// Sectioned the same way search results are, and drawn with the same compact row, so a saved
// listing looks like the same object a student met in the feed and in a search.

async function renderSaved() {
  const wrap = document.getElementById('mySaved');
  if (!wrap) return;

  // No longer hides itself. It is a TAB now, and a tab that vanishes when empty is not
  // navigation — the emptiness belongs inside it, where a student who tapped Saved gets an
  // answer rather than a bar that changed shape under them.
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  await loadFavorites(true);
  if (!_favs.size) {
    wrap.innerHTML = `<div class="sq-empty"><div class="sq-empty-t">Nothing saved yet</div>
      <p>Tap the star on anything — a listing, a book, an event — and it waits for you here.</p></div>`;
    return;
  }

  const ids = { listing: [], book: [], event: [] };
  for (const key of _favs) {
    const [type, id] = key.split(':');
    if (ids[type]) ids[type].push(id);
  }

  // Marketplace rows come from the caches the feed already holds, so a saved listing is drawn
  // from the same shape and the same visibility rule as everywhere else.
  const items = browseItems().filter(isListingLive);
  const goods = items.filter(l => !l.isBook && ids.listing.includes(String(l.id)));
  const books = items.filter(l =>  l.isBook && ids.book.includes(String(l.id)));

  let events = [];
  if (ids.event.length) {
    const { data } = await supabaseClient
      .from('visible_events')
      .select('id, org_id, title, starts_at, location, poster_url, status, has_ended')
      .in('id', ids.event);
    events = data || [];
    await evLoadOrgs(events);
  }

  // A saved item that has since sold, been withdrawn or ended is simply absent — the caches
  // and the view both apply the live rule. That is deliberate: a saved list is a shortcut to
  // things you can still act on, and a column of gone items is a list of disappointments.
  const total = goods.length + books.length + events.length;
  if (!total) {
    wrap.innerHTML = `<div class="sq-empty"><div class="sq-empty-t">Nothing saved is still available</div>
      <p>Things you starred have sold, been taken down, or already happened.</p></div>`;
    return;
  }

  wrap.innerHTML =
    savedSection('Listings', goods, l => sqRowHTML(l, `openDetail(${l.id})`)) +
    savedSection('Books',    books, l => sqRowHTML(l, `openBookDetail(${l.id})`)) +
    savedSection('Events',   events, e => sqEventRowHTML(e));
}

function savedSection(label, rows, render) {
  if (!rows.length) return '';
  return `<div class="sq-lab sq-lab-res">${label} · ${rows.length}</div>${rows.map(render).join('')}`;
}
