// ============================================================
// js/orgdir.js — the student-facing organization directory
// ============================================================
//
// Phase 1 of docs/nestrel-engagement-build.md. Until this file, every surface built on the
// org hierarchy faced officers and admins: the tree, the console, the roster. A student
// could not see that organizations existed at all.
//
// SEPARATE FROM js/orgs.js ON PURPOSE. That file is the admin tab and the officer console —
// two areas already, in 56K. This is a third, it shares no state with either, and keeping it
// apart is the same reasoning as the original split: a bug in the student directory must not
// be able to empty an officer's console.
//
// Plain script, not a module. Every function here stays global because the markup calls it
// from inline onclick handlers.
//
// WHAT THIS FILE READS, AND WHY IT IS TWO VIEWS RATHER THAN TWO TABLES
// org_follows is own-rows-only under RLS, so `count(*)` from the browser returns 1 or 0 —
// your own follow. org_memberships is invisible to a non-member, so a roster query returns
// nothing. Neither number can be assembled client-side, and neither should be: the point is
// to publish the FACT (how many follow, who runs it) without publishing the rows behind it.
// sql/2026-09-06_org_public_views.sql does that with two views that read past RLS and carry
// no identifying column. See that file's header before changing either query here.


// The directory, as loaded. Empty array and "never loaded" are different states; null means
// the second, and it is what tells the renderer to fetch rather than to draw nothing.
let _dirOrgs    = null;
// Organization ids this student follows. A Set because the only questions asked of it are
// "is this one in it" and "how many", both on every card of every repaint.
let _dirFollows = new Set();
let _dirQuery   = '';
let _dirType    = 'all';


// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------
// Two reads, in parallel. The directory view is school-scoped in the client, the same way
// every other feed in this project is (`l.school === eu.school`) — see the view's header for
// why the rule lives here rather than inside it.
async function loadOrgDirectory() {
  const eu = getEffectiveUser();
  if (!eu) return false;

  let q = supabaseClient.from('org_directory')
    .select('id, school, parent_id, type, name, slug, description, logo_url, is_verified, parent_name, grandparent_name, follower_count');
  if (eu.school) q = q.eq('school', eu.school);

  const [dirRes, folRes] = await Promise.all([
    q.order('name'),
    supabaseClient.from('org_follows').select('org_id'),
  ]);

  // A failed query and an empty directory are different things, and rendering them the same
  // way is the bug that cost a day on 2026-09-05: a school administrator was told they were
  // an officer of nothing because a request had failed. Say which one happened.
  if (dirRes.error) {
    console.error('[loadOrgDirectory] directory load failed:', dirRes.error.message);
    return dirRes.error.message;
  }
  if (folRes.error) {
    // Not fatal. The directory is still worth showing; the follow buttons just will not know
    // their state yet, so they are drawn as "Follow" and correct themselves on next load.
    console.error('[loadOrgDirectory] follows load failed:', folRes.error.message);
  }

  _dirOrgs    = dirRes.data || [];
  _dirFollows = new Set((folRes.data || []).map(f => f.org_id));
  return true;
}


// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------
function orgDirGo() {
  showPage('orgs');
  renderOrgDirectory();
}

async function renderOrgDirectory() {
  const host = document.getElementById('orgDirList');
  if (!host) return;

  if (_dirOrgs === null) {
    host.innerHTML = '<div class="dir-empty">Loading organizations…</div>';
    const ok = await loadOrgDirectory();
    if (ok !== true) {
      host.innerHTML = '<div class="dir-empty"><strong>Could not load organizations.</strong><br>'
        + esc(typeof ok === 'string' ? ok : 'You may need to sign in again.') + '</div>';
      return;
    }
  }

  const q    = _dirQuery.trim().toLowerCase();
  const list = _dirOrgs.filter(o =>
    (_dirType === 'all' || o.type === _dirType) &&
    (!q || o.name.toLowerCase().includes(q)
        || (o.description || '').toLowerCase().includes(q)
        || (o.parent_name  || '').toLowerCase().includes(q)));

  // The subtitle is updated BEFORE the early returns below, not after. Written the other
  // way round it stays on "Loading…" forever for exactly the two cases where the student
  // most needs to be told what happened.
  _dirUpdateCount(list.length);

  // Three different empty states, because they mean three different things and one message
  // for all of them sends the reader looking in the wrong place.
  if (!_dirOrgs.length) {
    host.innerHTML = '<div class="dir-empty"><strong>No organizations yet.</strong><br>'
      + 'Nothing has been created for your school. This is what the page looks like on day one.</div>';
    return;
  }
  if (!list.length) {
    host.innerHTML = '<div class="dir-empty"><strong>Nothing matches that.</strong><br>'
      + 'Try a shorter search, or clear the filter.</div>';
    return;
  }

  host.innerHTML = list.map(_dirCardHtml).join('');
}

function _dirUpdateCount(n) {
  const el = document.getElementById('orgDirCount');
  if (!el) return;
  // Says how many are SHOWING, and when a filter is hiding some, how many there are in all.
  // A bare "2 organizations" while a search is active reads as though the school has two.
  const total = (_dirOrgs || []).length;
  el.textContent = n === total
    ? (n === 1 ? '1 organization' : n + ' organizations')
    : `${n} of ${total} organizations`;
}

function _dirCardHtml(o) {
  const following = _dirFollows.has(o.id);

  // Caldwell University > Student Life > Chess Club. Built from two columns rather than a
  // recursive walk, because the hierarchy is three deep. Null at the root, so a school shows
  // no crumb at all rather than an empty separator.
  const crumbs = [o.grandparent_name, o.parent_name].filter(Boolean);
  const crumb  = crumbs.length
    ? `<div class="dir-crumb">${crumbs.map(c => esc(c)).join(' <span class="dir-sep">›</span> ')}</div>`
    : '';

  // An org with no logo gets its initial on a tinted square, the same idea as a student
  // avatar. A broken image is worse than no image.
  const logo = o.logo_url
    ? `<img class="dir-logo" src="${escAttr(o.logo_url)}" alt="" loading="lazy">`
    : `<div class="dir-logo dir-logo-none">${esc((o.name || '?').charAt(0).toUpperCase())}</div>`;

  const count = o.follower_count === 1 ? '1 follower' : `${o.follower_count || 0} followers`;

  return `
    <article class="dir-card">
      ${logo}
      <div class="dir-body">
        ${crumb}
        <h3 class="dir-name">${esc(o.name)}${o.is_verified ? '<span class="dir-verified" title="Verified by the university">✓</span>' : ''}</h3>
        ${o.description ? `<p class="dir-desc">${esc(o.description)}</p>` : ''}
        <div class="dir-meta"><span class="dir-type">${esc(o.type)}</span><span class="dir-dot">·</span><span class="dir-count" id="dir-count-${o.id}">${count}</span></div>
      </div>
      <button class="dir-follow${following ? ' is-following' : ''}"
              id="dir-follow-${o.id}"
              onclick="orgDirToggleFollow(${o.id})">${following ? 'Following' : 'Follow'}</button>
    </article>`;
}


// ------------------------------------------------------------
// Filters
// ------------------------------------------------------------
function orgDirSearch(value) { _dirQuery = value || ''; renderOrgDirectory(); }

function orgDirSetType(type, btn) {
  _dirType = type;
  document.querySelectorAll('.dir-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderOrgDirectory();
}


// ------------------------------------------------------------
// Follow
// ------------------------------------------------------------
// Optimistic: the button changes immediately and is put back if the write fails. Following
// is the lightest commitment in the product and a spinner on it would cost more than it
// buys — but "optimistic" means the revert has to actually work, so the failure path below
// restores both the Set and the count it had before.
async function orgDirToggleFollow(orgId) {
  const eu = getEffectiveUser();
  if (!eu) { toast('Sign in to follow organizations'); return; }

  const org  = (_dirOrgs || []).find(o => o.id === orgId);
  const was  = _dirFollows.has(orgId);
  const btn  = document.getElementById('dir-follow-' + orgId);
  const cnt  = document.getElementById('dir-count-' + orgId);

  // Paint first.
  if (was) _dirFollows.delete(orgId); else _dirFollows.add(orgId);
  if (org) org.follower_count = Math.max(0, (org.follower_count || 0) + (was ? -1 : 1));
  _dirPaintFollow(btn, cnt, org, !was);

  const { error } = was
    ? await supabaseClient.from('org_follows').delete().eq('org_id', orgId).eq('user_id', eu.id)
    : await supabaseClient.from('org_follows').insert({ org_id: orgId, user_id: eu.id });

  // 23505 is unique_violation: you already followed this, in another tab or on another
  // device. The database is right and the button was right — there is nothing to tell the
  // student and nothing to undo. org_follows has no upsert path because its primary key IS
  // the pair, so this is the shape "follow twice" takes, and it is a success, not an error.
  if (error && error.code !== '23505') {
    if (was) _dirFollows.add(orgId); else _dirFollows.delete(orgId);
    if (org) org.follower_count = Math.max(0, (org.follower_count || 0) + (was ? 1 : -1));
    _dirPaintFollow(btn, cnt, org, was);
    toast('Could not ' + (was ? 'unfollow' : 'follow') + ': ' + error.message);
    console.error('[orgDirToggleFollow]', error);
  }
}

function _dirPaintFollow(btn, cnt, org, following) {
  if (btn) {
    btn.textContent = following ? 'Following' : 'Follow';
    btn.classList.toggle('is-following', following);
  }
  if (cnt && org) {
    cnt.textContent = org.follower_count === 1 ? '1 follower' : `${org.follower_count || 0} followers`;
  }
}


// Called after signing in or out. The directory is per-student — the follow state is theirs
// — so a stale cache would show the previous person's buttons.
function clearOrgDirectory() { _dirOrgs = null; _dirFollows = new Set(); _dirQuery = ''; _dirType = 'all'; }
