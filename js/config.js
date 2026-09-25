// ============================================================
// CONFIG
// Supabase connection, the shared DB store, category constants, and every global state variable.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ── Supabase connection ──────────────────────────────────────
// ── Legal ────────────────────────────────────────────────────
// BUMP THIS whenever terms.html or privacy.html changes in a way that alters what a
// student is agreeing to. It is written onto the profile at signup, so a stored value
// of '2026-09-01' means "this person accepted the documents as they read on that date".
// Without it, a stored timestamp would only prove SOMEONE agreed to SOMETHING.
// Old profiles keep the version they accepted — never rewrite them to match this.
const TERMS_VERSION = '2026-09-01';
// The day consent recording went live. Accounts older than this have no consent record
// because none was ever captured — which is different from an account that SHOULD have one
// and doesn't. The admin student view uses this to tell those two apart instead of flagging
// every early student as a problem.
const CONSENT_LOGGING_SINCE = '2026-09-01';

const CATEGORY_EMOJI = { housing:'&#127968;', clothing:'&#128085;', technology:'&#128187;', donation:'&#127873;', organization_event:'&#128227;', other:'&#127991;', books:'&#128218;' };
// ---- THE ICON SET ---------------------------------------------------------
// One registry for the whole app. Values are the SVG children of a 24x24
// viewBox, so an icon can use <circle>, <rect> or <polyline> and not only
// <path>. icon() supplies the wrapper.
//
// This used to live in two places: ico() in listings.js and a second set here.
// Two registries meant an icon could be changed in one and stay stale in the
// other, which is the exact drift the category colours were consolidated to
// stop. There is one now.
const ICON = {
  alert:        '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5"/><path d="M12 17h.01"/>',
  bell:         '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  book:         '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  calendar:     '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  check:        '<path d="M20 6 9 17l-5-5"/>',
  checkDouble:  '<path d="M1.5 12.5 5 16l7.5-8.5"/><path d="M11 12.5l3.5 3.5L22 7.5"/>',
  chevDown:     '<path d="M6 9l6 6 6-6"/>',
  chevRight:    '<path d="M9 6l6 6-6 6"/>',
  clock:        '<path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/><path d="M12 7v5l3 2"/>',
  dot:          '<path d="M12 12h.01"/>',
  down:         '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
  eye:          '<path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:       '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 18.5C5 18.5 1.5 12 1.5 12a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 5.74A9.12 9.12 0 0 1 12 5.5c7 0 10.5 6.5 10.5 6.5a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
  flag:         '<path d="M4 22V4h9l1 2h6v10h-7l-1-2H4"/>',
  gift:         '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  grid:         '<path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M3 14h7v7H3z"/><path d="M14 14h7v7h-7z"/>',
  home:         '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  image:        '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  inbox:        '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  list:         '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h11"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>',
  lock:         '<path d="M4 10.5h16v10.5H4z"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  mapPin:       '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><path d="M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>',
  message:      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  monitor:      '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  more:         '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  note:         '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  pencil:       '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/>',
  pin:          '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  play:         '<path d="M7 4.5v15l12-7.5z"/>',
  school:       '<path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/>',
  search:       '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/>',
  send:         '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  shirt:        '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  star:         '<path d="M12 2l2.9 6.3 6.6.8-4.9 4.6 1.3 6.7L12 17.1 6.1 20.4l1.3-6.7-4.9-4.6 6.6-.8z"/>',
  starFill:     '<path d="M12 2.6l2.8 6 6.4.8-4.7 4.5 1.2 6.5L12 17.2 6.3 20.4l1.2-6.5L2.8 9.4l6.4-.8z"/>',
  tag:          '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><circle cx="7" cy="7" r="1"/>',
  up:           '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  user:         '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"/>',
  x:            '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'
};

// size defaults to 16 — the old ico() default, so existing callers are unchanged.
function icon(name, size = 16, filled = false) {
  const g = ICON[name];
  if (!g) return '';
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
         `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" ` +
         `stroke-linecap="round" stroke-linejoin="round">${g}</svg>`;
}

// Which icon stands for a listing category. Kept beside CATEGORY_LABELS and the
// colour tokens so the category vocabulary stays in one place.
const CATEGORY_ICON = {
  housing:'home', clothing:'shirt', technology:'monitor', donation:'gift',
  organization_event:'calendar', books:'book', other:'tag'
};
function catIcon(category, size = 18) { return icon(CATEGORY_ICON[category] || 'tag', size); }

// The categories the marketplace browses by, in the order the strip shows them — which is
// deliberately the same order the post picker offers, so what you can post and what you can
// filter by are visibly the same set.
//
// organization_event is NOT here. Events have their own tab, their own page and their own
// table; leaving the chip in made Events a destination and a filter at once. Legacy rows
// with that category still appear under All.
const BROWSE_CATEGORIES = ['housing', 'clothing', 'technology', 'donation', 'books', 'other'];

const CATEGORY_LABELS = { housing:'Housing', clothing:'Clothing', technology:'Technology', donation:'Free items', organization_event:'Org / Event', other:'Other', books:'Books' };
// Short forms, for the one place where width is the binding constraint: the Marketplace's
// single scrolling pill row. CATEGORY_LABELS stays the real vocabulary and is what filter
// tags, card badges and the post flow say — a pill that has to fit six siblings on a 390px
// screen is the exception, not a second opinion about what a category is called.
const CATEGORY_SHORT = { technology:'Tech', donation:'Free', organization_event:'Events' };
const catShort = c => CATEGORY_SHORT[c] || CATEGORY_LABELS[c] || c;
// Soft, tonal background + deep same-hue text for photo-less listing cards (typography-as-hero).
// All backgrounds sit in the same lightness band so the set reads as one family, not a rainbow.
//
// THE COLOURS THEMSELVES LIVE IN styles.css, in the --cat-* variables under :root.
// That is the single source of truth — change a category colour THERE and nowhere else.
// This object only names the variables. The values are injected whole into inline style
// attributes (`style="background:${cat.bg}"`) and the browser resolves the var() at render
// time. Never concatenate or slice these strings — they are not hex any more.
//
// Why: this used to be a second hardcoded copy of the same hexes as the CSS, and the two had
// already drifted — the Books picker button was painted with the TECHNOLOGY blue.
const catColor = name => ({ bg: `var(--cat-${name}-bg)`, text: `var(--cat-${name}-text)` });
const CATEGORY_COLORS = {
  housing:            catColor('housing'),             // sage — ties to the brand green
  clothing:           catColor('clothing'),            // dusty rose
  technology:         catColor('technology'),          // slate blue
  donation:           catColor('donation'),            // warm sand
  organization_event: catColor('organization_event'),  // muted lavender
  books:              catColor('books'),               // moss / olive
  other:              catColor('other')                // warm greige
};
let _postCategory = null;

const SUPABASE_URL = 'https://jcbohweepdgqqntherzo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjYm9od2VlcGRncXFudGhlcnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxNTkzODEsImV4cCI6MjA5NTczNTM4MX0.8RPbq2yIGib0gVzV2QQrWGkBEWokvdXNi1z9ZWTZcHk';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// SHARED DATA STORE — single source of truth for both interfaces
// ============================================================
const AC=['#2d6148','#3B5BA5','#C0392B','#7D3C98','#D68910','#117A65','#A04000'];

// students / convos / reports were removed 2026-07-13. They were empty leftovers from before this
// data moved to Supabase, and nothing ever wrote to them — which is exactly how NestBot ended up
// counting DB.reports and confidently answering "0 open reports" while reports sat waiting.
// Every surface now queries Supabase directly. Don't reintroduce a cache without a writer.
const DB = {
  pending:[],  // populated from Supabase listings (status=pending) via loadListings()
  listings:[], // populated from Supabase listings (status!=pending) via loadListings()
  pendingBooks:[], // admin-only: book_listings (status=pending) via loadAdminBooks()
  adminBooks:[],   // admin-only: book_listings (status!=pending) via loadAdminBooks()
  settings:{requireApproval:true,eduOnly:true,emailAlerts:true,maintenance:false},
  content:{siteName:'Nestrel',tagWord:'Nest',h1:'One trusted hub',h2:'campus life.',sub:"The plans, the people, the stuff — everything happening at your school, in one place. And everyone on it actually goes there.",cta:'Join with your school email',listTitle:'Marketplace',listSub:'Find what you need, right on campus.',banner:'',bannerOn:false}
};

// ============================================================
// ROLE / AUTH ROUTING
// ============================================================
let currentRole = null;
let sUser = null; // logged-in student
let adminPreviewMode = false; // true when admin has entered student view
let _filters = { category: 'all', keyword: '', minPrice: null, maxPrice: null, details: {}, schoolScope: '25mi', sort: 'newest' };
// Home and Search both land on page-listings now, so the page alone can no longer say
// which mobile tab should light up. This remembers which one was actually tapped.
// Defaults to 'home' so a student booting straight into the feed sees Home selected.
let _kwTimer  = null;
let _pMax        = 2000;
let _schoolsList = [];
let sConvoActive = null;
let sRealtimeChannel  = null;
let sGlobalMsgChannel = null;
let sNotifChannel     = null;
let sProfileChannel   = null;
let sUnreadCount = 0; // total unseen messages (derived from DB by refreshUnread, not counted by hand)
let sUnread = {};     // conversation_key → unseen count, for per-conversation badges
let adminUUID = null;
const SUPER_ADMIN_ID = '7f4e052c-666e-4955-8ced-9da380dbe589';
const isProtectedAdmin = id => id === SUPER_ADMIN_ID || id === adminUUID;
let aEditId = null, aEditSrc = 'listing';
let aRejectId = null, aSuspendId = null;
let aAdminSchool = null; // null = super admin (all schools); 'caldwell' etc = school-scoped admin
let aAdminBrand = null;     // brand_name from schools table for school-scoped admins
let _schoolBrandCache = {}; // slug → display brand label for drill-in context indicator
let _histStack = [];           // navigation stack: [{type:'section',value:'students'} | {type:'profile',value:id,name:'...'}]
let _histCurrentProfileId = null;
let _histGoingBack = false;
let _histListings = [], _histListingView = 'list', _pinnedView = 'grid';
let _histBooks = [];
let _stuSchoolFilter = 'all', _stuStatusFilter = 'all';
let _stuYearFilter = 'all', _stuMajorSearch = '', _stuSort = 'newest', _stuSearch = '', _stuFlagFilter = 'none';
let _listingSchoolFilter = 'all', _listingTypeFilter = 'all', _listingStatusFilter = 'all';
let _listingMinRent = '', _listingMaxRent = '', _listingSort = 'newest';
let _reportSchoolFilter = 'all', _reportStatusFilter = 'all', _reportCatFilter = 'all', _reportSearch = '', _reportGroupBy = 'date';
let _appealStatusFilter = 'all', _appealSort = 'newest', _appealSearch = '';
let _anaRange = '30d', _anaSchool = 'all', _anaNavSource = null;
let _approvalSchoolFilter = 'all', _approvalCategoryFilter = 'all';
let _approvalsTab = 'listings'; // 'listings' | 'books'
let aBookRejectId = null;
let _dashLogFilter = 'all';
let _actPage = 0, _actFilter = 'all';
let _adminRealtimeChannels = [];
let aiOpen = false, aiHistory = [];
let bType        = 'announcement';
let _bDisplayType = 'both';
let _bEditId      = null;
let _bPrevStatus  = null;
let _bHistFilter  = 'all';
let _bcastCache        = {};
let _pendingPhotoFiles = [];
const MAX_LISTING_PHOTOS = 6;
// True while the "set a new password" screen is up. Entry routing must stand down: the
// recovery link gives supabase-js a REAL session, so boot would otherwise route straight
// into the feed and the student would never get to set a password.
let _recoveryMode = false;
let _pendingAvatarFile = null;  // a newly picked avatar awaiting save
let _avatarRemoved = false;     // true if the user cleared their avatar this session

function pickRole(role) {
  if (role === 'admin') {
    openModal('adminLoginModal');
  }
}
