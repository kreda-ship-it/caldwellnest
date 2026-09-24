// ============================================================
// js/orgs.js — organizations, memberships, and the client mirror of can_act()
// ============================================================
//
// *** NOTHING IN THIS FILE IS SECURITY. READ THIS BEFORE USING ANY OF IT. ***
//
// orgCanAct() below is a MIRROR of the can_act() function in Postgres, and it exists for
// exactly one purpose: deciding whether to draw a button. It runs in the browser, where the
// person using it can open the console and make it return whatever they like.
//
// The real enforcement is Row Level Security, defined in sql/2026-09-04_org_hierarchy.sql
// and proven by sql/2026-09-04_verify_can_act.sql. If a student forces this function to
// return true, the button appears and the database still refuses the write.
//
// This is the standing project rule, and it is a launch blocker when broken: UI-only gating
// is not gating. Never move a permission decision here from the database. If you find
// yourself wanting to, what you actually want is a new flag and a new policy.
//
// The mirror can be WRONG in exactly one direction, and that is on purpose. RLS may hide an
// organization row from this browser — an inactive club the user does not manage, say — and
// the ancestor walk below then stops early and answers false where the database would answer
// true. A hidden button where one was allowed is a nuisance. A visible button that leads to a
// refused write is worse, and a visible button that WORKS when it should not is the thing
// that must never happen. So this fails closed.
//
// Kept deliberately lazy: nothing here loads at boot. A student with no memberships — which
// is almost every student — never pays for a query they do not use. Call loadOrgContext()
// when you are about to draw something that needs it.
// ============================================================

// The whole cache. null means "never loaded"; that is distinct from "loaded and found
// nothing", which is an object with empty maps. Code that cannot tell those apart ends up
// re-querying on every render.
let _orgCtx = null;

// WHY the last load failed, or null. This exists because of a real bug on 2026-09-05: the
// column list below was updated to ask for two new flags before the migration that creates
// them had been run. PostgREST rejects the WHOLE query when one column is unknown, so
// loadOrgContext() returned null, orgMemberships() returned [], and the console told a
// school administrator "You are not an officer of any organization" — which was false, and
// sent the reader looking at their membership row instead of at the failed request.
//
// An empty result and a failed request must never render the same way. When you cannot
// answer a question, say that, rather than returning the answer you would give if the
// answer were no.
let _orgCtxError = null;

// Mirrors the CASE expression inside can_act(). If a flag is ever added to org_memberships,
// it goes here AND in the SQL function, and the two must agree. They are checked against each
// other by nothing — that is the cost of a mirror, and the reason this map is small.
const ORG_ACTIONS = {
  post:              'can_post',
  manage_members:    'can_manage_members',
  view_analytics:    'can_view_analytics',
  message:           'can_message',
  create_child_orgs: 'can_create_child_orgs',
  manage_admins:     'can_manage_admins',
  manage_events:     'can_manage_events',   // read by events (Phase 3)
  check_in:          'can_check_in',        // read by attendance (Phase 4)
};

// FROZEN 2026-09-05 by sql/2026-09-05_flag_set.sql, and the freeze is the point. Eight
// flags, and adding a ninth is not one column: it is a column, a branch in can_act(), two
// lists inside the guard trigger, a list inside the insert policy, and the two places in
// this file. Six edits that must agree, checked by nothing.
//
// can_moderate was dropped in that migration. Nothing read it — no policy, no function, no
// line of code but this map — and a flag nothing checks is not protection, it is a column
// every future reader has to think about and then discover means nothing. It goes back in
// the day post replies exist and something actually asks the question.

// Same cap as the SQL. A parent_id cycle would spin forever; in Postgres that holds a
// connection from a small pool, and here it freezes the tab. Ten is far more than
// school -> department -> club needs.
const ORG_MAX_DEPTH = 10;


// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------
// Three reads, in parallel. RLS decides what comes back, so this asks for everything and
// trusts the database to filter — the opposite of building a query that tries to be clever
// about permissions, which is how the client and the server drift apart.
async function loadOrgContext(force = false) {
  if (_orgCtx && !force) return _orgCtx;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) { _orgCtx = { userId: null, isSuper: false, parents: new Map(), orgs: new Map(), grants: new Map() }; return _orgCtx; }

  const [orgRes, memRes, roleRes] = await Promise.all([
    supabaseClient.from('organizations')
      .select('id, parent_id, school, type, name, slug, logo_url, is_active, is_verified'),
    supabaseClient.from('org_memberships')
      // These column names must match ORG_ACTIONS above and the columns on the table. Asking
      // for a column that does not exist is not a silent miss — PostgREST rejects the whole
      // query, loadOrgContext() returns null, and every officer's console goes empty. Which
      // is why this file and sql/2026-09-05_flag_set.sql have to land together.
      .select('org_id, role, title, status, can_post, can_manage_members, can_view_analytics, can_message, can_create_child_orgs, can_manage_admins, can_manage_events, can_check_in')
      .eq('user_id', user.id),
    // "Users can read own roles" allows this; it is how the super-admin branch of the mirror
    // is answered without depending on globals another file happens to have set.
    supabaseClient.from('user_roles').select('role_id').eq('user_id', user.id),
  ]);

  // A failed query and an empty result are different things. Treating a network error as
  // "you have no permissions" would silently hide an officer's entire console, so the error
  // is surfaced and the cache is left unset so the next call retries.
  if (orgRes.error || memRes.error || roleRes.error) {
    _orgCtxError = orgRes.error?.message || memRes.error?.message || roleRes.error?.message
                   || 'unknown error';
    console.error('[loadOrgContext] load failed:', _orgCtxError);
    return null;
  }
  _orgCtxError = null;

  const orgs    = new Map();
  const parents = new Map();
  (orgRes.data || []).forEach(o => { orgs.set(o.id, o); parents.set(o.id, o.parent_id); });

  const grants = new Map();
  (memRes.data || []).forEach(m => grants.set(m.org_id, m));

  _orgCtx = {
    userId: user.id,          // needed to find your OWN row in a roster you are managing
    isSuper: (roleRes.data || []).some(r => r.role_id === 'super_admin'),
    orgs, parents, grants,
    loadedAt: Date.now(),
  };
  return _orgCtx;
}

// Call after anything that changes memberships or organizations, and on logout. A stale
// cache here shows an ex-officer their old buttons — which the database will refuse, but
// which reads as a bug to the person looking at it.
function clearOrgContext() { _orgCtx = null; _orgCtxError = null; }


// ------------------------------------------------------------
// The mirror
// ------------------------------------------------------------
// Line for line, this is can_act(p_action, p_org_id):
//
//   is_super_admin()                                    -> true
//   active membership on this org with the flag         -> true
//   active membership on any ANCESTOR org with the flag -> true   (walk parent_id upward)
//   otherwise                                           -> false
//
// Synchronous on purpose. It is called from render loops that draw a row per organization,
// and an async permission check inside a loop is how you end up with buttons that flicker in
// after the list has painted. loadOrgContext() must have been awaited first; if it has not
// been, this answers false, which is the safe direction.
function orgCanAct(action, orgId) {
  if (!_orgCtx) return false;
  if (_orgCtx.isSuper) return true;

  const flag = ORG_ACTIONS[action];
  if (!flag) { console.warn('[orgCanAct] unknown action:', action); return false; }

  let id = orgId;
  for (let depth = 0; id != null && depth < ORG_MAX_DEPTH; depth++) {
    const m = _orgCtx.grants.get(id);
    if (m && m.status === 'active' && m[flag] === true) return true;
    id = _orgCtx.parents.get(id) ?? null;   // ?? not ||, because a parent id is never 0 but
                                            // an unknown org must stop the walk, not continue
  }
  return false;
}

// Every organization this user holds an ACTIVE membership in, newest-looking first by name.
// Used to decide whether to offer the console entry at all, and to build the org picker for
// someone who is an officer in more than one place.
function orgMemberships() {
  if (!_orgCtx) return [];
  return [..._orgCtx.grants.values()]
    .filter(m => m.status === 'active')
    .map(m => ({ ...m, org: _orgCtx.orgs.get(m.org_id) || null }))
    .filter(m => m.org)
    .sort((a, b) => a.org.name.localeCompare(b.org.name));
}

// True if this user is an officer anywhere. This is the test for showing a "Switch to org
// console" entry (workstream 2) — a student with no memberships must never see it.
function orgIsOfficerAnywhere() {
  return orgMemberships().some(m => m.role === 'officer');
}

// The organization tree, for rendering. Returns root organizations with a `children` array
// on each, so a caller can draw the hierarchy without walking parents itself.
function orgTree(school) {
  if (!_orgCtx) return [];
  const nodes = new Map();
  [..._orgCtx.orgs.values()]
    .filter(o => !school || o.school === school)
    .forEach(o => nodes.set(o.id, { ...o, children: [] }));

  const roots = [];
  nodes.forEach(n => {
    const parent = n.parent_id != null ? nodes.get(n.parent_id) : null;
    if (parent) parent.children.push(n); else roots.push(n);
  });

  const byName = (a, b) => a.name.localeCompare(b.name);
  const sortRec = n => { n.children.sort(byName); n.children.forEach(sortRec); };
  roots.sort(byName); roots.forEach(sortRec);
  return roots;
}


// ============================================================
// ADMIN UI — the Organizations tab
// ============================================================
// Lives in the EXISTING admin page as its own tab, not in the org console. It began as a plain
// indented tree (workstream 1 stage 3), built so that organizations could exist at all. On
// 2026-09-14 it became one list grouped by department, from the mockup Kal approved on canvas
// page 5 ("Admin - organizations").
//
// Every action below is gated twice. orgCanAct() decides whether the button is drawn; RLS
// decides whether the write succeeds. The second one is the real one. If you ever find a
// button here that works when it should not, the bug is in the SQL, not in this file.
//
// What the mockup's first draft showed and this page deliberately does NOT:
//   - a club Requests queue. No requests table exists, and a queue also needs a student-side
//     "request a club" form. Deferred by Kal; admins create clubs directly.
//   - club categories ("Governance", "Cultural"). organizations has no category column, so a
//     club shows the department it belongs to, which is real.
//   - follower counts for suspended clubs. The count comes from org_directory, which hides
//     inactive organizations, so those read "—" until a counts function exists.

let _orgOpenPanel = null;   // org id whose officer panel is expanded, or null

// What the admin is looking at. Kept apart from _orgCtx and _aoStats because none of it is
// data, and reloading the data after a change must not throw the admin's place away.
let _aoTab     = 'active';   // 'active' | 'attention' | 'suspended'
let _aoQuery   = '';
let _aoOpenRow = null;       // org id whose action strip is open
let _aoSuspend = null;       // org id whose suspend form is open
let _aoReason  = null;       // the reason picked in that form
let _aoAddMode = 'club';     // 'club' | 'department': what the add card creates
let _aoStats   = null;       // the numbers, from _aoLoadStats()

const AO_TABS = ['active', 'attention', 'suspended'];
const AO_DECISION_TYPES = ['org_created', 'org_deactivated', 'org_reactivated'];
// Suspending asks for one of these, because "why" is the half of a decision that is lost first.
const AO_REASONS = ['No active officer', 'Breaks campus policy', 'Club asked to close', 'Other'];
// Supabase's default "max rows". A longer answer is cut off WITHOUT an error, so a result this
// long is treated as unknown rather than counted: a wrong number is worse than no number.
const AO_ROW_CAP = 1000;

// "This semester", for counting. Nestrel has no academic calendar, so this is a fixed US one:
// spring from Jan 1, summer from Jun 1, fall from Aug 15. Good enough to ask "is this club doing
// anything this term?" It is not a registrar's calendar and nothing should treat it as one.
function orgSemesterStart(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth();
  if (m > 7 || (m === 7 && d.getDate() >= 15)) return new Date(y, 7, 15);
  if (m >= 5) return new Date(y, 5, 1);
  return new Date(y, 0, 1);
}

async function renderOrgs() {
  const host = document.getElementById('asec-orgs');
  if (!host) return;
  host.innerHTML = '<div class="org-empty">Loading organizations…</div>';

  const ctx = await loadOrgContext(true);
  if (!ctx) {
    host.innerHTML = '<div class="org-empty">Could not load organizations'
      + (_orgCtxError ? ': ' + esc(_orgCtxError) : '') + '. Check the console.</div>';
    return;
  }

  if (!orgTree().length) {
    // The school row is created by the bootstrap in sql/2026-09-04_org_hierarchy.sql, and
    // only a super admin can create a root organization — that is what makes verification
    // provenance rather than a checkbox. So an empty tree means bootstrap has not been run,
    // not that something is broken.
    host.innerHTML = '<div class="org-empty"><strong>No organizations yet.</strong><br>'
      + 'The school organization is created once, by hand, in the SQL editor — see the '
      + 'BOOTSTRAP section of <code>sql/2026-09-04_org_hierarchy.sql</code>.</div>';
    return;
  }

  const saved = loadUiState('aoTab', 'active');
  _aoTab = AO_TABS.includes(saved) ? saved : 'active';
  _aoStats = await _aoLoadStats();

  host.innerHTML = _aoFrameHtml();
  const search = document.getElementById('aoSearch');
  if (search) search.value = _aoQuery;
  _aoPaintAdd();
  _aoPaint();
}

// Four reads in parallel, and each can fail on its own. A failed or truncated read makes its
// numbers "—", never 0: an admin who cannot read a roster must not be told the club has no
// officers, and a club with no officers is exactly what this page flags as needing attention.
async function _aoLoadStats() {
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
  const [dir, evs, mem, log] = await Promise.all([
    supabaseClient.from('org_directory').select('id, follower_count'),
    supabaseClient.from('events').select('org_id, starts_at')
      .in('status', ['published', 'completed']).gte('starts_at', yearAgo),
    supabaseClient.from('org_memberships').select('org_id')
      .eq('role', 'officer').eq('status', 'active'),
    supabaseClient.from('admin_activity_log')
      .select('id, created_at, actor_id, action_type, target_label, reason')
      .in('action_type', AO_DECISION_TYPES).is('undone_at', null)
      .order('created_at', { ascending: false }).limit(5),
  ]);

  const usable = (res, what) => {
    if (res.error) { console.error(`[_aoLoadStats] ${what}:`, res.error.message); return false; }
    if ((res.data || []).length >= AO_ROW_CAP) {
      console.warn(`[_aoLoadStats] ${what}: ${AO_ROW_CAP}+ rows, so the answer may be cut off — showing "—" instead`);
      return false;
    }
    return true;
  };
  const ok = { followers: usable(dir, 'directory'), events: usable(evs, 'events'), officers: usable(mem, 'rosters') };

  const followers = new Map();
  if (ok.followers) dir.data.forEach(r => followers.set(r.id, Number(r.follower_count) || 0));

  const semStart = orgSemesterStart().getTime(), now = Date.now();
  const events = new Map(), last = new Map(), next = new Map();
  if (ok.events) evs.data.forEach(e => {
    const t = new Date(e.starts_at).getTime();
    if (t >= semStart) events.set(e.org_id, (events.get(e.org_id) || 0) + 1);
    if (t <= now && t > (last.get(e.org_id) || 0)) last.set(e.org_id, t);
    if (t > now && t < (next.get(e.org_id) || Infinity)) next.set(e.org_id, t);
  });

  const officers = new Map();
  if (ok.officers) mem.data.forEach(m => officers.set(m.org_id, (officers.get(m.org_id) || 0) + 1));

  // Decisions name the admin who made them. The names live on profiles, whose read policy is
  // own-row plus school-scoped admin, so a refused lookup falls back to "An admin" rather than
  // printing an id.
  let decisions = null;
  const actors = new Map();
  if (!log.error) {
    decisions = log.data || [];
    const ids = [...new Set(decisions.map(d => d.actor_id).filter(Boolean))];
    if (ids.length) {
      const { data: profs } = await supabaseClient.from('profiles').select('id, first_name, last_name').in('id', ids);
      (profs || []).forEach(p => actors.set(p.id,
        [p.first_name, p.last_name ? p.last_name.charAt(0) + '.' : ''].filter(Boolean).join(' ')));
    }
  } else {
    console.error('[_aoLoadStats] decisions:', log.error.message);
  }

  return { ok, followers, events, last, next, officers, decisions, actors };
}

// What the page can honestly say about one organization. null means "not known" and is drawn
// as "—". Officer counts are only known where this admin may read the roster: RLS returns no
// rows for the others, and those empty results are indistinguishable from "no officers".
function _aoFacts(o) {
  const s = _aoStats || { ok: {} };
  const rosterReadable = !!s.ok.officers && orgCanAct('manage_members', o.id);
  const officers = rosterReadable ? (s.officers.get(o.id) || 0) : null;
  return {
    followers: (s.ok.followers && o.is_active) ? (s.followers.get(o.id) ?? 0) : null,
    events:    s.ok.events ? (s.events.get(o.id) || 0) : null,
    last:      s.ok.events ? (s.last.get(o.id) || null) : null,
    next:      s.ok.events ? (s.next.get(o.id) || null) : null,
    officers, rosterReadable,
    attention: o.is_active && o.type === 'club' && officers === 0,
  };
}

// True when every active club's roster could be read. Only then is "no club needs attention"
// a fact rather than a guess: an admin who holds authority over one department sees its rosters
// and not the next department's, and those unreadable clubs would otherwise count as fine.
function _aoAllRostersKnown() {
  if (!_orgCtx) return false;
  return [..._orgCtx.orgs.values()]
    .filter(o => o.type === 'club' && o.is_active)
    .every(o => _aoFacts(o).rosterReadable);
}

function _aoInTab(o, f) {
  if (_aoTab === 'suspended') return !o.is_active;
  if (_aoTab === 'attention') return f.attention;
  return o.is_active;
}

function _aoDate(v) {
  const d = new Date(v);
  if (isNaN(d)) return '';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function _aoFrameHtml() {
  return `
    <div class="ao-page">
      <div class="ao-toolbar">
        <div class="ao-tabs" id="aoTabs" role="group" aria-label="Show organizations"></div>
        <label class="ao-search">
          ${icon('search', 14)}
          <input id="aoSearch" type="search" autocomplete="off" placeholder="Find a club or department"
                 aria-label="Find a club or department" oninput="aoSearch(this.value)">
        </label>
      </div>
      <div class="ao-grid">
        <section class="ao-card ao-list-card" aria-labelledby="aoListTitle">
          <div class="ao-card-head">
            <h2 class="ao-card-title" id="aoListTitle">Clubs &amp; departments</h2>
            <span class="ao-card-note">Grouped by department · events counted this semester</span>
          </div>
          <div class="ao-cols" aria-hidden="true">
            <span>Name</span><span>Followers</span><span>Events</span><span>Officers</span><span>Status</span><span></span>
          </div>
          <div id="aoList"></div>
        </section>
        <div class="ao-side">
          <section class="ao-card" id="aoAdd" aria-labelledby="aoAddTitle"></section>
          <section class="ao-card" aria-labelledby="aoDecTitle">
            <div class="ao-card-head">
              <h2 class="ao-card-title" id="aoDecTitle">Recent decisions</h2>
              <button class="ao-link" onclick="aoOpenActivityLog()">Activity log ${icon('chevRight', 13)}</button>
            </div>
            <div id="aoDecisions"></div>
          </section>
        </div>
      </div>
    </div>`;
}

function _aoPaint() {
  _aoPaintTabs();
  _aoPaintList();
  _aoPaintDecisions();
}

function _aoPaintTabs() {
  const el = document.getElementById('aoTabs');
  if (!el || !_orgCtx) return;
  const counts = { active: 0, attention: 0, suspended: 0 };
  [..._orgCtx.orgs.values()].filter(o => o.type !== 'school').forEach(o => {
    const f = _aoFacts(o);
    if (o.is_active) counts.active++; else counts.suspended++;
    if (f.attention) counts.attention++;
  });
  // A flagged club is a fact, so a positive count always shows. "0" shows only when every
  // active club's roster was readable; otherwise it would say every club is fine when the page
  // simply could not look. (tests/admin-orgs.js caught the first version printing 0 here.)
  const attention = (counts.attention > 0 || _aoAllRostersKnown()) ? counts.attention : '—';
  const tab = (id, label, n, warn) => `
    <button class="ao-tab${_aoTab === id ? ' is-on' : ''}" aria-pressed="${_aoTab === id}" onclick="aoSetTab('${id}')">
      <span>${label}</span><span class="ao-tab-n${warn ? ' is-warn' : ''}">${n}</span>
    </button>`;
  el.innerHTML = tab('active', 'Active', counts.active, false)
               + tab('attention', 'Needs attention', attention, counts.attention > 0)
               + tab('suspended', 'Suspended', counts.suspended, false);
}

function _aoPaintList() {
  const el = document.getElementById('aoList');
  if (!el || !_orgCtx) return;

  // Repainting rebuilds every officer panel empty. Carry the open one across, so typing in the
  // search box or opening another row does not close the roster the admin is reading.
  const keepId = _orgOpenPanel;
  const keepHtml = keepId != null ? (document.getElementById('org-panel-' + keepId)?.innerHTML || '') : '';

  const q = _aoQuery.trim().toLowerCase();
  const matches = o => !q || o.name.toLowerCase().includes(q);
  const roots = orgTree();
  let html = '';

  roots.forEach(school => {
    const kids = school.children || [];
    let groups = '';
    const group = (dept, clubs) => {
      const shown = clubs.filter(c => _aoInTab(c, _aoFacts(c)) && (matches(c) || (dept && matches(dept))));
      const df = dept ? _aoFacts(dept) : null;
      const deptItself = dept && _aoInTab(dept, df) && matches(dept);
      // A department header also appears for context when only its clubs match.
      if (!shown.length && !deptItself) return '';
      const head = dept ? _aoDeptHtml(dept, df, clubs.length)
                        : '<div class="ao-dept"><span class="ao-dept-text"><span class="ao-dept-name">Not in a department</span></span></div>';
      return head + shown.map(c => _aoRowHtml(c, _aoFacts(c))).join('');
    };
    kids.filter(k => k.type === 'department').forEach(d => { groups += group(d, d.children || []); });
    // A club attached straight to a school cannot be created from this page, but nothing in the
    // schema forbids one, so it is shown rather than silently dropped.
    const loose = kids.filter(k => k.type !== 'department');
    if (loose.length) groups += group(null, loose);
    if (groups && roots.length > 1) html += `<div class="ao-school">${esc(school.name)}</div>`;
    html += groups;
  });

  el.innerHTML = html || `<div class="org-empty">${_aoEmptyText()}</div>`;

  if (keepId != null) {
    const panel = document.getElementById('org-panel-' + keepId);
    if (panel) panel.innerHTML = keepHtml; else _orgOpenPanel = null;
  }
}

function _aoEmptyText() {
  if (_aoQuery.trim()) return `Nothing matches “${esc(_aoQuery.trim())}”.`;
  if (_aoTab === 'attention' && !_aoAllRostersKnown()) {
    return 'Some rosters could not be read, so a club with no officers may not be listed here.';
  }
  return {
    active:    'No active organizations.',
    attention: 'Every active club has at least one officer.',
    suspended: 'No suspended organizations.',
  }[_aoTab];
}

function _aoNumHtml(n, one, many, whyUnknown, warn = false) {
  if (n === null) {
    return `<span class="ao-num"><span class="ao-unknown" title="${escAttr(whyUnknown)}">—</span>`
         + `<span class="ao-num-l"> ${many}: ${esc(whyUnknown.toLowerCase())}</span></span>`;
  }
  return `<span class="ao-num${warn ? ' is-warn' : ''}">${n}<span class="ao-num-l"> ${n === 1 ? one : many}</span></span>`;
}

function _aoMoreHtml(o) {
  if (!orgCanAct('manage_members', o.id)) return '<span class="ao-more-none" aria-hidden="true"></span>';
  const open = _aoOpenRow === o.id;
  return `<button class="ao-more${open ? ' is-open' : ''}" onclick="aoToggleRow(${o.id})" aria-expanded="${open}"
            aria-controls="ao-strip-${o.id}" aria-label="Actions for ${escAttr(o.name)}">${icon('more', 15)}</button>`;
}

function _aoDeptHtml(d, f, clubCount) {
  const open      = _aoOpenRow === d.id;
  const canChild  = d.is_active && orgCanAct('create_child_orgs', d.id);
  const canManage = orgCanAct('manage_members', d.id);
  const meta = ['Department', `${clubCount} club${clubCount === 1 ? '' : 's'}`,
                f.officers === null ? null : `${f.officers} officer${f.officers === 1 ? '' : 's'}`]
               .filter(Boolean).join(' · ');
  return `
    <div class="ao-dept${d.is_active ? '' : ' is-off'}${open ? ' is-open' : ''}">
      <span class="ao-dept-icon" aria-hidden="true">${icon('school', 15)}</span>
      <span class="ao-dept-text"><span class="ao-dept-name">${esc(d.name)}</span><span class="ao-dept-meta">${meta}</span></span>
      ${d.is_active ? '' : '<span class="ao-badge is-off">Suspended</span>'}
      <span class="ao-dept-actions">
        ${canChild ? `<button class="ao-btn" onclick="aoAddClubTo(${d.id})" aria-label="Add a club to ${escAttr(d.name)}">+ Club</button>` : ''}
        ${canManage ? `<button class="ao-btn" onclick="aoOfficers(${d.id})">Officers</button>` : ''}
        ${canManage ? _aoMoreHtml(d) : ''}
      </span>
    </div>
    <div class="ao-strip-host" id="ao-strip-${d.id}">${open ? _aoStripHtml(d, true) : ''}</div>
    <div class="org-panel" id="org-panel-${d.id}"></div>`;
}

function _aoRowHtml(o, f) {
  const open = _aoOpenRow === o.id;
  const sub = f.attention ? '<span class="ao-sub is-warn">No active officer</span>'
    : f.last  ? `<span class="ao-sub">Last event ${_aoDate(f.last)}</span>`
    : f.next  ? `<span class="ao-sub">Next event ${_aoDate(f.next)}</span>`
    : f.events === null ? '' : '<span class="ao-sub">No events in the past year</span>';
  const badge = !o.is_active ? '<span class="ao-badge is-off">Suspended</span>'
              : f.attention  ? '<span class="ao-badge is-warn">Needs attention</span>'
              :                '<span class="ao-badge is-ok">Active</span>';
  const couldNot = 'Could not load';
  return `
    <div class="ao-row${o.is_active ? '' : ' is-off'}${open ? ' is-open' : ''}">
      <div class="ao-who">${_dirLogoHTML(o, 'ao-tile')}<div class="ao-who-text"><span class="ao-name">${esc(o.name)}</span>${sub}</div></div>
      <span class="ao-nums">
        ${_aoNumHtml(f.followers, 'follower', 'followers', o.is_active ? couldNot : 'Not counted while suspended')}
        ${_aoNumHtml(f.events, 'event', 'events', couldNot)}
        ${_aoNumHtml(f.officers, 'officer', 'officers', f.rosterReadable || !_aoStats?.ok?.officers ? couldNot : 'You cannot read this roster', f.attention)}
      </span>
      <span class="ao-status">${badge}</span>
      ${_aoMoreHtml(o)}
    </div>
    <div class="ao-strip-host" id="ao-strip-${o.id}">${open ? _aoStripHtml(o, false) : ''}</div>
    <div class="org-panel" id="org-panel-${o.id}"></div>`;
}

function _aoStripHtml(o, isDept) {
  if (_aoSuspend === o.id) return _aoSuspendHtml(o);
  return `<div class="ao-strip">
    ${isDept ? '' : `<button class="ao-btn" onclick="aoOfficers(${o.id})">Officers</button>`}
    ${o.is_active
      ? `<button class="ao-btn ao-btn-warn" onclick="aoAskSuspend(${o.id})">Suspend…</button>`
      : `<button class="ao-btn ao-btn-go" onclick="orgSetActive(${o.id}, true)">Reactivate</button>`}
  </div>`;
}

// The suspend form IS the confirmation. It replaced a confirm() box, which asked "are you
// sure?" and recorded nothing about why.
function _aoSuspendHtml(o) {
  const other = _aoReason === 'Other';
  return `
    <div class="ao-strip ao-suspend" role="group" aria-labelledby="aoSusTitle-${o.id}">
      <div class="ao-suspend-copy">
        <strong id="aoSusTitle-${o.id}">Suspend ${esc(o.name)}?</strong>
        <span>It leaves the directory and its upcoming events stop showing. Past events stay as history, and you can reactivate it at any time.</span>
      </div>
      <div class="ao-reasons" role="group" aria-label="Reason for suspending">
        <span class="ao-reasons-label" aria-hidden="true">Reason</span>
        ${AO_REASONS.map((r, i) => `<button type="button" class="ao-reason${_aoReason === r ? ' is-on' : ''}" aria-pressed="${_aoReason === r}" onclick="aoPickReason(${o.id}, ${i})">${esc(r)}</button>`).join('')}
      </div>
      <div class="ao-suspend-row">
        <input class="ao-input" id="aoSusNote-${o.id}" type="text" maxlength="200" autocomplete="off"
               placeholder="${other ? 'Say why — needed for Other' : 'Add a note for the activity log (optional)'}"
               aria-label="Note for the activity log">
        <button class="ao-btn" onclick="aoCancelSuspend(${o.id})">Cancel</button>
        <button class="ao-btn ao-btn-danger" onclick="aoConfirmSuspend(${o.id})">Suspend ${o.type === 'department' ? 'department' : 'club'}</button>
      </div>
    </div>`;
}

function _aoPaintDecisions() {
  const el = document.getElementById('aoDecisions');
  if (!el) return;
  const s = _aoStats;
  if (!s || s.decisions === null) { el.innerHTML = '<p class="ao-empty">Could not load the activity log.</p>'; return; }
  if (!s.decisions.length) {
    el.innerHTML = '<p class="ao-empty">Nothing yet. Creating, suspending and reactivating organizations will show here.</p>';
    return;
  }
  const verb = { org_created: 'Created', org_deactivated: 'Suspended', org_reactivated: 'Reactivated' };
  el.innerHTML = '<ul class="ao-dec-list">' + s.decisions.map(d => {
    const meta = [d.reason, s.actors.get(d.actor_id) || 'An admin', _aoDate(d.created_at)].filter(Boolean).map(esc).join(' · ');
    return `<li class="ao-dec">
      <span class="ao-dec-dot${d.action_type === 'org_deactivated' ? ' is-off' : ''}" aria-hidden="true"></span>
      <span class="ao-dec-text"><span>${verb[d.action_type] || esc(d.action_type)} <strong>${esc(d.target_label || 'an organization')}</strong></span>
      <span class="ao-dec-meta">${meta}</span></span>
    </li>`;
  }).join('') + '</ul>';
}

function _aoPaintAdd() {
  const el = document.getElementById('aoAdd');
  if (!el || !_orgCtx) return;
  const all = [..._orgCtx.orgs.values()];
  const byName = (a, b) => a.name.localeCompare(b.name);
  // Where this admin may create something. Mirrors organizations_insert: create_child_orgs on
  // the parent. A club's parent is always a department; a department's is the school.
  const depts   = all.filter(o => o.type === 'department' && o.is_active && orgCanAct('create_child_orgs', o.id)).sort(byName);
  const schools = all.filter(o => o.type === 'school'     && o.is_active && orgCanAct('create_child_orgs', o.id)).sort(byName);
  if (!depts.length && !schools.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (_aoAddMode === 'club' && !depts.length) _aoAddMode = 'department';
  if (_aoAddMode === 'department' && !schools.length) _aoAddMode = 'club';

  const isClub  = _aoAddMode === 'club';
  const parents = isClub ? depts : schools;
  const manySchools = new Set(parents.map(p => p.school)).size > 1;
  const other = isClub
    ? (schools.length ? `<button class="ao-link" onclick="aoSetAddMode('department')">Add a department instead</button>` : '')
    : (depts.length   ? `<button class="ao-link" onclick="aoSetAddMode('club')">Add a club instead</button>` : '');

  el.innerHTML = `
    <div class="ao-card-head">
      <div>
        <h2 class="ao-card-title" id="aoAddTitle">${isClub ? 'Add a club' : 'Add a department'}</h2>
        <p class="ao-card-lede">${isClub
          ? 'It appears in the directory straight away. Add an officer now so it has a console to run from.'
          : 'Departments hold clubs. Add one only if the school really has it.'}</p>
      </div>
    </div>
    <div class="ao-field">
      <label for="aoNewName">${isClub ? 'Club name' : 'Department name'}</label>
      <input class="ao-input" id="aoNewName" type="text" maxlength="80" autocomplete="off"
             placeholder="${isClub ? 'e.g. Film Society' : 'e.g. Student Life'}">
    </div>
    <div class="ao-field">
      <label for="aoNewParent">Belongs to</label>
      <select class="ao-input" id="aoNewParent">
        ${parents.map(p => `<option value="${p.id}">${esc(p.name)}${manySchools ? ' — ' + esc(p.school) : ''}</option>`).join('')}
      </select>
    </div>
    ${isClub ? `
    <div class="ao-field">
      <label for="aoNewOfficer">First officer <span class="ao-optional">(optional)</span></label>
      <input class="ao-input" id="aoNewOfficer" type="email" autocomplete="off" placeholder="officer@caldwell.edu">
      <span class="ao-hint">They need a Nestrel account first.</span>
    </div>` : ''}
    <div class="ao-add-actions">
      ${other}
      <button class="ao-btn ao-btn-go" id="aoCreateBtn" onclick="aoCreateOrg()">${isClub ? 'Create club' : 'Create department'}</button>
    </div>`;
}

// ---------- page interactions ----------
function aoSetTab(tab) {
  if (!AO_TABS.includes(tab)) return;
  _aoTab = tab; _aoOpenRow = null; _aoSuspend = null; _aoReason = null;
  saveUiState('aoTab', tab);
  _aoPaintTabs();
  _aoPaintList();
}

function aoSearch(value) {
  _aoQuery = value || '';
  _aoOpenRow = null; _aoSuspend = null; _aoReason = null;
  _aoPaintList();
}

// Every repaint replaces the button that was focused, so focus is put back by hand. Without
// this a keyboard user is thrown to the top of the page each time they open a row.
function _aoFocus(selector) { document.querySelector(selector)?.focus(); }

function aoToggleRow(id) {
  _aoOpenRow = _aoOpenRow === id ? null : id;
  _aoSuspend = null; _aoReason = null;
  _aoPaintList();
  _aoFocus(`[aria-controls="ao-strip-${id}"]`);
}

function aoAskSuspend(id) {
  const org = _orgCtx?.orgs.get(id);
  if (!org) return;
  _aoOpenRow = id; _aoSuspend = id;
  // A club flagged for having no officer is usually being suspended for exactly that.
  _aoReason = _aoFacts(org).attention ? AO_REASONS[0] : null;
  _aoPaintList();
  _aoFocus(`#ao-strip-${id} .ao-reason`);
}

// Changes the buttons in place instead of repainting, so a note already typed is not wiped.
function aoPickReason(id, i) {
  _aoReason = AO_REASONS[i] || null;
  document.querySelectorAll(`#ao-strip-${id} .ao-reason`).forEach((b, j) => {
    b.classList.toggle('is-on', j === i);
    b.setAttribute('aria-pressed', String(j === i));
  });
  const note = document.getElementById('aoSusNote-' + id);
  if (note) note.placeholder = _aoReason === 'Other' ? 'Say why — needed for Other' : 'Add a note for the activity log (optional)';
}

function aoCancelSuspend(id) {
  _aoSuspend = null; _aoReason = null;
  _aoPaintList();
  _aoFocus(`[aria-controls="ao-strip-${id}"]`);
}

async function aoConfirmSuspend(id) {
  const noteEl = document.getElementById('aoSusNote-' + id);
  const note = (noteEl?.value || '').trim();
  if (!_aoReason) { toast('Choose a reason — it is saved to the activity log'); _aoFocus(`#ao-strip-${id} .ao-reason`); return; }
  if (_aoReason === 'Other' && !note) { toast('Add a note saying why'); noteEl?.focus(); return; }
  await orgSetActive(id, false, note ? `${_aoReason} — ${note}` : _aoReason);
}

function aoOfficers(id) {
  _aoOpenRow = null; _aoSuspend = null; _aoReason = null;
  _aoPaintList();
  orgTogglePanel(id);
}

function aoAddClubTo(deptId) {
  _aoAddMode = 'club';
  _aoPaintAdd();
  const select = document.getElementById('aoNewParent');
  if (select) select.value = String(deptId);
  document.getElementById('aoAdd')?.scrollIntoView({ block: 'nearest' });
  _aoFocus('#aoNewName');
}

function aoSetAddMode(mode) {
  _aoAddMode = mode === 'department' ? 'department' : 'club';
  _aoPaintAdd();
  _aoFocus('#aoNewName');
}

function aoOpenActivityLog() {
  ago('activity', document.querySelector(`.a-nav-item[onclick*="'activity'"]`));
}

// ---------- create a club or department ----------
async function aoCreateOrg() {
  const type   = _aoAddMode === 'department' ? 'department' : 'club';
  const nameEl = document.getElementById('aoNewName');
  const name   = (nameEl?.value || '').trim();
  const parent = _orgCtx?.orgs.get(Number(document.getElementById('aoNewParent')?.value));
  const email  = type === 'club' ? (document.getElementById('aoNewOfficer')?.value || '').trim().toLowerCase() : '';

  if (!name)   { toast(`Give the ${type} a name first`); nameEl?.focus(); return; }
  if (!parent) { toast('Choose where it belongs'); return; }

  // The slug is derived, never typed. It is half of `unique (school, slug)`, so letting a
  // person enter it invites two clubs that differ only by a capital letter.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) { toast('That name has no letters or numbers in it'); nameEl?.focus(); return; }

  const btn = document.getElementById('aoCreateBtn');
  if (btn) btn.disabled = true;

  const { data, error } = await supabaseClient.from('organizations').insert({
    school: parent.school,          // inherited, never chosen — a child cannot change schools
    parent_id: parent.id,
    type, name, slug,
    created_by: (await supabaseClient.auth.getUser()).data.user?.id || null,
  }).select('id').single();

  if (error) {
    if (btn) btn.disabled = false;
    // 23505 is unique_violation. Saying which constraint failed is the difference between
    // "something went wrong" and "you already have one of these".
    toast(error.code === '23505' ? `A ${type} with that name already exists` : 'Could not create: ' + error.message);
    console.error('[aoCreateOrg]', error);
    return;
  }
  // Awaited, so the Recent decisions list repainted below already includes it.
  await logEvent('org_created', { targetType: 'organization', targetId: data.id, targetLabel: name,
                                  school: parent.school, after: { type, parent_id: parent.id } });

  let message = `${name} created`;
  if (email) {
    await loadOrgContext(true);   // the new club must be in the cache before anything looks it up
    const r = await _orgGrantOfficer(data.id, email);
    // The club exists either way, and the message must say so. "Could not add officer" on its
    // own reads as though nothing was created, and the admin makes a second club.
    message = r.ok ? `${name} created, with ${email} as its first officer`
                   : `${name} was created, but the officer was not added. ${r.message}`;
  }
  toast(message);

  _aoTab = 'active'; _aoQuery = ''; _aoOpenRow = null; _aoSuspend = null; _aoReason = null;
  saveUiState('aoTab', 'active');
  clearOrgContext();
  renderOrgs();
}

// ---------- suspend / reactivate ----------
async function orgSetActive(orgId, active, reason = null) {
  const org = _orgCtx?.orgs.get(orgId);
  if (!org) return;

  // .select() makes a refused write visible. Without it, an update that RLS filters down to
  // zero rows returns no error at all, and the page would announce a suspension that never
  // happened.
  const { data, error } = await supabaseClient.from('organizations')
    .update({ is_active: active }).eq('id', orgId).select('id');
  if (error) { toast('Could not update: ' + error.message); console.error('[orgSetActive]', error); return; }
  if (!data || !data.length) { toast(`You don't have authority to change ${org.name}`); return; }

  await logEvent(active ? 'org_reactivated' : 'org_deactivated',
    { targetType: 'organization', targetId: orgId, targetLabel: org.name, school: org.school, reason,
      before: { is_active: !active }, after: { is_active: active } });
  toast(active ? `${org.name} reactivated` : `${org.name} suspended`);
  _aoOpenRow = null; _aoSuspend = null; _aoReason = null;
  renderOrgs();
}

// A roster change moves an officer count and can move a club in or out of "Needs attention",
// so the numbers are reloaded. Then the panel that was open is reopened, because closing the
// thing the admin was working in reads as the change having failed.
async function _aoAfterRosterChange(orgId) {
  clearOrgContext();
  await loadOrgContext(true);
  if (document.getElementById('aoList')) {
    _aoStats = await _aoLoadStats();
    _orgOpenPanel = null;
    _aoPaint();
  }
  _orgOpenPanel = null;
  orgTogglePanel(orgId);
}

// ---------- the officer panel ----------
async function orgTogglePanel(orgId) {
  const el = document.getElementById('org-panel-' + orgId);
  if (!el) return;
  // The permission cache must be loaded before this draws, or orgCanAct() answers false and the
  // roster repaints without its Add officer form. Every roster change clears the cache and then
  // calls this, which is exactly when that used to happen.
  if (!_orgCtx) await loadOrgContext();
  if (_orgOpenPanel === orgId) { el.innerHTML = ''; _orgOpenPanel = null; return; }

  document.querySelectorAll('.org-panel').forEach(p => p.innerHTML = '');
  _orgOpenPanel = orgId;
  el.innerHTML = '<div class="org-empty">Loading roster…</div>';

  const { data, error } = await supabaseClient
    .from('org_memberships')
    .select('id, user_id, pending_email, role, title, status, can_post, can_manage_members, can_manage_admins')
    .eq('org_id', orgId);
  if (error) { el.innerHTML = '<div class="org-empty">Could not load the roster.</div>'; console.error('[orgTogglePanel]', error); return; }

  // The roster stores user_id; the names live on profiles. One extra query rather than a
  // join, because the join would need a foreign-key relationship PostgREST can see and this
  // is a handful of rows.
  const ids = (data || []).map(m => m.user_id).filter(Boolean);
  let names = {}, namesFailed = false;
  if (ids.length) {
    const { data: profs, error: profErr } = await supabaseClient.from('profiles')
      .select('id, first_name, last_name, email').in('id', ids);
    // The read policy on profiles is own-row plus school-scoped admin. A school admin
    // outside that school, or any future tightening, gets nothing back — and the old code
    // then printed raw uuids into the roster as though they were names. Distinguish the two.
    if (profErr) { namesFailed = true; console.error('[orgTogglePanel] name lookup failed:', profErr.message); }
    (profs || []).forEach(p => names[p.id] = `${p.first_name} ${p.last_name}`.trim() + ` · ${p.email}`);
  }
  const who = m => m.user_id
    ? (names[m.user_id] || (namesFailed ? 'Name unavailable — no permission to read it' : 'Unknown student'))
    : (m.pending_email + ' (invited — see below)');

  const canGrant = orgCanAct('manage_admins', orgId);

  // Active first, then everyone who has left. A removed row is history rather than a member,
  // so it is dimmed and offers Restore instead of Remove.
  const sorted = (data || []).slice().sort((a, b) =>
    (a.status === 'removed' ? 1 : 0) - (b.status === 'removed' ? 1 : 0));

  const rows = sorted.length
    ? sorted.map(m => {
        const gone = m.status === 'removed';
        // No Remove control on your own row. The database refuses it anyway
        // (guard_org_self_removal), and a button whose only outcome is an error message is
        // worse than no button — this is the mirror, and the mirror should not offer what
        // the server will refuse.
        //
        // Anyone who can see this roster holds can_manage_members, so "my own row" and "a
        // row the guard protects" are the same row here.
        const mine = m.user_id && m.user_id === _orgCtx?.userId;
        const action = mine
          ? '<span class="org-roster-self">You</span>'
          : gone
            ? `<button class="org-btn" onclick="orgRestoreMember(${m.id}, ${orgId})">Restore</button>`
            : `<button class="org-btn org-btn-warn" onclick="orgRemoveMember(${m.id}, ${orgId})">Remove</button>`;
        return `
        <div class="org-roster-row${gone ? ' org-roster-row-off' : ''}">
          <span class="org-roster-who">${esc(who(m))}</span>
          <span class="org-roster-role">${esc(m.title || m.role)}${m.status !== 'active' ? ' · ' + esc(m.status) : ''}</span>
          ${action}
        </div>`; }).join('')
    : '<div class="org-empty">No members yet.</div>';

  // "Add me as an officer here" — the BOOTSTRAP block of sql/2026-09-04_org_hierarchy.sql,
  // without the SQL editor. §2.7 is explicit that platform operator and officer are two
  // identities sharing one login: can_act() answers true for a super admin everywhere, but
  // orgMemberships() lists real rows only, so a super admin with no row is told they are an
  // officer of nothing. True, and useless. This is the button that fixes it.
  //
  // SUPER ADMINS ONLY, deliberately. Someone holding can_manage_admins on one club could
  // otherwise use this to grant themselves can_create_child_orgs — a flag they were never
  // given — which is the escalation shape the whole flag guard exists to prevent. A super
  // admin already holds every authority through is_super_admin(), so the row they create
  // here adds identity, not power.
  const myRow = (data || []).find(m => m.user_id === _orgCtx?.userId);
  const selfBtn = (_orgCtx?.isSuper && (!myRow || myRow.status !== 'active'))
    ? `<div class="org-form">
         <button class="org-btn" onclick="orgAddSelf(${orgId})">Add me as an officer here</button>
       </div>`
    : '';

  el.innerHTML = rows + selfBtn + (canGrant ? `
    <div class="org-form">
      <input class="org-input" id="org-add-${orgId}" type="email" placeholder="officer@caldwell.edu" autocomplete="off">
      <button class="org-btn" onclick="orgAddOfficer(${orgId})">Add officer</button>
    </div>
    <div class="org-note">They must already have a Nestrel account. Adding someone who has not
    signed up yet is not supported — the invite would never resolve into a real membership.<br>
    You cannot remove your own officer role: another officer, or someone in the organization
    above this one, has to do it.</div>`
    : '<div class="org-empty">Adding officers needs the \u201Cmanage admins\u201D permission.</div>');
}

// Adds `email` as an officer of orgId and REPORTS what happened instead of toasting it, so each
// caller can word the outcome for its own context: the roster panel, and "Add a club", which
// creates a club and names its first officer in one step. Every check below is the one
// orgAddOfficer() always made, moved here unchanged.
async function _orgGrantOfficer(orgId, email) {

  // Look the person up. THE ERROR MATTERS AS MUCH AS THE RESULT, and until 2026-09-05 this
  // line discarded it — so "the database refused me this read" and "nobody has that address"
  // came back identically as null, and the code took the second branch for both.
  //
  // That is not theoretical. The read policy on profiles is own-row plus school-scoped admin
  // (sql/2026-09-04_restrict_profiles_select.sql), so a school admin outside that school gets
  // a refusal here, and the old code responded by writing a membership row with a null
  // user_id — a person who appears on the roster and can never log in as themselves.
  const { data: prof, error: lookupErr } = await supabaseClient
    .from('profiles').select('id').eq('email', email).maybeSingle();

  if (lookupErr) {
    console.error('[_orgGrantOfficer] lookup failed:', lookupErr);
    return { ok: false, message: 'Could not look that address up: ' + lookupErr.message };
  }

  // NO ORPHAN ROWS. pending_email exists on the table for plan A15 — add an e-board before
  // they have accounts, resolve it at signup — but THE RESOLUTION WAS NEVER BUILT. Nothing
  // in handle_new_user, the signup path or any sql/ file links a pending_email to a new
  // account. So a row written that way sits on the roster reading "(invited)" forever, and
  // the person it names is told they are an officer of nothing when they log in.
  //
  // Refusing is the honest answer while that is true. Writing a row that can never become
  // real is worse than declining to write one. When A15 is actually built, this branch is
  // where it goes.
  if (!prof) {
    return { ok: false, message: email + ' has no Nestrel account yet — ask them to sign up first, then add them' };
  }

  // A removed member keeps their row, because org_memberships is unique on (org_id, user_id)
  // and removal is now a status change rather than a delete. So re-adding somebody is an
  // UPDATE. Without this branch it fails on the unique constraint with a duplicate-key
  // message that names neither the person nor the reason.
  const { data: existing, error: existErr } = await supabaseClient
    .from('org_memberships').select('id, status')
    .eq('org_id', orgId).eq('user_id', prof.id).maybeSingle();

  if (existErr) {
    console.error('[_orgGrantOfficer] roster check failed:', existErr);
    return { ok: false, message: 'Could not check the roster: ' + existErr.message };
  }

  const grant = {
    role: 'officer',
    title: 'Officer',
    status: 'active',
    // A deliberate default, not a full set: post, manage the roster, read analytics, reply to
    // messages. NOT create_child_orgs and NOT manage_admins — granting authority is the one
    // thing that should never be handed out by default.
    //
    // Also not can_manage_events or can_check_in, which is correct only until Phase 3 ships:
    // nothing reads them yet, but the day events exist, an officer added here will not be
    // able to create one. Whether the default officer grant should include them is a Phase 3
    // decision, and this comment is the reminder to make it deliberately.
    can_post: true, can_manage_members: true, can_view_analytics: true, can_message: true,
  };

  const { error } = existing
    ? await supabaseClient.from('org_memberships').update(grant).eq('id', existing.id)
    : await supabaseClient.from('org_memberships').insert({ org_id: orgId, user_id: prof.id, ...grant });

  if (error) {
    console.error('[_orgGrantOfficer]', error);
    return { ok: false, message: error.code === '23505' ? 'That person is already on this roster' : 'Could not add: ' + error.message };
  }
  const org = _orgCtx?.orgs.get(orgId);
  logEvent('org_officer_added', { targetType: 'membership', targetId: orgId, targetLabel: email,
                                  school: org?.school, after: { role: 'officer' } });
  return { ok: true };
}

async function orgAddOfficer(orgId) {
  const input = document.getElementById('org-add-' + orgId);
  const email = (input?.value || '').trim().toLowerCase();
  if (!email) return;
  const r = await _orgGrantOfficer(orgId, email);
  if (!r.ok) { toast(r.message); return; }
  toast('Officer added');
  _aoAfterRosterChange(orgId);
}

// Removal is a STATUS CHANGE, not a delete. Changed 2026-09-05.
//
// 'removed' has been a legal value in the status check constraint since the table was
// created and nothing ever set it. Meanwhile this function deleted the row outright, which
// is the one thing the rest of the project never does — listings are soft-stated,
// organizations are deactivated rather than dropped, and the audit log keeps snapshots.
//
// It matters beyond consistency. can_act() requires status = 'active', so a removed row
// grants exactly nothing; keeping it costs no authority. And the involvement record (Phase 5)
// is built from membership history — a president who served last year should be able to
// prove it, and every delete run before today destroyed that evidence permanently.
//
// The flags are deliberately left as they were rather than being zeroed. The row now records
// what this person held while they served, which is what history means.
async function orgRemoveMember(membershipId, orgId) {
  if (!confirm('Remove this person from the organization?\n\nThey keep no permissions once removed. The record that they served stays, and you can restore them.')) return;
  const { error } = await supabaseClient.from('org_memberships')
    .update({ status: 'removed' }).eq('id', membershipId);
  if (error) { toast('Could not remove: ' + error.message); console.error('[orgRemoveMember]', error); return; }
  logEvent('org_member_removed', { targetType: 'membership', targetId: membershipId,
                                   before: { status: 'active' }, after: { status: 'removed' } });
  toast('Removed');
  _aoAfterRosterChange(orgId);
}

// The other half of soft removal. Restoring returns the flags the row already carried — it
// does not grant anything new, so the flag guard does not fire (it compares flags, and none
// of them change here).
//
// Worth knowing for Phase 2: that means can_manage_members alone is enough to restore
// somebody who held can_manage_admins. It is not an escalation — the same officer could
// simply not have removed them — but once accepted_at and ended_at exist, restoring should
// probably require the grantee to accept again rather than silently reviving old authority.
async function orgRestoreMember(membershipId, orgId) {
  const { error } = await supabaseClient.from('org_memberships')
    .update({ status: 'active' }).eq('id', membershipId);
  if (error) { toast('Could not restore: ' + error.message); console.error('[orgRestoreMember]', error); return; }
  logEvent('org_member_restored', { targetType: 'membership', targetId: membershipId,
                                    before: { status: 'removed' }, after: { status: 'active' } });
  toast('Restored');
  _aoAfterRosterChange(orgId);
}

// ---------- put yourself on a roster you already govern ----------
// The BOOTSTRAP block of sql/2026-09-04_org_hierarchy.sql, as a button. That block is
// commented out and easy to skip, and skipping it produces a confusing state: you administer
// every organization on campus through is_super_admin(), and the console tells you that you
// are an officer of nothing — because orgMemberships() lists membership rows, and you have
// none.
//
// Super admins only. See the note where the button is drawn: for anyone else this would be a
// way to grant themselves flags they were never given.
async function orgAddSelf(orgId) {
  const org = _orgCtx?.orgs.get(orgId);
  if (!org) return;
  if (!_orgCtx?.isSuper) { toast('Only a platform administrator can do that'); return; }
  if (!_orgCtx?.userId)  { toast('Could not identify your account — try signing in again'); return; }
  if (!confirm(`Add yourself as an officer of ${org.name}?\n\nThis does not change what you are allowed to do — you already administer every organization. It makes you appear on this roster and lets you open this organization's console.`)) return;

  const { data: existing, error: existErr } = await supabaseClient
    .from('org_memberships').select('id')
    .eq('org_id', orgId).eq('user_id', _orgCtx.userId).maybeSingle();

  if (existErr) {
    toast('Could not check the roster: ' + existErr.message);
    console.error('[orgAddSelf] roster check failed:', existErr);
    return;
  }

  // The full set, matching the bootstrap row in sql/2026-09-04_org_hierarchy.sql. It grants
  // no authority a super admin did not already hold — can_act() short-circuits on
  // is_super_admin() before it ever looks at a membership — so this row is about identity.
  //
  // can_manage_events and can_check_in are included, which means this needs
  // sql/2026-09-05_flag_set.sql to have been run. Same dependency as the column list in
  // loadOrgContext(); they land together or neither works.
  const grant = {
    role: 'officer', title: 'Administrator', status: 'active',
    can_post: true, can_manage_members: true, can_view_analytics: true, can_message: true,
    can_create_child_orgs: true, can_manage_admins: true,
    can_manage_events: true, can_check_in: true,
  };

  const { error } = existing
    ? await supabaseClient.from('org_memberships').update(grant).eq('id', existing.id)
    : await supabaseClient.from('org_memberships').insert({ org_id: orgId, user_id: _orgCtx.userId, ...grant });

  if (error) { toast('Could not add you: ' + error.message); console.error('[orgAddSelf]', error); return; }

  logEvent('org_self_added', { targetType: 'membership', targetId: orgId, targetLabel: org.name,
                               school: org.school, after: { role: 'officer', title: 'Administrator' } });
  toast('You are now an officer of ' + org.name);
  _aoAfterRosterChange(orgId);
}


// ============================================================
// ORG CONSOLE — workstream 2
// ============================================================
// A separate SURFACE, not a separate login (plan §2.7). The officer signs in as themselves and
// switches into an org identity; there is no shared club password to rotate when a president
// graduates, and admin_activity_log records which human acted rather than "Chess Club".
//
// Reached by showPage('org-console'), which the app's router resolves to #page-org-console.
// The header states the identity at all times, because an action taken here is taken ON BEHALF
// of an organization and that should never be ambiguous.

let _ocOrgId   = null;      // organization currently being operated as
let _ocSection = 'posts';

// The entry point. Drawn into #orgConsoleEntry on the profile page, and drawn as nothing at
// all for the overwhelming majority of students, who are officers of nothing.
async function renderOrgConsoleEntry() {
  const host = document.getElementById('orgConsoleEntry');
  if (!host) return;
  host.innerHTML = '';
  if (!getEffectiveUser()) return;

  await loadOrgContext();

  // The nav shortcut, so an officer deep in the app does not have to walk back to their
  // profile to reach the console. Same class as the bell deliberately: the mobile rule
  // `#navUser .nav-btn{display:none}` would hide a .nav-btn, and officers use phones too.
  const navBtn = document.getElementById('navConsoleBtn');
  if (navBtn) navBtn.hidden = !orgIsOfficerAnywhere();

  if (!orgIsOfficerAnywhere()) return;      // students never see it

  const mine = orgMemberships().filter(m => m.role === 'officer');
  const label = mine.length === 1
    ? `Switch to ${esc(mine[0].org.name)} console`
    : `Switch to org console (${mine.length})`;
  host.innerHTML = `<button class="btn-full oc-entry" onclick="orgConsoleOpen()">${label}</button>`;
}

// Officers in exactly one org go straight in. Officers in several get a picker — the plan is
// explicit that this is the normal case, not an edge case (§2.3).
async function orgConsoleOpen(orgId) {
  const ctx = await loadOrgContext(true);
  // A failed load is not an empty roster. Saying "you are not an officer" when the request
  // never completed sends the reader to look at their permissions, which are fine.
  if (!ctx) { toast('Could not load your organizations: ' + (_orgCtxError || 'unknown error')); return; }

  const mine = orgMemberships().filter(m => m.role === 'officer');
  if (!mine.length) { toast('You are not an officer of any organization'); return; }

  if (orgId) _ocOrgId = orgId;
  else if (mine.length === 1) _ocOrgId = mine[0].org_id;
  else if (!_ocOrgId || !mine.some(m => m.org_id === _ocOrgId)) { orgConsolePick(mine); return; }

  // The remembered section, falling back to Events — the first tab. renderOrgConsole() corrects it anyway if
  // this officer cannot reach it — a flag revoked since the last visit lands them on the
  // first section they can actually open rather than on an empty page.
  _ocSection = loadUiState('ocSection:' + _ocOrgId, 'events');
  // Remembered so a refresh returns here rather than to the feed. showPage() already stores
  // 'org-console' as the last page; on its own that is not enough, because the console markup
  // is an empty shell until an organization has been chosen.
  try { sessionStorage.setItem('cn_oc_org', String(_ocOrgId)); } catch (e) { /* private mode */ }
  showPage('org-console');
  renderOrgConsole();
  ocLoadStats(_ocOrgId);   // not awaited: the console is usable before its numbers arrive
}

// Called by boot.js when the remembered page is the console. Falls back to the feed rather
// than to a blank shell if the stored org is gone — deactivated, or the officer removed from
// it while the tab was closed.
async function orgConsoleRestore() {
  let id = null;
  try { id = parseInt(sessionStorage.getItem('cn_oc_org'), 10) || null; } catch (e) { /* private mode */ }
  await loadOrgContext(true);
  const stillMine = id && orgMemberships().some(m => m.role === 'officer' && m.org_id === id);
  if (stillMine) { orgConsoleOpen(id); return; }
  showPage('feed');
}

function orgConsolePick(mine) {
  showPage('org-console');
  document.getElementById('ocIdentity').textContent = 'Choose an organization';
  document.getElementById('ocNav').innerHTML = '';
  const st = document.getElementById('ocStats'); if (st) st.hidden = true;   // no org chosen yet
  document.getElementById('ocBody').innerHTML =
    '<div class="oc-pick">' + mine.map(m => `
      <button class="oc-pick-row" onclick="orgConsoleOpen(${m.org_id})">
        <span class="oc-pick-name">${esc(m.org.name)}</span>
        <span class="oc-pick-role">${esc(m.title || m.role)}</span>
      </button>`).join('') + '</div>';
}

function orgConsoleSwitch() {
  const mine = orgMemberships().filter(m => m.role === 'officer');
  if (mine.length < 2) { toast('You are only an officer of one organization'); return; }
  orgConsolePick(mine);
}

// Which sections exist depends on what this officer can actually do here, so the nav is built
// from orgCanAct() rather than from the org's type. A department officer and a club officer
// see different consoles because they hold different flags, not because of what the row says.
function orgConsoleSections() {
  // In the mockup's order: the work first (Events, Posts), then the people, then the club's own
  // details. Built from orgCanAct(), not from the org's type — a department officer and a club
  // officer see different consoles because they hold different flags.
  const s = [];
  if (orgCanAct('manage_events', _ocOrgId))  s.push({ id: 'events',  label: 'Events' });
  if (orgCanAct('post', _ocOrgId))           s.push({ id: 'posts',   label: 'Posts' });
  if (orgCanAct('manage_members', _ocOrgId)) s.push({ id: 'members', label: 'Members' });
  s.push({ id: 'profile', label: 'Profile' });
  // Analytics arrives with workstream 6. Listed so the shape of the console is visible, and
  // disabled so nothing pretends to work.
  s.push({ id: 'analytics', label: 'Analytics', soon: 'workstream 6' });
  return s;
}

function renderOrgConsole() {
  const org = _orgCtx?.orgs.get(_ocOrgId);
  if (!org) { toast('That organization is no longer available'); goHome(); return; }

  const me = _orgCtx.grants.get(_ocOrgId);
  // The club's own tile — _dirLogoHTML() from orgdir.js, so a club wears the same tint in the
  // console as in the directory and on its page — then its name and the officer's role.
  document.getElementById('ocIdentity').innerHTML = `
    ${_dirLogoHTML(org, 'oc-id-logo')}
    <div class="oc-id-text">
      <div class="oc-id-name">${esc(org.name)}</div>
      <div class="oc-id-meta"><span class="oc-role-pill">${esc(me?.title || me?.role || 'Administrator')}</span>${
        org.type ? `<span class="oc-id-type">${esc(org.type)}</span>` : ''}</div>
    </div>`;
  ocPaintStats();

  // Nothing to switch to is not a button. It used to render always and toast "you are only an
  // officer of one organization", which is the common case — a control whose usual answer is
  // "no" should not be on screen.
  const swBtn = document.getElementById('ocSwitchBtn');
  if (swBtn) swBtn.hidden = orgMemberships().filter(m => m.role === 'officer').length < 2;

  // A section this officer cannot reach must not stay selected. Falls back to the first one
  // they can — 'profile' is pushed unconditionally, so there is always one.
  const sections = orgConsoleSections();
  if (!sections.some(s => s.id === _ocSection && !s.soon)) {
    _ocSection = (sections.find(s => !s.soon) || { id: 'profile' }).id;
  }

  document.getElementById('ocNav').innerHTML = sections.map(s =>
    s.soon
      ? `<button class="oc-tab oc-tab-soon" disabled title="Arrives with ${s.soon}">${s.label}</button>`
      : `<button class="oc-tab${_ocSection === s.id ? ' active' : ''}" onclick="orgConsoleGo('${s.id}')">${s.label}</button>`
  ).join('');

  // Dispatch by name, not by a chain ending in `else renderOcPosts()`. The old chain sent
  // every unrecognised section to Posts, which was invisible while Events was a disabled
  // stub and would have become a bug the moment it was clickable: the Events tab would have
  // rendered the Posts page, which is worse than an error because it looks like it worked.
  //
  // It was already wrong in one live case. orgConsoleOpen() sets _ocSection = 'posts'
  // unconditionally, so an officer holding manage_events but NOT post — exactly the split
  // the flag set exists to allow — opened the console on a Posts page they cannot use,
  // backed by a query RLS returns nothing for.
  const OC_RENDER = {
    posts:   renderOcPosts,
    profile: renderOcProfile,
    members: renderOcMembers,
    events:  renderOcEvents,
  };
  (OC_RENDER[_ocSection] || renderOcProfile)();
}

// Followers, upcoming events and their RSVPs. The org context carries none of them, so they are
// fetched once per open. Painted only if BOTH queries succeed — a failed query is not zero — and
// only if the officer is still looking at the same organization when the answer comes back: a
// quick Switch must not paint one club's numbers under another club's name.
let _ocStats = null;
async function ocLoadStats(orgId) {
  const el = document.getElementById('ocStats');
  if (el) el.hidden = true;
  const [dir, evs] = await Promise.all([
    supabaseClient.from('org_directory').select('follower_count').eq('id', orgId).maybeSingle(),
    supabaseClient.from('visible_events').select('going_count, is_browsable').eq('org_id', orgId),
  ]);
  if (orgId !== _ocOrgId) return;
  if (dir.error || evs.error || !dir.data) {
    if (dir.error || evs.error) console.error('[ocLoadStats]', dir.error || evs.error);
    return;
  }
  const upcoming = (evs.data || []).filter(e => e.is_browsable);
  _ocStats = {
    orgId,
    followers: Number(dir.data.follower_count) || 0,
    upcoming:  upcoming.length,
    rsvps:     upcoming.reduce((n, e) => n + (Number(e.going_count) || 0), 0),
  };
  ocPaintStats();
}

// The club page's light-ruled stat columns (.op-stat), reused so both surfaces read alike.
function ocPaintStats() {
  const el = document.getElementById('ocStats');
  if (!el) return;
  if (!_ocStats || _ocStats.orgId !== _ocOrgId) { el.hidden = true; return; }
  const stat = (n, label) => `<div class="op-stat"><span class="op-stat-n">${n}</span><span class="op-stat-l">${label}</span></div>`;
  el.innerHTML = stat(_ocStats.followers, 'Followers') + stat(_ocStats.upcoming, 'Upcoming') + stat(_ocStats.rsvps, 'RSVPs');
  el.hidden = false;
}

function orgConsoleGo(section) {
  _ocSection = section;
  // Remembered per organization. An officer of two clubs is doing different work in each, and
  // restoring "Events" into a club where they only handle the roster would be a worse guess
  // than the default.
  saveUiState('ocSection:' + _ocOrgId, section);
  renderOrgConsole();
}

// ---------- Org profile ----------
const OC_FIELDS = [
  ['name',            'Name',            'text'],
  ['description',     'Description',     'textarea'],
  ['logo_url',        'Logo URL',        'url'],
  ['contact_email',   'Contact email',   'email'],
  ['office_location', 'Office',          'text'],
  ['phone',           'Phone',           'tel'],
  ['instagram',       'Instagram handle','text'],
  ['website',         'Website',         'url'],
  ['handshake_url',   'Handshake link',  'url'],
];

// The organization's profile exactly as the database holds it, loaded when Profile opens. The
// form is drawn from this and saving is diffed against it.
let _ocProfileRow = null;

async function renderOcProfile() {
  const orgId = _ocOrgId;
  const canEdit = orgCanAct('manage_members', orgId);
  const body = document.getElementById('ocBody');
  body.innerHTML = '<div class="oc-note" id="ocProfileLoading">Loading profile…</div>';

  // The whole row, fetched here. The form used to fill itself from the org context, which is
  // loaded for permissions and carries only id, name, slug, type, logo and flags — so seven of
  // its nine fields always drew EMPTY, and saving wrote every empty box back as NULL. An officer
  // who opened Profile to fix a typo in the name erased the description, email, website and
  // Instagram the club page shows students. It had been that way since the console shipped
  // (2f2ad8a): the context's select (80b265e) was written first and never had these columns.
  const cols = [...new Set(['id', 'name', 'slug', 'type', 'is_verified', 'logo_url', ...OC_FIELDS.map(([k]) => k)])];
  const { data: row, error } = await supabaseClient.from('organizations')
    .select(cols.join(', ')).eq('id', orgId).maybeSingle();
  // Painted only if the officer is still here — same organization, and this section's loading
  // note still on screen. Otherwise a slow reply would draw over whatever they moved on to.
  if (_ocOrgId !== orgId || !document.getElementById('ocProfileLoading')) return;
  if (error || !row) {
    _ocProfileRow = null;
    // No form at all rather than an empty one: an empty form is an invitation to overwrite.
    body.innerHTML = '<div class="oc-note">Could not load this organization’s profile. Reload to try again — nothing has been changed.</div>';
    if (error) console.error('[renderOcProfile]', error);
    return;
  }
  _ocProfileRow = row;

  body.innerHTML = `
    <div class="oc-logo-row">
      ${_dirLogoHTML(row, 'oc-logo')}
      ${canEdit ? `<label class="org-btn oc-logo-btn">Change logo
        <input type="file" accept="image/*" hidden onchange="ocPickLogo(this)">
      </label>` : ''}
    </div>
    <div class="oc-meta">
      <span class="org-badge ${row.is_verified ? 'org-badge-ok' : 'org-badge-off'}">${row.is_verified ? 'verified' : 'unverified'}</span>
      <span class="oc-meta-type">${esc(row.type)}</span>
      <span class="oc-meta-slug">/${esc(row.slug)}</span>
    </div>
    ${OC_FIELDS.map(([k, label, type]) => `
      <label class="oc-field">
        <span class="oc-label">${label}</span>
        ${type === 'textarea'
          ? `<textarea class="oc-input" id="oc-${k}" rows="3" ${canEdit ? '' : 'disabled'}>${esc(row[k] || '')}</textarea>`
          : `<input class="oc-input" id="oc-${k}" type="${type}" value="${escAttr(row[k] || '')}" autocomplete="off" ${canEdit ? '' : 'disabled'}>`}
      </label>`).join('')}
    ${canEdit
      ? '<button class="btn-full oc-save" onclick="saveOcProfile()">Save changes</button>'
      : '<div class="oc-note">You can see this organization but not edit it. Editing needs the “manage members” permission.</div>'}
    <div class="oc-note">Office, phone and Handshake link are kept on file but are not shown on your club page yet.</div>
    <div class="oc-note">The name is what students see. The slug is fixed once created — it is half of the organization’s address and changing it would break every link to it.</div>`;
}

async function saveOcProfile() {
  const row = _ocProfileRow;
  // Saving needs the row the form was drawn from, for this organization. Without it there is
  // nothing to compare against — which is exactly how blanks used to be written over real values.
  if (!row || row.id !== _ocOrgId) { toast('Reload the profile before saving'); return; }

  const patch = {};
  for (const [k, label, type] of OC_FIELDS) {
    const el = document.getElementById('oc-' + k);
    if (!el) continue;
    const raw = el.value.trim() || null;
    // Only what the officer changed is sent. A field they did not touch is not part of the write,
    // so no value can be lost to a box that failed to fill.
    if (raw === (row[k] ?? null)) continue;
    let v = raw;
    // A changed web address must be one. The club page already refuses to link anything that is
    // not http(s) — that kept students safe — but an officer who typed javascript:… or a typo would
    // simply have watched their link disappear. Saying so now is the useful half. Stored normalised
    // ("chessclub.org" becomes https://chessclub.org/), the same link the club page draws.
    if (v && type === 'url') {
      const u = safeUrl(v);
      if (!u) { toast(`${label} has to be a web address, like https://example.com`); return; }
      v = u;
    }
    patch[k] = v;
  }
  if ('name' in patch && !patch.name) { toast('An organization needs a name'); return; }
  const keys = Object.keys(patch);
  if (!keys.length) { toast('Nothing has changed'); return; }

  const { error } = await supabaseClient.from('organizations').update(patch).eq('id', _ocOrgId);
  if (error) {
    // RLS refusing here is the system working: the client mirror said yes, the database is the
    // one that decides. Say so plainly rather than showing a raw Postgres string.
    toast(error.code === '42501' ? 'You do not have permission to edit this organization' : 'Could not save: ' + error.message);
    console.error('[saveOcProfile]', error);
    return;
  }
  logEvent('org_profile_updated', { targetType: 'organization', targetId: _ocOrgId,
                                    targetLabel: patch.name || row.name, school: _orgCtx.orgs.get(_ocOrgId)?.school,
                                    before: Object.fromEntries(keys.map(k => [k, row[k] ?? null])), after: patch });
  toast('Saved');
  await loadOrgContext(true);
  renderOrgConsole();
}

// ---------- Members ----------
// The roster an officer can reach without the admin dashboard, which they have no access to.
async function renderOcMembers() {
  const body = document.getElementById('ocBody');
  body.innerHTML = '<div class="oc-note">Loading roster…</div>';

  const { data, error } = await supabaseClient
    .from('org_memberships')
    .select('id, user_id, pending_email, role, title, status')
    .eq('org_id', _ocOrgId);
  if (error) { body.innerHTML = '<div class="oc-note">Could not load the roster.</div>'; console.error('[renderOcMembers]', error); return; }

  const ids = (data || []).map(m => m.user_id).filter(Boolean);
  const names = {};
  if (ids.length) {
    // public_profiles, not profiles: after the F2 change an officer who is not an admin can
    // only read their own row from the table, and a roster of one person is not a roster.
    const { data: profs, error: profErr } = await supabaseClient.from('public_profiles')
      .select('id, first_name, last_name').in('id', ids);
    if (profErr) console.error('[renderOcMembers] name lookup failed:', profErr.message);
    (profs || []).forEach(p => names[p.id] = `${p.first_name} ${p.last_name}`.trim());
  }

  // Explicitly 'active', not "not pending". Removal became a status change on 2026-09-05,
  // so a not-pending filter would list everyone who has ever left as a current member.
  const pending = (data || []).filter(m => m.status === 'pending');
  const active  = (data || []).filter(m => m.status === 'active');
  // Same rule as the admin panel: your own row carries no Remove control, because
  // guard_org_self_removal() refuses it and a button that can only produce an error is not
  // a feature. See sql/2026-09-06_guard_self_removal.sql.
  // An initial on a tinted circle, like the directory's tiles: the tint is picked from the id, so a
  // person keeps one colour, and a roster reads as people rather than as a column of text.
  const initials = s => (s || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const tintOf = id => { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) % 997; return (h % 6) + 1; };
  const row = m => {
    const mine = m.user_id && m.user_id === _orgCtx?.userId;
    const name = m.user_id ? (names[m.user_id] || 'Unknown student') : (m.pending_email + ' (invited)');
    return `
    <div class="oc-member">
      <span class="oc-member-av dir-logo-none" data-tint="${tintOf(m.user_id || m.pending_email)}" aria-hidden="true">${esc(initials(name))}</span>
      <span class="oc-member-who">${esc(name)}</span>
      <span class="oc-member-role">${esc(m.title || m.role)}</span>
      ${m.status === 'pending'
        ? `<button class="org-btn org-btn-go" onclick="ocApprove(${m.id})">Approve</button>`
        : ''}
      ${mine
        ? '<span class="org-roster-self">You</span>'
        : `<button class="org-btn org-btn-warn" onclick="ocRemove(${m.id})">Remove</button>`}
    </div>`; };

  // Requests sit in a warm card above the members, so someone waiting to be let in is the first
  // thing an officer sees rather than a line they might scroll past.
  body.innerHTML =
    (pending.length ? `<div class="oc-subhead">Requests to join (${pending.length})</div>
       <div class="oc-member-list is-pending">${pending.map(row).join('')}</div>` : '') +
    `<div class="oc-subhead">Members (${active.length})</div>` +
    (active.length ? `<div class="oc-member-list">${active.map(row).join('')}</div>` : '<div class="oc-note">No members yet.</div>') +
    `<div class="oc-note">Adding officers and changing permissions needs the \u201Cmanage admins\u201D permission, and is done from the admin page for now. Removing someone keeps a record that they served \u2014 they can be restored from the admin page. You cannot remove your own officer role; another officer, or someone in the organization above this one, has to do it.</div>`;
}

async function ocApprove(membershipId) {
  const { error } = await supabaseClient.from('org_memberships')
    .update({ status: 'active' }).eq('id', membershipId);
  if (error) { toast('Could not approve: ' + error.message); console.error('[ocApprove]', error); return; }
  logEvent('org_member_approved', { targetType: 'membership', targetId: membershipId });
  toast('Approved');
  renderOcMembers();
}

// Soft, matching orgRemoveMember() on the admin page. Changed 2026-09-05 in the same pass,
// deliberately crossing the one-area-per-change rule: leaving this one deleting would give
// the same table two opposite removal semantics, and THIS is the path a club president
// actually uses — so the history the admin page preserves would be destroyed here instead.
async function ocRemove(membershipId) {
  if (!confirm('Remove this person from the organization?\n\nThey lose every permission immediately. The record that they served is kept.')) return;
  const { error } = await supabaseClient.from('org_memberships')
    .update({ status: 'removed' }).eq('id', membershipId);
  if (error) { toast('Could not remove: ' + error.message); console.error('[ocRemove]', error); return; }
  logEvent('org_member_removed', { targetType: 'membership', targetId: membershipId,
                                   before: { status: 'active' }, after: { status: 'removed' } });
  toast('Removed');
  clearOrgContext();
  await loadOrgContext();
  renderOcMembers();
}


// ============================================================
// CONSOLE: POSTS — announcements and polls
// ============================================================
let _ocPosts = [];   // [{post, options:[], votes:[], myVote}]

async function renderOcPosts() {
  const body = document.getElementById('ocBody');
  // Two regions: the top (a button, or the composer) and the list. A refresh after a pin, a
  // delete or a vote repaints the LIST only, so a half-written post survives an officer tidying
  // the posts beneath it — the whole section used to be redrawn, taking the draft with it.
  // The shell is rebuilt on entering the section, and whenever the organization changes: a post
  // typed for one club must never sit in the composer when the officer is acting as another.
  if (!document.getElementById('ocPostList') || _ocPostShellOrg !== _ocOrgId) {
    _ocPostShellOrg = _ocOrgId; _ocPostFormOpen = false; _ocType = 'announcement';
    body.innerHTML = '<div id="ocPostTop"></div><div id="ocPostList"><div class="oc-note">Loading posts…</div></div>';
    ocPostPaintTop();
  }

  const { data: posts, error } = await supabaseClient
    .from('org_posts')
    .select('id, type, title, body, is_pinned, is_urgent, members_only, status, poll_closes_at, created_at')
    .eq('org_id', _ocOrgId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) { document.getElementById('ocPostList').innerHTML = '<div class="oc-note">Could not load posts.</div>'; console.error('[renderOcPosts]', error); return; }

  const pollIds = (posts || []).filter(p => p.type === 'poll').map(p => p.id);
  let options = [], votes = [];
  if (pollIds.length) {
    // RLS decides what comes back from poll_votes: your own always, everyone's only once you
    // have voted, plus officers holding can_view_analytics. So an empty tally here is the
    // gate working, not a failed query.
    const [o, v] = await Promise.all([
      supabaseClient.from('poll_options').select('id, post_id, label, position').in('post_id', pollIds).order('position'),
      supabaseClient.from('poll_votes').select('post_id, option_id, user_id').in('post_id', pollIds),
    ]);
    options = o.data || []; votes = v.data || [];
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  _ocPosts = (posts || []).map(p => ({
    post: p,
    options: options.filter(o => o.post_id === p.id),
    votes:   votes.filter(v => v.post_id === p.id),
    myVote:  votes.find(v => v.post_id === p.id && v.user_id === user?.id) || null,
  }));

  ocPostPaintList();
}

// ---------- Events ----------
// Gated on can_manage_events. A can_check_in holder reaches the door (E5) and never this.

let _ocEvents = [];

// There is deliberately no pastness helper here any more. It used to be EVENT_ASSUMED_HOURS
// plus an eventEndsAt() that reimplemented the SQL coalesce in JavaScript — a third copy of a
// three-hour constant that also lived in the view and in self_report_arrival().
//
// visible_events now answers it as a column. The browser reads `has_ended` and holds no
// opinion about when an event finishes, which means the console and a student's feed cannot
// disagree about whether something is over.

async function renderOcEvents() {
  const body = document.getElementById('ocBody');
  body.innerHTML = '<div class="oc-note">Loading events…</div>';

  // Reads the VIEW, not the table, and that is the point of this query changing.
  //
  // The view's WHERE carries no status test, so RLS decides what comes back: an officer sees
  // their own drafts and cancellations because events_select lets them, and a student never
  // would. Nothing here filters by status, and nothing here compares a time to now() — the
  // view answers both as columns.
  //
  // Writes still go to `events`; only reads come through the view.
  const { data: events, error } = await supabaseClient
    .from('visible_events')
    .select('id, title, event_type, starts_at, ends_at, location, status, poster_url, ' +
            'registration_open, capacity, cancelled_reason, members_only, ' +
            'has_ended, is_browsable, effective_ends_at')
    .eq('org_id', _ocOrgId)
    .order('starts_at', { ascending: false });
  if (error) {
    body.innerHTML = '<div class="oc-note">Could not load events.</div>';
    console.error('[renderOcEvents]', error); return;
  }

  // Counted here rather than stored on the event. A stored count is a second source of truth
  // that drifts the first time a registration is written by anything other than the one code
  // path that remembers to increment it.
  const ids = (events || []).map(e => e.id);
  let regs = [], media = [];
  if (ids.length) {
    const [r, m] = await Promise.all([
      supabaseClient.from('event_registrations').select('event_id, status').in('event_id', ids),
      supabaseClient.from('event_media').select('id, event_id, kind, url, phase, sort_order')
        .in('event_id', ids).order('sort_order'),
    ]);
    regs = r.data || []; media = m.data || [];
  }

  _ocEvents = (events || []).map(e => {
    const mine = regs.filter(r => r.event_id === e.id);
    return {
      ...e,
      _media:   media.filter(m => m.event_id === e.id),
      _past:    e.has_ended,
      _going:   mine.filter(r => ['registered', 'self_reported', 'checked_in', 'walk_in'].includes(r.status)).length,
      _checked: mine.filter(r => ['checked_in', 'walk_in'].includes(r.status)).length,
    };
  });

  // One full-width action at the top, as the mockup has it, instead of a heading that repeated
  // the Events tab directly above it. Hidden while the form is open — the form IS the new event.
  // The form opens on demand rather than sitting permanently above the list: with twenty
  // events an always-open composer pushes everything the officer came to look at below the
  // fold. Editing and duplicating force it open, because they have nowhere else to put values.
  const formOpen = _ocEvFormOpen || _ocEvEditId || _ocEvDraft;
  body.innerHTML = `
    ${formOpen ? ocEventFormHTML() : '<button class="oc-cta" onclick="ocEvOpenForm()">+ New event</button>'}
    <div id="ocEvList"></div>`;
  ocEvPaintList();

  // The strip is filled after innerHTML rather than inside the template, because the previews
  // are object URLs held in memory and the existing media comes from the loaded rows — two
  // sources that only the painter knows how to merge.
  ocEvPaintPhotos();
}

// Which bucket the list shows. Not persisted: it describes this visit, and a console that
// reopened on Past would look as if the club had nothing coming up.
let _ocEvFilter = 'upcoming';

// Every event in exactly one place. Drafts are their own bucket whatever their date — a draft is
// unfinished work, not something that is happening. Cancelled events stay in Upcoming or Past by
// date, wearing their red chip, because the people registered for them still need to find them.
function ocEvBuckets() {
  const drafts   = _ocEvents.filter(e => e.status === 'draft');
  const upcoming = _ocEvents.filter(e => e.status !== 'draft' && !e._past)
                     .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past     = _ocEvents.filter(e => e.status !== 'draft' && e._past);   // query order: newest first
  return { upcoming, drafts, past };
}

function ocEvSetFilter(f) { _ocEvFilter = f; ocEvPaintList(); }

// The list under the form, painted on its own. A filter tap redraws only this, so an officer
// halfway through the form does not lose what they typed because they glanced at the drafts.
function ocEvPaintList() {
  const host = document.getElementById('ocEvList');
  if (!host) return;
  if (!_ocEvents.length) {
    host.innerHTML = `<div class="oc-ev-empty">Nothing scheduled yet.<br>
      <span class="note-xs">Events you publish appear to students in their own feed.</span></div>`;
    return;
  }
  const b = ocEvBuckets();
  if (!b[_ocEvFilter]) _ocEvFilter = 'upcoming';
  const chip = (key, label) => {
    const on = _ocEvFilter === key;
    return `<button class="oc-ev-filter${on ? ' is-on' : ''}" aria-pressed="${on}"
              onclick="ocEvSetFilter('${key}')">${label}<span class="oc-ev-count">${b[key].length}</span></button>`;
  };
  const EMPTY = {
    upcoming: 'Nothing coming up. Publish a draft, or start a new event.',
    drafts:   'No drafts. Save an event as a draft to finish it later.',
    past:     'Nothing has ended yet. Events move here once they are over.',
  };
  const list = b[_ocEvFilter];
  host.innerHTML = `
    <div class="oc-ev-filters">${chip('upcoming', 'Upcoming')}${chip('drafts', 'Drafts')}${chip('past', 'Past')}</div>
    ${list.length ? list.map(ocEventCardHTML).join('') : `<div class="oc-ev-empty">${EMPTY[_ocEvFilter]}</div>`}`;
}

// Publishing a draft from its card. This button existed on every draft and called a function
// that had never been written, so it did nothing at all; check 8 in tests/load-order.js now
// catches that kind of dead button.
//
// A saved draft already has a title, date, place and kind — ocSaveEvent() will not save one
// without them — so the only thing left to check is what can go stale while a draft sits: its
// date. A draft for last Tuesday opens in the editor with a note instead of being published as
// something that has already happened.
//
// The update only succeeds while the row is STILL a draft, so two officers pressing Publish at
// once cannot both believe they did it. It logs as the form does for the same act (publishing a
// draft through Edit is event_edited), so the activity log reads the same whichever button.
async function ocEvPublish(id) {
  const ev = _ocEvents.find(e => e.id === id);
  if (!ev || ev.status !== 'draft') { renderOcEvents(); return; }
  if (new Date(ev.starts_at) <= new Date()) {
    toast("This draft's date has already passed — change it, then publish");
    ocEvEdit(id);
    return;
  }
  const { data, error } = await supabaseClient.from('events')
    .update({ status: 'published', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'draft').select('id');
  if (error) { toast('Could not publish: ' + error.message); console.error('[ocEvPublish]', error); return; }
  if (!data || !data.length) { toast('That draft was already published or removed'); renderOcEvents(); return; }
  logEvent('event_edited', {
    targetType: 'event', targetId: id, targetLabel: ev.title,
    school: _orgCtx.orgs.get(_ocOrgId)?.school,
    before: { status: 'draft' }, after: { status: 'published' },
  });
  toast('Event published');
  _ocEvFilter = 'upcoming';   // follow it to where it now lives
  renderOcEvents();
}

// The seven from §4.2 of the plan. Slug stored, label shown — the slug is what the student
// events search filters on later, so it must not be the display string.
const EVENT_TYPES = [
  ['social', 'Social'], ['academic', 'Academic'], ['sports', 'Sports'],
  ['service', 'Service'], ['career', 'Career'], ['arts', 'Arts'], ['meeting', 'Meeting'],
];

// Which disclosure panels are open. Module-level rather than read off the DOM, so a re-render
// after a failed submit does not silently collapse a panel the officer had filled in.
let _ocEvOpen = {};
function ocEvToggle(key) {
  _ocEvOpen[key] = !_ocEvOpen[key];
  const el = document.getElementById('ocEvPanel-' + key);
  const btn = document.getElementById('ocEvToggle-' + key);
  // Toggled in place rather than re-rendered: a re-render would throw away everything already
  // typed into the fields above, which is the one thing a disclosure control must never do.
  if (el) el.hidden = !_ocEvOpen[key];
  if (btn) btn.classList.toggle('is-open', !!_ocEvOpen[key]);
}

function ocEventFormHTML() {
  // Three states, one form: creating, editing an existing event, or carrying a duplicate's
  // values with no id yet. Prefill comes from whichever applies.
  const src = _ocEvEditId ? _ocEvents.find(e => e.id === _ocEvEditId) : _ocEvDraft;
  const p = src || {};
  const st = ocEvISOToLocal(p.starts_at);
  const en = ocEvISOToLocal(p.ends_at);
  const editing = !!_ocEvEditId;
  const va = v => (v == null ? '' : escAttr(String(v)));
  if ((p._media || []).length) _ocEvOpen.media = true;

  const shots = (p._media || []).filter(m => m.kind === 'image').length;
  const vidUrl = (p._media || []).find(m => m.kind === 'video_link')?.url;

  // Each collapsed section states what is inside it before it is opened. A row labelled only
  // "Add registration" makes the officer open it to find out whether they already did.
  const regSummary = src
    ? (p.registration_open ? (p.capacity ? `On · ${p.capacity} places` : 'On · unlimited') : 'Off')
    : 'Off';
  const mediaSummary = [shots ? `${shots} photo${shots === 1 ? '' : 's'}` : '', vidUrl ? 'video link' : '']
    .filter(Boolean).join(' · ') || 'None yet';

  const section = (key, label, summary) => `
    <button type="button" class="ff-section${_ocEvOpen[key] ? ' is-open' : ''}"
            id="ocEvToggle-${key}" onclick="ocEvToggle('${key}')">
      <span class="ff-section-label">${label}</span>
      <span class="ff-section-state">${esc(summary)}</span>
      <span class="ff-section-mark" aria-hidden="true"></span>
    </button>`;

  return `
    <div class="oc-composer oc-ev-form" id="ocEvForm">
      <div class="ff-head">
        <h3 class="ff-head-title">${editing ? 'Edit event' : (src ? 'Duplicate' : 'New event')}</h3>
        ${src ? `<button type="button" class="ff-head-x" onclick="ocEvClearForm()">${
          editing ? 'Stop editing' : 'Discard'}</button>` : ''}
      </div>
      ${editing ? `<p class="ff-warn">Editing a published event changes it for everyone already
        registered, and nobody is notified — there is no notification layer yet. For a change of
        date or venue, say so in the description as well.</p>` : ''}

      <div class="ff">
        <label class="ff-label" for="ocEvTitle">Event title</label>
        <input class="oc-input" id="ocEvTitle" placeholder="Fall Club Fair" autocomplete="off" value="${va(p.title)}">
      </div>

      <div class="ff-when">
        <div class="ff ff-when-date">
          <label class="ff-label" for="ocEvDate">Date</label>
          <input class="oc-input" id="ocEvDate" type="date" autocomplete="off" value="${va(st.date)}">
        </div>
        <div class="ff">
          <label class="ff-label" for="ocEvStart">Starts</label>
          <input class="oc-input" id="ocEvStart" type="time" autocomplete="off" value="${va(st.time)}">
        </div>
        <div class="ff">
          <label class="ff-label" for="ocEvEnd">Ends <span class="ff-opt">optional</span></label>
          <input class="oc-input" id="ocEvEnd" type="time" autocomplete="off" value="${va(en.time)}">
        </div>
      </div>
      <p class="ff-help">Leave the end blank and it is treated as about three hours, so the event
        does not drop out of the feed while it is still happening.</p>

      <div class="ff">
        <label class="ff-label" for="ocEvLoc">Location</label>
        <input class="oc-input" id="ocEvLoc" placeholder="Main Hall Lawn" autocomplete="off" value="${va(p.location)}">
      </div>

      <div class="ff">
        <label class="ff-label" for="ocEvType">Kind of event</label>
        <select class="oc-input" id="ocEvType">
          <option value="">Choose one…</option>
          ${EVENT_TYPES.map(([v, l]) =>
            `<option value="${v}"${p.event_type === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <div class="ff">
        <label class="ff-label" for="ocEvDesc">Description <span class="ff-opt">optional</span></label>
        <textarea class="oc-input" id="ocEvDesc" rows="3"
          placeholder="What happens, who it is for, anything to bring.">${esc(p.description || '')}</textarea>
      </div>

      ${section('reg', 'Registration', regSummary)}
      <div class="ff-panel" id="ocEvPanel-reg" ${_ocEvOpen.reg ? '' : 'hidden'}>
        <label class="oc-toggle"><input type="checkbox" id="ocEvRegOpen" ${(src ? p.registration_open : true) ? 'checked' : ''}> Let students register</label>
        <div class="ff">
          <label class="ff-label" for="ocEvCapacity">Capacity <span class="ff-opt">blank = unlimited</span></label>
          <input class="oc-input" id="ocEvCapacity" type="number" min="1" placeholder="60" autocomplete="off" value="${va(p.capacity)}">
        </div>
        <p class="ff-help">Capacity is enforced by the database, not the browser, so the last seat
          cannot be taken twice. Students who register are visible to you by name and email — they
          are told that before they tap.</p>
      </div>

      ${section('media', 'Photos and video', mediaSummary)}
      <div class="ff-panel" id="ocEvPanel-media" ${_ocEvOpen.media ? '' : 'hidden'}>
        <label for="ocEvPhotoInput" class="oc-ev-drop">Tap to choose photos<br>
          <span class="note-xs">JPEG · PNG · WebP · resized before upload</span></label>
        <input type="file" id="ocEvPhotoInput" accept="image/jpeg,image/png,image/webp,image/*"
               multiple style="display:none" onchange="ocEvPickPhotos(this)">
        <div class="oc-ev-strip" id="ocEvPhotoStrip"></div>
        <p class="ff-help">The first photo is the card image. Without one the card draws a colour
          generated from the event itself — the same colour every time, never blank.</p>

        <div class="ff">
          <label class="ff-label" for="ocEvVideo">Video link <span class="ff-opt">optional</span></label>
          <input class="oc-input" id="ocEvVideo" placeholder="instagram.com/p/…" autocomplete="off" value="${va(vidUrl)}">
        </div>
        <p class="ff-help">A link, not an upload. Hosting video would cost more bandwidth than the
          whole marketplace has used, and an iPhone .mov often will not play on Android.</p>
      </div>

      <div class="ff-actions">
        ${p.status !== 'published'
          ? `<button class="ff-btn ff-btn-ghost" onclick="ocSaveEvent('draft')">${editing ? 'Save draft' : 'Save as draft'}</button>` : ''}
        <button class="ff-btn ff-btn-go" onclick="ocSaveEvent('published')">${
          editing && p.status === 'published' ? 'Save changes' : 'Publish event'}</button>
      </div>
      ${p.status !== 'published' ? `<p class="ff-help ff-help-center">A draft is finished enough to
        save and not ready to be seen. It stays in this list, is invisible to students, and takes no
        registrations until you publish it.</p>` : ''}
    </div>`;
}

function ocEvClearForm() {
  _ocEvPhotos.forEach(ph => URL.revokeObjectURL(ph.preview));
  _ocEvPhotos = []; _ocEvRemoved = [];
  _ocEvEditId = null; _ocEvDraft = null; _ocEvOpen = {}; _ocEvFormOpen = false;
  renderOcEvents();
}

function ocEvEdit(id) {
  _ocEvEditId = id; _ocEvDraft = null;
  renderOcEvents().then(() => document.getElementById('ocEvForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// Duplicate is what stands in for recurrence until recurrence is built, so it copies
// everything EXCEPT the identity: no id, and the date moved a week forward. A week is the
// commonest gap between meetings of the same club, and a date the officer must look at beats
// one they might not notice — a duplicate silently keeping the original's date would publish
// a second event in the past.
function ocEvDuplicate(id) {
  const e = _ocEvents.find(x => x.id === id);
  if (!e) return;
  const start = new Date(new Date(e.starts_at).getTime() + 7 * 864e5);
  const ends  = e.ends_at ? new Date(new Date(e.ends_at).getTime() + 7 * 864e5) : null;
  _ocEvEditId = null;
  // The copy carries status 'draft' so the form offers both buttons. A duplicate is a form,
  // not an event: it has not been published, and the officer has to look at the new date
  // before it should be. Carrying 'published' over would have hidden the draft option on the
  // one screen where it is most useful.
  _ocEvDraft = { ...e, id: undefined, starts_at: start.toISOString(),
                 ends_at: ends ? ends.toISOString() : null, status: 'draft', cancelled_reason: null };
  renderOcEvents().then(() => document.getElementById('ocEvForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ---------- Poster fallback ----------
// A deterministic gradient from the event id. Deterministic matters: the same event must look
// the same on every device and every reload, or a student scrolling back cannot recognise the
// card they saw this morning. Math.random() here would be a different poster every paint.
//
// The id is a bigint, so the hash is trivial — spread it across the hue circle and take a
// second, offset hue for the other end of the gradient. Saturation and lightness are fixed so
// no event ever draws unreadable white text on a pale block.
function eventGradient(id) {
  const h1 = (Number(id) * 137) % 360;          // 137° ≈ the golden angle: consecutive ids
  const h2 = (h1 + 40) % 360;                   // land far apart instead of in a run
  return `linear-gradient(135deg, hsl(${h1} 62% 46%), hsl(${h2} 58% 34%))`;
}

// ---------- Photos and video ----------
// Files chosen but not yet uploaded, and media already on the event being edited.
let _ocEvPhotos = [];      // [{ blob, preview }]
let _ocEvRemoved = [];     // urls of existing media the officer removed while editing

// Instagram, YouTube and TikTok, and nothing that takes money. The payment rejection is not
// squeamishness: an event page is a place students trust, and a "pay here" link on one is the
// single most effective scam surface this app could offer. Same posture as the ticket URL.
const VIDEO_HOSTS = ['instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com'];
const PAYMENT_HOSTS = ['venmo.com', 'cash.app', 'cashapp.com', 'zelle.com', 'paypal.me', 'paypal.com'];
function ocEvCheckVideo(raw) {
  const url = raw.trim();
  if (!url) return { ok: true, value: null };
  let u;
  try { u = new URL(url.startsWith('http') ? url : 'https://' + url); }
  catch { return { ok: false, why: 'That does not look like a link.' }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (PAYMENT_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return { ok: false, why: 'Payment links are not allowed on an event. Students are told this page is safe, and a payment link is what makes it not.' };
  }
  if (!VIDEO_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return { ok: false, why: 'Video links can be Instagram, YouTube or TikTok. Other sites are not accepted yet.' };
  }
  return { ok: true, value: u.href };
}

async function ocEvPickPhotos(input) {
  const files = [...input.files];
  input.value = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) { toast('Skipped a file that is not an image'); continue; }
    if (f.size > 10 * 1024 * 1024)   { toast('Skipped an image over 10 MB'); continue; }
    try {
      const blob = await resizeImage(f);
      _ocEvPhotos.push({ blob, preview: URL.createObjectURL(blob) });
    } catch (e) { console.error('[ocEvPickPhotos]', e); toast('Could not read one of those images'); }
  }
  ocEvPaintPhotos();
}

function ocEvRemoveNew(i) {
  URL.revokeObjectURL(_ocEvPhotos[i].preview);
  _ocEvPhotos.splice(i, 1);
  ocEvPaintPhotos();
}

// "Make cover" rather than drag-to-reorder. The only ordering decision that changes anything
// a student sees is WHICH image is the card, and a one-tap answer to that works standing up
// on a phone, where dragging a thumbnail into position does not.
function ocEvMakeCover(i) {
  _ocEvPhotos.unshift(..._ocEvPhotos.splice(i, 1));
  ocEvPaintPhotos();
}

function ocEvRemoveExisting(url) {
  _ocEvRemoved.push(url);
  ocEvPaintPhotos();
}

function ocEvExistingMedia() {
  const ev = _ocEvEditId ? _ocEvents.find(e => e.id === _ocEvEditId) : null;
  return (ev?._media || []).filter(m => m.kind === 'image' && !_ocEvRemoved.includes(m.url));
}

function ocEvPaintPhotos() {
  const el = document.getElementById('ocEvPhotoStrip');
  if (!el) return;
  const existing = ocEvExistingMedia();
  el.innerHTML =
    existing.map((m, i) => `
      <div class="oc-ev-thumb">
        <img src="${escAttr(m.url)}" alt="">
        ${i === 0 && !_ocEvPhotos.length ? '<span class="oc-ev-cover">Cover</span>' : ''}
        <button class="oc-ev-x" onclick="ocEvRemoveExisting('${escAttr(m.url)}')" title="Remove">&times;</button>
      </div>`).join('') +
    _ocEvPhotos.map((p, i) => `
      <div class="oc-ev-thumb">
        <img src="${escAttr(p.preview)}" alt="">
        ${i === 0 && !existing.length ? '<span class="oc-ev-cover">Cover</span>'
          : `<button class="oc-ev-cover oc-ev-cover-btn" onclick="ocEvMakeCover(${i})">Make cover</button>`}
        <button class="oc-ev-x" onclick="ocEvRemoveNew(${i})" title="Remove">&times;</button>
      </div>`).join('');
}

// The event being edited, or null when the form is creating a new one. A draft carried in
// from Duplicate lives here too, as values without an id.
let _ocEvEditId = null;
let _ocEvDraft  = null;
let _ocEvFormOpen = false;
function ocEvOpenForm() { _ocEvFormOpen = true; renderOcEvents(); }

// The REVERSE of ocEvLocalToISO, and the place the timezone bug hides on the way back.
// getFullYear/getMonth/getDate/getHours read the date in the BROWSER'S timezone, which is the
// clock the officer typed on. Using toISOString().slice(0,10) instead — the obvious one-liner
// — reads it in UTC, so an 8pm event in New Jersey comes back as the NEXT day's date and the
// officer silently reschedules it by saving a form they only opened to fix a typo.
function ocEvISOToLocal(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', time: '' };
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// 'YYYY-MM-DD' plus 'HH:MM' with no timezone suffix parses as LOCAL time, which is what the
// officer typed on their own clock. toISOString() then converts to UTC for storage.
//
// Appending 'Z' instead — or assembling the string by hand — is the classic bug in this
// feature: it stores 6pm as 6pm UTC, and a New Jersey club fair shows up at 2pm.
function ocEvLocalToISO(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr}`);
  return isNaN(d) ? null : d.toISOString();
}

// `status` is 'published' or 'draft'. The one transition NOT offered anywhere is
// published -> draft: un-publishing an event hides it from people who already registered,
// who would simply watch it vanish with no explanation. A published event is cancelled, with
// a reason, or it is edited. It is never quietly withdrawn.
async function ocSaveEvent(status = 'published') {
  const title = document.getElementById('ocEvTitle').value.trim();
  const date  = document.getElementById('ocEvDate').value;
  const start = document.getElementById('ocEvStart').value;
  const end   = document.getElementById('ocEvEnd').value;
  const loc   = document.getElementById('ocEvLoc').value.trim();
  const type  = document.getElementById('ocEvType').value;

  if (!title) { toast('An event needs a title'); return; }
  if (!date || !start) { toast('An event needs a date and a start time'); return; }
  if (!loc)  { toast('An event needs a location'); return; }
  if (!type) { toast('Choose what kind of event this is'); return; }

  const startsAt = ocEvLocalToISO(date, start);
  if (!startsAt) { toast('That date and time did not make sense'); return; }

  let endsAt = null;
  if (end) {
    let e = new Date(`${date}T${end}`);
    // An end earlier than the start means the event crosses midnight — a 10pm to 1am party is
    // an ordinary thing to schedule. The table has a check constraint requiring
    // ends_at > starts_at, so without this the officer gets a raw constraint error for a
    // perfectly reasonable event.
    if (e <= new Date(`${date}T${start}`)) e = new Date(e.getTime() + 864e5);
    endsAt = e.toISOString();
  }

  const vid = ocEvCheckVideo(document.getElementById('ocEvVideo').value);
  if (!vid.ok) { toast(vid.why); return; }

  const capRaw = document.getElementById('ocEvCapacity').value;
  const capacity = capRaw === '' ? null : parseInt(capRaw, 10);
  if (capacity !== null && (isNaN(capacity) || capacity < 1)) {
    toast('Capacity has to be a whole number, or blank for unlimited'); return;
  }

  const editing = _ocEvEditId;
  const before  = editing ? _ocEvents.find(e => e.id === editing) : null;

  // Editing an event that has already been cancelled would quietly un-cancel nothing and
  // confuse its registrants, who are looking at a red banner. Refuse rather than half-do it.
  if (before && before.status === 'cancelled') {
    toast('A cancelled event cannot be edited. Duplicate it instead.'); return;
  }
  if (before && before.status === 'published' && status === 'draft') {
    toast('A published event cannot go back to a draft. Cancel it with a reason instead.'); return;
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  // The button that was pressed, not always the publish one — and its own label is captured
  // so restoring it cannot drift out of step with what the form decided to call it.
  const btn = document.querySelector(status === 'draft' ? '.ff-actions .ff-btn-ghost'
                                                       : '.ff-actions .ff-btn-go');
  const btnLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = status === 'draft' ? 'Saving…' : (editing ? 'Saving…' : 'Publishing…'); }

  const row = {
    status,
    title,
    description: document.getElementById('ocEvDesc').value.trim() || null,
    event_type: type,
    starts_at: startsAt,
    ends_at: endsAt,
    location: loc,
    registration_open: document.getElementById('ocEvRegOpen').checked,
    capacity,
  };

  // This block used to sit AFTER the write below, and that is why an uploaded photo never
  // appeared: the cover was assigned to the row object down there, after the database had
  // already been sent it. It was computed correctly and then thrown away, so every card and
  // the detail view fell back to the generated gradient. The comment here always described
  // this order — the code had drifted out of step with it.
  //
  // Uploaded before the event row, because the bucket folders by organization rather than by
  // event: nothing here needs an event id. That ordering is what makes the failure recoverable
  // in the right direction — a failed row leaves files we can delete, where a failed upload
  // after a successful insert would leave an event whose poster silently never appears.
  let uploaded = [];
  try {
    for (const ph of _ocEvPhotos) uploaded.push(await uploadListingPhoto(ph.blob, _ocOrgId, 'event-media'));
  } catch (upErr) {
    if (uploaded.length) await deleteListingPhotos(uploaded, 'event-media');
    if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    toast('Could not upload the photos: ' + (upErr.message || upErr));
    console.error('[ocSaveEvent upload]', upErr); return;
  }

  const keptExisting = ocEvExistingMedia().map(m => m.url);
  const cover = keptExisting[0] || uploaded[0] || null;
  if (cover) row.poster_url = cover;
  else if (editing) row.poster_url = null;   // every photo removed: fall back to the gradient

  // updated_at is set by hand because nothing sets it for us: the column defaults to now()
  // on INSERT and no trigger touches it afterwards, so without this an edited event would
  // claim it had not changed since the day it was created.
  const { data: ev, error } = editing
    ? await supabaseClient.from('events').update({ ...row, updated_at: new Date().toISOString() })
        .eq('id', editing).select('id').single()
    : await supabaseClient.from('events').insert({
        ...row,
        org_id: _ocOrgId,
        school: _orgCtx.orgs.get(_ocOrgId)?.school,  // overwritten by events_set_school; sent to satisfy NOT NULL
        created_by: user?.id,
      }).select('id').single();

  if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
  if (error) {
    if (uploaded.length) await deleteListingPhotos(uploaded, 'event-media');
    // The likeliest refusal here is RLS: can_act('manage_events') walked the tree and found
    // nothing. The raw message reads as a database fault, so it is shown alongside plainer
    // words rather than instead of them.
    toast(`Could not ${editing ? 'save' : 'publish'}: ` + error.message);
    console.error('[ocSaveEvent]', error); return;
  }

  // Media rows are a second write with no transaction around it, the same shape as a post and
  // its poll options. The recovery is different, though, and deliberately so: a poll with no
  // options is unanswerable, so ocCreatePost() deletes the post. An event with no poster is
  // fine — it draws its gradient — so a failure here keeps the event and says what is missing.
  const mediaRows = [
    ...uploaded.map((url, i) => ({ event_id: ev.id, kind: 'image', url,
                                   sort_order: keptExisting.length + i, phase: 'promo',
                                   created_by: user?.id })),
  ];
  if (vid.value) mediaRows.push({ event_id: ev.id, kind: 'video_link', url: vid.value,
                                  sort_order: 0, phase: 'promo', created_by: user?.id });

  if (_ocEvRemoved.length) {
    await supabaseClient.from('event_media').delete().eq('event_id', ev.id).in('url', _ocEvRemoved);
    await deleteListingPhotos(_ocEvRemoved, 'event-media');
  }
  // One video link per event: the old row goes unconditionally, then the new one is inserted
  // above if there is one. Replace rather than accumulate — editing the link twice would
  // otherwise leave two cards pointing at different videos with no way to tell which is
  // current — and an emptied field has to actually remove the link, not just stop updating it.
  await supabaseClient.from('event_media').delete().eq('event_id', ev.id).eq('kind', 'video_link');

  if (mediaRows.length) {
    const { error: me } = await supabaseClient.from('event_media').insert(mediaRows);
    if (me) { toast('Event saved, but the photos did not attach: ' + me.message); console.error('[ocSaveEvent media]', me); }
  }

  logEvent(editing ? 'event_edited' : (status === 'draft' ? 'event_drafted' : 'event_created'), {
    targetType: 'event', targetId: ev.id, targetLabel: title,
    school: _orgCtx.orgs.get(_ocOrgId)?.school,
    before: before ? { starts_at: before.starts_at, location: before.location, title: before.title } : undefined,
    after: { starts_at: startsAt, location: loc, event_type: type },
  });
  _ocEvPhotos.forEach(ph => URL.revokeObjectURL(ph.preview));
  _ocEvPhotos = []; _ocEvRemoved = [];
  _ocEvEditId = null; _ocEvDraft = null; _ocEvOpen = {}; _ocEvFormOpen = false;
  toast(status === 'draft' ? 'Draft saved' : (editing ? 'Event updated' : 'Event published'));
  _ocEvFilter = status === 'draft' ? 'drafts' : 'upcoming';   // show the officer where it went
  renderOcEvents();
}

// ---------- Who is coming ----------
// Expanded per event rather than loaded for all of them: an officer looks at one event's list
// at a time, and fetching every registration on the page would pull the whole term's
// attendance to render a button nobody pressed.
//
// event_reg_select lets an officer read the rows for their own events — including a
// can_check_in holder, deliberately, because whoever works the door needs the list without
// being able to post as the club.
let _ocRegOpen = null;   // event id whose roster is showing
let _ocRegRows = [];

async function ocToggleRoster(id) {
  if (_ocRegOpen === id) {
    // Clear the pending undo too. A timer that fires after the panel has gone would repaint a
    // list that is no longer on screen, and worse, leave _ocUndoId pointing at a row the next
    // event's roster might reuse the id of.
    clearTimeout(_ocUndoTimer); _ocUndoId = null; _ocRegQuery = ''; _ocWalkOpen = false;
    _ocRegOpen = null; _ocRegRows = []; ocPaintRoster(); return;
  }
  clearTimeout(_ocUndoTimer); _ocUndoId = null; _ocRegQuery = ''; _ocWalkOpen = false;
  _ocRegOpen = id; _ocRegRows = [];
  ocPaintRoster('Loading…');

  const { data, error } = await supabaseClient
    .from('event_registrations')
    .select('id, user_id, name_at_signup, email_at_signup, status, check_in_method, ' +
            'checked_in_at, created_at')
    .eq('event_id', id)
    .order('created_at', { ascending: true });

  if (error) { ocPaintRoster('Could not load the list.'); console.error('[ocToggleRoster]', error); return; }
  _ocRegRows = data || [];
  ocPaintRoster();
}


// The row whose Undo is still showing, and the timer that takes it away.
//
// UNDO, NOT A CONFIRMATION DIALOG. A door has a line forming behind it, and a dialog asks the
// officer to answer a question about every single person. Undo asks nothing, and the mistake
// it protects against — tapping the wrong Daniel — is one somebody notices within seconds or
// not at all. Five seconds is long enough to notice and short enough that the button is gone
// before the next person is in front of you.
let _ocUndoId = null;
let _ocUndoTimer = null;

function ocArmUndo(regId) {
  clearTimeout(_ocUndoTimer);
  _ocUndoId = regId;
  _ocUndoTimer = setTimeout(() => { _ocUndoId = null; ocPaintRoster(); }, 5000);
}

// Search repaints ONLY the list, never the panel around it. A full repaint rebuilds the input
// the officer is typing into, which drops focus after the first character — the box empties
// itself and looks broken. The same reasoning keeps the walk-in fields out of the repainted
// region: a form that clears itself while you fill it in is worse than no form.
let _ocRegQuery = '';
function ocRegSearch(v) {
  _ocRegQuery = (v || '').trim().toLowerCase();
  const list = document.getElementById('ocRosterList');
  if (list) list.innerHTML = ocRosterListHTML();
}

let _ocWalkOpen = false;
function ocWalkToggle() {
  _ocWalkOpen = !_ocWalkOpen;
  const box = document.getElementById('ocWalkBox');
  if (box) box.hidden = !_ocWalkOpen;
  if (_ocWalkOpen) document.getElementById('ocWalkName')?.focus();
}

function ocRosterRowHTML(r) {
  const isHere = r.status === 'checked_in' || r.status === 'walk_in';
  const undo = _ocUndoId === r.id;
  return `
    <div class="oc-reg-row${r.status === 'cancelled' ? ' is-off' : ''}${isHere ? ' is-here' : ''}">
      <div class="oc-reg-who">
        <div class="oc-reg-name">${esc(r.name_at_signup)}</div>
        <div class="oc-reg-mail">${esc(r.email_at_signup || '—')}</div>
      </div>
      ${r.status === 'cancelled'
        ? '<div class="oc-reg-state">Cancelled</div>'
        : isHere
          ? (undo
              ? `<button class="org-btn oc-undo" onclick="ocUndoCheckIn(${r.id})">Undo</button>`
              : `<div class="oc-reg-state oc-reg-in">Here &#10003;${
                   r.check_in_method ? `<br><span class="note-xs">${esc(r.check_in_method.replace(/_/g, ' '))}</span>` : ''}</div>`)
          : `<button class="org-btn org-btn-go" onclick="ocCheckIn(${r.id}, '${r.status === 'self_reported' ? 'self_confirmed' : 'officer'}')">${
               r.status === 'self_reported' ? 'Confirm' : 'Check in'}</button>`}
    </div>`;
}

// Arrivals first. Somebody standing at the door having tapped "I'm here" is waiting on the
// officer RIGHT NOW; somebody who registered last week is not. Ordering the list by who is
// waiting is the difference between a screen an officer reads and one they search.
function ocRosterListHTML() {
  const q = _ocRegQuery;
  const match = r => !q
    || (r.name_at_signup || '').toLowerCase().includes(q)
    || (r.email_at_signup || '').toLowerCase().includes(q);

  const groups = [
    ['Waiting to be confirmed', _ocRegRows.filter(r => r.status === 'self_reported')],
    ['Expected',                _ocRegRows.filter(r => r.status === 'registered')],
    ['Here',                    _ocRegRows.filter(r => r.status === 'checked_in' || r.status === 'walk_in')],
    ['Cancelled',               _ocRegRows.filter(r => r.status === 'cancelled')],
  ];

  let html = '';
  let shown = 0;
  for (const [label, rows] of groups) {
    const hit = rows.filter(match);
    if (!hit.length) continue;
    shown += hit.length;
    html += `<div class="oc-reg-head">${label} · ${hit.length}</div>${hit.map(ocRosterRowHTML).join('')}`;
  }
  if (!_ocRegRows.length) return '<div class="oc-note">Nobody has registered yet. You can still add walk-ins.</div>';
  if (!shown) return `<div class="oc-note">Nobody matching “${esc(_ocRegQuery)}”. They may be a walk-in.</div>`;
  return html;
}

function ocPaintRoster(msg) {
  const el = document.getElementById('ocRoster-' + _ocRegOpen);
  document.querySelectorAll('.oc-ev-roster').forEach(n => {
    if (n !== el) { n.hidden = true; n.innerHTML = ''; }
  });
  if (!el) return;
  el.hidden = false;

  if (msg) { el.innerHTML = `<div class="oc-note">${esc(msg)}</div>`; return; }

  const ev = _ocEvents.find(x => x.id === _ocRegOpen);
  const here    = _ocRegRows.filter(r => r.status === 'checked_in' || r.status === 'walk_in');
  const waiting = _ocRegRows.filter(r => r.status === 'self_reported');
  const expected = _ocRegRows.filter(r => r.status === 'registered');
  const gone    = _ocRegRows.filter(r => r.status === 'cancelled');

  // Everything an officer wants at a door, in one line, in the order they want it: how many
  // are in, out of how many to expect. A percentage would be worse — nobody counts a room in
  // percentages.
  el.innerHTML = `
    <div class="oc-door-count">
      <span class="oc-door-in">${here.length}</span>
      <span class="oc-door-of">of ${here.length + waiting.length + expected.length} here</span>
      ${gone.length ? `<span class="oc-door-note">${gone.length} cancelled</span>` : ''}
      ${ev?.capacity ? `<span class="oc-door-note">capacity ${ev.capacity}</span>` : ''}
    </div>

    <input class="oc-input oc-door-search" placeholder="Search by name or email…"
           autocomplete="off" value="${escAttr(_ocRegQuery)}" oninput="ocRegSearch(this.value)">

    <div id="ocRosterList">${ocRosterListHTML()}</div>

    <div class="oc-door-actions">
      <button class="org-btn" onclick="ocWalkToggle()">+ Add walk-in</button>
      <button class="org-btn" onclick="ocCopyEmails(${_ocRegOpen})">Copy emails</button>
    </div>

    <div class="oc-walk" id="ocWalkBox" ${_ocWalkOpen ? '' : 'hidden'}>
      <div class="ff">
        <label class="ff-label" for="ocWalkName">Name</label>
        <input class="oc-input" id="ocWalkName" placeholder="As they say it at the door"
               autocomplete="off" onkeydown="if(event.key==='Enter')document.getElementById('ocWalkEmail').focus()">
      </div>
      <div class="ff">
        <label class="ff-label" for="ocWalkEmail">Email <span class="ff-opt">optional</span></label>
        <input class="oc-input" id="ocWalkEmail" type="email" placeholder="name@caldwell.edu"
               autocomplete="off" onkeydown="if(event.key==='Enter')ocAddWalkIn(${_ocRegOpen})">
      </div>
      <p class="ff-help">If the email matches a student account they are linked to it. If it
        does not, or you leave it blank, they are still counted — a walk-in does not need an
        account to have walked in.</p>
      <button class="ff-btn ff-btn-go" onclick="ocAddWalkIn(${_ocRegOpen})">Add and check in</button>
    </div>`;
}

// Every check-in goes through the RPC, never an UPDATE. The RPC records WHO checked them in
// and BY WHAT METHOD in the same transaction as the log row — and check_in_method is the
// column that cannot be backfilled, because "how much of our attendance is officer-verified"
// is a question an advisor asks six months later and app code cannot answer it retroactively.
//
// 'self_confirmed' when the student tapped "I'm here" first and the officer confirmed;
// 'officer' when the officer found them by name. Two different facts, and the difference is
// exactly what makes the number honest.
async function ocCheckIn(regId, method) {
  const { error } = await supabaseClient.rpc('check_in_attendee',
    { p_registration_id: regId, p_method: method });
  if (error) { toast('Could not check in: ' + error.message); console.error('[ocCheckIn]', error); return; }
  ocArmUndo(regId);
  await ocReloadRoster();
}

async function ocUndoCheckIn(regId) {
  const { error } = await supabaseClient.rpc('undo_check_in', { p_registration_id: regId });
  if (error) { toast('Could not undo: ' + error.message); console.error('[ocUndoCheckIn]', error); return; }
  clearTimeout(_ocUndoTimer); _ocUndoId = null;
  await ocReloadRoster();
  toast('Undone');
}

// A walk-in is somebody who never registered. They may have no account at all, which is why
// event_registrations.user_id is nullable — the single schema decision this whole path rests
// on, and the one most likely to be "tidied" into NOT NULL by a future session.
//
// The RPC links them to a profile when the email matches one, and to nothing when it does
// not. Either way they are counted.
async function ocAddWalkIn(eventId) {
  const nameEl  = document.getElementById('ocWalkName');
  const emailEl = document.getElementById('ocWalkEmail');
  const name  = (nameEl?.value || '').trim();
  const email = (emailEl?.value || '').trim();
  if (!name) { toast('A walk-in needs a name'); nameEl?.focus(); return; }

  const { error } = await supabaseClient.rpc('add_walk_in',
    { p_event_id: eventId, p_name: name, p_email: email });
  if (error) { toast('Could not add: ' + error.message); console.error('[ocAddWalkIn]', error); return; }

  toast(name + ' added');
  await ocReloadRoster();
  // The box stays open and the cursor goes back to the name. Walk-ins arrive in a run — three
  // people from the same corridor — and closing the form after each one makes the officer
  // reopen it while somebody waits.
  document.getElementById('ocWalkName')?.focus();
}

// Re-reads rather than patching the local array. At a door two officers may be checking people
// in at once, and a list built from what THIS browser did would quietly disagree with the room.
async function ocReloadRoster() {
  const { data } = await supabaseClient
    .from('event_registrations')
    .select('id, user_id, name_at_signup, email_at_signup, status, check_in_method, ' +
            'checked_in_at, created_at')
    .eq('event_id', _ocRegOpen)
    .order('created_at', { ascending: true });
  _ocRegRows = data || [];
  ocPaintRoster();
}

// Copying beats a CSV export here. There is no notification layer, so the only way an officer
// reaches their registrants is by pasting the addresses into their own mail client — and a
// downloaded file that has to be opened, found and re-copied is three steps to reach the same
// clipboard. Cancelled rows are excluded: those people said they are not coming.
async function ocCopyEmails(id) {
  const emails = _ocRegRows
    .filter(r => r.status !== 'cancelled' && r.email_at_signup)
    .map(r => r.email_at_signup).join(', ');
  if (!emails) { toast('No email addresses to copy'); return; }
  try {
    await navigator.clipboard.writeText(emails);
    toast('Copied');
  } catch (e) {
    // Clipboard access needs a secure context and can be refused outright. Falling back to a
    // prompt is ugly and always works, which beats a button that silently does nothing.
    window.prompt('Copy these addresses:', emails);
  }
}

// ---------- The QR ----------
// The deep link the QR encodes. Taken from window.location.origin at the moment the officer
// clicks, NOT from a constant somebody has to remember to change at deploy: a QR generated on
// the live site encodes the live site, forever, with no code change. A QR generated on
// localhost would encode localhost, which is why that case refuses instead of printing.
//
// The #/event/:id ROUTE does not exist yet — it arrives with E3. A QR printed today therefore
// opens the app rather than the event. That is fine for testing the sheet and not fine for a
// real door, so the button says so.
function ocEvDeepLink(id) { return `${window.location.origin}${window.location.pathname}#/event/${id}`; }

async function ocEvDownloadQR(id) {
  const e = _ocEvents.find(x => x.id === id);
  if (!e) return;

  if (location.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) {
    toast('Publish the site first — a QR made here only works on this computer.');
    return;
  }
  if (typeof QRCode === 'undefined') { toast('The QR library did not load — check the connection and reload.'); return; }

  // qrcodejs renders into a DOM node rather than returning anything, so it gets a detached
  // div to fill and we read the canvas back out of it.
  const holder = document.createElement('div');
  new QRCode(holder, { text: ocEvDeepLink(id), width: 640, height: 640, correctLevel: QRCode.CorrectLevel.M });
  const src = holder.querySelector('canvas');
  if (!src) { toast('Could not draw the QR code'); return; }

  // Drawn on our own canvas rather than assembled as HTML, so the result is one PNG an officer
  // can hand to a printer. The event POSTER is deliberately not on the sheet: it is loaded
  // cross-origin from Supabase storage, and drawing a cross-origin image taints the canvas so
  // toDataURL throws. A sheet that silently fails to download is worse than a plainer sheet.
  const W = 820, H = 1120;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);

  x.fillStyle = '#111111';
  x.textAlign = 'center';
  x.font = 'bold 54px Georgia, serif';
  wrapText(x, e.title, W / 2, 110, W - 120, 62);

  const when = new Date(e.starts_at).toLocaleString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  x.fillStyle = '#444444';
  x.font = '30px Helvetica, Arial, sans-serif';
  x.fillText(when, W / 2, 250);
  x.fillText(e.location || '', W / 2, 296);

  x.drawImage(src, (W - 640) / 2, 350, 640, 640);

  x.fillStyle = '#111111';
  x.font = 'bold 34px Helvetica, Arial, sans-serif';
  x.fillText('Scan to sign up or check in', W / 2, 1055);

  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `qr-${String(e.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'event'}.png`;
  a.click();
  toast('QR sheet downloaded');
}

// Canvas has no line wrapping. A long event title would otherwise run off both edges of the
// sheet, which is only discovered after it is printed.
function wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = String(text || '').split(/\s+/);
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, cx, y); y += lineHeight; line = w; }
    else line = test;
  }
  if (line) ctx.fillText(line, cx, y);
}

// Cancellation goes through the RPC, never a bare UPDATE, because the RPC writes the
// admin_activity_log row in the same transaction and enforces the reason a second time.
//
// The reason is required in three places — this prompt, the function, and a check constraint
// on the table — and that is not redundancy for its own sake. §6 makes the reason the ENTIRE
// mitigation for having no notification layer: nobody is emailed, so the only thing a
// registrant ever learns is what they read on the banner.
async function ocCancelEvent(id) {
  const ev = _ocEvents.find(e => e.id === id);
  const reason = prompt(`Cancel "${ev ? ev.title : 'this event'}"?\n\nEveryone registered will see this reason, and it is the only way they find out — nobody is emailed yet.`);
  if (reason === null) return;
  if (!reason.trim()) { toast('A cancellation needs a reason'); return; }

  const { error } = await supabaseClient.rpc('cancel_event', { p_event_id: id, p_reason: reason.trim() });
  if (error) { toast('Could not cancel: ' + error.message); console.error('[ocCancelEvent]', error); return; }
  toast('Event cancelled');
  renderOcEvents();
}

function ocEventCardHTML(e) {
  const when = new Date(e.starts_at);
  // toLocaleString, not a hand-built string: the officer sees their own device's format, and
  // an event stored in UTC renders in local time without any conversion of ours to get wrong.
  const whenTxt = when.toLocaleString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const shots = (e._media || []).filter(m => m.kind === 'image').length;
  const org = _orgCtx?.orgs.get(_ocOrgId);

  // Two posters, one slot.
  //
  // With a photo, the photo IS the poster and nothing is drawn over it. An officer who chose
  // an image chose a composition; typing across it would wreck theirs.
  //
  // Without one, the generated poster is composed rather than blank, and it carries exactly
  // three things: who is running it, what it is called, and when. Location is deliberately
  // NOT here — it sits in the card text below, and repeating it on the poster would be
  // filling space rather than placing something. The rule above the date is there to give the
  // block a base line to sit on, so short titles do not leave the date floating.
  const poster = e.poster_url
    ? `<div class="oc-ev-poster"><img src="${escAttr(e.poster_url)}" alt=""></div>`
    : `<div class="oc-ev-poster oc-ev-made" style="background:${eventGradient(e.id)}">
         <div class="oc-ev-p-org">${esc(org?.name || '')}</div>
         <div class="oc-ev-p-title">${esc(e.title)}</div>
         <div class="oc-ev-p-foot">
           <span class="oc-ev-p-rule"></span>
           ${esc(whenTxt)}
         </div>
       </div>`;

  const chips = [
    e.status === 'cancelled' ? '<span class="oc-chip oc-chip-urgent">Cancelled</span>' : '',
    e.status === 'draft'     ? '<span class="oc-chip">Draft</span>' : '',
    e.members_only           ? '<span class="oc-chip">Members only</span>' : '',
    e._past                  ? '<span class="oc-chip">Past</span>' : '',
  ].join('');

  // Registration state reads as one line rather than several counters. "18 spots left" is the
  // number an officer acts on; "42 of 60" makes them do the subtraction.
  const left = e.capacity == null ? null : Math.max(0, e.capacity - e._going);
  const reg = !e.registration_open
    ? 'Registration closed'
    : `${e._going} going${left == null ? '' : ` · ${left} spot${left === 1 ? '' : 's'} left`}`;

  // One facts line, built from whatever is true, rather than three lines two of which are
  // usually empty. Empty slots that sometimes fill are what make a list look ragged.
  const facts = [
    reg,
    e._past && e._checked ? `${e._checked} checked in` : '',
    shots ? `${shots} photo${shots === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  const live = e.status !== 'cancelled' && !e._past;

  return `
    <div class="oc-ev-card${e.status === 'cancelled' ? ' is-cancelled' : ''}">
      ${poster}
      <div class="oc-ev-body">
        ${chips ? `<div class="oc-ev-chips">${chips}</div>` : ''}
        <div class="oc-ev-title">${esc(e.title)}</div>
        <div class="oc-ev-when">${esc(whenTxt)}</div>
        <div class="oc-ev-where">${esc(e.location)}</div>
        <div class="oc-ev-facts">${esc(facts)}</div>
        ${e.status === 'cancelled' && e.cancelled_reason
          ? `<div class="oc-ev-reason">Reason given: ${esc(e.cancelled_reason)}</div>` : ''}
        <div class="oc-ev-actions">
          ${e.status === 'draft' ? `<button class="org-btn org-btn-go" onclick="ocEvPublish(${e.id})">Publish</button>` : ''}
          ${live ? `<button class="org-btn" onclick="ocEvEdit(${e.id})">Edit</button>` : ''}
          <button class="org-btn" onclick="ocToggleRoster(${e.id})">Who's coming${
          e._going ? ` · ${e._checked ? `${e._checked}/${e._going}` : e._going}` : ''}</button>
        ${e._past ? `<button class="org-btn" onclick="ocToggleRecap(${e.id})">Recap</button>` : ''}
        <button class="org-btn" onclick="ocEvDuplicate(${e.id})">Duplicate</button>
          <button class="org-btn" onclick="ocEvDownloadQR(${e.id})">QR</button>
          ${live ? `<button class="org-btn org-btn-warn" onclick="ocCancelEvent(${e.id})">Cancel</button>` : ''}
        </div>
        <div class="oc-ev-roster" id="ocRoster-${e.id}" hidden></div>
        <div class="oc-ev-recap oc-ev-roster" id="ocRecap-${e.id}" hidden></div>
      </div>
    </div>`;
}

// The composer, rebuilt 2026-09-24 from the approved design: a live preview beside it shows the
// card exactly as it will look on Home (it is drawn by feed.js's own feedNewsCardHTML, so the
// two cannot drift), polls take 2 to 6 options and a closing time, and a post can be saved as a
// draft instead of published.
//
// Drawn FROM _ocType. It used to hard-code Announcement as selected and the poll options as
// hidden, while _ocType kept whatever it was last set to — so after an officer posted a poll,
// the next post showed Announcement but went out as a poll with its options hidden, and was
// refused for having fewer than two. The UI shows the state; it does not assume it.
const OC_OPT_MIN = 2, OC_OPT_MAX = 6;
const OC_CLOSES = [['1d', 'In 1 day'], ['3d', 'In 3 days'], ['7d', 'In a week'], ['pick', 'Pick a date']];
let _ocOpts = ['', ''];      // the poll options as typed, so re-drawing the list keeps them
let _ocCloses = '3d';

function ocComposerHTML() {
  const poll = _ocType === 'poll';
  const pinned = _ocPosts.find(x => x.post.is_pinned && x.post.status === 'published');
  return `
    <div class="oc-compose">
      <div class="oc-composer">
        <div class="oc-type-row">
          <button class="oc-type${poll ? '' : ' active'}" id="oc-t-announcement" onclick="ocSetType('announcement')">Announcement</button>
          <button class="oc-type${poll ? ' active' : ''}" id="oc-t-poll" onclick="ocSetType('poll')">Poll</button>
        </div>
        <label class="oc-lbl" for="ocTitle" id="ocTitleLbl">${poll ? 'Question' : 'Headline'}</label>
        <input class="oc-input" id="ocTitle" autocomplete="off" oninput="ocPreview()"
          placeholder="${poll ? 'Which Saturday works for the next cleanup?' : 'Volunteer shirts are here!'}">
        <label class="oc-lbl" for="ocBodyText">Message <span class="oc-lbl-opt">optional</span></label>
        <textarea class="oc-input" id="ocBodyText" rows="3" oninput="ocPreview()" placeholder="Say more"></textarea>
        <div id="ocPollFields" class="oc-poll-fields"${poll ? '' : ' hidden'}>
          <div class="oc-lbl">Options · ${OC_OPT_MIN} to ${OC_OPT_MAX}</div>
          <div id="ocOptList">${ocOptListHTML()}</div>
          <div class="oc-lbl">Voting closes</div>
          <div class="oc-close-row" id="ocCloseRow">${ocCloseRowHTML()}</div>
          <input class="oc-input" type="datetime-local" id="ocCloseAt" onchange="ocPreview()"${_ocCloses === 'pick' ? '' : ' hidden'}>
        </div>
        <label class="oc-check"><input type="checkbox" id="ocPinned" onchange="ocPreview()">
          <span><b>Pin to the top</b><small>One pinned post per club.${pinned
            ? ` This would replace “${esc(pinned.post.title)}”.` : ''}</small></span></label>
        <label class="oc-check"><input type="checkbox" id="ocUrgent" onchange="ocPreview()">
          <span><b>Urgent</b><small>Shows as a red banner at the top of your followers' Home for 3 days.
            Keep it for changes people must not miss. It does not email anyone.</small></span></label>
        <label class="oc-check"><input type="checkbox" id="ocMembersOnly" onchange="ocPreview()">
          <span><b>Members only</b><small>Only your members see it. Followers who aren't members don't.</small></span></label>
        <div class="oc-compose-actions">
          <button class="ff-btn ff-btn-ghost" onclick="ocPostCloseForm()">Cancel</button>
          <button class="ff-btn ff-btn-ghost" id="ocDraftBtn" onclick="ocCreatePost('draft')">Save draft</button>
          <button class="ff-btn ff-btn-go" id="ocPostBtn" onclick="ocCreatePost('published')">${poll ? 'Publish poll' : 'Publish'}</button>
        </div>
      </div>
      <aside class="oc-preview">
        <div class="oc-lbl">How it looks on Home</div>
        <div id="ocPreview"></div>
        <p class="oc-note" id="ocReach"></p>
      </aside>
    </div>`;
}

function ocOptListHTML() {
  return _ocOpts.map((v, i) => `
    <div class="oc-opt-row">
      <input class="oc-input" value="${escAttr(v)}" placeholder="Option ${i + 1}" autocomplete="off"
        oninput="_ocOpts[${i}]=this.value;ocPreview()">
      ${_ocOpts.length > OC_OPT_MIN ? `<button class="oc-opt-x" aria-label="Remove option" onclick="ocOptRemove(${i})">${icon('x', 14)}</button>` : ''}
    </div>`).join('')
    + (_ocOpts.length < OC_OPT_MAX ? `<button class="oc-add-opt" onclick="ocOptAdd()">+ Add option</button>` : '');
}
function ocOptAdd() {
  if (_ocOpts.length >= OC_OPT_MAX) return;
  _ocOpts.push('');
  document.getElementById('ocOptList').innerHTML = ocOptListHTML();
  document.querySelectorAll('#ocOptList .oc-input')[_ocOpts.length - 1]?.focus();
  ocPreview();
}
function ocOptRemove(i) {
  if (_ocOpts.length <= OC_OPT_MIN) return;
  _ocOpts.splice(i, 1);
  document.getElementById('ocOptList').innerHTML = ocOptListHTML();
  ocPreview();
}

function ocCloseRowHTML() {
  return OC_CLOSES.map(([v, l]) =>
    `<button class="oc-close${_ocCloses === v ? ' active' : ''}" onclick="ocSetCloses('${v}')">${l}</button>`).join('');
}
function ocSetCloses(v) {
  _ocCloses = v;
  document.getElementById('ocCloseRow').innerHTML = ocCloseRowHTML();
  const pick = document.getElementById('ocCloseAt');
  pick.hidden = v !== 'pick';
  if (v === 'pick') pick.focus();
  ocPreview();
}
// When the poll closes, as an ISO string. A picked date in the past is refused by ocCreatePost.
function ocClosesAt() {
  if (_ocCloses === 'pick') {
    const v = document.getElementById('ocCloseAt')?.value;
    return v ? new Date(v).toISOString() : null;
  }
  const days = { '1d': 1, '3d': 3, '7d': 7 }[_ocCloses] || 3;
  return new Date(Date.now() + days * 864e5).toISOString();
}

// The preview is the real Home card, fed the composer's values. It is inert (see .oc-preview in
// styles.css): voting on a preview would be voting on a poll that does not exist yet.
function ocPreview() {
  const host = document.getElementById('ocPreview');
  if (!host || typeof feedNewsCardHTML !== 'function') return;
  const org = _orgCtx.orgs.get(_ocOrgId) || { id: _ocOrgId, name: 'Your club' };
  const poll = _ocType === 'poll';
  const title = document.getElementById('ocTitle').value.trim();
  const labels = _ocOpts.map((v, i) => v.trim() || `Option ${i + 1}`);
  const membersOnly = document.getElementById('ocMembersOnly').checked;
  host.innerHTML = feedNewsCardHTML({
    key: 'preview', kind: 'club', id: 0, org,
    title: title || (poll ? 'Your question' : 'Your headline'),
    body: document.getElementById('ocBodyText').value.trim(),
    at: new Date().toISOString(), pinned: document.getElementById('ocPinned').checked, urgent: false,
    membersOnly, isPoll: poll, closesAt: poll ? ocClosesAt() : null,
    options: poll ? labels.map((label, i) => ({ id: i, label })) : [], votes: [],
  });
  const followers = _ocStats && _ocStats.orgId === _ocOrgId ? _ocStats.followers : null;
  const reach = membersOnly
    ? 'Goes to the Home of your members who follow the club, and to your club page — members only.'
    : `Goes to the Home of your ${followers != null ? `<b>${followers} follower${followers === 1 ? '' : 's'}</b>` : 'followers'} and to your club page.`;
  const urgent = document.getElementById('ocUrgent').checked
    ? ' Marked urgent, it also shows as the red banner at the top of their Home for 3 days.' : '';
  const results = poll ? " You'll see the results as votes come in; students see them after they vote." : '';
  document.getElementById('ocReach').innerHTML = reach + urgent + results;
}

let _ocType = 'announcement';
// Whether the composer is showing, and which organization the section was drawn for.
let _ocPostFormOpen = false;
let _ocPostShellOrg = null;

// The button, or the composer.
function ocPostPaintTop() {
  const top = document.getElementById('ocPostTop');
  if (!top) return;
  top.innerHTML = _ocPostFormOpen ? ocComposerHTML() : `
    <button class="oc-cta" onclick="ocPostOpenForm()">+ New post</button>
    <p class="oc-post-note">Posts appear on your club's page and on your followers' Home. They don't email or notify anyone yet.</p>`;
  if (_ocPostFormOpen) ocPreview();
}

function ocPostPaintList() {
  const host = document.getElementById('ocPostList');
  if (!host) return;
  host.innerHTML = _ocPosts.length
    ? '<h3 class="oc-list-title">Your posts</h3>' + _ocPosts.map(ocPostCardHTML).join('')
    : '<div class="oc-note">Nothing posted yet. An announcement is the quickest way to start.</div>';
}

// A new post starts as an empty announcement, whatever the last one was.
function ocPostOpenForm() {
  _ocPostFormOpen = true; _ocType = 'announcement'; _ocOpts = ['', '']; _ocCloses = '3d';
  ocPostPaintTop();
  document.getElementById('ocTitle')?.focus();
}
function ocPostCloseForm() { _ocPostFormOpen = false; ocPostPaintTop(); }
function ocSetType(t) {
  _ocType = t;
  const poll = t === 'poll';
  document.getElementById('oc-t-announcement').classList.toggle('active', !poll);
  document.getElementById('oc-t-poll').classList.toggle('active', poll);
  document.getElementById('ocPollFields').hidden = !poll;
  document.getElementById('ocTitleLbl').textContent = poll ? 'Question' : 'Headline';
  document.getElementById('ocTitle').placeholder = poll ? 'Which Saturday works for the next cleanup?' : 'Volunteer shirts are here!';
  document.getElementById('ocPostBtn').textContent = poll ? 'Publish poll' : 'Publish';
  ocPreview();
}

// One line saying what the post is and where it stands: "Poll · Open · closes in 2 days".
function ocPostStatusLine(p) {
  const kind = p.type === 'poll' ? 'Poll' : 'Announcement';
  if (p.status === 'draft') return `${kind} · Draft`;
  if (p.status === 'archived') return `${kind} · Archived`;
  if (p.type === 'poll' && p.poll_closes_at) {
    return new Date(p.poll_closes_at).getTime() <= Date.now()
      ? `${kind} · Closed ${fmtDate(p.poll_closes_at)}`
      : `${kind} · Open · ${feedClosesLabel(p.poll_closes_at)}`;
  }
  return `${kind} · Published · ${fmtDate(p.created_at)}`;
}

function ocPostCardHTML(x) {
  const p = x.post;
  const canManage = orgCanAct('post', _ocOrgId);
  // The tally is shown only when this browser is actually allowed to have it — you voted, or
  // you hold analytics. It mirrors the RLS rather than deciding anything: if the mirror said
  // yes and the database said no, `votes` would simply be empty and the bars would read zero.
  const canSeeResults = !!x.myVote || orgCanAct('view_analytics', _ocOrgId);
  const total = x.votes.length;
  const open = p.type === 'poll' && p.status === 'published'
    && !(p.poll_closes_at && new Date(p.poll_closes_at).getTime() <= Date.now());

  const poll = p.type !== 'poll' ? '' : `
    <div class="oc-poll">
      ${x.options.map(o => {
        const n = x.votes.filter(v => v.option_id === o.id).length;
        const pct = total ? Math.round(n / total * 100) : 0;
        const mine = x.myVote && x.myVote.option_id === o.id;
        return canSeeResults || !open
          ? `<div class="oc-opt-result${mine ? ' mine' : ''}">
               <div class="oc-opt-bar" style="width:${pct}%"></div>
               <span class="oc-opt-label">${esc(o.label)}</span>
               <span class="oc-opt-count">${canSeeResults ? n : ''}</span>
             </div>`
          : `<button class="oc-opt-vote" onclick="ocVote(${p.id}, ${o.id})">${esc(o.label)}</button>`;
      }).join('')}
      <div class="oc-note">${canSeeResults
        ? `${total} vote${total === 1 ? '' : 's'}${x.myVote ? ' · you voted' : ''}`
        : 'Vote to see the results.'}</div>
    </div>`;

  // What an officer can do depends on where the post stands.
  const btn = (label, fn, cls = '') => `<button class="org-btn${cls}" onclick="${fn}">${label}</button>`;
  let actions = [];
  if (p.status === 'draft') {
    actions = [btn('Publish', `ocSetPostStatus(${p.id}, 'published')`, ' org-btn-go'), btn('Delete', `ocDeletePost(${p.id})`, ' org-btn-warn')];
  } else if (p.status === 'published') {
    actions = [btn(p.is_pinned ? 'Unpin' : 'Pin', `ocTogglePin(${p.id}, ${!p.is_pinned})`)];
    if (open) actions.push(btn('Close now', `ocClosePoll(${p.id})`));
    actions.push(btn('Archive', `ocSetPostStatus(${p.id}, 'archived')`), btn('Delete', `ocDeletePost(${p.id})`, ' org-btn-warn'));
  } else {
    actions = [btn('Restore', `ocSetPostStatus(${p.id}, 'published')`), btn('Delete', `ocDeletePost(${p.id})`, ' org-btn-warn')];
  }

  return `
    <div class="oc-post${p.is_urgent ? ' oc-post-urgent' : ''}${p.status !== 'published' ? ' oc-post-off' : ''}">
      <div class="oc-post-head">
        ${p.is_pinned ? '<span class="oc-chip oc-chip-pin">Pinned</span>' : ''}
        ${p.is_urgent ? '<span class="oc-chip oc-chip-urgent">Urgent</span>' : ''}
        ${p.members_only ? '<span class="oc-chip">Members only</span>' : ''}
        <span class="oc-post-status">${esc(ocPostStatusLine(p))}</span>
      </div>
      <div class="oc-post-title">${esc(p.title)}</div>
      ${p.body ? `<div class="oc-post-body">${esc(p.body)}</div>` : ''}
      ${poll}
      ${canManage ? `<div class="oc-post-actions">${actions.join('')}</div>` : ''}
    </div>`;
}

// status: 'published' or 'draft'.
async function ocCreatePost(status) {
  const title = document.getElementById('ocTitle').value.trim();
  const poll = _ocType === 'poll';
  if (!title) { toast(poll ? 'A poll needs a question' : 'A post needs a headline'); return; }

  const opts = poll ? _ocOpts.map(v => v.trim()).filter(Boolean) : [];
  if (poll && opts.length < OC_OPT_MIN) { toast('A poll needs at least two options'); return; }
  const closesAt = poll ? ocClosesAt() : null;
  if (poll && (!closesAt || new Date(closesAt).getTime() <= Date.now())) { toast('Pick a closing time in the future'); return; }

  // Disabled while it works: without this a double tap posted the same announcement twice.
  const btns = ['ocPostBtn', 'ocDraftBtn'].map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  const restore = () => btns.forEach(b => { b.disabled = false; });

  const { data: { user } } = await supabaseClient.auth.getUser();
  // A draft is not on show, so it does not take the pin from the post that has it.
  const wantPin = status === 'published' && document.getElementById('ocPinned').checked;

  // One pinned post per org is a partial unique index, so pinning a second one is refused by
  // the database rather than silently allowed. Unpin the incumbent first — that is what
  // "pinning replaces" means, and doing it here keeps the promise the composer makes.
  if (wantPin) await supabaseClient.from('org_posts').update({ is_pinned: false }).eq('org_id', _ocOrgId).eq('is_pinned', true);

  const { data: post, error } = await supabaseClient.from('org_posts').insert({
    org_id: _ocOrgId,
    school: _orgCtx.orgs.get(_ocOrgId)?.school,   // overwritten by the trigger; sent to satisfy NOT NULL
    type: _ocType,
    title,
    body: document.getElementById('ocBodyText').value.trim() || null,
    is_pinned: wantPin,
    is_urgent: document.getElementById('ocUrgent').checked,
    members_only: document.getElementById('ocMembersOnly').checked,
    status,
    poll_closes_at: closesAt,
    created_by: user?.id || null,
  }).select('id').single();

  if (error) { restore(); toast('Could not post: ' + error.message); console.error('[ocCreatePost]', error); return; }

  if (opts.length) {
    const { error: oe } = await supabaseClient.from('poll_options')
      .insert(opts.map((label, i) => ({ post_id: post.id, label, position: i })));
    // A poll with no options is worse than no poll: it renders as an unanswerable question.
    // Removing the post is the honest recovery, since the options insert is the second half
    // of one action and Supabase gives us no transaction across two calls.
    if (oe) {
      await supabaseClient.from('org_posts').delete().eq('id', post.id);
      restore();
      toast('Could not save the poll options — nothing was posted');
      console.error('[ocCreatePost options]', oe);
      return;
    }
  }

  logEvent(status === 'draft' ? 'org_post_drafted' : 'org_post_created', { targetType: 'organization', targetId: _ocOrgId, targetLabel: title,
                                 school: _orgCtx.orgs.get(_ocOrgId)?.school, after: { type: _ocType, status } });
  _ocType = 'announcement'; _ocPostFormOpen = false;
  ocPostPaintTop();
  toast(status === 'draft' ? 'Draft saved' : 'Posted');
  renderOcPosts();
}

async function ocVote(postId, optionId) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  // upsert on the (post_id, user_id) primary key: voting again changes your answer rather
  // than adding a second vote.
  const { error } = await supabaseClient.from('poll_votes')
    .upsert({ post_id: postId, option_id: optionId, user_id: user.id }, { onConflict: 'post_id,user_id' });
  if (error) { toast('Could not record your vote: ' + error.message); console.error('[ocVote]', error); return; }
  renderOcPosts();
}

async function ocTogglePin(postId, pin) {
  if (pin) await supabaseClient.from('org_posts').update({ is_pinned: false }).eq('org_id', _ocOrgId).eq('is_pinned', true);
  const { error } = await supabaseClient.from('org_posts').update({ is_pinned: pin }).eq('id', postId);
  if (error) { toast('Could not update: ' + error.message); console.error('[ocTogglePin]', error); return; }
  renderOcPosts();
}

// Publish a draft, archive a post (it leaves Home and the club page, and keeps its votes), or
// restore an archived one. An archived post gives up its pin: pinned-but-hidden would hold the
// club's one pin slot while showing nothing.
async function ocSetPostStatus(postId, status) {
  const x = _ocPosts.find(p => p.post.id === postId);
  if (status === 'archived' && !confirm('Archive this post? It leaves Home and your club page. You can restore it later.')) return;
  if (status === 'published' && x?.post.type === 'poll' && x.post.poll_closes_at
      && new Date(x.post.poll_closes_at).getTime() <= Date.now() && x.post.status === 'draft') {
    toast('This poll’s closing time has passed — make a new poll instead'); return;
  }
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'archived') patch.is_pinned = false;
  const { error } = await supabaseClient.from('org_posts').update(patch).eq('id', postId);
  if (error) { toast('Could not update: ' + error.message); console.error('[ocSetPostStatus]', error); return; }
  logEvent('org_post_' + status, { targetType: 'organization', targetId: _ocOrgId, targetLabel: x?.post.title || null });
  toast(status === 'published' ? 'Published' : status === 'archived' ? 'Archived' : 'Updated');
  renderOcPosts();
}

// Ends voting now. Voters keep seeing the final result on Home for 3 days.
async function ocClosePoll(postId) {
  if (!confirm('Close this poll now? Nobody can vote after this.')) return;
  const { error } = await supabaseClient.from('org_posts')
    .update({ poll_closes_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', postId);
  if (error) { toast('Could not close the poll: ' + error.message); console.error('[ocClosePoll]', error); return; }
  logEvent('org_poll_closed', { targetType: 'organization', targetId: _ocOrgId });
  toast('Poll closed');
  renderOcPosts();
}

async function ocDeletePost(postId) {
  if (!confirm('Delete this post? Any votes on it go with it.')) return;
  const { error } = await supabaseClient.from('org_posts').delete().eq('id', postId);
  if (error) { toast('Could not delete: ' + error.message); console.error('[ocDeletePost]', error); return; }
  logEvent('org_post_deleted', { targetType: 'organization', targetId: _ocOrgId });
  toast('Deleted');
  renderOcPosts();
}


// ============================================================
// CONSOLE: ORG LOGO
// ============================================================
// Reuses the listing-photos bucket and resizeImage() from js/media.js rather than adding a
// bucket. NOTE THE PATH: uploadAvatar() records that the first folder must be the uploader's
// user id to pass the storage policy, so an org logo filed under `org-5/` would be rejected.
// It goes under the officer's own id with the org in the filename.
async function ocPickLogo(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('That image is over 10 MB'); return; }

  toast('Uploading…');
  try {
    const blob = await resizeImage(file);
    const { data: { user } } = await supabaseClient.auth.getUser();
    // Was an inlined copy of uploadListingPhoto() with a different path scheme. Now the
    // shared helper, so the bucket is named in one place. The old path carried the org id
    // and a timestamp; the helper uses a uuid, which is just as unique and needs no
    // collision reasoning.
    const publicUrl = await uploadListingPhoto(blob, user.id);

    const { error } = await supabaseClient.from('organizations')
      .update({ logo_url: publicUrl }).eq('id', _ocOrgId);
    if (error) throw error;

    toast('Logo updated');
    await loadOrgContext(true);
    renderOrgConsole();
  } catch (e) {
    toast('Could not upload: ' + (e.message || e));
    console.error('[ocPickLogo]', e);
  }
}


// ============================================================
// RECAP  —  after the event
// ============================================================
// Two halves under two different flags, which is the resolution TEST 9c pins down: the recap
// PHOTOS need can_manage_events, the feedback SUMMARY needs can_view_analytics. Authority
// flows down, so a school admin can edit every club's events — and if editing implied reading
// the comments, "private to the org" would quietly mean "private to everyone above you",
// which is not what a student is told when they leave one.

let _ocRecapOpen = null;
let _ocRecapFb   = null;

async function ocToggleRecap(id) {
  if (_ocRecapOpen === id) { _ocRecapOpen = null; _ocRecapFb = null; ocPaintRecap(); return; }
  _ocRecapOpen = id; _ocRecapFb = null;
  ocPaintRecap('Loading…');

  // Officers never read event_feedback directly — the policy is own-row-only. The function is
  // the only door, and the suppression below five lives INSIDE it, not in this file. A
  // suppression rule enforced in JavaScript is not a suppression rule.
  const { data, error } = await supabaseClient.rpc('get_event_feedback', { p_event_id: id });
  if (error) {
    // Refusal here is the analytics flag, not a fault. Saying which is more useful than the
    // raw message, because the fix is a permission somebody has to grant.
    _ocRecapFb = { denied: /Not authorized/.test(error.message || '') };
    if (!_ocRecapFb.denied) console.error('[ocToggleRecap]', error);
  } else {
    _ocRecapFb = data;
  }
  ocPaintRecap();
}

function ocPaintRecap(msg) {
  const el = document.getElementById('ocRecap-' + _ocRecapOpen);
  document.querySelectorAll('.oc-ev-recap').forEach(n => {
    if (n !== el) { n.hidden = true; n.innerHTML = ''; }
  });
  if (!el) return;
  el.hidden = false;
  if (msg) { el.innerHTML = `<div class="oc-note">${esc(msg)}</div>`; return; }

  const fb = _ocRecapFb || {};
  const ev = _ocEvents.find(x => x.id === _ocRecapOpen);
  const recapShots = (ev?._media || []).filter(m => m.phase === 'recap');

  let summary;
  if (fb.denied) {
    summary = `<div class="oc-note">Feedback is visible to officers with analytics access.
               Ask whoever administers your organization to grant it.</div>`;
  } else if (!fb.count) {
    summary = '<div class="oc-note">No feedback yet. Only people who checked in can leave any.</div>';
  } else if (fb.suppressed) {
    // The number is withheld by the FUNCTION, and the wording says why rather than pretending
    // there is nothing there. At three responses an average is not a measurement, and at that
    // size the person who left a comment is guessable.
    summary = `
      <div class="oc-recap-sum">
        <div class="oc-recap-n">${fb.count}</div>
        <div class="oc-recap-lab">response${fb.count === 1 ? '' : 's'} — not enough to summarise yet</div>
      </div>
      <div class="oc-note">An average appears at five. Below that it would say more about who
        answered than about the event.</div>`;
  } else {
    summary = `
      <div class="oc-recap-sum">
        <div class="oc-recap-n">${esc(String(fb.avg))}</div>
        <div class="oc-recap-lab">average from ${fb.count} response${fb.count === 1 ? '' : 's'}</div>
      </div>`;
  }

  const comments = (fb.comments || []).length
    ? `<div class="oc-reg-head">What people said</div>
       ${fb.comments.map(c => `<div class="oc-recap-c">${esc(c)}</div>`).join('')}
       <div class="oc-note">Ordered by rating, not by time, so the order cannot be lined up
         against who walked through the door when.</div>`
    : '';

  el.innerHTML = `
    ${summary}
    ${comments}
    <div class="oc-reg-head">Recap photos${recapShots.length ? ` · ${recapShots.length}` : ''}</div>
    <div class="oc-ev-strip">${recapShots.map(m => `
      <div class="oc-ev-thumb"><img src="${escAttr(m.url)}" alt="">
        <button class="oc-ev-x" onclick="ocDeleteRecap(${m.id}, '${escAttr(m.url)}')" title="Remove">&times;</button>
      </div>`).join('')}</div>
    <label for="ocRecapInput" class="oc-ev-drop">Add photos from the event</label>
    <input type="file" id="ocRecapInput" accept="image/jpeg,image/png,image/webp,image/*"
           multiple style="display:none" onchange="ocUploadRecap(${_ocRecapOpen}, this)">
    <div class="oc-note">Recap photos are what makes a past event worth opening, and what makes
      the organization look alive to somebody deciding whether to join.</div>`;
}

async function ocUploadRecap(eventId, input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  toast('Uploading…');

  const urls = [];
  try {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast('Skipped a file that is not an image'); continue; }
      const blob = await resizeImage(f);
      urls.push(await uploadListingPhoto(blob, _ocOrgId, 'event-media'));
    }
  } catch (e) {
    if (urls.length) await deleteListingPhotos(urls, 'event-media');
    toast('Could not upload: ' + (e.message || e)); console.error('[ocUploadRecap]', e); return;
  }
  if (!urls.length) return;

  const { data: { user } } = await supabaseClient.auth.getUser();
  const base = ((_ocEvents.find(x => x.id === eventId)?._media) || []).length;
  const { error } = await supabaseClient.from('event_media').insert(
    urls.map((url, i) => ({ event_id: eventId, kind: 'image', url,
                            phase: 'recap', sort_order: base + i, created_by: user?.id })));
  if (error) {
    // Same recovery as the create form: the files exist and the rows do not, so the files go.
    // An orphan in storage is invisible and permanent, which is worse than a failed upload.
    await deleteListingPhotos(urls, 'event-media');
    toast('Could not attach: ' + error.message); console.error('[ocUploadRecap insert]', error); return;
  }
  toast('Added');
  await renderOcEvents();
  ocPaintRecap();
}

async function ocDeleteRecap(mediaId, url) {
  if (!confirm('Remove this photo?')) return;
  const { error } = await supabaseClient.from('event_media').delete().eq('id', mediaId);
  if (error) { toast('Could not remove: ' + error.message); console.error('[ocDeleteRecap]', error); return; }
  await deleteListingPhotos([url], 'event-media');
  await renderOcEvents();
  ocPaintRecap();
}
