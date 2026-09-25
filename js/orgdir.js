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

  // The lit chip is DERIVED from _dirType on every render, the loading and empty states
  // included. It used to be set by the click handler, so anything that reset the filter without
  // a click — clearOrgDirectory() on sign-out — left the old tab lit over an unfiltered list.
  document.querySelectorAll('[data-dirtype]').forEach(b => {
    const on = b.getAttribute('data-dirtype') === _dirType;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  // Cleared up front as well as painted below: the strip is DOM, and clearOrgDirectory() only
  // resets variables, so after a sign-out the previous student's follows would otherwise sit
  // there through a failed load.
  _dirPaintFollowing();

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
  _dirPaintFollowing();

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

  const logo = _dirLogoHTML(o, 'dir-logo');

  const count = o.follower_count === 1 ? '1 follower' : `${o.follower_count || 0} followers`;

  return `
    <article class="dir-card" onclick="orgPageOpen(${o.id})">
      ${logo}
      <div class="dir-body">
        ${crumb}
        <h3 class="dir-name">${esc(o.name)}${o.is_verified ? '<span class="dir-verified" title="Verified by the university">' + icon('check',11) + '</span>' : ''}</h3>
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

function orgDirSetType(type) {
  _dirType = type;
  renderOrgDirectory();   // which chip is lit is decided there, from _dirType
}

// An org with no logo gets its initial on a tinted square, like a student avatar. The tint comes
// from the id, so a club keeps the same colour everywhere it appears and neighbouring rows
// usually differ. A broken image is worse than no image.
function _dirLogoHTML(o, cls) {
  return o.logo_url
    ? `<img class="${cls}" src="${escAttr(o.logo_url)}" alt="" loading="lazy">`
    : `<div class="${cls} dir-logo-none" data-tint="${((Number(o.id) || 0) % 6) + 1}">${esc((o.name || '?').charAt(0).toUpperCase())}</div>`;
}

// The clubs you follow, as tiles above the list. Only on the unfiltered directory: while a
// search or a type filter is on, the list IS the answer, and a strip of other clubs above it
// would be noise about a question the student is not asking.
function _dirPaintFollowing() {
  const host = document.getElementById('orgDirFollowing');
  if (!host) return;
  const mine = (_dirOrgs || []).filter(o => _dirFollows.has(o.id));
  if (!mine.length || _dirQuery.trim() || _dirType !== 'all') { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="dir-following">
      <div class="dir-fol-lab">Following · ${mine.length}</div>
      <div class="dir-fol-row">${mine.map(o => `
        <button class="dir-fol" onclick="orgPageOpen(${Number(o.id)})">
          ${_dirLogoHTML(o, 'dir-fol-logo')}
          <span class="dir-fol-name">${esc(o.name)}</span>
        </button>`).join('')}</div>
    </div>`;
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
  // Before the early return: the strip reads _dirFollows, not org, and runs on the rollback
  // path too, so a failed follow takes its tile back out.
  _dirPaintFollowing();
  if (!org) return;
  const txt = org.follower_count === 1 ? '1 follower' : `${org.follower_count || 0} followers`;
  document.querySelectorAll(`[data-count="${orgId}"]`).forEach(el => { el.textContent = txt; });
  // The club page shows the bare number in its stats row, under a Followers label.
  document.querySelectorAll(`[data-count-n="${orgId}"]`).forEach(el => { el.textContent = org.follower_count || 0; });
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
let _opPosts = [];      // shaped like Home's club posts (feed.js), so feedNewsCardHTML draws them
let _opOfficers = [];
let _opTab = null;      // 'upcoming' | 'posts' | 'past'
let _opPreview = false; // opened from the console's "View as student"

// preview: opened by an officer from their console. The page is the same page — only a bar across
// the top says so and leads back, instead of "All clubs".
async function orgPageOpen(orgId, preview = false) {
  // Remembered so a refresh comes back HERE. showPage() stores 'org' as the last page, but
  // the page renders one specific organization and the markup is an empty shell without it —
  // the same shape as the console, which stores its org id for the same reason.
  saveUiState('orgPage', orgId);
  if (!_opOrg || _opOrg.id !== orgId) _opTab = null;
  _opPreview = !!preview;
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
      .select('id, org_id, type, title, body, is_pinned, is_urgent, members_only, poll_closes_at, created_at')
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
  // Drafts never belong on the student page. RLS already hides them from students, but an officer
  // previewing their own club can read their drafts — and "View as student" must show what a
  // student sees, not what the officer is allowed to see.
  _opEvents = (evs.data || []).filter(e => e.status !== 'draft');

  // Polls, so they can be answered here exactly as on Home. The same two tables Home reads;
  // RLS decides whose votes come back (your own, or everyone's once you have voted).
  const rows = posts.data || [];
  const pollIds = rows.filter(p => p.type === 'poll').map(p => p.id);
  let options = [], votes = [];
  if (pollIds.length) {
    const [o, v] = await Promise.all([
      supabaseClient.from('poll_options').select('id, post_id, label, position').in('post_id', pollIds).order('position'),
      supabaseClient.from('poll_votes').select('post_id, option_id, user_id').in('post_id', pollIds),
    ]);
    options = o.data || []; votes = v.data || [];
  }
  _opPosts = rows.map(p => ({
    key: 'op' + p.id, kind: 'club', id: p.id, org: _opOrg,
    title: p.title, body: p.body, at: p.created_at, pinned: p.is_pinned, urgent: p.is_urgent,
    membersOnly: p.members_only, isPoll: p.type === 'poll', closesAt: p.poll_closes_at,
    options: options.filter(o => o.post_id === p.id),
    votes: votes.filter(v => v.post_id === p.id),
  }));
  // feed.js decides "is this my vote" from _feedMe, which Home sets when it loads. Someone who
  // came straight here after a refresh may not have been through Home yet.
  if (typeof _feedMe !== 'undefined' && !_feedMe) _feedMe = getEffectiveUser()?.id || null;

  // The follow set is loaded by the directory. Someone arriving here from an event card may
  // never have opened the directory, so it is fetched rather than assumed. The org context tells
  // us whether this student runs the club (cached after the first load).
  await Promise.all([orgPageLoadFollow(orgId), typeof loadOrgContext === 'function' ? loadOrgContext() : null]);
  orgPagePaint();
}

async function orgPageLoadFollow(orgId) {
  const eu = getEffectiveUser();
  if (!eu?.id) return;
  const { data } = await supabaseClient.from('org_follows')
    .select('org_id').eq('user_id', eu.id).eq('org_id', orgId).maybeSingle();
  if (data) _dirFollows.add(orgId); else _dirFollows.delete(orgId);
}

// The top of a club's page: the cover in the club's tint, its logo, name and counts, Follow, what
// it is about and how to reach it. ONE function for the page and for the console's previews
// (Overview and the Club page editor), so what an officer sees while editing is what students get.
//   opt.preview   draw Follow as a picture of the button, not a working one
//   opt.upcoming  how many events are coming up (the page counts them; the console passes it in)
//   opt.following / opt.manage   the student's own state on the real page
function orgHeroHTML(o, opt = {}) {
  const id = Number(o.id) || 0;
  const crumbs = [o.grandparent_name, o.parent_name].filter(Boolean);
  const followers = Number(o.follower_count) || 0;
  // The website goes through safeUrl(). escAttr() stops a value breaking OUT of href="…", but
  // javascript:… needs no breaking out — it is a well-formed href that runs when clicked. The
  // website is typed by club officers, who are students, into a link every visitor is invited
  // to click; the database takes direct writes, so the check has to live where the link is built.
  const site = safeUrl(o.website);
  const ig = o.instagram ? String(o.instagram).replace(/^@/, '').trim() : '';
  // Contact as a row of small buttons under the bio — the way Instagram and Linktree put links
  // under a profile — rather than a table of labels. Only the ones that exist are drawn.
  const links = [
    o.contact_email ? `<a class="op-link" href="mailto:${escAttr(o.contact_email)}">${icon('send', 14)}<span>Email</span></a>` : '',
    site ? `<a class="op-link" href="${escAttr(site)}" target="_blank" rel="noopener noreferrer">${icon('monitor', 14)}<span>${esc(new URL(site).host.replace(/^www\./, ''))}</span></a>` : '',
    ig ? `<a class="op-link" href="https://instagram.com/${encodeURIComponent(ig)}" target="_blank" rel="noopener noreferrer">${icon('image', 14)}<span>@${esc(ig)}</span></a>` : '',
  ].join('');
  const counts = [
    `<span data-count="${id}">${followers === 1 ? '1 follower' : `${followers} followers`}</span>`,
    opt.upcoming ? `${opt.upcoming} upcoming` : '',
  ].filter(Boolean).join(' · ');
  const follow = opt.preview
    ? `<span class="dir-follow op-follow is-preview" aria-hidden="true">Follow</span>`
    : `<button class="dir-follow op-follow${opt.following ? ' is-following' : ''}" data-follow="${id}"
         onclick="orgDirToggleFollow(${id})">${_dirFollowLabel(opt.following)}</button>`;
  return `
    <div class="op-hero" data-tint="${(id % 6) + 1}">
      <div class="op-cover" aria-hidden="true"></div>
      <header class="op-head">
        ${_dirLogoHTML(o, 'op-logo')}
        <div class="op-head-text">
          ${crumbs.length ? `<div class="dir-crumb">${crumbs.map(esc).join(' <span class="dir-sep">›</span> ')}</div>` : ''}
          <h1 class="op-name">${esc(o.name || 'Your club')}${
            o.is_verified ? `<span class="dir-verified" title="Verified by the university">${icon('check', 11)}</span>` : ''}</h1>
          <div class="op-meta"><span class="op-type">${esc(o.type || '')}</span>${o.type ? ' · ' : ''}${counts}</div>
        </div>
      </header>
      <div class="op-acts">
        ${follow}
        ${opt.manage ? `<button class="org-btn op-manage" onclick="orgConsoleOpen(${id})">${icon('pencil', 14)} Manage club</button>` : ''}
      </div>
      ${(o.description || '').trim() ? `<p class="op-desc">${esc(o.description)}</p>`
        : opt.preview ? '<p class="op-desc op-desc-empty">No description yet.</p>' : ''}
      ${links ? `<div class="op-links">${links}</div>` : ''}
    </div>`;
}

function orgPagePaint() {
  const o = _opOrg;
  const following = _dirFollows.has(o.id);
  const upcoming = _opEvents.filter(e => e.is_browsable)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = _opEvents.filter(e => e.has_ended && e.status === 'published');
  // Officers of this club get a way into the console from their club's own page — the other half
  // of "View as student". Not in preview, where the bar at the top already leads back.
  const manage = !_opPreview && typeof orgMemberships === 'function'
    && orgMemberships().some(m => m.role === 'officer' && m.org_id === o.id);

  // Three tabs, in the order a student asks: what's coming, what they said, what already happened.
  // Opens on the first one with something in it, so a club with no events opens on its posts.
  const tabs = [['upcoming', 'Upcoming', upcoming.length], ['posts', 'Posts', _opPosts.length], ['past', 'Past', past.length]];
  if (!_opTab || !tabs.some(t => t[0] === _opTab)) _opTab = (tabs.find(t => t[2]) || tabs[0])[0];

  const back = document.getElementById('opBack');
  if (back) back.hidden = _opPreview;

  const body = document.getElementById('orgPageBody');
  // The club's own tint — the same one its tile has in the directory — inherited from here by
  // the cover band, the logo tile and every date block on the page.
  body.setAttribute('data-tint', String(((Number(o.id) || 0) % 6) + 1));
  body.innerHTML = `
    ${_opPreview ? `
      <div class="op-preview-bar">
        ${icon('eye', 16)}<span><b>Student view.</b> This is your club page exactly as students see it.</span>
        <button class="op-preview-back" onclick="orgPageBackToConsole()">Back to console</button>
      </div>` : ''}
    <div class="op-layout">
      <div class="op-side">${orgHeroHTML(o, { following, upcoming: upcoming.length, manage })}</div>
      ${_opOfficers.length ? `<div class="op-side2">${orgOfficersHTML(_opOfficers.map(x =>
        ({ name: `${x.first_name || ''} ${x.last_name || ''}`.trim(), title: x.title })))}</div>` : ''}
      <div class="op-main">
        <div class="op-tabs" role="tablist">${tabs.map(([k, label, n]) => `
          <button class="op-tab${_opTab === k ? ' is-on' : ''}" role="tab" aria-selected="${_opTab === k}"
                  onclick="orgPageTab('${k}')">${label}${n ? `<span class="op-tab-n">${n}</span>` : ''}</button>`).join('')}</div>
        <div id="opTabBody">${orgPageTabHTML(upcoming, past)}</div>
      </div>
    </div>`;
}

// Who runs it: [{ name, title }]. Shared with the console's Members section, which shows the
// officer what students see of their roster.
function orgOfficersHTML(list) {
  return `
    <section class="op-sec op-people">
      <h2 class="op-sec-title">Who runs it</h2>
      <div class="op-officers">${list.map(x => {
        const ini = (x.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
        return `
        <div class="op-officer">
          <span class="op-officer-av" aria-hidden="true">${esc(ini)}</span>
          <span class="op-officer-text">
            <span class="op-officer-name">${esc(x.name)}</span>
            ${x.title ? `<span class="op-officer-role">${esc(x.title)}</span>` : ''}
          </span>
        </div>`; }).join('')}</div>
    </section>`;
}

function orgPageTab(k) { _opTab = k; orgPagePaint(); }

function orgPageTabHTML(upcoming, past) {
  if (_opTab === 'posts') {
    // Home's own card (feed.js), with its vote buttons pointed at this page's handlers — so a
    // post looks the same wherever a student meets it, and a poll can be answered here too.
    // Only handler openings (onclick, a quote, feedVote / feedPollToggle / feedRevote) are
    // rewritten: text is escaped before it gets here, so no title can contain a quote and match.
    // (Written with ["] and a function so tests/load-order.js does not read them as handlers.)
    const retarget = h => h.replace(/onclick=["]feed(Vote|PollToggle|Revote)\(/g, (m, fn) => `onclick=${'"'}orgPage${fn}(`);
    return _opPosts.length
      ? `<div class="hn-list op-posts">${_opPosts.map(x => retarget(feedNewsCardHTML(x))).join('')}</div>`
      : '<div class="op-empty">No posts yet. Announcements and polls from this club show up here and on Home.</div>';
  }
  if (_opTab === 'past') {
    return past.length ? `<div class="op-list op-past">${past.map(orgPageEventHTML).join('')}</div>`
      : '<div class="op-empty">Nothing has happened yet — events move here once they are over.</div>';
  }
  return upcoming.length ? `<div class="op-list">${upcoming.map(orgPageEventHTML).join('')}</div>`
    : `<div class="op-empty">Nothing scheduled right now.${_dirFollows.has(_opOrg.id) ? '' : ' Follow the club to see its next event on your Events page.'}</div>`;
}

function orgPageBackToConsole() {
  const id = _opOrg?.id;
  _opPreview = false;
  if (id && typeof orgConsoleOpen === 'function') orgConsoleOpen(id); else goHome();
}

// Voting from the club page — feedVote()'s twin, writing the same row. Home keeps its own copy of
// the post in _feedNews, so both are refreshed: a vote here shows as voted there too.
async function orgPageVote(postId, optionId) {
  const x = _opPosts.find(p => p.id === postId);
  const me = getEffectiveUser()?.id;
  if (!x || !me) { toast('Sign in to vote'); return; }
  if (feedPollClosed(x)) { toast('This poll has closed'); return; }
  const { error } = await supabaseClient.from('poll_votes')
    .upsert({ post_id: postId, option_id: optionId, user_id: me }, { onConflict: 'post_id,user_id' });
  if (error) { toast('Could not record your vote'); console.error('[orgPageVote]', error); return; }
  const { data } = await supabaseClient.from('poll_votes').select('post_id, option_id, user_id').eq('post_id', postId);
  x.votes = data || [{ post_id: postId, option_id: optionId, user_id: me }];
  const home = (typeof _feedNews !== 'undefined' ? _feedNews : []).find(n => n.kind === 'club' && n.id === postId);
  if (home) home.votes = x.votes;
  _feedRevote.delete(postId);
  _feedPollOpen.delete(postId);
  _feedPollJust.add(postId);
  orgPagePaint();
  setTimeout(() => { if (_feedPollJust.delete(postId) && _opOrg) orgPagePaint(); }, 4000);
}
function orgPagePollToggle(id, open) {
  _feedPollJust.delete(id);
  if (open) _feedPollOpen.add(id); else _feedPollOpen.delete(id);
  orgPagePaint();
}
function orgPageRevote(id, open) {
  if (open) _feedRevote.add(id); else _feedRevote.delete(id);
  orgPagePaint();
}

// A compact row, not the big feed card. This page is a summary of an organization; a column of
// full-height posters would bury the description and the contact details under the events.
function orgPageEventHTML(e) {
  const d = new Date(e.starts_at);
  const dow = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const mon = d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  // Time, place and — when registration is open — the headcount, on one line. The date is in
  // the block beside it, so it is not written out a second time.
  const bits = [evTime(e.starts_at), e.location].filter(Boolean).map(esc);
  if (e.registration_open && e.going_count) bits.push(`${Number(e.going_count)} going`);
  // No RSVP button on the row, although the mockup drew one: registering shows the organizers
  // your name and email, and §4.1 wants that said under the button before the tap — which
  // the event's detail view does. The row opens it.
  const mine = _evGoing.has(e.id) ? `<span class="op-going">${icon('check', 12)} You're going</span>` : '';
  return `
    <button class="op-event" onclick="evOpen(${Number(e.id)})">
      <div class="op-date"><span class="op-date-dow">${esc(e.has_ended ? mon : dow)}</span><span class="op-date-day">${d.getDate()}</span></div>
      <div class="op-event-text">
        <div class="op-event-title">${esc(e.title)}</div>
        <div class="op-event-where">${bits.join(' · ')}</div>
        ${mine}
      </div>
      ${icon('chevRight', 16)}
    </button>`;
}
