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
        return `
        <div class="org-roster-row${gone ? ' org-roster-row-off' : ''}">
          <span class="org-roster-who">${esc(who(m))}</span>
          <span class="org-roster-role">${esc(m.title || m.role)}${m.status !== 'active' ? ' · ' + esc(m.status) : ''}</span>
          ${gone
            ? `<button class="org-btn" onclick="orgRestoreMember(${m.id}, ${orgId})">Restore</button>`
            : `<button class="org-btn org-btn-warn" onclick="orgRemoveMember(${m.id}, ${orgId})">Remove</button>`}
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
    signed up yet is not supported — the invite would never resolve into a real membership.</div>`
    : '<div class="org-empty">Adding officers needs the \u201Cmanage admins\u201D permission.</div>');
}

async function orgAddOfficer(orgId) {
  const input = document.getElementById('org-add-' + orgId);
  const email = (input?.value || '').trim().toLowerCase();
  if (!email) return;

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
    toast('Could not look that address up: ' + lookupErr.message);
    console.error('[orgAddOfficer] lookup failed:', lookupErr);
    return;
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
    toast(email + ' has no Nestrel account yet — ask them to sign up first, then add them');
    return;
  }

  // A removed member keeps their row, because org_memberships is unique on (org_id, user_id)
  // and removal is now a status change rather than a delete. So re-adding somebody is an
  // UPDATE. Without this branch it fails on the unique constraint with a duplicate-key
  // message that names neither the person nor the reason.
  const { data: existing, error: existErr } = await supabaseClient
    .from('org_memberships').select('id, status')
    .eq('org_id', orgId).eq('user_id', prof.id).maybeSingle();

  if (existErr) {
    toast('Could not check the roster: ' + existErr.message);
    console.error('[orgAddOfficer] roster check failed:', existErr);
    return;
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
  toast('✓ Removed');
  clearOrgContext();
  _orgOpenPanel = null;
  orgTogglePanel(orgId);
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
  toast('✓ Restored');
  clearOrgContext();
  _orgOpenPanel = null;
  orgTogglePanel(orgId);
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
  toast('✓ You are now an officer of ' + org.name);
  clearOrgContext();
  _orgOpenPanel = null;
  orgTogglePanel(orgId);
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

  _ocSection = 'posts';
  // Remembered so a refresh returns here rather than to the feed. showPage() already stores
  // 'org-console' as the last page; on its own that is not enough, because the console markup
  // is an empty shell until an organization has been chosen.
  try { sessionStorage.setItem('cn_oc_org', String(_ocOrgId)); } catch (e) { /* private mode */ }
  showPage('org-console');
  renderOrgConsole();
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
  showPage('listings');
}

function orgConsolePick(mine) {
  showPage('org-console');
  document.getElementById('ocIdentity').textContent = 'Choose an organization';
  document.getElementById('ocNav').innerHTML = '';
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
  const s = [];
  if (orgCanAct('post', _ocOrgId)) s.push({ id: 'posts', label: 'Posts' });
  s.push({ id: 'profile', label: 'Org profile' });
  if (orgCanAct('manage_members', _ocOrgId)) s.push({ id: 'members', label: 'Members' });
  // Events, Registrations, Check-in and Analytics arrive with workstreams 3 and 6. They are
  // listed so the shape of the console is visible, and disabled so nothing pretends to work.
  s.push({ id: 'events',    label: 'Events',    soon: 'workstream 3' });
  s.push({ id: 'analytics', label: 'Analytics', soon: 'workstream 6' });
  return s;
}

function renderOrgConsole() {
  const org = _orgCtx?.orgs.get(_ocOrgId);
  if (!org) { toast('That organization is no longer available'); showPage('listings'); return; }

  const me = _orgCtx.grants.get(_ocOrgId);
  document.getElementById('ocIdentity').innerHTML =
    `${esc(org.name)} <span class="oc-sep">·</span> <span class="oc-role">${esc(me?.title || me?.role || 'Administrator')}</span>`;

  // Nothing to switch to is not a button. It used to render always and toast "you are only an
  // officer of one organization", which is the common case — a control whose usual answer is
  // "no" should not be on screen.
  const swBtn = document.getElementById('ocSwitchBtn');
  if (swBtn) swBtn.hidden = orgMemberships().filter(m => m.role === 'officer').length < 2;

  document.getElementById('ocNav').innerHTML = orgConsoleSections().map(s =>
    s.soon
      ? `<button class="oc-tab oc-tab-soon" disabled title="Arrives with ${s.soon}">${s.label}</button>`
      : `<button class="oc-tab${_ocSection === s.id ? ' active' : ''}" onclick="orgConsoleGo('${s.id}')">${s.label}</button>`
  ).join('');

  if      (_ocSection === 'members') renderOcMembers();
  else if (_ocSection === 'profile') renderOcProfile();
  else                               renderOcPosts();
}

function orgConsoleGo(section) { _ocSection = section; renderOrgConsole(); }

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

function renderOcProfile() {
  const org = _orgCtx.orgs.get(_ocOrgId);
  const canEdit = orgCanAct('manage_members', _ocOrgId);

  document.getElementById('ocBody').innerHTML = `
    <div class="oc-logo-row">
      <div class="oc-logo">${org.logo_url
        ? `<img src="${escAttr(org.logo_url)}" alt="${escAttr(org.name)}">`
        : `<span class="oc-logo-empty">${esc((org.name || '?').slice(0, 2).toUpperCase())}</span>`}</div>
      ${canEdit ? `<label class="org-btn oc-logo-btn">Change logo
        <input type="file" accept="image/*" hidden onchange="ocPickLogo(this)">
      </label>` : ''}
    </div>
    <div class="oc-meta">
      <span class="org-badge ${org.is_verified ? 'org-badge-ok' : 'org-badge-off'}">${org.is_verified ? 'verified' : 'unverified'}</span>
      <span class="oc-meta-type">${esc(org.type)}</span>
      <span class="oc-meta-slug">/${esc(org.slug)}</span>
    </div>
    ${OC_FIELDS.map(([k, label, type]) => `
      <label class="oc-field">
        <span class="oc-label">${label}</span>
        ${type === 'textarea'
          ? `<textarea class="oc-input" id="oc-${k}" rows="3" ${canEdit ? '' : 'disabled'}>${esc(org[k] || '')}</textarea>`
          : `<input class="oc-input" id="oc-${k}" type="${type}" value="${escAttr(org[k] || '')}" autocomplete="off" ${canEdit ? '' : 'disabled'}>`}
      </label>`).join('')}
    ${canEdit
      ? '<button class="btn-full oc-save" onclick="saveOcProfile()">Save changes</button>'
      : '<div class="oc-note">You can see this organization but not edit it. Editing needs the “manage members” permission.</div>'}
    <div class="oc-note">The name is what students see. The slug is fixed once created — it is half of the organization’s address and changing it would break every link to it.</div>`;
}

async function saveOcProfile() {
  const patch = {};
  OC_FIELDS.forEach(([k]) => {
    const el = document.getElementById('oc-' + k);
    if (el) patch[k] = el.value.trim() || null;
  });
  if (!patch.name) { toast('An organization needs a name'); return; }

  const before = _orgCtx.orgs.get(_ocOrgId);
  const { error } = await supabaseClient.from('organizations').update(patch).eq('id', _ocOrgId);
  if (error) {
    // RLS refusing here is the system working: the client mirror said yes, the database is the
    // one that decides. Say so plainly rather than showing a raw Postgres string.
    toast(error.code === '42501' ? 'You do not have permission to edit this organization' : 'Could not save: ' + error.message);
    console.error('[saveOcProfile]', error);
    return;
  }
  logEvent('org_profile_updated', { targetType: 'organization', targetId: _ocOrgId,
                                    targetLabel: patch.name, school: before?.school,
                                    before: { name: before?.name }, after: { name: patch.name } });
  toast('✓ Saved');
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
  const row = m => `
    <div class="oc-member">
      <span class="oc-member-who">${esc(m.user_id ? (names[m.user_id] || 'Unknown student') : (m.pending_email + ' (invited)'))}</span>
      <span class="oc-member-role">${esc(m.title || m.role)}</span>
      ${m.status === 'pending'
        ? `<button class="org-btn" onclick="ocApprove(${m.id})">Approve</button>`
        : ''}
      <button class="org-btn org-btn-warn" onclick="ocRemove(${m.id})">Remove</button>
    </div>`;

  body.innerHTML =
    (pending.length ? `<div class="oc-subhead">Requests to join (${pending.length})</div>` + pending.map(row).join('') : '') +
    `<div class="oc-subhead">Members (${active.length})</div>` +
    (active.length ? active.map(row).join('') : '<div class="oc-note">No members yet.</div>') +
    `<div class="oc-note">Adding officers and changing permissions needs the \u201Cmanage admins\u201D permission, and is done from the admin page for now. Removing someone keeps a record that they served \u2014 they can be restored from the admin page.</div>`;
}

async function ocApprove(membershipId) {
  const { error } = await supabaseClient.from('org_memberships')
    .update({ status: 'active' }).eq('id', membershipId);
  if (error) { toast('Could not approve: ' + error.message); console.error('[ocApprove]', error); return; }
  logEvent('org_member_approved', { targetType: 'membership', targetId: membershipId });
  toast('✓ Approved');
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
  toast('✓ Removed');
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
  body.innerHTML = '<div class="oc-note">Loading posts…</div>';

  const { data: posts, error } = await supabaseClient
    .from('org_posts')
    .select('id, type, title, body, is_pinned, is_urgent, members_only, status, poll_closes_at, created_at')
    .eq('org_id', _ocOrgId)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) { body.innerHTML = '<div class="oc-note">Could not load posts.</div>'; console.error('[renderOcPosts]', error); return; }

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

  body.innerHTML = ocComposerHTML() + (_ocPosts.length
    ? _ocPosts.map(ocPostCardHTML).join('')
    : '<div class="oc-note">Nothing posted yet. An announcement is the quickest way to start.</div>');
}

function ocComposerHTML() {
  return `
    <div class="oc-composer">
      <div class="oc-type-row">
        <button class="oc-type active" id="oc-t-announcement" onclick="ocSetType('announcement')">Announcement</button>
        <button class="oc-type" id="oc-t-poll" onclick="ocSetType('poll')">Poll</button>
      </div>
      <input class="oc-input" id="ocTitle" placeholder="Title" autocomplete="off">
      <textarea class="oc-input" id="ocBodyText" rows="3" placeholder="Say more (optional)"></textarea>
      <div id="ocPollFields" class="oc-poll-fields" hidden>
        <input class="oc-input" id="ocOpt1" placeholder="Option 1" autocomplete="off">
        <input class="oc-input" id="ocOpt2" placeholder="Option 2" autocomplete="off">
        <input class="oc-input" id="ocOpt3" placeholder="Option 3 (optional)" autocomplete="off">
        <input class="oc-input" id="ocOpt4" placeholder="Option 4 (optional)" autocomplete="off">
        <div class="oc-note">Members see the results once they have voted. Early results skew later votes, so the tally stays hidden until someone has committed to an answer.</div>
      </div>
      <div class="oc-toggle-row">
        <label class="oc-toggle"><input type="checkbox" id="ocPinned"> Pin to top</label>
        <label class="oc-toggle"><input type="checkbox" id="ocMembersOnly"> Members only</label>
        <label class="oc-toggle"><input type="checkbox" id="ocUrgent"> Mark urgent</label>
      </div>
      <div class="oc-note">Pinning replaces whatever is currently pinned — one per organization, so the pin keeps meaning something.
        “Urgent” shows a red marker to students who open the app; it does <strong>not</strong> email or notify anyone yet.</div>
      <button class="btn-full oc-save" onclick="ocCreatePost()">Post</button>
    </div>`;
}

let _ocType = 'announcement';
function ocSetType(t) {
  _ocType = t;
  document.getElementById('oc-t-announcement').classList.toggle('active', t === 'announcement');
  document.getElementById('oc-t-poll').classList.toggle('active', t === 'poll');
  document.getElementById('ocPollFields').hidden = (t !== 'poll');
}

function ocPostCardHTML(x) {
  const p = x.post;
  const canManage = orgCanAct('post', _ocOrgId);
  // The tally is shown only when this browser is actually allowed to have it — you voted, or
  // you hold analytics. It mirrors the RLS rather than deciding anything: if the mirror said
  // yes and the database said no, `votes` would simply be empty and the bars would read zero.
  const canSeeResults = !!x.myVote || orgCanAct('view_analytics', _ocOrgId);
  const total = x.votes.length;

  const poll = p.type !== 'poll' ? '' : `
    <div class="oc-poll">
      ${x.options.map(o => {
        const n = x.votes.filter(v => v.option_id === o.id).length;
        const pct = total ? Math.round(n / total * 100) : 0;
        const mine = x.myVote && x.myVote.option_id === o.id;
        return canSeeResults
          ? `<div class="oc-opt-result${mine ? ' mine' : ''}">
               <div class="oc-opt-bar" style="width:${pct}%"></div>
               <span class="oc-opt-label">${esc(o.label)}</span>
               <span class="oc-opt-count">${n}</span>
             </div>`
          : `<button class="oc-opt-vote" onclick="ocVote(${p.id}, ${o.id})">${esc(o.label)}</button>`;
      }).join('')}
      <div class="oc-note">${canSeeResults
        ? `${total} vote${total === 1 ? '' : 's'}${x.myVote ? ' · you voted' : ''}`
        : 'Vote to see the results.'}</div>
    </div>`;

  return `
    <div class="oc-post${p.is_urgent ? ' oc-post-urgent' : ''}">
      <div class="oc-post-head">
        ${p.is_pinned ? '<span class="oc-chip oc-chip-pin">Pinned</span>' : ''}
        ${p.is_urgent ? '<span class="oc-chip oc-chip-urgent">Urgent</span>' : ''}
        ${p.members_only ? '<span class="oc-chip">Members only</span>' : ''}
        ${p.status !== 'published' ? `<span class="oc-chip">${esc(p.status)}</span>` : ''}
        <span class="oc-post-date">${fmtDate(p.created_at)}</span>
      </div>
      <div class="oc-post-title">${esc(p.title)}</div>
      ${p.body ? `<div class="oc-post-body">${esc(p.body)}</div>` : ''}
      ${poll}
      ${canManage ? `<div class="oc-post-actions">
        <button class="org-btn" onclick="ocTogglePin(${p.id}, ${!p.is_pinned})">${p.is_pinned ? 'Unpin' : 'Pin'}</button>
        <button class="org-btn org-btn-warn" onclick="ocDeletePost(${p.id})">Delete</button>
      </div>` : ''}
    </div>`;
}

async function ocCreatePost() {
  const title = document.getElementById('ocTitle').value.trim();
  if (!title) { toast('A post needs a title'); return; }

  const opts = _ocType === 'poll'
    ? [1,2,3,4].map(i => document.getElementById('ocOpt' + i).value.trim()).filter(Boolean)
    : [];
  if (_ocType === 'poll' && opts.length < 2) { toast('A poll needs at least two options'); return; }

  const { data: { user } } = await supabaseClient.auth.getUser();
  const wantPin = document.getElementById('ocPinned').checked;

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
    created_by: user?.id || null,
  }).select('id').single();

  if (error) { toast('Could not post: ' + error.message); console.error('[ocCreatePost]', error); return; }

  if (opts.length) {
    const { error: oe } = await supabaseClient.from('poll_options')
      .insert(opts.map((label, i) => ({ post_id: post.id, label, position: i })));
    // A poll with no options is worse than no poll: it renders as an unanswerable question.
    // Removing the post is the honest recovery, since the options insert is the second half
    // of one action and Supabase gives us no transaction across two calls.
    if (oe) {
      await supabaseClient.from('org_posts').delete().eq('id', post.id);
      toast('Could not save the poll options — nothing was posted');
      console.error('[ocCreatePost options]', oe);
      return;
    }
  }

  logEvent('org_post_created', { targetType: 'organization', targetId: _ocOrgId, targetLabel: title,
                                 school: _orgCtx.orgs.get(_ocOrgId)?.school, after: { type: _ocType } });
  toast('✓ Posted');
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

async function ocDeletePost(postId) {
  if (!confirm('Delete this post? Any votes on it go with it.')) return;
  const { error } = await supabaseClient.from('org_posts').delete().eq('id', postId);
  if (error) { toast('Could not delete: ' + error.message); console.error('[ocDeletePost]', error); return; }
  logEvent('org_post_deleted', { targetType: 'organization', targetId: _ocOrgId });
  toast('✓ Deleted');
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
    const path = `${user.id}/orglogo-${_ocOrgId}-${Date.now()}.jpg`;
    const { error: ue } = await supabaseClient.storage
      .from('listing-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (ue) throw ue;
    const { data: pub } = supabaseClient.storage.from('listing-photos').getPublicUrl(path);

    const { error } = await supabaseClient.from('organizations')
      .update({ logo_url: pub.publicUrl }).eq('id', _ocOrgId);
    if (error) throw error;

    toast('✓ Logo updated');
    await loadOrgContext(true);
    renderOrgConsole();
  } catch (e) {
    toast('Could not upload: ' + (e.message || e));
    console.error('[ocPickLogo]', e);
  }
}
