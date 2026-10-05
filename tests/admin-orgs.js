// Behaviour of the admin Organizations tab (js/orgs.js), driven against a fake database and a
// fake page. Where tests/load-order.js proves the files RUN, this proves the page TELLS THE TRUTH:
//
//   - a number it cannot know is drawn as "—", never as 0
//   - a club is flagged "Needs attention" only when its roster was actually readable
//   - suspending requires a reason, and the reason reaches the activity log
//   - a write the database silently refuses is not announced as a success
//   - "Add a club" says plainly when the club was made but its first E-board member was not
//   - an organization name cannot inject markup
//   - E-board (2026-10-05): a position is saved, every power is on by default, the editor changes
//     them, one President per club, the school is created from the page, and names can change
//   - the club console: whoever holds Manage E-board adds members to the E-board, edits and removes
//     them, and can never name a President; nobody else gets those controls
//   - a club page: Ask to join sends a powerless request; Requested, Member and Not a member say
//     where you stand, and cancelling or leaving deletes only your own row
//
//   node tests/admin-orgs.js
//
// Exits non-zero on failure. The fake page understands only what js/orgs.js asks of it:
// elements by id, created whenever innerHTML containing id="..." is assigned.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// boot.js is left out: it is the one file that RUNS the app rather than defining it.
const files = [...html.matchAll(/src="(js\/[a-z-]+\.js)/g)].map(m => m[1]).filter(f => f !== 'js/boot.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log('  ok    ' + label);
  else { failures++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
};

// ---------------------------------------------------------------- a fake page
let strict = false;                 // permissive while the files load, exact afterwards
const els = new Map();              // id -> element
const children = new Map();         // id -> ids created by that element's innerHTML
const permissive = new Proxy(function () {}, {
  get: (t, k) => (k === 'innerHTML' || k === 'value' || k === 'textContent') ? '' : permissive,
  set: () => true, apply: () => permissive, has: () => true,
});
function forget(id) {
  for (const c of children.get(id) || []) { forget(c); els.delete(c); }
  children.delete(id);
}
function makeEl(id, value = '') {
  let inner = '';
  return {
    id, value, hidden: false, disabled: false, placeholder: '',
    focus() { page.focused = '#' + id; }, select() {}, scrollIntoView() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() { return inner; },
    set innerHTML(v) {
      inner = String(v);
      forget(id);
      const made = new Set();
      for (const m of inner.matchAll(/<(\w+)\b([^>]*?)\sid="([^"]+)"/g)) {
        let val = (m[2].match(/\svalue="([^"]*)"/) || [])[1] || '';
        if (m[1] === 'select') {   // a select starts on its first option
          const after = inner.slice(m.index);
          val = (after.match(/<option value="([^"]*)"/) || [])[1] || '';
        }
        els.set(m[3], makeEl(m[3], val));
        made.add(m[3]);
      }
      children.set(id, made);
    },
  };
}
const page = { focused: null };
const document = {
  getElementById: id => els.get(id) || (strict ? null : permissive),
  querySelector: sel => {
    if (!strict) return permissive;
    const byId = sel.match(/^#([\w-]+)$/);
    if (byId) return els.get(byId[1]) || null;
    return { focus() { page.focused = sel; } };
  },
  querySelectorAll: sel => {
    if (strict && sel === '.org-panel') return [...els.values()].filter(e => e.id.startsWith('org-panel-'));
    // The E-board editor's power boxes, read from the HTML that drew them. `unchecked` lets a check
    // untick a box before saving, as a person would.
    const box = strict && sel.match(/^#(\S+) input\[data-k\]$/);
    if (box) {
      const host = [...els.values()].find(e => e.innerHTML.includes(`id="${box[1]}"`));
      if (!host) return [];
      const part = host.innerHTML.slice(host.innerHTML.indexOf(`id="${box[1]}"`));
      const end = part.indexOf('eb-edit-actions');
      return [...part.slice(0, end < 0 ? undefined : end).matchAll(/<input type="checkbox" data-k="(\w+)"( checked)?/g)]
        .map(m => ({ dataset: { k: m[1] }, checked: !!m[2] && !unchecked.has(m[1]) }));
    }
    return [];
  },
  createElement: () => permissive, addEventListener() {}, removeEventListener() {},
  body: permissive, documentElement: permissive, head: permissive, cookie: '',
};
const unchecked = new Set();
const store = new Map();
const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                  removeItem: k => store.delete(k), clear: () => store.clear() };

// ---------------------------------------------------------------- a fake database
let S;                               // the current scenario
const calls = [];
function respond(q) {
  const f = Object.fromEntries(q.filters.map(([, c, v]) => [c, v]));
  const one = rows => q.single ? { data: rows[0] || null, error: null } : { data: rows, error: null };
  switch (q.table) {
    case 'user_roles':    return { data: S.isSuper ? [{ role_id: 'super_admin' }] : [], error: null };
    case 'organizations':
      if (q.op === 'select') return { data: S.orgs.map(o => ({ ...o })), error: null };
      if (q.op === 'insert') {
        const id = S.nextId++;
        S.orgs.push({ id, logo_url: null, is_active: true, is_verified: true, ...q.payload });
        return one([{ id }]);
      }
      if (q.op === 'update') {
        if (S.refuseUpdate) return { data: [], error: null };   // RLS filtered it to zero rows
        const o = S.orgs.find(x => x.id === f.id); Object.assign(o, q.payload);
        return { data: [{ id: o.id }], error: null };
      }
      break;
    case 'org_directory':
      return { data: S.orgs.filter(o => o.is_active).map(o => ({ id: o.id, follower_count: S.followers[o.id] || 0 })), error: null };
    case 'events':        return { data: S.events, error: null };
    case 'schools':       return { data: S.schools || [], error: null };
    case 'org_memberships':
      if (q.op === 'insert' || q.op === 'update') {
        if (S.grantError) return { data: null, error: S.grantError };
        S.grants.push({ ...q.payload, _id: f.id });
        if (q.op === 'insert' && q.single) return one([{ id: 777, role: q.payload.role, status: q.payload.status }]);
        return { data: q.op === 'update' ? [{ id: f.id }] : null, error: null };
      }
      if (q.op === 'delete') { (S.deleted = S.deleted || []).push(f.id); return { data: [{ id: f.id }], error: null }; }
      if ('title' in f) return { data: S.seats || [], error: null };   // who holds a one-per-club position
      if (q.cols && q.cols.includes('can_check_in') && 'user_id' in f) return { data: S.myGrants, error: null };
      if (f.role === 'officer') return { data: S.officers, error: null };
      if ('user_id' in f) return one([]);                        // "already on this roster?" — no
      return { data: S.roster || [], error: null };               // the officer panel
    case 'public_profiles': return { data: S.profiles, error: null };
    case 'profiles':
      if ('email' in f) return one(S.profiles.filter(p => p.email === f.email));
      return { data: S.profiles, error: null };
    case 'admin_activity_log':
      if (q.op === 'insert') { S.log.unshift({ id: S.log.length + 100, created_at: new Date().toISOString(), ...q.payload }); return { data: null, error: null }; }
      return { data: S.log.slice(0, 5), error: null };
  }
  return { data: [], error: null };
}
function from(table) {
  const q = { table, op: 'select', cols: null, filters: [], payload: null, single: false };
  const b = {
    select(c)  { if (q.op === 'select') q.cols = c; return b; },
    insert(p)  { q.op = 'insert'; q.payload = p; return b; },
    update(p)  { q.op = 'update'; q.payload = p; return b; },
    delete()   { q.op = 'delete'; return b; },
    eq(c, v)   { q.filters.push(['eq', c, v]); return b; },
    in(c, v)   { q.filters.push(['in', c, v]); return b; },
    is(c, v)   { q.filters.push(['is', c, v]); return b; },
    gte(c, v)  { q.filters.push(['gte', c, v]); return b; },
    lte(c, v)  { q.filters.push(['lte', c, v]); return b; },
    ilike(c, v) { q.filters.push(['ilike', c, v]); return b; },
    order() { return b; }, limit() { return b; }, range() { return b; }, or() { return b; },
    maybeSingle() { q.single = true; return b; }, single() { q.single = true; return b; },
    then(ok, bad) { calls.push(q); return Promise.resolve().then(() => respond(q)).then(ok, bad); },
  };
  return b;
}
const client = {
  from,
  auth: {
    getUser: async () => ({ data: { user: { id: 'u-admin' } } }),
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  channel: () => permissive, removeChannel() {}, storage: { from: () => permissive },
  rpc: async () => ({ data: null, error: null }),
};

// ---------------------------------------------------------------- load the app
const ctx = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  document, localStorage: storage, sessionStorage: storage,
  location: { href: 'http://127.0.0.1:5500/', search: '', hash: '', pathname: '/', origin: 'http://127.0.0.1:5500' },
  navigator: { userAgent: 'admin-orgs-test', onLine: true },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: f => f(), cancelAnimationFrame() {},
  fetch: () => Promise.resolve({ json: () => ({}), ok: true }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  supabase: { createClient: () => client },
  alert() {}, confirm: () => true, prompt: () => null,
  URL, URLSearchParams, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean,
  RegExp, Error, Map, Set, WeakMap, isNaN, parseInt, parseFloat, encodeURIComponent,
  decodeURIComponent, Intl, TextEncoder, TextDecoder, btoa: s => s, atob: s => s,
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n'), ctx);

const toasts = [];
ctx.toast = m => toasts.push(String(m));
strict = true;
els.set('asec-orgs', makeEl('asec-orgs'));

const run = code => vm.runInContext(code, ctx);
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
const $ = id => (els.get(id) || { innerHTML: '' }).innerHTML;
const lastToast = () => toasts[toasts.length - 1] || '';
// The number printed on a tab, read fresh each time.
const tabCount = label => ($('aoTabs').match(new RegExp(`<span>${label}</span><span class="ao-tab-n[^"]*">([^<]+)<`)) || [])[1];
const writes = (table, op) => calls.filter(c => c.table === table && c.op === op);

// The piece of the list that belongs to one organization: its row, up to the next row.
function rowOf(name) {
  const list = $('aoList');
  const at = list.indexOf(`<span class="ao-name">${name}</span>`);
  if (at < 0) return '';
  const start = list.lastIndexOf('<div class="ao-row', at);
  const next = list.indexOf('<div class="ao-row', at);
  return list.slice(start, next < 0 ? undefined : next);
}

function scenario(overrides = {}) {
  const now = Date.now();
  const semStart = run('orgSemesterStart().getTime()');
  return {
    isSuper: true, myGrants: [], nextId: 900, refuseUpdate: false, grants: [],
    orgs: [
      { id: 1,  parent_id: null, school: 'caldwell', type: 'school',     name: 'Caldwell University', slug: 'caldwell', logo_url: null, is_active: true,  is_verified: true },
      { id: 10, parent_id: 1,    school: 'caldwell', type: 'department', name: 'Student Life',        slug: 'sl',       logo_url: null, is_active: true,  is_verified: true },
      { id: 11, parent_id: 1,    school: 'caldwell', type: 'department', name: 'Academic Affairs',    slug: 'aa',       logo_url: null, is_active: true,  is_verified: true },
      { id: 20, parent_id: 10,   school: 'caldwell', type: 'club',       name: 'Eco Club',            slug: 'eco',      logo_url: null, is_active: true,  is_verified: true },
      { id: 21, parent_id: 10,   school: 'caldwell', type: 'club',       name: 'Film Society',        slug: 'film',     logo_url: null, is_active: true,  is_verified: true },
      { id: 22, parent_id: 10,   school: 'caldwell', type: 'club',       name: 'Chess Club',          slug: 'chess',    logo_url: null, is_active: false, is_verified: true },
      { id: 23, parent_id: 11,   school: 'caldwell', type: 'club',       name: '<img src=x onerror=alert(1)>', slug: 'x', logo_url: null, is_active: true, is_verified: true },
    ],
    followers: { 20: 84, 21: 23, 22: 31, 23: 5 },
    events: [
      { org_id: 20, starts_at: new Date(now - 3600e3).toISOString() },          // this semester, past
      { org_id: 20, starts_at: new Date(now + 3 * 864e5).toISOString() },       // this semester, upcoming
      { org_id: 23, starts_at: new Date(semStart - 10 * 864e5).toISOString() }, // last term
    ],
    officers: [{ org_id: 20 }, { org_id: 20 }, { org_id: 10 }, { org_id: 23 }],
    roster: [],
    profiles: [
      { id: 'u-admin', first_name: 'Kal', last_name: 'Reda', email: 'kal@caldwell.edu' },
      { id: 'u-ana',   first_name: 'Ana', last_name: 'Nunez', email: 'ana@caldwell.edu' },
    ],
    log: [{ id: 1, created_at: new Date(now - 864e5).toISOString(), actor_id: 'u-admin', action_type: 'org_deactivated',
            target_label: 'Chess Club', reason: 'No active officer' }],
    ...overrides,
  };
}

(async () => {
  console.log('\nAdmin › Organizations, against a fake database\n');

  // ---------------------------------------------------------- 1. what the page says
  S = scenario();
  store.clear();
  await run('renderOrgs()'); await settle();
  check('tabs count 5 active, 1 needing attention, 1 suspended',
    tabCount('Active') === '5' && tabCount('Needs attention') === '1' && tabCount('Suspended') === '1',
    `got active=${tabCount('Active')} attention=${tabCount('Needs attention')} suspended=${tabCount('Suspended')}`);
  check('the club with no E-board is flagged, and says why',
    rowOf('Film Society').includes('Needs attention') && rowOf('Film Society').includes('No E-board yet'));
  check('a club with officers is not flagged', rowOf('Eco Club').includes('is-ok">Active'));
  check('Eco Club shows 84 followers and 2 events this semester',
    /ao-num">84</.test(rowOf('Eco Club')) && /ao-num">2</.test(rowOf('Eco Club')));
  check('an event from last term is not counted this semester', /ao-num">0</.test(rowOf('&lt;img src=x onerror=alert(1)&gt;')));
  check('a suspended club is not in the Active list', !$('aoList').includes('Chess Club'));
  check('an organization name cannot inject markup',
    $('aoList').includes('&lt;img src=x onerror=alert(1)&gt;') && !$('aoList').includes('<img src=x'));
  check('Recent decisions names the admin and the reason',
    $('aoDecisions').includes('Suspended <strong>Chess Club</strong>') && $('aoDecisions').includes('No active officer · Kal R.'));

  run("aoSetTab('suspended')");
  check('a suspended club reads "—" for followers, never 0',
    rowOf('Chess Club').includes('title="Not counted while suspended">—'));
  run("aoSetTab('active')");

  // ---------------------------------------------------------- 2. suspending
  run('aoAskSuspend(20)');
  const updatesBefore = writes('organizations', 'update').length;
  await run('aoConfirmSuspend(20)'); await settle();
  check('suspending with no reason is refused before anything is written',
    writes('organizations', 'update').length === updatesBefore && lastToast().startsWith('Choose a reason'), lastToast());

  run('aoPickReason(20, 3)');                       // "Other", with no note
  await run('aoConfirmSuspend(20)'); await settle();
  check('"Other" without a note is refused', writes('organizations', 'update').length === updatesBefore && lastToast() === 'Add a note saying why', lastToast());
  run('aoCancelSuspend(20)');

  run('aoAskSuspend(21)');
  check('a flagged club opens the form with "No active E-board" already chosen',
    /aria-pressed="true"[^>]*>No active E-board</.test($('aoList')));
  els.get('aoSusNote-21').value = 'president graduated in May';
  await run('aoConfirmSuspend(21)'); await settle();
  const upd = writes('organizations', 'update').pop();
  const logged = S.log.find(r => r.action_type === 'org_deactivated' && r.target_label === 'Film Society');
  check('suspending writes is_active = false', upd && upd.payload.is_active === false);
  check('the reason and the note reach the activity log',
    logged && logged.reason === 'No active E-board — president graduated in May', logged && logged.reason);
  check('the page then shows 2 suspended', tabCount('Suspended') === '2', `got ${tabCount('Suspended')}`);
  check('and the new decision is already in Recent decisions', $('aoDecisions').indexOf('Film Society') > -1);

  // ---------------------------------------------------------- 3. a refusal is not a success
  S.refuseUpdate = true;
  const logsBefore = S.log.length;
  run('aoAskSuspend(20)'); run('aoPickReason(20, 1)');
  await run('aoConfirmSuspend(20)'); await settle();
  check('a write RLS filtered to zero rows is reported as refused, not as done',
    lastToast().includes("don't have authority") && S.log.length === logsBefore, lastToast());
  S.refuseUpdate = false;

  // ---------------------------------------------------------- 4. adding a club
  await run('renderOrgs()'); await settle();
  els.get('aoNewName').value = 'Robotics Club';
  els.get('aoNewParent').value = '10';
  els.get('aoNewOfficer').value = 'nobody@caldwell.edu';
  await run('aoCreateOrg()'); await settle();
  const ins = writes('organizations', 'insert').pop();
  check('a club is created under the chosen department, with a derived slug',
    ins && ins.payload.parent_id === 10 && ins.payload.type === 'club' && ins.payload.slug === 'robotics-club' && ins.payload.school === 'caldwell');
  check('a first E-board member with no account: the message says the club WAS created',
    lastToast().startsWith('Robotics Club was created, but nobody@caldwell.edu was not added.'), lastToast());

  els.get('aoNewName').value = 'Chess Club Two';
  els.get('aoNewParent').value = '10';
  els.get('aoNewOfficer').value = 'ANA@caldwell.edu ';
  const grantsBefore = S.grants.length;
  await run('aoCreateOrg()'); await settle();
  const grant = S.grants[S.grants.length - 1];
  check('a real person is added to the NEW club\'s E-board, as its President',
    S.grants.length === grantsBefore + 1 && grant.user_id === 'u-ana' && grant.role === 'officer' && grant.org_id === S.nextId - 1
    && grant.title === 'President', JSON.stringify(grant));
  const CLUB_POWERS = ['can_manage_events', 'can_check_in', 'can_post', 'can_manage_members', 'can_view_analytics', 'can_message', 'can_manage_admins'];
  check('...with every club power on, and never "Add clubs"',
    CLUB_POWERS.every(k => grant[k] === true) && grant.can_create_child_orgs === false, JSON.stringify(grant));
  check('and the message names them and the position', lastToast() === 'Chess Club Two created, with ana@caldwell.edu as its President', lastToast());

  // ---------------------------------------------------------- 5. the roster repaint bug
  run('clearOrgContext()');
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(20)'); await settle();
  check('after the cache is cleared, the E-board panel still draws its add form',
    $('org-panel-20').includes('Add to E-board'), $('org-panel-20').slice(0, 160));

  // ---------------------------------------------------------- 6. an admin who cannot read rosters
  S = scenario({ isSuper: false, myGrants: [] });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('without roster access, officer counts read "—"', rowOf('Eco Club').includes('title="Could not load">—') || rowOf('Eco Club').includes('title="You cannot read this roster">—'),
    rowOf('Eco Club').slice(0, 400));
  check('...nothing is flagged, and the tab says "—" rather than 0',
    !$('aoList').includes('Needs attention') && tabCount('Needs attention') === '—', `tab: ${tabCount('Needs attention')}`);
  check('...and no action buttons are offered', !$('aoList').includes('aoToggleRow(') && els.get('aoAdd').hidden === true);

  // ---------------------------------------------------------- 6b. authority over ONE department
  // Student Life's rosters are readable (the walk up reaches the grant on dept 10); Academic
  // Affairs' are not. A flagged club there is still a fact; a zero is not.
  S = scenario({ isSuper: false, myGrants: [{ org_id: 10, role: 'officer', title: 'Director', status: 'active', can_post: false, can_manage_members: true, can_view_analytics: false, can_message: false, can_create_child_orgs: false, can_manage_admins: false, can_manage_events: false, can_check_in: false }] });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('partial access: a verified flag still shows as a number',
    tabCount('Needs attention') === '1' && rowOf('Film Society').includes('Needs attention'), `tab: ${tabCount('Needs attention')}`);
  check('partial access: a club outside that authority is not flagged, and reads "—"',
    !rowOf('&lt;img src=x onerror=alert(1)&gt;').includes('Needs attention') && rowOf('&lt;img src=x onerror=alert(1)&gt;').includes('You cannot read this roster'));
  S = scenario({ isSuper: false, myGrants: [{ org_id: 10, role: 'officer', title: 'Director', status: 'active', can_post: false, can_manage_members: true, can_view_analytics: false, can_message: false, can_create_child_orgs: false, can_manage_admins: false, can_manage_events: false, can_check_in: false }], officers: [{ org_id: 20 }, { org_id: 21 }, { org_id: 10 }] });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('partial access with nothing flagged: "—", because the unread club might need attention',
    tabCount('Needs attention') === '—', `tab: ${tabCount('Needs attention')}`);
  run("aoSetTab('attention')");
  check('...and the empty list says why instead of "every club is fine"',
    $('aoList').includes('Some rosters could not be read'), $('aoList').slice(0, 160));

  // ---------------------------------------------------------- 7. a cut-off answer
  S = scenario({ events: Array.from({ length: 1000 }, () => ({ org_id: 20, starts_at: new Date().toISOString() })) });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('1000 event rows (Supabase\'s silent cap) make event counts "—", not 1000',
    rowOf('Eco Club').includes('>—<') && !rowOf('Eco Club').includes('>1000<'));

  // ---------------------------------------------------------- 8. E-board positions and powers
  const full = { can_post: true, can_manage_members: true, can_view_analytics: true, can_message: true,
                 can_create_child_orgs: false, can_manage_admins: true, can_manage_events: true, can_check_in: true };
  S = scenario({
    roster: [
      { id: 501, user_id: 'u-ana', role: 'officer', title: 'Secretary',     status: 'active', ...full },
      { id: 502, user_id: 'u-bo',  role: 'officer', title: 'President',     status: 'active', ...full },
      { id: 503, user_id: 'u-cy',  role: 'member',  title: null,            status: 'active' },
      { id: 504, user_id: 'u-admin', role: 'officer', title: 'Administrator', status: 'active', ...full },
    ],
  });
  S.profiles.push({ id: 'u-bo', first_name: 'Bo', last_name: 'Lee', email: 'bo@caldwell.edu' },
                  { id: 'u-cy', first_name: 'Cy', last_name: 'Park', email: 'cy@caldwell.edu' });
  store.clear();
  await run('renderOrgs()'); await settle();
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(20)'); await settle();
  let panel = $('org-panel-20');
  const at = n => panel.indexOf(n);
  check('the roster lists the President first, then other positions, then members',
    at('Bo Lee') > -1 && at('Bo Lee') < at('Ana Nunez') && at('Ana Nunez') < at('Kal Reda') && at('Kal Reda') < at('Cy Park'),
    [at('Bo Lee'), at('Ana Nunez'), at('Kal Reda'), at('Cy Park')].join(' '));
  check('every E-board row has Edit, and a plain member does not',
    panel.includes('orgEditEboard(501)') && panel.includes('orgEditEboard(502)') && !panel.includes('orgEditEboard(503)'));
  check('the add form starts on Vice President, because the club already has a President',
    /<option value="Vice President" selected>/.test(panel), (panel.match(/<option[^>]*selected>[^<]*/) || [''])[0]);
  check('nothing on the panel says "officer" any more', !panel.replace(/<[^>]*>/g, '').includes('fficer'),
    (panel.replace(/<[^>]*>/g, '').match(/.{30}fficer.{30}/) || [''])[0]);

  run('orgEditEboard(501)');
  panel = $('org-panel-20');
  check('Edit opens the editor with the position and the powers',
    panel.includes('id="eb-ed-501"') && panel.includes('data-k="can_manage_admins"') && panel.includes('Door check-in'));
  check('a club\'s editor has no "Add clubs" power', !panel.includes('data-k="can_create_child_orgs"'));

  els.get('eb-ed-501-pos').value = 'other';
  els.get('eb-ed-501-title').value = '  outreach   chair ';
  unchecked.add('can_post');
  const logBefore = S.log.length;
  await run('orgSaveEboard(501)'); await settle();
  unchecked.clear();
  let g = S.grants[S.grants.length - 1];
  check('saving writes the typed position (tidied) and the unticked power',
    g && g._id === 501 && g.title === 'outreach chair' && g.can_post === false && g.can_check_in === true, JSON.stringify(g));
  const changed = S.log.find(r => r.action_type === 'org_eboard_changed');
  check('...and logs only what changed', S.log.length === logBefore + 1 && changed
    && JSON.stringify(changed.before_state) === '{"title":"Secretary","can_post":true}'
    && JSON.stringify(changed.after_state) === '{"title":"outreach chair","can_post":false}',
    changed && JSON.stringify([changed.before_state, changed.after_state]));

  // A typed title that IS a position is saved as that position, so the one-President rule sees it.
  S.seats = [{ id: 502 }];
  const grantsNow = S.grants.length;
  run('orgEditEboard(501)');
  els.get('eb-ed-501-pos').value = 'other';
  els.get('eb-ed-501-title').value = 'PRESIDENT';
  await run('orgSaveEboard(501)'); await settle();
  check('a second President is refused before anything is written, even typed as "PRESIDENT"',
    S.grants.length === grantsNow && lastToast() === "Eco Club already has a President. Change that person's position first.", lastToast());

  run('orgEditEboard(null)');
  run('orgEditEboard(502)');
  unchecked.add('can_view_analytics');
  await run('orgSaveEboard(502)'); await settle();
  unchecked.clear();
  g = S.grants[S.grants.length - 1];
  check('the President keeps their own position while their powers change',
    S.grants.length === grantsNow + 1 && g._id === 502 && g.title === 'President' && g.can_view_analytics === false, lastToast());

  // The database's rule, if the page's check is ever skipped or wrong.
  S.seats = [];
  S.grantError = { code: '23505', message: 'duplicate key value violates unique constraint "org_memberships_one_president_vp"' };
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(20)'); await settle();
  els.get('org-add-20').value = 'cy@caldwell.edu';
  els.get('eb-add-20-pos').value = 'Vice President';
  await run('orgAddOfficer(20)'); await settle();
  check('the database refusing a second Vice President reads as words, not a code',
    lastToast() === "Eco Club already has a Vice President. Change that person's position first.", lastToast());
  S.grantError = null;

  // A department's E-board can add clubs; a club's cannot.
  S.roster = [];
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(10)'); await settle();
  els.get('org-add-10').value = 'cy@caldwell.edu';
  els.get('eb-add-10-pos').value = 'other';
  els.get('eb-add-10-title').value = 'Director';
  await run('orgAddOfficer(10)'); await settle();
  g = S.grants[S.grants.length - 1];
  check('a department\'s new E-board member starts with every power, "Add clubs" included',
    g && g.title === 'Director' && g.can_create_child_orgs === true && g.can_manage_admins === true, JSON.stringify(g));
  check('...and the message names the position', lastToast() === 'Added as Director', lastToast());

  // In a club, only the President starts with Manage E-board.
  S.roster = [{ id: 502, user_id: 'u-bo', role: 'officer', title: 'President', status: 'active', ...full }];
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(20)'); await settle();
  els.get('org-add-20').value = 'cy@caldwell.edu';
  els.get('eb-add-20-pos').value = 'Secretary';
  await run('orgAddOfficer(20)'); await settle();
  g = S.grants[S.grants.length - 1];
  check('a club Secretary starts with every power except Manage E-board',
    g && g.title === 'Secretary' && g.can_manage_admins === false && g.can_post === true && g.can_manage_events === true, JSON.stringify(g));

  // ---------------------------------------------------------- 9. renaming
  S = scenario();
  store.clear();
  await run('renderOrgs()'); await settle();
  check('the school heading is shown with one school, and offers Rename', $('aoList').includes('aoAskRename(1)'));
  run('aoToggleRow(10)');
  check('a department\'s actions include Rename', $('aoList').includes('aoAskRename(10)'));
  run('aoAskRename(10)');
  els.get('aoRename-10').value = '  Campus   Life ';
  await run('aoSaveRename(10)'); await settle();
  let ren = writes('organizations', 'update').pop();
  check('renaming a department writes the new name and a matching address (slug)',
    ren && ren.payload.name === 'Campus Life' && ren.payload.slug === 'campus-life', JSON.stringify(ren && ren.payload));
  check('...and logs the old and new name', S.log.some(r => r.action_type === 'org_renamed'
    && r.before_state?.name === 'Student Life' && r.after_state?.name === 'Campus Life'));
  run('aoAskRename(1)');
  els.get('aoRename-1').value = 'Caldwell U';
  await run('aoSaveRename(1)'); await settle();
  ren = writes('organizations', 'update').pop();
  check('renaming the school changes its name only — its address is the school\'s',
    ren && ren.payload.name === 'Caldwell U' && !('slug' in ren.payload), JSON.stringify(ren && ren.payload));

  // ---------------------------------------------------------- 10. creating the school
  S = scenario({ orgs: [], schools: [{ slug: 'caldwell', name: 'Caldwell University' }, { slug: 'drew', name: 'Drew University' }] });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('with no organizations, a super admin sees "Create the school", not the SQL editor',
    $('asec-orgs').includes('aoCreateSchool()') && !$('asec-orgs').includes('SQL editor'));
  check('the name box starts filled in with the school\'s name',
    /id="aoSchoolName"[^>]*value="Caldwell University"/.test($('asec-orgs')));
  els.get('aoSchoolName').value = 'Caldwell University';   // the fake page reads value="" only before id=""
  await run('aoCreateSchool()'); await settle();
  const sch = writes('organizations', 'insert').pop();
  check('it creates a root organization of type school, addressed by the school\'s slug',
    sch && sch.payload.type === 'school' && sch.payload.parent_id === null && sch.payload.school === 'caldwell'
    && sch.payload.slug === 'caldwell' && sch.payload.name === 'Caldwell University', JSON.stringify(sch && sch.payload));
  check('then the page shows the school, says what comes next, and offers "Add a department"',
    $('aoList').includes('Caldwell University') && $('aoList').includes('No departments yet') && $('aoAdd').includes('Add a department'),
    $('aoList').slice(0, 200));

  S = scenario({ orgs: [], isSuper: false, schools: [{ slug: 'caldwell', name: 'Caldwell University' }] });
  store.clear();
  await run('renderOrgs()'); await settle();
  check('anyone else is told an administrator creates it, with no button',
    !$('asec-orgs').includes('aoCreateSchool()') && $('asec-orgs').includes('platform administrator'));

  // ---------------------------------------------------------- 11. the club console: the President runs the E-board
  const presGrant = { org_id: 20, role: 'officer', title: 'President', status: 'active', ...full, can_manage_admins: true };
  const consoleRoster = () => [
    { id: 500, user_id: 'u-admin', role: 'officer', title: 'President', status: 'active', ...full },
    { id: 501, user_id: 'u-ana', role: 'officer', title: 'Secretary', status: 'active', ...full, can_manage_admins: false },
    { id: 503, user_id: 'u-cy', role: 'member', title: null, status: 'active' },
  ];
  S = scenario({ isSuper: false, myGrants: [presGrant], roster: consoleRoster() });
  S.profiles.push({ id: 'u-cy', first_name: 'Cy', last_name: 'Park', email: 'cy@caldwell.edu' });
  store.clear();
  els.set('ocBody', makeEl('ocBody'));
  run('clearOrgContext()');
  await run('loadOrgContext(true)');
  run("_ocOrgId = 20; _ocSection = 'members'");
  await run('renderOcMembers()'); await settle();
  let ocb = $('ocBody');
  check('console: the President can put a member on the E-board, and edit another E-board member',
    ocb.includes('ocEboardOpen(503)') && ocb.includes('Add to the E-board') && ocb.includes('ocEboardOpen(501)'));
  check('console: the President\'s own row has no controls', !ocb.includes('ocEboardOpen(500)') && !ocb.includes('ocEboardRemove(500)'));
  check('console: nothing here says "officer"', !ocb.replace(/<[^>]*>/g, '').includes('fficer'),
    (ocb.replace(/<[^>]*>/g, '').match(/.{30}fficer.{30}/) || [''])[0]);

  run('ocEboardOpen(503)');
  let lists = $('ocMemLists');
  check('console: putting a member on the E-board never offers President',
    lists.includes('id="oc-eb-503"') && !lists.includes('<option value="President"'));
  check('console: ...starts on Vice President, with every power except Manage E-board',
    /<option value="Vice President" selected>/.test(lists)
    && /data-k="can_post" checked/.test(lists) && /data-k="can_manage_admins">/.test(lists) && !lists.includes('can_create_child_orgs'));

  els.get('oc-eb-503-pos').value = 'other';
  els.get('oc-eb-503-title').value = 'president';
  const before11 = S.grants.length;
  await run('ocEboardSave(503)'); await settle();
  check('console: typing "president" into Other is refused before anything is written',
    S.grants.length === before11 && lastToast() === 'Only a Nestrel admin can name a President', lastToast());

  els.get('oc-eb-503-pos').value = 'Treasurer';
  await run('ocEboardSave(503)'); await settle();
  g = S.grants[S.grants.length - 1];
  check('console: the member joins the E-board as Treasurer, without Manage E-board or Add clubs',
    g && g._id === 503 && g.role === 'officer' && g.title === 'Treasurer' && g.can_post === true
    && g.can_manage_admins === false && g.can_create_child_orgs === false, JSON.stringify(g));
  check('console: ...logged, and announced by name', S.log.some(r => r.action_type === 'org_officer_added' && r.target_label === 'Cy Park')
    && lastToast() === 'Cy Park is now Treasurer', lastToast());

  await run('ocEboardRemove(501)'); await settle();
  g = S.grants[S.grants.length - 1];
  check('console: "Take off the E-board" keeps them as a member with no position or powers',
    g && g._id === 501 && g.role === 'member' && g.title === null && g.status === undefined
    && ['can_post', 'can_manage_members', 'can_manage_admins', 'can_manage_events', 'can_check_in'].every(k => g[k] === false), JSON.stringify(g));
  check('console: ...and logs what they held', S.log.some(r => r.action_type === 'org_eboard_removed' && r.before_state?.title === 'Secretary'));

  // Someone with "Members & club page" but not Manage E-board: runs members, not the E-board.
  S = scenario({ isSuper: false, roster: consoleRoster(),
    myGrants: [{ org_id: 20, role: 'officer', title: 'Secretary', status: 'active', ...full, can_manage_admins: false }] });
  S.roster[0].user_id = 'u-bo'; S.roster[1].user_id = 'u-admin';
  store.clear();
  run('clearOrgContext()');
  await run('loadOrgContext(true)');
  run("_ocOrgId = 20; _ocSection = 'members'");
  await run('renderOcMembers()'); await settle();
  ocb = $('ocBody');
  check('console: without Manage E-board there is no Add to the E-board, Edit, or Remove on an E-board member',
    !ocb.includes('ocEboardOpen(') && !ocb.includes('ocEboardRemove(') && !ocb.includes('ocRemove(500)'));
  check('console: ...but plain members can still be removed from the club', ocb.includes('ocRemove(503)'));

  // ---------------------------------------------------------- 12. a club page: Ask to join
  S = scenario({ isSuper: false });
  store.clear();
  run("sUser = { id: 'u-cy', first: 'Cy' }; adminPreviewMode = false");
  run("_opOrg = { id: 20, name: 'Eco Club', type: 'club', follower_count: 3 }; _opEvents = []; _opPosts = []; _opOfficers = []; _opPreview = false; _opTab = null");
  els.set('orgPageBody', makeEl('orgPageBody'));
  run('_opMember = null'); run('orgPagePaint()');
  check('club page: a student who is not a member sees Ask to join', $('orgPageBody').includes('orgPageJoin(20)'));
  await run('orgPageJoin(20)'); await settle();
  const req = S.grants[S.grants.length - 1];
  check('club page: asking writes a powerless request for yourself',
    req && req.org_id === 20 && req.user_id === 'u-cy' && req.role === 'member' && req.status === 'pending'
    && !Object.keys(req).some(k => k.startsWith('can_') && req[k]), JSON.stringify(req));
  check('club page: ...then shows Requested, which cancels', $('orgPageBody').includes('Requested') && $('orgPageBody').includes('orgPageCancelJoin(20)'));
  await run('orgPageCancelJoin(20)'); await settle();
  check('club page: cancelling deletes only your own request', (S.deleted || []).join() === '777' && $('orgPageBody').includes('orgPageJoin(20)'));

  run("_opMember = { id: 778, role: 'member', status: 'active' }"); run('orgPagePaint()');
  check('club page: a member sees Member, which leaves', $('orgPageBody').includes('>Member<') && $('orgPageBody').includes('orgPageLeave(20)'));
  run("_opMember = { id: 779, role: 'officer', status: 'active' }"); run('orgPagePaint()');
  check('club page: the E-board gets no join control', !/orgPage(Join|Leave|CancelJoin)\(/.test($('orgPageBody')));
  run("_opMember = { id: 780, role: 'member', status: 'removed' }"); run('orgPagePaint()');
  check('club page: after a decline or removal it reads "Not a member", with no button to ask again',
    $('orgPageBody').includes('Not a member') && !$('orgPageBody').includes('orgPageJoin(20)'));
  run("_opMember = { error: true }"); run('orgPagePaint()');
  check('club page: if your membership could not be read, no join control is offered', !/orgPage(Join|Leave|CancelJoin)\(/.test($('orgPageBody')));

  console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  All checks passed\n');
  process.exit(failures ? 1 : 0);

})().catch(e => { console.log('  FAIL  the test itself crashed: ' + (e && e.stack || e)); process.exit(1); });
