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
function favPaint(type, id) {
  const on = isFav(type, id);
  document.querySelectorAll(`[data-fav="${favKey(type, id)}"]`).forEach(el => {
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', on ? 'Saved' : 'Save');
  });
}

// The one star. `stop` keeps the click off the card underneath it, which is always a link to
// the thing being saved.
function favStarHTML(type, id, extraClass = '') {
  const on = isFav(type, id);
  return `<button class="fav-star${on ? ' is-on' : ''} ${extraClass}" data-fav="${favKey(type, id)}"
    aria-pressed="${on}" aria-label="${on ? 'Saved' : 'Save'}"
    onclick="event.stopPropagation();toggleFav('${type}', '${id}', this)">&#9733;</button>`;
}
