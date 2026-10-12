// ============================================================
// SERVICES
// The student Services page (2026-10-12): what students offer each other — tutoring, braiding,
// photos, moving help. It took the Events tab while Events waits for clubs to start using it
// (EVENTS_VISIBLE in js/config.js).
//
// A service is an ordinary row in `listings` with category 'services'. That is the whole trick:
// approval, reports, saving (the star), messaging the poster, the detail view, push alerts and
// the admin screens already work for every listing, so this file only draws the page. Posting
// goes through the same form as everything else (submitListing in js/listings.js); the kinds of
// service are LISTING_SPECS.services and the price line is priceLabel(), both in js/listings.js.
//
// Loaded as a plain script (not a module) so every function stays global — the HTML's
// onclick="..." handlers depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

let _svType  = 'all';   // the lit chip: 'all' or a service_type value
let _svQuery = '';      // what is typed in the page's search box
let _svReady = false;   // false until the listings have loaded once — skeletons until then

// Called from renderListings() (js/listings.js), which runs after every change to the listings in
// memory: the first load, a new post, an admin approving one. One hook there instead of a call in
// each of those places.
function svListingsChanged() {
  _svReady = true;
  if (document.getElementById('page-services')?.classList.contains('active')) renderServices();
}

function svItems() {
  return DB.listings.filter(l => l.category === 'services' && isListingLive(l));
}

function renderServices() {
  svPaintChips();
  const host = document.getElementById('svSections');
  if (!host) return;
  if (!_svReady) { host.innerHTML = `<div class="listings-grid">${feedSkeletonHTML(4)}</div>`; return; }

  const all = svItems().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const shown = all.filter(l => (_svType === 'all' || l.details?.service_type === _svType)
    && matchItemKeyword(l, _svQuery));
  if (!shown.length) { host.innerHTML = svEmptyHTML(all.length === 0); return; }

  // A chip or a search is a question: answer it in one list. Otherwise the Marketplace's
  // sections — Featured, then your school, then nearby campuses.
  if (_svType !== 'all' || _svQuery) {
    streamSections(host, [mkSection('Results', shown, `${shown.length} service${shown.length !== 1 ? 's' : ''}`, true)]);
    return;
  }
  const mySchool = getEffectiveUser()?.school || null;
  const rest = shown.filter(l => !l.pinned);
  streamSections(host, [
    mkSection('Featured', shown.filter(l => l.pinned)),
    mkSection(mySchool ? 'At your school' : 'All services', rest.filter(l => !mySchool || !l.school || l.school === mySchool)),
    mkSection('From nearby campuses', rest.filter(l => mySchool && l.school && l.school !== mySchool)),
  ]);
}

// Built once from LISTING_SPECS.services, then only the highlight moves (the Marketplace's
// renderCategoryChips does the same, for the same reason: never rebuild the button being tapped).
function svPaintChips() {
  const wrap = document.getElementById('svChips');
  if (!wrap) return;
  if (!wrap.children.length) {
    const kinds = specOf('services', 'service_type')?.options || [];
    wrap.innerHTML = [['all', 'All'], ...kinds].map(([v, label]) =>
      `<button class="cat-pill" data-cat="${v === 'all' ? 'all' : 'services'}" data-type="${escAttr(v)}"
        onclick="svSetType('${escAttr(v)}')"><span>${esc(label)}</span></button>`).join('');
  }
  wrap.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.type === _svType));
}

function svSetType(type) { _svType = type; renderServices(); }

function svSearch(value) { _svQuery = value.trim(); renderServices(); }

function svClear() {
  _svType = 'all'; _svQuery = '';
  const box = document.getElementById('svSearch'); if (box) box.value = '';
  renderServices();
}

function svEmptyHTML(nothingAtAll) {
  return `<div class="lc-empty">
    <div class="lc-empty-icon">${icon(nothingAtAll ? 'briefcase' : 'search', 38)}</div>
    <div class="lc-empty-title">${nothingAtAll ? 'No services yet — be the first to offer one!' : 'No services match.'}</div>
    ${nothingAtAll
      ? `<div class="lc-empty-sub">Tutoring, braiding, photos, moving help — whatever you're good at.</div>
         <button class="lc-empty-btn" onclick="svPost()">Offer a service</button>`
      : `<button class="lc-empty-btn" onclick="svClear()">Show all services</button>`}
  </div>`;
}

// "+ Offer a service": the posting form, already on the Services step.
function svPost() {
  if (!requireAuth('postListing')) return;
  selectCategory('services');
}

// The posting form's "How you charge" box. Free needs no price; "depends on the job" takes an
// optional starting price, shown as "From $80".
function svUnitChange(sel) {
  const price = document.getElementById('pSV_price');
  if (!price) return;
  const free = sel.value === 'free';
  price.disabled = free;
  if (free) price.value = '';
  price.placeholder = free ? 'Free' : sel.value === 'varies' ? 'Starting at (optional)' : '20';
}
