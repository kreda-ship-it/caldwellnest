// ============================================================
// CONFIG
// Supabase connection, the shared DB store, category constants, and every global state variable.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ── Supabase connection ──────────────────────────────────────
const CATEGORY_EMOJI = { housing:'&#127968;', clothing:'&#128085;', technology:'&#128187;', donation:'&#127873;', organization_event:'&#128227;', other:'&#127991;', books:'&#128218;' };
const CATEGORY_LABELS = { housing:'Housing', clothing:'Clothing', technology:'Technology', donation:'Donation', organization_event:'Org / Event', other:'Other', books:'Books' };
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
  log:[],      // in-session activity log; resets on refresh (no Supabase backend yet)
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
let _pendingAvatarFile = null;  // a newly picked avatar awaiting save
let _avatarRemoved = false;     // true if the user cleared their avatar this session

function pickRole(role) {
  if (role === 'admin') {
    openModal('adminLoginModal');
  }
}
