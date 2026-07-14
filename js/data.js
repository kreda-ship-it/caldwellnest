// ============================================================
// DATA
// Loading + shaping data from Supabase: listings, books, the isListingLive visibility rule, and student boot.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// Marker email that identifies a listing posted via the official CaldwellNest identity.
const OFFICIAL_POSTER_EMAIL = 'official@caldwellnest.com';

// Builds the canonical in-memory poster object for a listing.
// - `prof` is the live profile row (or undefined for official posts / deleted profiles).
// - Public `name` defaults to first-name only (privacy); `fullName`/`email` are kept for admin surfaces only.
function posterFromRow(row, prof) {
  const isOfficial = row.poster_email === OFFICIAL_POSTER_EMAIL;
  if (prof && !isOfficial) {
    return {
      name: prof.display_name || prof.first_name || 'Student',
      fullName: row.poster_name,
      initials: prof.initials, color: prof.color,
      email: row.poster_email,
      avatar_url: prof.avatar_url || null,
      verified: true, official: false,
      year: prof.year || null, major: prof.major || null,
      memberSince: prof.created_at || null
    };
  }
  // Official post, or a poster whose profile no longer exists → use the listing's stored snapshot.
  return {
    name: row.poster_name, fullName: row.poster_name,
    initials: row.poster_initials, color: row.poster_color,
    email: row.poster_email,
    avatar_url: null,
    verified: false, official: isOfficial,
    year: null, major: null, memberSince: null
  };
}

// Canonical visibility rule (mirrors the `visible_listings` SQL view) — a listing
// is live in feed/search only if admin-approved, still in an active lifecycle
// state, and not past its deadline. Owner and admin views bypass this on purpose
// (they query Supabase directly, not this cached/filtered list).
function isListingLive(l) {
  if (l.status !== 'approved') return false;
  // Missing lifecycle_status = a client-constructed row (fresh post/approve before the
  // next Supabase reload); the DB column is NOT NULL DEFAULT 'active', so treat as active.
  if (l.lifecycle_status && !['active', 'pending_sale'].includes(l.lifecycle_status)) return false;
  if (l.expires_at && new Date(l.expires_at) <= new Date()) return false;
  return true;
}

// ── Books-as-a-category normalizer ──────────────────────────
// book_listings stays a separate table (different fields, own detail page), but every
// GRID treats books as just another category. This maps a book row into the same shape
// listingCardHTML/renderListingGrid expect. `isBook: true` is the routing flag — book
// ids and listing ids are independent sequences, so taps/lookups must never cross tables.
function bookAsListing(b) {
  const p = _bookPosterMap[b.poster_id];
  return {
    id: b.id, isBook: true, category: 'books',
    title: b.title, rent: b.price, desc: b.description || '',
    location: null, tags: [], details: {},
    type: bookChipLabel(b),
    author: b.author, isbn: b.isbn, edition: b.edition,
    book_type: b.book_type, course_code: b.course_code,
    // book_listings has no school column — borrow the POSTER's school so the card
    // shows their university and the distance/scope filter treats books like listings.
    school: p?.school ? p.school.toLowerCase() : null,
    poster_id: b.poster_id,
    poster: p
      ? { name: p.display_name || p.first_name || 'Student', fullName: p.display_name || `${p.first_name} ${p.last_name}`, initials: p.initials, color: p.color, avatar_url: p.avatar_url || null, email: null, verified: true, official: false, year: p.year || null, major: p.major || null, memberSince: p.created_at || null }
      : { name: 'Caldwell student', fullName: 'Caldwell student', initials: '?', color: '#888', avatar_url: null, email: null, verified: false, official: false, year: null, major: null, memberSince: null },
    posted: new Date(b.created_at).toLocaleDateString(),
    created_at: b.created_at,
    emoji: CATEGORY_EMOJI.books,
    status: b.status, lifecycle_status: b.lifecycle_status, expires_at: b.expires_at,
    pinned: false, photo_urls: b.photo_urls || []
  };
}

// The one browse source: marketplace cache + normalized books, together.
function browseItems() {
  return [...DB.listings, ..._books.map(bookAsListing)];
}

let _lastSuspendedIds = new Set(); // last successful "who is suspended" answer — see below
async function loadListings() {
  const { data: suspendedProfiles, error: suspErr } = await supabaseClient
    .from('profiles').select('id').eq('status', 'suspended');
  // A transient failure here must NOT un-hide suspended posters' listings for a
  // refresh cycle — fall back to the last known suspended set, never an empty one.
  if (suspErr) console.warn('[loadListings] suspended lookup failed, using last known set:', suspErr.message);
  const suspendedIds = suspErr ? _lastSuspendedIds : new Set((suspendedProfiles || []).map(p => p.id));
  if (!suspErr) _lastSuspendedIds = suspendedIds;

  const { data, error } = await supabaseClient
    .from('listings')
    .select('*')
    .order('created_at', { ascending: false });
  // A FAILED query and an EMPTY table are different things and must be handled differently:
  //  - failed  → keep whatever is cached; showing stale listings beats blanking the feed.
  //  - empty   → fall through and assign []. Bailing out here (the old behavior) left the
  //              previous listings on screen forever, so deleting the last listing, or an
  //              empty database, still showed a populated feed.
  if (error) { console.error('[loadListings]', error.message); return; }
  const rows = data || [];

  // Live-join poster profiles so avatar + name + trust info are a single source of truth
  // (update your picture → next load every card reflects it). Official CaldwellNest posts
  // are detected by their marker email and SKIP the join, so the real admin behind the
  // official identity is never exposed.
  const realPosterIds = [...new Set(rows
    .filter(r => r.poster_id && r.poster_email !== OFFICIAL_POSTER_EMAIL)
    .map(r => r.poster_id))];
  const profMap = {};
  if (realPosterIds.length) {
    const { data: profs } = await supabaseClient.from('profiles')
      .select('id, display_name, first_name, last_name, initials, color, avatar_url, year, major, created_at')
      .in('id', realPosterIds);
    (profs || []).forEach(p => { profMap[p.id] = p; });
  }

  const mapRow = row => ({
    id: row.id,
    title: row.title,
    category: row.category || 'housing',
    type: (row.details && row.details.room_type) || CATEGORY_LABELS[row.category] || 'Housing',
    rent: row.price,
    location: row.location,
    desc: row.description,
    tags: row.tags || [],
    details: row.details || {},
    school: row.school ? row.school.toLowerCase() : null,
    poster_id: row.poster_id,
    poster: posterFromRow(row, profMap[row.poster_id]),
    posted: new Date(row.created_at).toLocaleDateString(),
    created_at: row.created_at, // raw timestamp — merged feed sorting needs it
    emoji: row.emoji || CATEGORY_EMOJI[row.category] || '&#127968;',
    status: row.status,
    lifecycle_status: row.lifecycle_status,
    expires_at: row.expires_at,
    pinned: row.pinned,
    rejection_reason: row.rejection_reason || null,
    photo_urls: row.photo_urls || []
  });
  const visible = rows.filter(row => !suspendedIds.has(row.poster_id));
  DB.listings = visible.filter(row => row.status !== 'pending').map(mapRow);
  DB.pending = visible.filter(row => row.status === 'pending').map(mapRow);
  // removed listings stay in DB.listings with status:'removed' — hidden from students, visible to admin
}

// Admin-only: loads ALL book_listings regardless of moderation/lifecycle state (the public
// loadBooks() only pulls approved+active). Mirrors loadListings()'s pending/live split.
async function loadAdminBooks() {
  const { data, error } = await supabaseClient
    .from('book_listings').select('*').order('created_at', { ascending: false });
  if (error) { console.error('[loadAdminBooks]', error.message); return; }
  const posterIds = [...new Set((data || []).map(r => r.poster_id).filter(Boolean))];
  const profMap = {};
  if (posterIds.length) {
    const { data: profs } = await supabaseClient.from('profiles')
      .select('id, display_name, first_name, last_name, initials, color, email')
      .in('id', posterIds);
    (profs || []).forEach(p => { profMap[p.id] = p; });
  }
  const mapBookRow = row => {
    const p = profMap[row.poster_id];
    return {
      id: row.id,
      title: row.title,
      category: 'books',
      type: row.book_type === 'course' ? (row.course_code || 'Textbook') : (row.genre || 'Book'),
      author: row.author,
      isbn: row.isbn,
      edition: row.edition,
      rent: row.price,
      condition: row.condition,
      desc: row.description || 'No description.',
      poster_id: row.poster_id,
      poster: p ? { name: p.display_name || `${p.first_name} ${p.last_name}`, fullName: p.display_name || `${p.first_name} ${p.last_name}`, initials: p.initials, color: p.color, email: p.email } : { name: 'Unknown', fullName: 'Unknown', initials: '?', color: '#888', email: '' },
      submitted: new Date(row.created_at).toLocaleDateString(),
      posted: new Date(row.created_at).toLocaleDateString(),
      status: row.status,
      lifecycle_status: row.lifecycle_status,
      expires_at: row.expires_at,
      rejection_reason: row.rejection_reason || null,
      photo_urls: row.photo_urls || []
    };
  };
  DB.pendingBooks = (data || []).filter(r => r.status === 'pending').map(mapBookRow);
  DB.adminBooks   = (data || []).filter(r => r.status !== 'pending').map(mapBookRow);
}

async function initStudent() {
  const [, , , , { count: stuCount }] = await Promise.all([
    loadListings(),
    loadBooks(), // books are part of the browse feed now — load with everything else
    loadSchools(),
    _settingsReady,
    supabaseClient.from('profiles').select('id', { count: 'exact', head: true })
  ]);
  applyDBContent();
  if (applyMaintenance()) return;
  renderDeepFilters();
  renderListings();
  animNum('statListings', 0, browseItems().filter(isListingLive).length, 600);
  animNum('statStudents', 0, stuCount || 0, 800);
  if (localStorage.getItem('cn_msg_sidebar') === 'collapsed') {
    msgSidebarPinned = false;
    const sidebar = document.getElementById('msgSidebar');
    if (sidebar) { sidebar.style.transition = 'none'; sidebar.classList.add('msg-collapsed'); setTimeout(() => sidebar.style.transition = '', 10); }
  }
}

function applyDBContent() {
  const c = DB.content;
  document.getElementById('heroH1').innerHTML = `${c.h1}<br>for <em id="heroEm">${c.h2}</em>`;
  document.getElementById('heroSub').textContent = c.sub;
  document.getElementById('heroCta').textContent = c.cta;
  document.getElementById('listingsTitle').textContent = c.listTitle;
  document.getElementById('listingsSub').textContent = c.listSub;
  const banner = document.getElementById('sBanner');
  if (c.bannerOn && c.banner) { banner.textContent = c.banner; banner.style.display = 'block'; }
  else banner.style.display = 'none';
}

function animNum(id, s, e, dur) {
  const el = document.getElementById(id); if (!el) return;
  const step = Math.ceil((e - s) / (dur / 16)); let cur = s;
  const t = setInterval(() => { cur = Math.min(cur + step, e); el.textContent = cur; if (cur >= e) clearInterval(t); }, 16);
}
