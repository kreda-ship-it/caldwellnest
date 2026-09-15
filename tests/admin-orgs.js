// Behaviour of the admin Organizations tab (js/orgs.js), driven against a fake database and a
// fake page. Where tests/load-order.js proves the files RUN, this proves the page TELLS THE TRUTH:
//
//   - a number it cannot know is drawn as "—", never as 0
//   - a club is flagged "Needs attention" only when its roster was actually readable
//   - suspending requires a reason, and the reason reaches the activity log
//   - a write the database silently refuses is not announced as a success
//   - "Add a club" says plainly when the club was made but its officer was not
//   - an organization name cannot inject markup
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
const files = [...html.matchAll(/src="(js\/[a-z]+\.js)/g)].map(m => m[1]).filter(f => f !== 'js/boot.js');

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
    focus() { page.focused = '#' + id; }, scrollIntoView() {},
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
  querySelectorAll: sel => (strict && sel === '.org-panel')
    ? [...els.values()].filter(e => e.id.startsWith('org-panel-')) : [],
  createElement: () => permissive, addEventListener() {}, removeEventListener() {},
  body: permissive, documentElement: permissive, head: permissive, cookie: '',
};
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
    case 'org_memberships':
      if (q.op === 'insert' || q.op === 'update') { S.grants.push(q.payload); return { data: null, error: null }; }
      if (q.cols && q.cols.includes('can_check_in') && 'user_id' in f) return { data: S.myGrants, error: null };
      if (f.role === 'officer') return { data: S.officers, error: null };
      if ('user_id' in f) return one([]);                        // "already on this roster?" — no
      return { data: S.roster || [], error: null };               // the officer panel
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
  check('the club with no officers is flagged, and says why',
    rowOf('Film Society').includes('Needs attention') && rowOf('Film Society').includes('No active officer'));
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
  check('a flagged club opens the form with "No active officer" already chosen',
    /aria-pressed="true"[^>]*>No active officer</.test($('aoList')));
  els.get('aoSusNote-21').value = 'president graduated in May';
  await run('aoConfirmSuspend(21)'); await settle();
  const upd = writes('organizations', 'update').pop();
  const logged = S.log.find(r => r.action_type === 'org_deactivated' && r.target_label === 'Film Society');
  check('suspending writes is_active = false', upd && upd.payload.is_active === false);
  check('the reason and the note reach the activity log',
    logged && logged.reason === 'No active officer — president graduated in May', logged && logged.reason);
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
  check('an officer with no account: the message says the club WAS created',
    lastToast().startsWith('Robotics Club was created, but the officer was not added.'), lastToast());

  els.get('aoNewName').value = 'Chess Club Two';
  els.get('aoNewParent').value = '10';
  els.get('aoNewOfficer').value = 'ANA@caldwell.edu ';
  const grantsBefore = S.grants.length;
  await run('aoCreateOrg()'); await settle();
  const grant = S.grants[S.grants.length - 1];
  check('a real officer is granted on the NEW club, as an officer',
    S.grants.length === grantsBefore + 1 && grant.user_id === 'u-ana' && grant.role === 'officer' && grant.org_id === S.nextId - 1,
    JSON.stringify(grant));
  check('and the message names them', lastToast() === 'Chess Club Two created, with ana@caldwell.edu as its first officer', lastToast());

  // ---------------------------------------------------------- 5. the roster repaint bug
  run('clearOrgContext()');
  run('_orgOpenPanel = null');
  await run('orgTogglePanel(20)'); await settle();
  check('after the cache is cleared, the officer panel still draws its Add officer form',
    $('org-panel-20').includes('Add officer'), $('org-panel-20').slice(0, 160));

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

  console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  All checks passed\n');
  process.exit(failures ? 1 : 0);

})().catch(e => { console.log('  FAIL  the test itself crashed: ' + (e && e.stack || e)); process.exit(1); });
