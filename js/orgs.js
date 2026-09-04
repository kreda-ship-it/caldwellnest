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

// Mirrors the CASE expression inside can_act(). If a flag is ever added to org_memberships,
// it goes here AND in the SQL function, and the two must agree. They are checked against each
// other by nothing — that is the cost of a mirror, and the reason this map is small.
const ORG_ACTIONS = {
  post:              'can_post',
  manage_members:    'can_manage_members',
  view_analytics:    'can_view_analytics',
  message:           'can_message',
  create_child_orgs: 'can_create_child_orgs',
  moderate:          'can_moderate',
  manage_admins:     'can_manage_admins',
};

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
  if (!user) { _orgCtx = { isSuper: false, parents: new Map(), orgs: new Map(), grants: new Map() }; return _orgCtx; }

  const [orgRes, memRes, roleRes] = await Promise.all([
    supabaseClient.from('organizations')
      .select('id, parent_id, school, type, name, slug, logo_url, is_active, is_verified'),
    supabaseClient.from('org_memberships')
      .select('org_id, role, title, status, can_post, can_manage_members, can_view_analytics, can_message, can_create_child_orgs, can_moderate, can_manage_admins')
      .eq('user_id', user.id),
    // "Users can read own roles" allows this; it is how the super-admin branch of the mirror
    // is answered without depending on globals another file happens to have set.
    supabaseClient.from('user_roles').select('role_id').eq('user_id', user.id),
  ]);

  // A failed query and an empty result are different things. Treating a network error as
  // "you have no permissions" would silently hide an officer's entire console, so the error
  // is surfaced and the cache is left unset so the next call retries.
  if (orgRes.error || memRes.error || roleRes.error) {
    console.error('[loadOrgContext] load failed:',
      orgRes.error?.message || memRes.error?.message || roleRes.error?.message);
    return null;
  }

  const orgs    = new Map();
  const parents = new Map();
  (orgRes.data || []).forEach(o => { orgs.set(o.id, o); parents.set(o.id, o.parent_id); });

  const grants = new Map();
  (memRes.data || []).forEach(m => grants.set(m.org_id, m));

  _orgCtx = {
    isSuper: (roleRes.data || []).some(r => r.role_id === 'super_admin'),
    orgs, parents, grants,
    loadedAt: Date.now(),
  };
  return _orgCtx;
}

// Call after anything that changes memberships or organizations, and on logout. A stale
// cache here shows an ex-officer their old buttons — which the database will refuse, but
// which reads as a bug to the person looking at it.
function clearOrgContext() { _orgCtx = null; }


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
// ADMIN UI — workstream 1 stage 3
// ============================================================
// Lives in the EXISTING admin page as its own tab, not in the org console. The console is
// workstream 2 and the plan is explicit about not building it early: this tab exists so that
// organizations can be created at all, which everything later depends on.
//
// Every action below is gated twice. orgCanAct() decides whether the button is drawn; RLS
// decides whether the write succeeds. The second one is the real one. If you ever find a
// button here that works when it should not, the bug is in the SQL, not in this file.

let _orgOpenPanel = null;   // org id whose officer panel is expanded, or null

async function renderOrgs() {
  const host = document.getElementById('asec-orgs');
  if (!host) return;
  host.innerHTML = '<div class="org-empty">Loading organizations…</div>';

  const ctx = await loadOrgContext(true);
  if (!ctx) { host.innerHTML = '<div class="org-empty">Could not load organizations. Check the console.</div>'; return; }

  const roots = orgTree();
  if (!roots.length) {
    // The school row is created by the bootstrap in sql/2026-09-04_org_hierarchy.sql, and
    // only a super admin can create a root organization — that is what makes verification
    // provenance rather than a checkbox. So an empty tree means bootstrap has not been run,
    // not that something is broken.
    host.innerHTML = '<div class="org-empty"><strong>No organizations yet.</strong><br>'
      + 'The school organization is created once, by hand, in the SQL editor — see the '
      + 'BOOTSTRAP section of <code>sql/2026-09-04_org_hierarchy.sql</code>.</div>';
    return;
  }

  host.innerHTML = '<div class="org-tree">' + roots.map(n => _orgNodeHtml(n, 0)).join('') + '</div>';
}

function _orgNodeHtml(node, depth) {
  const canChild  = orgCanAct('create_child_orgs', node.id);
  const canManage = orgCanAct('manage_members', node.id);
  // school -> department -> club. An org that cannot have children offers no add button.
  const childType = node.type === 'school' ? 'department' : (node.type === 'department' ? 'club' : null);

  let actions = '';
  if (canChild && childType) {
    actions += `<button class="org-btn" onclick="orgCreateChild(${node.id}, '${childType}')">+ ${childType}</button>`;
  }
  if (canManage) {
    actions += `<button class="org-btn" onclick="orgTogglePanel(${node.id})">Officers</button>`;
    actions += node.is_active
      ? `<button class="org-btn org-btn-warn" onclick="orgSetActive(${node.id}, false)">Deactivate</button>`
      : `<button class="org-btn" onclick="orgSetActive(${node.id}, true)">Reactivate</button>`;
  }

  const badges = (node.is_verified ? '<span class="org-badge org-badge-ok">verified</span>' : '')
               + (node.is_active ? '' : '<span class="org-badge org-badge-off">inactive</span>');

  return `
    <div class="org-node org-depth-${Math.min(depth, 3)}">
      <div class="org-row${node.is_active ? '' : ' org-row-off'}">
        <div class="org-name">${esc(node.name)} ${badges}</div>
        <div class="org-type">${esc(node.type)}</div>
        <div class="org-actions">${actions}</div>
      </div>
      <div class="org-panel" id="org-panel-${node.id}"></div>
      ${(node.children || []).map(c => _orgNodeHtml(c, depth + 1)).join('')}
    </div>`;
}

// ---------- create a child organization ----------
async function orgCreateChild(parentId, type) {
  const name = prompt(`Name of the new ${type}?`);
  if (!name || !name.trim()) return;

  const parent = _orgCtx?.orgs.get(parentId);
  if (!parent) return;

  // The slug is derived, never typed. It is half of `unique (school, slug)`, so letting a
  // person enter it invites two clubs that differ only by a capital letter.
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) { toast('That name has no letters or numbers in it'); return; }

  const { error } = await supabaseClient.from('organizations').insert({
    school: parent.school,          // inherited, never chosen — a child cannot change schools
    parent_id: parentId,
    type, name: name.trim(), slug,
    created_by: (await supabaseClient.auth.getUser()).data.user?.id || null,
  });

  if (error) {
    // 23505 is unique_violation. Saying which constraint failed is the difference between
    // "something went wrong" and "you already have one of these".
    toast(error.code === '23505' ? `A ${type} with that name already exists` : 'Could not create: ' + error.message);
    console.error('[orgCreateChild]', error);
    return;
  }
  logEvent('org_created', { targetType: 'organization', targetLabel: name.trim(), school: parent.school,
                            after: { type, parent_id: parentId } });
  toast(`✓ ${name.trim()} created`);
  renderOrgs();
}

// ---------- deactivate / reactivate ----------
async function orgSetActive(orgId, active) {
  const org = _orgCtx?.orgs.get(orgId);
  if (!org) return;
  if (!active && !confirm(`Deactivate ${org.name}? It disappears from the directory and its future events stop showing. Past events stay as history.`)) return;

  const { error } = await supabaseClient.from('organizations').update({ is_active: active }).eq('id', orgId);
  if (error) { toast('Could not update: ' + error.message); console.error('[orgSetActive]', error); return; }

  logEvent(active ? 'org_reactivated' : 'org_deactivated',
    { targetType: 'organization', targetId: orgId, targetLabel: org.name, school: org.school,
      before: { is_active: !active }, after: { is_active: active } });
  toast(active ? '✓ Reactivated' : '✓ Deactivated');
  renderOrgs();
}

// ---------- the officer panel ----------
async function orgTogglePanel(orgId) {
  const el = document.getElementById('org-panel-' + orgId);
  if (!el) return;
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
  let names = {};
  if (ids.length) {
    const { data: profs } = await supabaseClient.from('profiles')
      .select('id, first_name, last_name, email').in('id', ids);
    (profs || []).forEach(p => names[p.id] = `${p.first_name} ${p.last_name}`.trim() + ` · ${p.email}`);
  }

  const canGrant = orgCanAct('manage_admins', orgId);
  const rows = (data || []).length
    ? data.map(m => `
        <div class="org-roster-row">
          <span class="org-roster-who">${esc(m.user_id ? (names[m.user_id] || m.user_id) : (m.pending_email + ' (invited)'))}</span>
          <span class="org-roster-role">${esc(m.title || m.role)}${m.status !== 'active' ? ' · ' + esc(m.status) : ''}</span>
          <button class="org-btn org-btn-warn" onclick="orgRemoveMember(${m.id}, ${orgId})">Remove</button>
        </div>`).join('')
    : '<div class="org-empty">No members yet.</div>';

  el.innerHTML = rows + (canGrant ? `
    <div class="org-form">
      <input class="org-input" id="org-add-${orgId}" type="email" placeholder="officer@caldwell.edu" autocomplete="off">
      <button class="org-btn" onclick="orgAddOfficer(${orgId})">Add officer</button>
    </div>`
    : '<div class="org-empty">Adding officers needs the “manage admins” permission.</div>');
}

async function orgAddOfficer(orgId) {
  const input = document.getElementById('org-add-' + orgId);
  const email = (input?.value || '').trim().toLowerCase();
  if (!email) return;

  // Look the person up. If they have not signed up yet, the membership is stored against
  // pending_email and resolved to a user_id when they do — plan A15. Without that, onboarding
  // an organization would require its whole e-board to sign up first, in order.
  const { data: prof } = await supabaseClient.from('profiles').select('id').eq('email', email).maybeSingle();

  const { error } = await supabaseClient.from('org_memberships').insert({
    org_id: orgId,
    user_id: prof?.id || null,
    pending_email: prof ? null : email,
    role: 'officer',
    title: 'Officer',
    status: 'active',
    // A deliberate default, not a full set: post, manage the roster, read analytics, reply to
    // messages. NOT create_child_orgs, NOT moderate, and NOT manage_admins — granting
    // authority is the one thing that should never be handed out by default.
    can_post: true, can_manage_members: true, can_view_analytics: true, can_message: true,
  });

  if (error) {
    toast(error.code === '23505' ? 'That person is already on this roster' : 'Could not add: ' + error.message);
    console.error('[orgAddOfficer]', error);
    return;
  }
  const org = _orgCtx?.orgs.get(orgId);
  logEvent('org_officer_added', { targetType: 'membership', targetId: orgId, targetLabel: email,
                                  school: org?.school, after: { role: 'officer' } });
  toast('✓ Officer added');
  clearOrgContext();
  orgTogglePanel(orgId); orgTogglePanel(orgId);   // close + reopen to repaint
}

async function orgRemoveMember(membershipId, orgId) {
  if (!confirm('Remove this person from the organization? Events they created stay with the organization.')) return;
  const { error } = await supabaseClient.from('org_memberships').delete().eq('id', membershipId);
  if (error) { toast('Could not remove: ' + error.message); console.error('[orgRemoveMember]', error); return; }
  logEvent('org_member_removed', { targetType: 'membership', targetId: membershipId });
  toast('✓ Removed');
  clearOrgContext();
  _orgOpenPanel = null;
  orgTogglePanel(orgId);
}
