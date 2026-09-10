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
// Icons for the same seven categories, as SVG path data. Kept beside the labels
// and colours because the category vocabulary belongs in one place.
//
// These are DISPLAY only. The `emoji` column on listings still exists and is
// still written on insert — it is simply no longer what the admin dashboard
// draws, because an emoji cannot inherit a colour or a stroke weight, and
// renders differently on every operating system.
const CATEGORY_ICON_PATH = {
  housing:            'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z|M9 21v-7h6v7',
  clothing:           'M8.4 3 4.5 5.4V10h3v11h9V10h3V5.4L15.6 3a3.7 3.7 0 0 1-7.2 0z',
  technology:         'M2.5 4.5h19v12h-19z|M8.5 21h7|M12 16.5V21',
  donation:           'M3 9h18v3.5H3z|M4.6 12.5V21h14.8v-8.5|M12 9v12',
  organization_event: 'M3 4.5h18v17H3z|M3 10h18|M8 2v4|M16 2v4',
  other:              'M20.6 13.4 12 4.8H4.8V12l8.6 8.6a1.5 1.5 0 0 0 2.1 0l5.1-5.1a1.5 1.5 0 0 0 0-2.1z|M8.4 8.4h.01',
  books:              'M5 4.5A2.5 2.5 0 0 1 7.5 2H19v20H7.5A2.5 2.5 0 0 1 5 19.5z|M5 17.5h14'
};

// The one icon set the whole app draws from. Path data only — icon() wraps it.
// Same 24px grid and stroke weight as the SVGs written directly into index.html,
// so a generated icon and a hand-written one are the same drawing.
const ICON_PATH = {
  check:     'M20 6 9 17l-5-5',
  x:         'M6 6l12 12|M18 6 6 18',
  pencil:    'M12 19l7-7 3 3-7 7-3-3z|M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z',
  star:      'M12 2l2.9 6.3 6.6.8-4.9 4.6 1.3 6.7L12 17.1 6.1 20.4l1.3-6.7-4.9-4.6 6.6-.8z',
  lock:      'M4 10.5h16v10.5H4z|M8 10.5V7a4 4 0 0 1 8 0v3.5',
  mapPin:    'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z|M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  note:      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M8 13h8|M8 17h5',
  user:      'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2|M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  book:      'M5 4.5A2.5 2.5 0 0 1 7.5 2H19v20H7.5A2.5 2.5 0 0 1 5 19.5z|M5 17.5h14',
  grid:      'M3 3h7v7H3z|M14 3h7v7h-7z|M3 14h7v7H3z|M14 14h7v7h-7z',
  list:      'M8 6h13|M8 12h13|M8 18h11|M3.5 6h.01|M3.5 12h.01|M3.5 18h.01',
  up:        'M12 19V5|M5 12l7-7 7 7',
  down:      'M12 5v14|M19 12l-7 7-7-7',
  chevDown:  'M6 9l6 6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  inbox:     'M22 12h-6l-2 3h-4l-2-3H2|M5.5 5.5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  flag:      'M4 22V4h9l1 2h6v10h-7l-1-2H4',
  search:    'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z|M20 20l-3.4-3.4',
  send:      'M21 3 10.5 13.5|M21 3l-6.5 18-4-7.5L3 9.5z',
  dot:       'M12 12h.01',
  clock:     'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z|M12 7v5l3 2',
  alert:     'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4.5|M12 17h.01',
  // A second tick offset behind the first — the read receipt everyone already knows.
  checkDouble: 'M1.5 12.5 5 16l7.5-8.5|M11 12.5l3.5 3.5L22 7.5',
  play:      'M7 4.5v15l12-7.5z',
  starFill:  'M12 2.6l2.8 6 6.4.8-4.7 4.5 1.2 6.5L12 17.2 6.3 20.4l1.2-6.5L2.8 9.4l6.4-.8z'
};

// Wraps a registry entry as an inline SVG string. Unknown names return '' so a
// typo leaves a gap rather than an error inside a template literal.
function icon(name, size = 14, filled = false) {
  const d = ICON_PATH[name];
  if (!d) return '';
  const paths = d.split('|').map(p => `<path d="${p}"/>`).join('');
  const fill = filled ? 'currentColor' : 'none';
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" ` +
         `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// Returns an inline SVG string for a category. Falls back to `other` so an
// unknown category still draws something rather than an empty box.
function categoryIcon(cat, size = 16) {
  const d = CATEGORY_ICON_PATH[cat] || CATEGORY_ICON_PATH.other;
  const paths = d.split('|').map(p => `<path d="${p}"/>`).join('');
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
         `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const CATEGORY_LABELS = { housing:'Housing', clothing:'Clothing', technology:'Technology', donation:'Free items', organization_event:'Org / Event', other:'Other', books:'Books' };
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
  content:{siteName:'CaldwellNest',tagWord:'Nest',h1:'One trusted hub',h2:'campus life.',sub:'Housing, marketplace, free stuff, events, and a verified student community — all in one place, just for your school.',cta:'Get started free',listTitle:'Campus listings',listSub:'Caldwell University students only',banner:'',bannerOn:false}
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
let _mTabIntent = 'home'; // 'home' | 'search'
let _kwTimer  = null;
let _dfPriceOpen = true;
let _dfCatOpen   = true;
let _pMax        = 2000;
let _schoolsList = [];
let _selectedSchool = null;
let _usernameTimer = null;
let _emailTimer = null;
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
