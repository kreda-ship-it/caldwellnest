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
    <article class="dir-card" onclick="orgPageOpen(${o.id})">
      ${logo}
      <div class="dir-body">
        ${crumb}
        <h3 class="dir-name">${esc(o.name)}${o.is_verified ? '<span class="dir-verified" title="Verified by the university">✓</span>' : ''}</h3>
        ${o.description ? `<p class="dir-desc">${esc(o.description)}</p>` : ''}
        <div class="dir-meta"><span class="dir-type">${esc(o.type)}</span><span class="dir-dot">·</span><span class="dir-count" data-count="${o.id}">${count}</span></div>
      </div>
      <button class="dir-follow${following ? ' is-following' : ''}"
              data-follow="${o.id}"
              onclick="event.stopPropagation();orgDirToggleFollow(${o.id})">${_dirFollowLabel(following)}</button>
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

  // The org row can come from either surface. _dirOrgs is only filled by the DIRECTORY
  // loader, so a student who reached the org page from an event card has it null — and the
  // follower count would silently never update, including on the rollback path.
  const org  = (_dirOrgs || []).find(o => o.id === orgId)
            || (_opOrg && _opOrg.id === orgId ? _opOrg : null);
  const was  = _dirFollows.has(orgId);
  // Attributes, not ids. page-orgs and page-org are BOTH in the document at all times — the
  // router hides pages, it does not remove them — and both render a follow button for the
  // same organization. getElementById returns the first match in document order, which is the
  // directory card, so tapping Follow on the org page repainted a hidden button and left the
  // visible one alone. Duplicate ids are invalid HTML anyway; this paints every instance.

  // Paint first.
  if (was) _dirFollows.delete(orgId); else _dirFollows.add(orgId);
  if (org) org.follower_count = Math.max(0, (org.follower_count || 0) + (was ? -1 : 1));
  _dirPaintFollow(orgId, org, !was);

  // Unfollowing is confirmed by a toast rather than by a dialog. A dialog is friction on the
  // common, deliberate case; the risk is the accidental tap, and the thing that fixes an
  // accidental tap is NOTICING it. Following back is one tap and the button is still there.
  if (was) toast('Unfollowed ' + (org?.name || 'that organization'));

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
    _dirPaintFollow(orgId, org, was);
    toast('Could not ' + (was ? 'unfollow' : 'follow') + ': ' + error.message);
    console.error('[orgDirToggleFollow]', error);
  }
}

// A button labelled only "Following" states a fact and hides an action: nothing on it says
// that tapping unfollows. Two spans, swapped by CSS on hover and focus, so the label becomes
// "Unfollow" exactly when the pointer is on it. Touch has no hover, which is why the toast
// above exists — on a phone the confirmation arrives after the tap rather than before it.
function _dirFollowLabel(following) {
  return following
    ? '<span class="df-is">Following</span><span class="df-do">Unfollow</span>'
    : 'Follow';
}

function _dirPaintFollow(orgId, org, following) {
  document.querySelectorAll(`[data-follow="${orgId}"]`).forEach(btn => {
    btn.innerHTML = _dirFollowLabel(following);
    btn.classList.toggle('is-following', following);
  });
  if (!org) return;
  const txt = org.follower_count === 1 ? '1 follower' : `${org.follower_count || 0} followers`;
  document.querySelectorAll(`[data-count="${orgId}"]`).forEach(el => { el.textContent = txt; });
}


// Called after signing in or out. The directory is per-student — the follow state is theirs
// — so a stale cache would show the previous person's buttons.
function clearOrgDirectory() { _dirOrgs = null; _dirFollows = new Set(); _dirQuery = ''; _dirType = 'all'; }


// ============================================================
// ONE ORGANIZATION
// ============================================================
// The page the directory has been missing since it shipped. Cards were never tappable, so a
// student could see that a club existed and learn nothing else about it — and an event card's
// org row had nowhere to send them either.
//
// Everything here comes from views that are already public: org_directory,
// org_public_officers, visible_events and the org_posts policy. No new permission surface.

let _opOrg = null;
let _opEvents = [];
let _opPosts = [];
let _opOfficers = [];

async function orgPageOpen(orgId) {
  // Remembered so a refresh comes back HERE. showPage() stores 'org' as the last page, but
  // the page renders one specific organization and the markup is an empty shell without it —
  // the same shape as the console, which stores its org id for the same reason.
  saveUiState('orgPage', orgId);
  showPage('org');
  const body = document.getElementById('orgPageBody');
  body.innerHTML = '<div class="op-note">Loading…</div>';

  const [dir, off, evs, posts] = await Promise.all([
    supabaseClient.from('org_directory').select('*').eq('id', orgId).maybeSingle(),
    supabaseClient.from('org_public_officers').select('*').eq('org_id', orgId),
    supabaseClient.from('visible_events')
      .select('id, title, starts_at, location, poster_url, status, has_ended, is_browsable, ' +
              'going_count, seats_left, registration_open')
      .eq('org_id', orgId).order('starts_at', { ascending: false }),
    // members_only posts are filtered by RLS, not by this query. A student who is a member
    // gets them; one who is not never sees the row. Filtering here as well would only hide
    // rows from the people entitled to them.
    supabaseClient.from('org_posts')
      .select('id, type, title, body, is_pinned, is_urgent, members_only, created_at')
      .eq('org_id', orgId).eq('status', 'published')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false }).limit(10),
  ]);

  if (dir.error || !dir.data) {
    body.innerHTML = '<div class="op-note">That organization is not available.</div>';
    if (dir.error) console.error('[orgPageOpen]', dir.error);
    return;
  }

  _opOrg = dir.data;
  _opOfficers = off.data || [];
  _opEvents = evs.data || [];
  _opPosts = posts.data || [];

  // The follow set is loaded by the directory. Someone arriving here from an event card may
  // never have opened the directory, so it is fetched rather than assumed.
  await orgPageLoadFollow(orgId);
  orgPagePaint();
}

async function orgPageLoadFollow(orgId) {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient.from('org_follows')
    .select('org_id').eq('user_id', eu.id).eq('org_id', orgId).maybeSingle();
  if (data) _dirFollows.add(orgId); else _dirFollows.delete(orgId);
}

function orgPagePaint() {
  const o = _opOrg;
  const following = _dirFollows.has(o.id);

  const crumbs = [o.grandparent_name, o.parent_name].filter(Boolean);
  const logo = o.logo_url
    ? `<img class="op-logo" src="${escAttr(o.logo_url)}" alt="">`
    : `<div class="op-logo op-logo-none">${esc((o.name || '?').charAt(0).toUpperCase())}</div>`;

  // Contact rows are only drawn when they exist. An empty "Website —" line tells a student
  // nothing except that the club did not fill in a form.
  const contact = [
    o.contact_email ? `<a href="mailto:${escAttr(o.contact_email)}">${esc(o.contact_email)}</a>` : '',
    o.website ? `<a href="${escAttr(o.website)}" target="_blank" rel="noopener noreferrer">Website</a>` : '',
    o.instagram ? `<a href="https://instagram.com/${escAttr(String(o.instagram).replace(/^@/, ''))}" target="_blank" rel="noopener noreferrer">@${esc(String(o.instagram).replace(/^@/, ''))}</a>` : '',
  ].filter(Boolean);

  const upcoming = _opEvents.filter(e => e.is_browsable)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = _opEvents.filter(e => e.has_ended && e.status === 'published');

  document.getElementById('orgPageBody').innerHTML = `
    <header class="op-head">
      ${logo}
      <div class="op-head-text">
        ${crumbs.length ? `<div class="dir-crumb">${crumbs.map(esc).join(' <span class="dir-sep">›</span> ')}</div>` : ''}
        <h1 class="op-name">${esc(o.name)}${
          o.is_verified ? '<span class="dir-verified" title="Verified by the university">✓</span>' : ''}</h1>
        <div class="op-meta">${esc(o.type)} <span class="dir-dot">·</span>
          <span data-count="${o.id}">${o.follower_count === 1 ? '1 follower' : `${o.follower_count || 0} followers`}</span></div>
      </div>
      <button class="dir-follow${following ? ' is-following' : ''}" data-follow="${o.id}"
              onclick="orgDirToggleFollow(${o.id})">${_dirFollowLabel(following)}</button>
    </header>

    ${o.description ? `<p class="op-desc">${esc(o.description)}</p>` : ''}
    ${contact.length ? `<div class="op-contact">${contact.join('<span class="dir-dot">·</span>')}</div>` : ''}

    ${_opOfficers.length ? `
      <section class="op-sec">
        <h2 class="op-sec-title">Who runs it</h2>
        <div class="op-officers">${_opOfficers.map(x => `
          <div class="op-officer">
            <div class="op-officer-name">${esc(x.first_name || '')} ${esc(x.last_name || '')}</div>
            ${x.title ? `<div class="op-officer-role">${esc(x.title)}</div>` : ''}
          </div>`).join('')}</div>
      </section>` : ''}

    <section class="op-sec">
      <h2 class="op-sec-title">Upcoming</h2>
      ${upcoming.length ? upcoming.map(orgPageEventHTML).join('')
                        : '<div class="op-note">Nothing scheduled right now.</div>'}
    </section>

    ${_opPosts.length ? `
      <section class="op-sec">
        <h2 class="op-sec-title">Announcements</h2>
        ${_opPosts.map(p => `
          <div class="op-post${p.is_urgent ? ' is-urgent' : ''}">
            <div class="op-post-head">
              ${p.is_pinned ? '<span class="oc-chip oc-chip-pin">Pinned</span>' : ''}
              ${p.is_urgent ? '<span class="oc-chip oc-chip-urgent">Urgent</span>' : ''}
              ${p.members_only ? '<span class="oc-chip">Members only</span>' : ''}
              <span class="op-post-date">${esc(fmtDate(p.created_at))}</span>
            </div>
            <div class="op-post-title">${esc(p.title)}</div>
            ${p.body ? `<div class="op-post-body">${esc(p.body)}</div>` : ''}
          </div>`).join('')}
      </section>` : ''}

    ${past.length ? `
      <section class="op-sec">
        <h2 class="op-sec-title">Already happened</h2>
        <div class="op-past">${past.map(orgPageEventHTML).join('')}</div>
      </section>` : ''}`;
}

// A compact row, not the big feed card. This page is a summary of an organization; a column of
// full-height posters would bury the description and the contact details under the events.
function orgPageEventHTML(e) {
  const d = new Date(e.starts_at);
  const when = d.toLocaleString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `
    <button class="op-event" onclick="evOpen(${e.id})">
      <div class="op-event-thumb"${e.poster_url ? '' : ` style="background:${eventGradient(e.id)}"`}>
        ${e.poster_url ? `<img src="${escAttr(e.poster_url)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="op-event-text">
        <div class="op-event-title">${esc(e.title)}</div>
        <div class="op-event-when">${esc(when)}</div>
        <div class="op-event-where">${esc(e.location)}</div>
      </div>
    </button>`;
}
