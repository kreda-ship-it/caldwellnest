// ============================================================
// ADMIN
// The whole admin dashboard: moderation queues, students, reports, appeals, broadcasts, analytics, site editor, NestBot, exports.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ── Admin sidebar collapse ───────────────────────────────────
function toggleAdminSidebar() {
  const sidebar = document.querySelector('.a-sidebar');
  const main = document.querySelector('.a-main');
  const btn = document.getElementById('adminSidebarToggle');
  const isCollapsed = sidebar.classList.toggle('a-collapsed');
  main.style.marginLeft = isCollapsed ? '52px' : '240px';
  btn.textContent = isCollapsed ? '›' : '‹';
  localStorage.setItem('cn_admin_sidebar', isCollapsed ? 'collapsed' : 'open');
}

// ============================================================
// ADMIN — INIT
// ============================================================
function updateAdminLogo() {
  const textEl = document.querySelector('.a-logo-text');
  const subEl  = document.querySelector('.a-logo-sub');
  if (!textEl) return;
  if (!aAdminSchool) {
    textEl.innerHTML = 'Nest<span>rel</span>';
    if (subEl) subEl.textContent = 'Platform Admin';
  } else {
    textEl.textContent = aAdminBrand || aAdminSchool;
    if (subEl) subEl.textContent = 'School Admin';
  }
}

function updateDrillCtx() {
  const ctx = document.getElementById('adminSchoolCtx');
  if (!ctx || aAdminSchool) return; // school admins have a permanent scope indicator, no drill overlay needed
  const active = document.querySelector('.a-section.active');
  const sid = active?.id || '';
  let school = null;
  if      (sid.includes('students')) school = _stuSchoolFilter !== 'all' ? _stuSchoolFilter : null;
  else if (sid.includes('listings')) school = _listingSchoolFilter !== 'all' ? _listingSchoolFilter : null;
  else if (sid.includes('reports'))  school = _reportSchoolFilter !== 'all' ? _reportSchoolFilter : null;
  if (school) {
    const label = _schoolBrandCache[school] || school.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    ctx.textContent = '↳ Viewing: ' + label;
    ctx.style.display = 'block';
  } else {
    ctx.style.display = 'none';
  }
}

async function loadPlatformSettings() {
  const { data, error } = await supabaseClient.from('platform_settings').select('key, value');
  if (error) { console.error('platform_settings load failed:', error.message); return; }
  if (data) data.forEach(r => { DB.settings[r.key] = r.value; });
}

function applyMaintenance() {
  if (DB.settings.maintenance && !adminPreviewMode && currentRole !== 'admin') {
    showPage('maintenance');
    return true;
  }
  return false;
}

async function initAdmin() {
  await loadPlatformSettings();
  await loadListings();   // warm the listings cache so Approvals/Listings/Pinned aren't empty on entry
  await loadAdminBooks(); // warm the book_listings cache so Approvals isn't empty on entry
  updateAdminLogo();
  updateAllAdminBadges();
  buildMultiSchoolStats();
  buildAdminBar();
  buildTypeChart();
  renderAdminDashLog();
  buildPresets();
  buildASettings();
  renderBcastHistory();
  renderBcastTemplates();
  buildAnalytics();
  initAI();
  startAdminRealtimeListeners();
  if (localStorage.getItem('cn_admin_sidebar') === 'collapsed') {
    const sidebar = document.querySelector('.a-sidebar');
    const main = document.querySelector('.a-main');
    const btn = document.getElementById('adminSidebarToggle');
    sidebar.style.transition = 'none';
    sidebar.classList.add('a-collapsed');
    main.style.marginLeft = '52px';
    if (btn) btn.textContent = '›';
    setTimeout(() => sidebar.style.transition = '', 10);
  }
}

// Realtime: any change on a watched table schedules ONE debounced full reload,
// so manual refresh and live updates run the exact same path. Events are '*'
// (INSERT/UPDATE/DELETE) so cross-admin status changes propagate too.
function startAdminRealtimeListeners() {
  stopAdminRealtimeListeners();
  // Tables whose changes really do affect the whole dashboard: queues, counts, charts.
  ['listings', 'book_listings', 'reports', 'appeals', 'profiles'].forEach(tbl => {
    _adminRealtimeChannels.push(
      supabaseClient.channel('adm-' + tbl)
        .on('postgres_changes', { event: '*', schema: 'public', table: tbl }, scheduleAdminReload)
        .subscribe()
    );
  });
  // `messages` is deliberately NOT on the full-reload path. It fires on every chat message
  // any two students send to each other — and a full reload means re-fetching every listing,
  // every book, every poster profile, all the badge counts, the school stats, the charts and
  // the open section. All so the admin can see one number tick up. Refresh just that number,
  // and re-render the Messages table only when it is actually the section on screen.
  _adminRealtimeChannels.push(
    supabaseClient.channel('adm-messages')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, scheduleMessageCountRefresh)
      .subscribe()
  );
}

// Tears down every admin realtime channel + pending timer. Called on re-subscribe and on
// logout — a channel that outlives the session keeps firing as an anonymous client.
function stopAdminRealtimeListeners() {
  _adminRealtimeChannels.forEach(ch => supabaseClient.removeChannel(ch));
  _adminRealtimeChannels = [];
  clearTimeout(_adminReloadTimer);
  clearTimeout(_msgCountTimer);
}

let _adminReloadTimer = null;
function scheduleAdminReload() {
  clearTimeout(_adminReloadTimer);
  _adminReloadTimer = setTimeout(() => adminReload({ reloadCache: true }), 350);
}

// The cheap path for `messages`: one HEAD count query, plus a re-render of the Messages
// section only if the admin is looking at it. Debounced, so a burst of chat costs one query.
let _msgCountTimer = null;
function scheduleMessageCountRefresh() {
  clearTimeout(_msgCountTimer);
  _msgCountTimer = setTimeout(async () => {
    const { count, error } = await supabaseClient.from('messages').select('id', { count: 'exact', head: true });
    if (error) { console.warn('[messages count]', error.message); return; }
    const el = document.getElementById('ds-m');
    if (el) el.textContent = count ?? '—';
    if (document.querySelector('.a-section.active')?.id === 'asec-messages') renderAMessages();
  }, 400);
}

// Re-renders whichever admin section is currently open, from fresh data.
function rerenderActiveAdminSection() {
  const active = document.querySelector('.a-section.active');
  if (!active) return;
  const id = active.id.replace('asec-', '');
  if (typeof _agoMap !== 'undefined' && _agoMap[id]) _agoMap[id]();
}

// Single source of truth for refreshing admin data — used by both the refresh
// button and the realtime listeners so they behave identically.
// Reloads never overlap: the 350ms debounce is shorter than a reload takes, so
// realtime bursts used to start concurrent reloads whose responses could land
// out of order — an older answer overwriting a newer one made rows flicker.
// While one runs, the next request just queues a single trailing re-run.
let _adminReloadRunning = false;
let _adminReloadQueued = false;
async function adminReload({ reloadCache = true } = {}) {
  if (_adminReloadRunning) { _adminReloadQueued = true; return; }
  _adminReloadRunning = true;
  try {
    if (reloadCache) await loadListings();        // reload DB.listings/DB.pending cache (Pattern A fix)
    if (reloadCache) await loadAdminBooks();      // reload DB.adminBooks/DB.pendingBooks cache
    await updateAllAdminBadges();                 // fresh counts
    buildMultiSchoolStats();
    buildAdminBar();
    renderAdminDashLog();
    rerenderActiveAdminSection();                 // re-render the open section from fresh data
  } finally {
    _adminReloadRunning = false;
    if (_adminReloadQueued) { _adminReloadQueued = false; adminReload({ reloadCache: true }); }
  }
}

async function refreshAdmin() {
  const btn = document.getElementById('adminRefreshBtn');
  if (btn) {
    if (btn.dataset.busy) return;               // idempotent — ignore double-clicks while running
    btn.dataset.busy = '1'; btn.disabled = true;
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = '&#8635; Refreshing…';
  }
  try {
    await adminReload({ reloadCache: true });
    toast('✓ Refreshed');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || '&#8635; Refresh'; delete btn.dataset.busy; }
  }
}

async function updateAdminBadges() {
  let stuQ   = supabaseClient.from('profiles').select('id', { count: 'exact', head: true });
  let pendQ  = supabaseClient.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  let liveQ  = supabaseClient.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'approved');
  let pinQ   = supabaseClient.from('listings').select('id', { count: 'exact', head: true }).eq('pinned', true);
  let pendBookQ = supabaseClient.from('book_listings').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (aAdminSchool) {
    stuQ  = stuQ.eq('school', aAdminSchool);
    pendQ = pendQ.eq('school', aAdminSchool);
    liveQ = liveQ.eq('school', aAdminSchool);
    pinQ  = pinQ.eq('school', aAdminSchool);
    // book_listings has no school column yet — school-scoped admins see all pending books for now.
  }
  const [{ count: stuN }, { count: pendN }, { count: liveN }, { count: pinN }, { count: msgN }, { count: pendBookN }] =
    await Promise.all([stuQ, pendQ, liveQ, pinQ,
      supabaseClient.from('messages').select('id', { count: 'exact', head: true }), pendBookQ]);
  const pending = (pendN || 0) + (pendBookN || 0);
  document.getElementById('pendBadge').textContent = pending;
  document.getElementById('pendBadge').style.display = pending ? 'inline' : 'none';
  const bookBadge = document.getElementById('aApprovalBookBadge');
  if (bookBadge) { bookBadge.textContent = ` (${pendBookN || 0})`; bookBadge.style.display = pendBookN ? 'inline' : 'none'; }
  document.getElementById('ds-s').textContent    = stuN  ?? '—';
  document.getElementById('ds-p').textContent    = pending;
  document.getElementById('ds-l').textContent    = liveN ?? '—';
  document.getElementById('ds-pins').textContent = pinN  ?? '—';
  document.getElementById('ds-m').textContent    = msgN  ?? '—';
}

function updateAllAdminBadges() {
  return Promise.all([updateAdminBadges(), updateAppealsBadge(), updateReportsBadge()]);
}

async function buildMultiSchoolStats() {
  const el = document.getElementById('dashMultiSchool');
  if (!el || aAdminSchool) return; // school admins never see this
  el.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-faint);font-size:12px">Loading school stats…</div>';
  const [
    { data: stuRows },
    { data: listRows },
    { data: repRows },
    { data: suspRows }
  ] = await Promise.all([
    supabaseClient.from('profiles').select('school'),
    supabaseClient.from('listings').select('school').eq('status', 'approved'),
    supabaseClient.from('reports').select('listing:listing_id(school)').eq('status', 'open'),
    supabaseClient.from('suspension_history').select('school').eq('action', 'suspended')
  ]);
  // Derive distinct schools from profiles — no separate schools table needed
  const schoolSlugs = [...new Set((stuRows || []).map(r => r.school).filter(Boolean))].sort();
  if (!schoolSlugs.length) { el.innerHTML = ''; return; }
  const schools = schoolSlugs.map(s => ({ slug: s, name: s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }));
  const tally = (rows, key) => {
    const m = {};
    (rows || []).forEach(r => { const v = r[key] ?? r?.listing?.[key]; if (v) m[v] = (m[v] || 0) + 1; });
    return m;
  };
  const stuC  = tally(stuRows,  'school');
  const listC = tally(listRows, 'school');
  const repC  = tally(repRows,  'school');
  const suspC = tally(suspRows, 'school');
  el.innerHTML = `
    <div class="tcard" style="margin-bottom:18px">
      <div class="tcard-head">
        <div class="tcard-title">Schools overview</div>
        <span style="font-size:12px;background:var(--brand-pale);color:var(--brand);padding:2px 10px;border-radius:20px;font-weight:500">${schools.length} school${schools.length !== 1 ? 's' : ''}</span>
      </div>
      <table>
        <thead><tr>
          <th>School</th>
          <th style="text-align:center">Students</th>
          <th style="text-align:center">Live listings</th>
          <th style="text-align:center">Open reports</th>
          <th style="text-align:center">Total suspensions</th>
        </tr></thead>
        <tbody>${schools.map(sc => `
          <tr>
            <td style="font-weight:500">${esc(sc.name)}</td>
            <td style="text-align:center"><span class="school-cell-link" onclick="goToStudentsFiltered('${sc.slug}')">${stuC[sc.slug]  || 0}</span></td>
            <td style="text-align:center"><span class="school-cell-link" onclick="goToListingsFiltered('${sc.slug}')">${listC[sc.slug] || 0}</span></td>
            <td style="text-align:center"><span class="school-cell-link" onclick="goToReportsFiltered('${sc.slug}')">${repC[sc.slug]  || 0}</span></td>
            <td style="text-align:center"><span class="school-cell-link" onclick="goToStudentsFiltered('${sc.slug}','suspended')">${suspC[sc.slug] || 0}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const ATITLES = { dashboard:'Dashboard', approvals:'Listing approvals', listings:'All listings', pinned:'Pinned / Featured', students:'Students', 'student-history':'Student record', messages:'Messages', reports:'Reports', editor:'Site editor', broadcast:'Broadcast', analytics:'Analytics', activity:'Activity log', asettings:'Settings' };
// ago() — the admin section router — is defined ONCE, near _agoMap at the bottom of this file.
// (There used to be a second, earlier definition here. It never ran: two function declarations
// with the same name in one script scope means the LAST one wins for the whole scope, so this
// one was dead code and the `_ago_orig = ago` line next to it captured the later one, not this.)

// ADMIN DASHBOARD
async function buildAdminBar() {
  const el = document.getElementById('aBarChart');
  // Build last-7-days date range (inclusive, local midnight)
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (6 - i)); return d;
  });
  const since = dates[0].toISOString();
  const { data } = await supabaseClient.from('profiles').select('created_at').gte('created_at', since);
  const counts = dates.map(d => {
    const key = d.toDateString();
    return (data || []).filter(r => new Date(r.created_at).toDateString() === key).length;
  });
  const mx = Math.max(...counts, 1);
  if (counts.every(v => v === 0)) {
    el.innerHTML = '<div style="width:100%;text-align:center;color:var(--text-faint);font-size:12px;align-self:center">No signups in the last 7 days</div>';
    return;
  }
  el.innerHTML = counts.map((v, i) => `<div class="bwrap"><div class="bval">${v || ''}</div><div class="bar" style="height:${Math.round((v/mx)*70)}px"></div><div class="blabel">${dayNames[dates[i].getDay()]}</div></div>`).join('');
}
function goToBookApprovals() {
  const btn = [...document.querySelectorAll('.a-nav-item')].find(b => b.getAttribute('onclick')?.includes("'approvals'"));
  ago('approvals', btn || null);
  setApprovalsTab('books');
}

async function buildTypeChart() {
  const el = document.getElementById('aDashTypeChart');
  if (!el) return;
  const [{ data }, { data: bookData }] = await Promise.all([
    supabaseClient.from('listings').select('category').neq('status', 'removed'),
    supabaseClient.from('book_listings').select('id').neq('status', 'removed')
  ]);
  const counts = {};
  (data || []).forEach(r => { const c = r.category || 'other'; counts[c] = (counts[c] || 0) + 1; });
  if (bookData && bookData.length) counts.books = bookData.length;
  if (Object.keys(counts).length === 0) {
    el.innerHTML = '<div style="padding:8px 0;color:var(--text-faint);font-size:12px;text-align:center">No listings yet</div>';
    return;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const mx = Math.max(...sorted.map(e => e[1]), 1);
  el.innerHTML = sorted.map(([cat, n]) => {
    const label = CATEGORY_LABELS[cat] || cat;
    const emoji = CATEGORY_EMOJI[cat] || '📦';
    const clickHandler = cat === 'books' ? 'goToBookApprovals()' : `goToListingsFiltered(null,'${cat}')`;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" title="View ${label} listings" onclick="${clickHandler}">
      <div style="width:22px;text-align:center;font-size:14px">${emoji}</div>
      <div style="width:90px;font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0">${label}</div>
      <div style="flex:1;height:18px;background:var(--bg);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${Math.round((n/mx)*100)}%;background:var(--brand-light);border-radius:4px;transition:width .4s"></div>
      </div>
      <div style="width:22px;text-align:right;font-size:12px;font-weight:600;color:var(--brand)">${n}</div>
    </div>`;
  }).join('');
}

function alItem(a) { return `<div class="al-item"><div class="al-dot" style="background:${escAttr(a.color)}"></div><div class="al-text">${esc(a.text)}</div><div class="al-time">${esc(a.time)}</div></div>`; }

// ── Activity log helpers ─────────────────────────────────────────────────────
const ACTION_META = {
  approve_listing:      { label: 'Listing approved',        color: '#1a7a45' },
  reject_listing:       { label: 'Listing rejected',        color: '#c0392b' },
  remove_listing:            { label: 'Listing removed',              color: '#c0392b' },
  restore_listing:           { label: 'Listing restored',             color: '#1a7a45' },
  listing_permanently_deleted: { label: 'Listing permanently deleted', color: '#8b0000' },
  pin_listing:          { label: 'Listing pinned',          color: '#6b21a8' },
  unpin_listing:        { label: 'Listing unpinned',        color: '#6b21a8' },
  edit_listing:         { label: 'Listing edited',          color: '#3B5BA5' },
  suspend_student:      { label: 'Student suspended',       color: '#c0392b' },
  reinstate_student:    { label: 'Student reinstated',      color: '#1a7a45' },
  resolve_report:       { label: 'Report resolved',         color: '#1a7a45' },
  dismiss_report:       { label: 'Report dismissed',        color: '#888888' },
  appeal_upheld:        { label: 'Appeal upheld',           color: '#c0392b' },
  appeal_reinstated:    { label: 'Appeal: reinstated',      color: '#1a7a45' },
  edit_appeal_decision: { label: 'Appeal decision edited',  color: '#d4860a' },
  broadcast_sent:       { label: 'Broadcast sent',          color: '#3B5BA5' },
  broadcast_drafted:    { label: 'Broadcast drafted',       color: '#888888' },
  broadcast_scheduled:  { label: 'Broadcast scheduled',     color: '#3B5BA5' },
  broadcast_updated:    { label: 'Broadcast updated',       color: '#d4860a' },
  broadcast_deleted:              { label: 'Broadcast deleted',              color: '#c0392b' },
  broadcast_restored:             { label: 'Broadcast restored',             color: '#1a7a45' },
  broadcast_permanently_deleted:  { label: 'Broadcast permanently deleted',  color: '#8b0000' },
  content_edit:         { label: 'Site content updated',    color: '#3B5BA5' },
  color_edit:           { label: 'Colors updated',          color: '#3B5BA5' },
  setting_change:       { label: 'Setting changed',         color: '#3B5BA5' },
  export:               { label: 'Data exported',           color: '#117A65' },
  return_to_pending:    { label: 'Returned to pending',     color: '#d4860a' },
  undo_action:          { label: 'Action undone',           color: '#d4860a' },
  student_signup:       { label: 'New student signup',      color: '#4a9470' },
  listing_submitted:    { label: 'Listing submitted',       color: '#d4860a' },
  book_submitted:       { label: 'Book submitted',          color: '#d4860a' },
  // Student lifecycle actions (Session C4) — written via logEvent(), never undoable
  listing_sold:         { label: 'Listing marked sold',     color: '#888888' },
  listing_pending_sale: { label: 'Listing pending sale',    color: '#3B5BA5' },
  listing_withdrawn:    { label: 'Listing withdrawn',       color: '#888888' },
  listing_relisted:     { label: 'Listing relisted',        color: '#1a7a45' },
  listing_renewed:      { label: 'Listing renewed',         color: '#1a7a45' },
  listing_deadline_set: { label: 'Listing deadline changed', color: '#3B5BA5' },
  book_sold:            { label: 'Book marked sold',        color: '#888888' },
  book_pending_sale:    { label: 'Book pending sale',        color: '#3B5BA5' },
  book_relisted:        { label: 'Book relisted',           color: '#1a7a45' },
  // Book moderation gets its OWN action types — never reuse approve_listing etc. for
  // books: book ids and listing ids are independent sequences, and the undo machinery
  // routes purely on action_type into the `listings` table (see _executeUndo).
  approve_book:         { label: 'Book approved',           color: '#1a7a45' },
  reject_book:          { label: 'Book rejected',           color: '#c0392b' },
  remove_book:          { label: 'Book removed',            color: '#c0392b' },
  restore_book:         { label: 'Book restored',           color: '#1a7a45' },
  report_submitted:     { label: 'Report filed',            color: '#c0392b' },
  appeal_submitted:     { label: 'Appeal submitted',        color: '#3B5BA5' },
};

const ACTIVITY_FILTER_GROUPS = {
  approvals:  ['approve_listing','reject_listing','restore_listing','edit_listing','approve_book','reject_book','restore_book'],
  moderation: ['remove_listing','listing_permanently_deleted','suspend_student','reinstate_student','resolve_report','dismiss_report','remove_book'],
  appeals:    ['appeal_upheld','appeal_reinstated','edit_appeal_decision'],
  system:     ['broadcast_sent','broadcast_drafted','broadcast_scheduled','broadcast_updated','broadcast_deleted','broadcast_restored','broadcast_permanently_deleted','content_edit','color_edit','setting_change','export'],
  students:   ['student_signup','listing_submitted','book_submitted','report_submitted','appeal_submitted','listing_sold','listing_pending_sale','listing_withdrawn','listing_relisted','listing_renewed','listing_deadline_set','book_sold','book_pending_sale','book_relisted'],
};

const fmtActivityTime = d => {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1)  return 'Just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24)   return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7)  return `${day}d ago`;
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const UNDOABLE_ACTIONS = new Set(['reject_listing','remove_listing','pin_listing','unpin_listing','approve_listing','suspend_student']);
function activityItem(e) {
  const m = ACTION_META[e.action_type] || { label: e.action_type, color: '#888' };
  const suffix = e.target_label
    ? ` <span style="color:var(--text-muted)">—</span> <em style="color:var(--text)">"${esc(e.target_label)}"</em>`
    : '';
  const undone = e.undone_at ? ` <span style="font-size:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:1px 7px;color:var(--text-faint);margin-left:4px">reversed</span>` : '';
  const undoBtn = (!e.undone_at && UNDOABLE_ACTIONS.has(e.action_type) && e.target_id)
    ? `<button onclick="event.stopPropagation();undoActivityEntry('${e.id}','${e.action_type}','${e.target_id}')" style="flex-shrink:0;align-self:center;font-size:11px;padding:2px 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-muted);cursor:pointer;font-family:inherit" title="Undo this action">&#8617; Undo</button>`
    : '';
  return `<div class="al-item" onclick="openActivityDetail('${e.id}')" title="View detail">
    <div class="al-dot" style="background:${escAttr(m.color)}"></div>
    <div class="al-text">${esc(m.label)}${suffix}${undone}</div>
    <div class="al-time" style="align-self:center">${fmtActivityTime(e.created_at)}</div>
    ${undoBtn}
  </div>`;
}

async function logAdminAction(actionType, opts = {}) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;
  const { error } = await supabaseClient.from('admin_activity_log').insert({
    actor_id:            user.id,
    actor_school:        aAdminSchool,
    action_type:         actionType,
    target_type:         opts.targetType                              ?? null,
    target_id:           opts.targetId != null ? String(opts.targetId) : null,
    target_label:        opts.targetLabel                             ?? null,
    school:              opts.school                                  ?? null,
    category:            opts.category                               ?? null,
    chain_report_id:     opts.reportId                               ?? null,
    chain_suspension_id: opts.suspensionId                           ?? null,
    chain_appeal_id:     opts.appealId                               ?? null,
    reason:              opts.reason                                  ?? null,
    before_state:        opts.before                                 ?? null,
    after_state:         opts.after                                  ?? null,
    metadata:            opts.meta                                   ?? null,
  });
  if (error) console.error('[logAdminAction] insert failed:', error.message, { actionType });
}

async function logEvent(actionType, opts = {}) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;
  const { error } = await supabaseClient.from('admin_activity_log').insert({
    actor_id:     user.id,
    actor_school: opts.school  || null,
    action_type:  actionType,
    target_type:  opts.targetType  || null,
    target_id:    opts.targetId != null ? String(opts.targetId) : null,
    target_label: opts.targetLabel || null,
    school:       opts.school      || null,
    category:     opts.category    || null,
    before_state: opts.before      || null,
    after_state:  opts.after       || null,
    reason:       opts.reason      || null,
  });
  if (error) console.error('[logEvent] insert failed:', error.message, { actionType });
}

async function fetchActivityLog({ limit = 20, offset = 0, actionType = null, actionTypes = null, actorId = null,
    targetId = null, school = null, dateFrom = null, dateTo = null, search = null, withCount = false } = {}) {
  let q = supabaseClient
    .from('admin_activity_log')
    .select('id, created_at, action_type, target_type, target_id, target_label, school, reason, undone_at, reverts_id',
            withCount ? { count: 'exact' } : undefined)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (actionType)                        q = q.eq('action_type', actionType);
  if (actionTypes && actionTypes.length) q = q.in('action_type', actionTypes);
  if (actorId)    q = q.eq('actor_id', actorId);
  if (targetId)   q = q.eq('target_id', String(targetId));
  if (school)     q = q.eq('school', school);
  if (dateFrom)   q = q.gte('created_at', dateFrom);
  if (dateTo)     q = q.lte('created_at', dateTo);
  if (search)     q = q.or(`target_label.ilike.%${search}%,reason.ilike.%${search}%`);
  return q;
}

async function renderAdminDashLog() {
  const el        = document.getElementById('aDashLog');
  const filtersEl = document.getElementById('aDashLogFilters');
  const chips = [
    { key: 'all',        label: 'All'        },
    { key: 'approvals',  label: 'Approvals'  },
    { key: 'moderation', label: 'Moderation' },
    { key: 'appeals',    label: 'Appeals'    },
    { key: 'students',   label: 'Students'   },
    { key: 'system',     label: 'System'     },
  ];
  if (filtersEl) filtersEl.innerHTML = chips.map(c =>
    `<button class="filter-chip${_dashLogFilter === c.key ? ' active' : ''}" onclick="_dashLogFilter='${c.key}';renderAdminDashLog()">${c.label}</button>`
  ).join('');
  const actionTypes = _dashLogFilter !== 'all' ? ACTIVITY_FILTER_GROUPS[_dashLogFilter] : null;
  const { data: entries } = await fetchActivityLog({ limit: 8, actionTypes });
  el.innerHTML = entries && entries.length
    ? entries.map(activityItem).join('')
    : '<div style="padding:16px 0;text-align:center;color:var(--text-faint);font-size:13px">No activity yet.</div>';
}

async function openActivityDetail(entryId) {
  openHDrawer('Activity detail', '<div class="drawer-loading">Loading…</div>');
  const { data: e } = await supabaseClient.from('admin_activity_log').select('*').eq('id', entryId).single();
  if (!e) { document.getElementById('hDrawerBody').innerHTML = '<div style="color:var(--danger);padding:20px">Could not load this entry.</div>'; return; }

  let actorName = 'Unknown admin';
  if (e.actor_id) {
    const { data: p } = await supabaseClient.from('profiles').select('first_name, last_name').eq('id', e.actor_id).single();
    if (p) actorName = [p.first_name, p.last_name].filter(Boolean).join(' ') || actorName;
  }

  const m = ACTION_META[e.action_type] || { label: e.action_type, color: '#888' };
  const row = (label, val) => val
    ? `<div style="display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px"><div style="width:80px;flex-shrink:0;color:var(--text-faint);font-weight:500">${label}</div><div style="flex:1;color:var(--text)">${val}</div></div>`
    : '';
  // JSON.stringify does NOT escape HTML — before/after blobs carry listing titles, so esc() the result.
  const codeRow = (label, val) => val
    ? row(label, `<span style="font-family:monospace;font-size:12px;background:var(--bg);padding:3px 7px;border-radius:4px;display:inline-block">${esc(JSON.stringify(val))}</span>`)
    : '';

  let targetVal = '';
  if (e.target_label) {
    let link = '';
    if (e.target_type === 'listing' && e.target_id)
      link = ` <span class="stu-link-a" style="font-size:12px" onclick="closeHDrawer();openListingDrawer(${+e.target_id})">view listing →</span>`;
    else if (e.target_type === 'student' && e.target_id)
      link = ` <span class="stu-link-a" style="font-size:12px" onclick="closeHDrawer();aOpenStudentHistory('${e.target_id}')">view profile →</span>`;
    targetVal = `"${esc(e.target_label)}" <span style="color:var(--text-faint);font-size:11px">(${esc(e.target_type || '—')})</span>${link}`;
  }

  const chainParts = [
    e.chain_report_id    ? `<span class="stu-link-a" style="font-size:12px" onclick="closeHDrawer();openReportDrawer('${e.chain_report_id}')">view linked report →</span>` : '',
    e.chain_suspension_id ? `<span style="color:var(--text-faint);font-size:12px">Suspension: ${e.chain_suspension_id.slice(0,8)}…</span>` : '',
    e.chain_appeal_id    ? `<span style="color:var(--text-faint);font-size:12px">Appeal: ${e.chain_appeal_id.slice(0,8)}…</span>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  const reversedBadge = e.undone_at
    ? ` <span style="font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:2px 9px;color:var(--text-faint);margin-left:8px">Reversed ${fmtActivityTime(e.undone_at)}</span>`
    : '';
  const schoolLabel = e.school ? e.school.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase()) : '';

  document.getElementById('hDrawerTitle').innerHTML =
    `<span style="display:inline-block;background:${m.color}22;color:${m.color};border-radius:6px;padding:2px 10px;font-size:13px;font-weight:600">${esc(m.label)}</span>${reversedBadge}`;
  document.getElementById('hDrawerBody').innerHTML =
    `<div style="padding:0 2px">` +
    row('Actor',  esc(actorName)) +
    row('Time',   new Date(e.created_at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})) +
    (targetVal ? row('Target', targetVal) : '') +   // targetVal already escaped + carries link HTML
    (schoolLabel ? row('School', esc(schoolLabel)) : '') +
    (e.reason ? row('Reason', esc(e.reason)) : '') +
    codeRow('Before', e.before_state) +
    codeRow('After',  e.after_state) +
    (e.metadata ? codeRow('Meta', e.metadata) : '') +
    (chainParts ? row('Links', chainParts) : '') +
    `</div>`;
}

let _undoWarningCb = null;
function showUndoWarning(message, onConfirm) {
  _undoWarningCb = onConfirm;
  document.getElementById('undoWarningMsg').textContent = message;
  document.getElementById('undoWarningConfirm').onclick = () => { closeModal('undoWarningModal'); if (_undoWarningCb) _undoWarningCb(); };
  openModal('undoWarningModal');
}

async function undoActivityEntry(entryId, actionType, targetId) {
  const WARN = {
    approve_listing: "This will return the listing to the pending queue for re-review. The poster won't be notified.",
    suspend_student: "This will immediately restore the student's account access.",
  };
  if (WARN[actionType]) {
    showUndoWarning(WARN[actionType], () => _executeUndo(entryId, actionType, targetId));
    return;
  }
  await _executeUndo(entryId, actionType, targetId);
}

async function _executeUndo(entryId, actionType, targetId) {
  const numId = targetId ? +targetId : null;
  await supabaseClient.from('admin_activity_log').update({ undone_at: new Date().toISOString() }).eq('id', entryId);
  logAdminAction('undo_action', { targetType: 'log', targetId: entryId, meta: { original_action: actionType } });
  if (actionType === 'reject_listing'  && numId)    { await aApprove(numId);          return; }
  if (actionType === 'remove_listing'  && numId)    { await aRestoreListing(numId);   return; }
  if (actionType === 'pin_listing'     && numId)    { await aTogglePin(numId);        return; }
  if (actionType === 'unpin_listing'   && numId)    { await aTogglePin(numId);        return; }
  if (actionType === 'approve_listing' && numId)    { await aReturnToPending(numId);  return; }
  if (actionType === 'suspend_student' && targetId) { await aReinstate(targetId);     return; }
  renderAdminDashLog();
  toast('Action reversed');
}

// ADMIN APPROVALS
function setApprovalsTab(tab) {
  _approvalsTab = tab;
  document.getElementById('aApprovalTab-listings').classList.toggle('active', tab === 'listings');
  document.getElementById('aApprovalTab-books').classList.toggle('active', tab === 'books');
  // The category/school filters only apply to marketplace listings; hide the button
  // (and any open panel) on the Books tab instead of offering an empty panel.
  const fBtn = document.getElementById('aApprovalFilterBtn');
  const fPanel = document.getElementById('aApprovalFilterPanel');
  if (fBtn) fBtn.style.display = tab === 'books' ? 'none' : '';
  if (fPanel && tab === 'books') { fPanel.style.display = 'none'; fBtn && (fBtn.innerHTML = '&#9657; Filters'); }
  renderAApprovals();
}

function renderAApprovals() {
  if (_approvalsTab === 'books') { renderABookApprovals(); return; }
  const q = document.getElementById('aApprovalQ');

  const filterPanel = document.getElementById('aApprovalFilterPanel');
  if (filterPanel) {
    const panelRows = [];

    // Category filter — always show if there are any pending listings
    const cats = ['all', ...new Set(DB.pending.map(l => l.category).filter(Boolean))];
    if (cats.length > 1) {
      panelRows.push(`<div style="display:flex;gap:6px;flex-wrap:wrap">${cats.map(c => `<button class="filter-chip${_approvalCategoryFilter===c?' active':''}" onclick="_approvalCategoryFilter='${c}';renderAApprovals()">${c === 'all' ? 'All types' : (CATEGORY_EMOJI[c]||'') + ' ' + (CATEGORY_LABELS[c]||c)}</button>`).join('')}</div>`);
    }

    // School filter — super-admin only, multiple schools
    if (!aAdminSchool) {
      const slugs = ['all', ...new Set(DB.pending.map(l => l.school).filter(Boolean))].sort((a,b) => a==='all'?-1:b==='all'?1:a.localeCompare(b));
      if (slugs.length > 1) {
        const slabel = s => s === 'all' ? 'All schools' : s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        panelRows.push(`<div style="display:flex;gap:6px;flex-wrap:wrap">${slugs.map(s=>`<button class="filter-chip${_approvalSchoolFilter===s?' active':''}" onclick="_approvalSchoolFilter='${s}';renderAApprovals()">${slabel(s)}</button>`).join('')}</div>`);
      }
    } else {
      panelRows.push(`<span class="school-chip">&#128274; ${aAdminSchool} only</span>`);
    }

    filterPanel.innerHTML = panelRows.join('');
    if (_approvalSchoolFilter !== 'all' || _approvalCategoryFilter !== 'all') ensureFilterOpen('aApprovalFilterPanel', 'aApprovalFilterBtn');
  }

  let src = aAdminSchool
    ? DB.pending.filter(l => l.school === aAdminSchool)
    : _approvalSchoolFilter !== 'all' ? DB.pending.filter(l => l.school === _approvalSchoolFilter) : DB.pending;
  if (_approvalCategoryFilter !== 'all') src = src.filter(l => l.category === _approvalCategoryFilter);

  if (!src.length) {
    q.innerHTML = '<div style="text-align:center;padding:48px;color:var(--text-faint)"><div style="font-size:36px;margin-bottom:10px">&#9745;</div>No pending listings</div>';
    return;
  }

  q.innerHTML =
    `<div style="font-size:13px;font-weight:600;color:var(--warning);margin-bottom:12px;display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;background:var(--warning);border-radius:50%;display:inline-block"></span>${src.length} listing${src.length>1?'s':''} awaiting review</div>` +
    src.map(l => `<div class="acard">
      ${l.photo_urls?.length ? `<div style="margin-bottom:10px">${photoGalleryHtml(l.photo_urls, { height: 180, radius: '6px', mainId: 'aq' + l.id })}</div>` : ''}
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:10px;">
        <div><div class="acard-title">${esc(l.title)}</div><div class="acard-meta">${esc(l.type)} · $${l.rent}/mo · ${esc(l.location)} · ${l.submitted}</div></div>
        <span class="pill pill-pending">Pending</span>
      </div>
      <div class="acard-desc">${esc(l.desc)}</div>
      <div class="acard-tags">${l.tags.map(t => `<span class="atag">${esc(t)}</span>`).join('')}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="mav" style="background:${escAttr(l.poster.color)}">${esc(l.poster.initials)}</div>
          <div>
            <div style="font-size:13px;font-weight:500">${esc(l.poster.fullName || l.poster.name)}</div>
            <div style="font-size:11px;color:var(--text-faint)">${esc(l.poster.email)}</div>
            ${l.school ? `<span class="school-chip" style="display:inline-block;margin-top:3px">${esc(l.school.replace(/_/g,' '))}</span>` : ''}
          </div>
        </div>
        <div class="arow">
          <button class="btn-sm-a btn-a-neutral" onclick="aOpenEdit(${l.id},'pending')">&#9998; Edit</button>
          <button class="btn-sm-a btn-a-danger" onclick="aOpenReject(${l.id})">&#10005; Reject</button>
          <button class="btn-sm-a btn-a-success" onclick="aApprove(${l.id})">&#10003; Approve</button>
        </div>
      </div>
    </div>`).join('');
}

async function aApprove(id) {
  const l = DB.pending.find(x => x.id === id); if (!l) return;
  const { error } = await supabaseClient.from('listings').update({ status: 'approved' }).eq('id', id);
  if (error) { toast('Could not approve listing — please try again.'); console.error(error.message); return; }
  DB.listings.unshift({ id, title: l.title, category: l.category, type: l.type, rent: l.rent, location: l.location, desc: l.desc, tags: l.tags, poster: l.poster, posted: 'Just now', created_at: l.created_at || new Date().toISOString(), emoji: l.emoji, status: 'approved', lifecycle_status: l.lifecycle_status || 'active', expires_at: l.expires_at || null, pinned: false, photo_urls: l.photo_urls || [], school: l.school });
  DB.pending.splice(DB.pending.findIndex(x => x.id === id), 1);
  DB.log.unshift({ type: 'approve', text: `Listing approved: "${l.title}"`, time: 'Just now', color: '#1a7a45' });
  logAdminAction('approve_listing', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { status: 'pending' }, after: { status: 'approved' } });
  updateAdminBadges(); renderAApprovals(); renderListings();
  toast('✓ Listing approved — now live on student board');
}

async function aReturnToPending(id) {
  const l = DB.listings.find(x => x.id === id && x.status === 'approved');
  if (!l) { toast('Listing not found or already changed.'); return; }
  const { error } = await supabaseClient.from('listings').update({ status: 'pending' }).eq('id', id);
  if (error) { toast('Could not return listing to pending.'); console.error(error.message); return; }
  DB.listings.splice(DB.listings.findIndex(x => x.id === id), 1);
  DB.pending.unshift({ ...l, status: 'pending' });
  DB.log.unshift({ type: 'return_pending', text: `Listing returned to pending: "${l.title}"`, time: 'Just now', color: '#d4860a' });
  logAdminAction('return_to_pending', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { status: 'approved' }, after: { status: 'pending' } });
  updateAdminBadges(); renderAApprovals(); renderAListings(); renderListings();
  renderAdminDashLog();
  toast('Listing returned to pending review');
}

let _rejectTarget = 'listing'; // 'listing' | 'book' — which confirmReject() should act on
function aOpenReject(id) { aRejectId = id; _rejectTarget = 'listing'; document.getElementById('rejReason').value = ''; document.getElementById('rejectModalTitle').textContent = 'Reject listing'; openModal('rejectModal'); }
async function confirmReject() {
  if (_rejectTarget === 'book') return confirmRejectBook();
  const l = DB.pending.find(x => x.id === aRejectId); if (!l) return;
  const r = document.getElementById('rejReason').value || 'Did not meet guidelines.';
  const { error } = await supabaseClient.from('listings').update({ status: 'rejected', rejection_reason: r }).eq('id', aRejectId);
  if (error) { toast('Could not reject listing — please try again.'); console.error(error.message); return; }
  DB.listings.unshift({ id: aRejectId, title: l.title, type: l.type, rent: l.rent, location: l.location, desc: l.desc, tags: l.tags || [], poster: l.poster, posted: 'Just now', emoji: l.emoji, status: 'rejected', pinned: false, photo_urls: l.photo_urls || [], school: l.school });
  DB.pending.splice(DB.pending.findIndex(x => x.id === aRejectId), 1);
  DB.log.unshift({ type: 'reject', text: `Listing rejected: "${l.title}"`, time: 'Just now', color: '#c0392b' });
  logAdminAction('reject_listing', { targetType: 'listing', targetId: aRejectId, targetLabel: l.title, school: l.school, category: l.category, reason: r, before: { status: 'pending' }, after: { status: 'rejected' } });
  updateAdminBadges(); closeModal('rejectModal'); renderAApprovals(); toast('Listing rejected');
}

// ─── BOOK APPROVALS ─────────────────────────────────────────
function renderABookApprovals() {
  const q = document.getElementById('aApprovalQ');
  const filterPanel = document.getElementById('aApprovalFilterPanel');
  if (filterPanel) filterPanel.innerHTML = '';
  const pending = DB.pendingBooks;
  const live    = DB.adminBooks.filter(b => b.status === 'approved');
  const removed = DB.adminBooks.filter(b => b.status === 'removed');

  const pendingHtml = pending.length
    ? `<div style="font-size:13px;font-weight:600;color:var(--warning);margin-bottom:12px;display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;background:var(--warning);border-radius:50%;display:inline-block"></span>${pending.length} book${pending.length>1?'s':''} awaiting review</div>` +
      pending.map(b => `<div class="acard">
        ${b.photo_urls?.length ? `<div style="margin-bottom:10px">${photoGalleryHtml(b.photo_urls, { height: 180, radius: '6px', mainId: 'aqb' + b.id })}</div>` : ''}
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:10px;">
          <div><div class="acard-title">${esc(b.title)}</div><div class="acard-meta">${esc(b.type)}${b.author ? ' · ' + esc(b.author) : ''} · $${b.rent}${b.condition ? ' · ' + esc(b.condition) : ''}${b.isbn ? ' · ISBN ' + esc(b.isbn) : ''} · ${b.submitted}</div></div>
          <span class="pill pill-pending">Pending</span>
        </div>
        <div class="acard-desc">${esc(b.desc)}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="mav" style="background:${escAttr(b.poster.color)}">${esc(b.poster.initials)}</div>
            <div>
              <div style="font-size:13px;font-weight:500">${esc(b.poster.fullName || b.poster.name)}</div>
              <div style="font-size:11px;color:var(--text-faint)">${esc(b.poster.email)}</div>
            </div>
          </div>
          <div class="arow">
            <button class="btn-sm-a btn-a-danger" onclick="aOpenRejectBook(${b.id})">&#10005; Reject</button>
            <button class="btn-sm-a btn-a-success" onclick="aApproveBook(${b.id})">&#10003; Approve</button>
          </div>
        </div>
      </div>`).join('')
    : '<div style="text-align:center;padding:32px;color:var(--text-faint)"><div style="font-size:32px;margin-bottom:8px">&#9745;</div>No pending books</div>';

  const rowHtml = (b, actionBtn) => `<tr>
    <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.title)}</td>
    <td><span class="pill pill-active" style="font-size:10px">${esc(b.type)}</span></td>
    <td style="font-weight:600;color:var(--brand)">$${b.rent}</td>
    <td>${esc(b.poster?.name || '—')}</td>
    <td>${actionBtn}</td>
  </tr>`;

  const liveHtml = live.length ? `
    <div style="margin-top:24px;font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px">${live.length} live book${live.length>1?'s':''}</div>
    <div style="overflow-x:auto"><table><thead><tr><th>Title</th><th>Type</th><th>Price</th><th>Poster</th><th>Actions</th></tr></thead>
    <tbody>${live.map(b => rowHtml(b, `<button class="btn-sm-a btn-a-danger" onclick="aRemoveBook(${b.id})">Remove</button>`)).join('')}</tbody></table></div>` : '';

  const removedHtml = removed.length ? `
    <div style="margin-top:24px;font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px">${removed.length} removed book${removed.length>1?'s':''}</div>
    <div style="overflow-x:auto"><table><thead><tr><th>Title</th><th>Type</th><th>Price</th><th>Poster</th><th>Actions</th></tr></thead>
    <tbody>${removed.map(b => rowHtml(b, `<button class="btn-sm-a btn-a-success" onclick="aRestoreBook(${b.id})">&#8635; Restore</button>`)).join('')}</tbody></table></div>` : '';

  q.innerHTML = pendingHtml + liveHtml + removedHtml;
}

async function aApproveBook(id) {
  const b = DB.pendingBooks.find(x => x.id === id); if (!b) return;
  const { error } = await supabaseClient.from('book_listings').update({ status: 'approved' }).eq('id', id);
  if (error) { toast('Could not approve book — please try again.'); console.error(error.message); return; }
  DB.adminBooks.unshift({ ...b, status: 'approved' });
  DB.pendingBooks.splice(DB.pendingBooks.findIndex(x => x.id === id), 1);
  DB.log.unshift({ type: 'book', text: `Book approved: "${b.title}"`, time: 'Just now', color: '#1a7a45' });
  logAdminAction('approve_book', { targetType: 'book_listing', targetId: id, targetLabel: b.title, before: { status: 'pending' }, after: { status: 'approved' } });
  updateAdminBadges(); renderAApprovals();
  await loadBooks(); renderListings(); // refresh the merged feed so the approval is visible without a reload
  toast('✓ Book approved — now live on the Books board');
}

function aOpenRejectBook(id) { aBookRejectId = id; _rejectTarget = 'book'; document.getElementById('rejReason').value = ''; document.getElementById('rejectModalTitle').textContent = 'Reject book'; openModal('rejectModal'); }
async function confirmRejectBook() {
  const b = DB.pendingBooks.find(x => x.id === aBookRejectId); if (!b) return;
  const r = document.getElementById('rejReason').value || 'Did not meet guidelines.';
  const { error } = await supabaseClient.from('book_listings').update({ status: 'rejected', rejection_reason: r }).eq('id', aBookRejectId);
  if (error) { toast('Could not reject book — please try again.'); console.error(error.message); return; }
  DB.adminBooks.unshift({ ...b, status: 'rejected', rejection_reason: r });
  DB.pendingBooks.splice(DB.pendingBooks.findIndex(x => x.id === aBookRejectId), 1);
  DB.log.unshift({ type: 'book', text: `Book rejected: "${b.title}"`, time: 'Just now', color: '#c0392b' });
  logAdminAction('reject_book', { targetType: 'book_listing', targetId: aBookRejectId, targetLabel: b.title, reason: r, before: { status: 'pending' }, after: { status: 'rejected' } });
  updateAdminBadges(); closeModal('rejectModal'); renderAApprovals();
  toast('Book rejected');
}

async function aRemoveBook(id) {
  const b = DB.adminBooks.find(x => x.id === id); if (!b) return;
  const prevStatus = b.status;
  const { error } = await supabaseClient.from('book_listings').update({ status: 'removed' }).eq('id', id);
  if (error) { toast('Could not remove book — please try again.'); console.error(error.message); return; }
  b.status = 'removed';
  DB.log.unshift({ type: 'book', text: `Book removed: "${b.title}"`, time: 'Just now', color: '#c0392b' });
  logAdminAction('remove_book', { targetType: 'book_listing', targetId: id, targetLabel: b.title, before: { status: prevStatus }, after: { status: 'removed' } });
  renderAApprovals(); updateAdminBadges();
  await loadBooks(); renderListings();
  toast('Book removed');
}

async function aRestoreBook(id) {
  const b = DB.adminBooks.find(x => x.id === id); if (!b) return;
  const { error } = await supabaseClient.from('book_listings').update({ status: 'approved' }).eq('id', id);
  if (error) { toast('Could not restore book — please try again.'); console.error(error.message); return; }
  b.status = 'approved';
  DB.log.unshift({ type: 'book', text: `Book restored: "${b.title}"`, time: 'Just now', color: '#1a7a45' });
  logAdminAction('restore_book', { targetType: 'book_listing', targetId: id, targetLabel: b.title, before: { status: 'removed' }, after: { status: 'approved' } });
  renderAApprovals(); updateAdminBadges();
  await loadBooks(); renderListings();
  toast('Book restored');
}

// ADMIN ALL LISTINGS
function allListings() { return [...DB.listings.filter(l => l.status !== 'removed'), ...DB.pending.map(p => ({ ...p, poster: p.poster, status: 'pending' }))]; }

// ── Shared admin UI bits ────────────────────────────────────────────────────
// These three were each copy-pasted several times over (secHead ×3, chipRow ×3, sPill ×4),
// every copy carrying its own inline styles. One definition each now, styled by class in
// styles.css — change the look in one place and every admin panel follows.

// Small uppercase label above a group of filter controls.
const aFieldLabel = t => `<div class="a-field-label">${t}</div>`;

// A wrapping row of filter chips. `opts` items are either a plain string or {v, l}.
const aChipRow = (opts, active, setter) => `<div class="a-chip-row">${
  opts.map(o => {
    const v = typeof o === 'string' ? o : o.v;
    const l = typeof o === 'string' ? (v === 'all' ? 'All' : v) : o.l;
    return `<button class="filter-chip${active === v ? ' active' : ''}" onclick="${setter}('${v}')">${l}</button>`;
  }).join('')
}</div>`;

// Moderation-status pill. `compact` is the smaller, non-shrinking variant used inside flex rows.
const A_PILL_CLASS = { approved:'pill-approved', pinned:'pill-pinned', pending:'pill-pending', rejected:'pill-rejected', removed:'pill-rejected' };
const aStatusPill = (status, compact = false) =>
  `<span class="pill ${A_PILL_CLASS[status] || 'pill-pending'}${compact ? ' pill-compact' : ''}">${esc(status)}</span>`;

function toggleFilterPanel(panelId, btnId) {
  const panel = document.getElementById(panelId);
  const btn   = document.getElementById(btnId);
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'flex' : 'none';
  if (btn) btn.innerHTML = opening ? '&#9663; Filters' : '&#9657; Filters';
}
function ensureFilterOpen(panelId, btnId) {
  const panel = document.getElementById(panelId);
  if (!panel || panel.style.display !== 'none') return;
  toggleFilterPanel(panelId, btnId);
}
function toggleAListFilters() { toggleFilterPanel('aListFilterPanel', 'aListFilterToggle'); }

function setAListFilter(dimension, value) {
  if (dimension === 'type')   _listingTypeFilter   = value;
  if (dimension === 'status') _listingStatusFilter = value;
  if (dimension === 'school') _listingSchoolFilter = value;
  if (dimension === 'sort')   _listingSort         = value;
  renderAListings();
}

function clearAListFilters() {
  _listingTypeFilter = 'all'; _listingStatusFilter = 'all'; _listingSchoolFilter = 'all';
  _listingMinRent = ''; _listingMaxRent = ''; _listingSort = 'newest';
  const minEl = document.getElementById('aListMinRent'); if (minEl) minEl.value = '';
  const maxEl = document.getElementById('aListMaxRent'); if (maxEl) maxEl.value = '';
  renderAListings();
}

function renderAListings() {
  // School chips (built from live listing data — no extra Supabase call needed)
  const schoolChipsEl = document.getElementById('aListSchoolChips');
  if (schoolChipsEl) {
    const slugs = ['all', ...new Set(allListings().map(l => l.school).filter(Boolean))].sort((a, b) => a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b));
    schoolChipsEl.innerHTML = slugs.map(s => {
      const label = s === 'all' ? 'All' : s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const active = (_listingSchoolFilter === 'all' && s === 'all') || _listingSchoolFilter === s;
      return `<button class="filter-chip${active ? ' active' : ''}" onclick="setAListFilter('school','${s}')">${label}</button>`;
    }).join('');
  }

  // Sync chip active states
  ['all','housing','clothing','technology','donation','organization_event','other'].forEach(v =>
    document.getElementById(`aTypeChip-${v}`)?.classList.toggle('active', _listingTypeFilter === v));
  ['all','approved','pending','rejected','pinned'].forEach(v =>
    document.getElementById(`aStatusChip-${v}`)?.classList.toggle('active', _listingStatusFilter === v));
  ['newest','oldest'].forEach(v =>
    document.getElementById(`aSortChip-${v}`)?.classList.toggle('active', _listingSort === v));

  // Apply filters
  const schoolF = aAdminSchool || (_listingSchoolFilter !== 'all' ? _listingSchoolFilter : null);
  let src = allListings();
  if (schoolF) src = src.filter(l => l.school === schoolF);
  if (_listingTypeFilter !== 'all') src = src.filter(l => (l.category || '') === _listingTypeFilter);
  if (_listingStatusFilter === 'pinned')   src = src.filter(l => l.pinned);
  else if (_listingStatusFilter !== 'all') src = src.filter(l => l.status === _listingStatusFilter);
  const minR = parseFloat(_listingMinRent), maxR = parseFloat(_listingMaxRent);
  if (_listingMinRent !== '' && !isNaN(minR)) src = src.filter(l => parseFloat(l.rent) >= minR);
  if (_listingMaxRent !== '' && !isNaN(maxR)) src = src.filter(l => parseFloat(l.rent) <= maxR);
  if (_listingSort === 'oldest') src = src.slice().reverse();
  const q = (document.getElementById('aListSearch')?.value || '').toLowerCase().trim();
  if (q) src = src.filter(l => (l.title + ' ' + (l.poster?.name || '') + ' ' + (l.type || '')).toLowerCase().includes(q));

  // Result count + clear button
  const metaEl = document.getElementById('aListMeta');
  const isFiltered = schoolF || _listingTypeFilter !== 'all' || _listingStatusFilter !== 'all' || _listingMinRent !== '' || _listingMaxRent !== '';
  if (isFiltered) ensureFilterOpen('aListFilterPanel', 'aListFilterToggle');
  if (metaEl) metaEl.innerHTML = `<span>${src.length} listing${src.length !== 1 ? 's' : ''}</span>${isFiltered ? `<button class="filter-chip" style="font-size:11px;padding:3px 10px" onclick="clearAListFilters()">&#10005; Clear filters</button>` : ''}`;

  // Table rows
  document.getElementById('aListTb').innerHTML = src.length ? src.map(l => `<tr>
    <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.pinned ? '&#128204; ' : ''}${esc(l.title)}</td>
    <td><span class="pill pill-active" style="font-size:10px">${esc(l.type)}</span></td>
    <td style="font-weight:600;color:var(--brand)">$${l.rent}</td>
    <td><div style="font-size:13px">${esc(l.poster?.name || l.poster || '—')}</div>${l.school ? `<div style="font-size:10px;color:var(--brand);font-weight:500;text-transform:capitalize;margin-top:2px">${esc(l.school.replace(/_/g,' '))}</div>` : ''}</td>
    <td><span class="pill ${l.pinned?'pill-pinned':l.status==='approved'?'pill-approved':l.status==='rejected'?'pill-rejected':'pill-pending'}">${l.pinned ? 'pinned' : esc(l.status)}</span>${l.rejection_reason?`<div style="font-size:11px;color:var(--text-muted);margin-top:3px;max-width:160px;white-space:normal">&#128221; ${esc(l.rejection_reason)}</div>`:''}</td>
    <td><div class="arow">
      <button class="btn-sm-a btn-a-neutral" onclick="aOpenEdit(${l.id},'${l.status==='pending'?'pending':'listing'}')">&#9998; Edit</button>
      ${l.status === 'approved' ? `<button class="btn-sm-a ${l.pinned?'btn-a-neutral':'btn-a-pin'}" onclick="aTogglePin(${l.id})">${l.pinned ? 'Unpin' : '&#128204; Pin'}</button>` : ''}
      ${l.status === 'approved' ? `<button class="btn-sm-a btn-a-danger" onclick="aRemoveListing(${l.id})">Remove</button>` : ''}
    </div></td>
  </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-faint)">No listings match the current filters.</td></tr>`;

  // Removed section
  const removed = DB.listings.filter(l => l.status === 'removed' && (!schoolF || l.school === schoolF));
  const wrap = document.getElementById('aRemovedWrap');
  wrap.style.display = removed.length ? 'block' : 'none';
  document.getElementById('aRemovedCount').textContent = removed.length ? `${removed.length} listing${removed.length > 1 ? 's' : ''}` : '';
  document.getElementById('aRemovedTb').innerHTML = removed.map(l => `<tr>
    <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted)">${esc(l.title)}</td>
    <td><span class="pill pill-active" style="font-size:10px">${esc(l.type)}</span></td>
    <td style="font-weight:600;color:var(--text-muted)">$${l.rent}</td>
    <td>${esc(l.poster?.name || l.poster || '—')}</td>
    <td style="font-size:12px;color:var(--text-muted)">${l.updated_at ? fmtDate(l.updated_at) : '—'}</td>
    <td style="display:flex;gap:6px;align-items:center;"><button class="btn-sm-a btn-a-success" onclick="aRestoreListing(${l.id})">&#8635; Restore</button><button class="btn-sm-a btn-a-danger" onclick="aHardDeleteListing(${l.id})">Delete forever</button></td>
  </tr>`).join('');
}

function aft(id, q) { document.querySelectorAll(`#${id} tr`).forEach(r => r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none'); }

async function aRemoveListing(id) {
  const l = DB.listings.find(x => x.id === id);
  if (!l) return;
  const { error } = await supabaseClient.from('listings').update({ status: 'removed' }).eq('id', id);
  if (error) { toast('Could not remove listing — please try again.'); console.error(error.message); return; }
  const prevStatus = l.status;
  l.status = 'removed';
  l.updated_at = new Date().toISOString();
  DB.log.unshift({ type: 'remove', text: `Listing removed: "${l.title}"`, time: 'Just now', color: '#c0392b' });
  logAdminAction('remove_listing', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { status: prevStatus }, after: { status: 'removed' } });
  renderAListings(); renderListings(); updateAdminBadges(); toast('Listing removed');
}

async function aRestoreListing(id) {
  const l = DB.listings.find(x => x.id === id);
  if (!l) return;
  const { error } = await supabaseClient.from('listings').update({ status: 'approved' }).eq('id', id);
  if (error) { toast('Could not restore listing — please try again.'); console.error(error.message); return; }
  l.status = 'approved';
  DB.log.unshift({ type: 'restore', text: `Listing restored: "${l.title}"`, time: 'Just now', color: '#1a7a45' });
  logAdminAction('restore_listing', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { status: 'removed' }, after: { status: 'approved' } });
  renderAListings(); renderListings(); updateAdminBadges(); toast('Listing restored');
}

async function aHardDeleteListing(id) {
  const l = DB.listings.find(x => x.id === id);
  if (!l) return;
  if (!confirm(`Permanently delete "${l.title}"?\n\nThis will remove the listing and any uploaded photos from storage. This cannot be undone.`)) return;
  await deleteListingPhotos(l.photo_urls);
  const { error } = await supabaseClient.from('listings').delete().eq('id', id);
  if (error) { toast('Could not delete listing — please try again.'); console.error(error.message); return; }
  DB.listings.splice(DB.listings.findIndex(x => x.id === id), 1);
  logAdminAction('listing_permanently_deleted', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category });
  renderAListings(); updateAdminBadges(); toast('Listing permanently deleted');
}

async function aTogglePin(id) {
  const l = DB.listings.find(x => x.id === id); if (!l) return;
  if (!l.pinned && DB.listings.filter(x => x.pinned).length >= 3) { toast('Max 3 pinned. Unpin one first.'); return; }
  const newPinned = !l.pinned;
  const { error } = await supabaseClient.from('listings').update({ pinned: newPinned }).eq('id', id);
  if (error) { toast('Could not update pin — please try again.'); console.error(error.message); return; }
  l.pinned = newPinned;
  DB.log.unshift({ type: 'pin', text: `Listing ${l.pinned ? 'pinned' : 'unpinned'}: "${l.title}"`, time: 'Just now', color: '#6b21a8' });
  logAdminAction(newPinned ? 'pin_listing' : 'unpin_listing', { targetType: 'listing', targetId: id, targetLabel: l.title, school: l.school, category: l.category, before: { pinned: !newPinned }, after: { pinned: newPinned } });
  renderAListings(); renderAPinned(); renderListings(); updateAdminBadges();
  toast(l.pinned ? '&#128204; Listing pinned — visible on student board' : 'Listing unpinned');
}

function toggleAeRejReason() {
  const isRejected = document.getElementById('aeS').value === 'rejected';
  document.getElementById('aeRejGroup').style.display = isRejected ? '' : 'none';
}

function aOpenEdit(id, src) {
  aEditId = id; aEditSrc = src;
  const l = (src === 'pending' ? DB.pending : DB.listings).find(x => x.id === id); if (!l) return;
  document.getElementById('aeT').value = l.title;
  document.getElementById('aeY').value = l.type;
  document.getElementById('aeR').value = l.rent;
  document.getElementById('aeL').value = l.location || '';
  document.getElementById('aeD').value = l.desc || '';
  document.getElementById('aeS').value = l.status || 'pending';
  document.getElementById('aeRej').value = l.rejection_reason || '';
  toggleAeRejReason();
  openModal('aEditModal');
}

async function saveAEdit() {
  const oldSrc = aEditSrc === 'pending' ? DB.pending : DB.listings;
  const src = oldSrc.find(x => x.id === aEditId); if (!src) return;
  const oldStatus = src.status;
  const oldTitle  = src.title;
  const oldPrice  = src.rent;
  const oldLoc    = src.location;
  const oldDesc   = src.desc;
  const newTitle = document.getElementById('aeT').value;
  const newType = document.getElementById('aeY').value;
  const newRent = parseInt(document.getElementById('aeR').value) || src.rent;
  const newLoc = document.getElementById('aeL').value;
  const newDesc = document.getElementById('aeD').value;
  const newStatus = document.getElementById('aeS').value;
  const newRejReason = document.getElementById('aeRej').value || null;
  const { error } = await supabaseClient.from('listings').update({
    title: newTitle, price: newRent, location: newLoc,
    description: newDesc, status: newStatus, rejection_reason: newRejReason
  }).eq('id', aEditId);
  if (error) { toast('Could not save — please try again.'); console.error(error.message); return; }
  src.title = newTitle; src.type = newType; src.rent = newRent;
  src.location = newLoc; src.desc = newDesc; src.status = newStatus;
  src.rejection_reason = newRejReason;
  if (newStatus === 'pending' && aEditSrc !== 'pending') {
    DB.listings.splice(DB.listings.findIndex(x => x.id === aEditId), 1);
    DB.pending.push(src);
  } else if (newStatus !== 'pending' && aEditSrc === 'pending') {
    DB.pending.splice(DB.pending.findIndex(x => x.id === aEditId), 1);
    DB.listings.unshift(src);
  }
  DB.log.unshift({ type: 'edit', text: `Listing edited: "${newTitle}"`, time: 'Just now', color: '#3B5BA5' });
  logAdminAction('edit_listing', { targetType: 'listing', targetId: aEditId, targetLabel: newTitle, school: src.school, category: src.category, reason: newStatus === 'rejected' ? newRejReason : null, before: { status: oldStatus, title: oldTitle, price: oldPrice, location: oldLoc, description: oldDesc }, after: { status: newStatus, title: newTitle, price: newRent, location: newLoc, description: newDesc } });
  closeModal('aEditModal');
  renderAApprovals(); renderAListings(); renderListings(); updateAdminBadges();
  toast('✓ Listing updated');
}

// ADMIN PINNED
async function renderAPinned() {
  const pins  = DB.listings.filter(l => l.pinned && l.status === 'approved');
  // Only live listings are offered for pinning — featuring a sold/expired listing
  // would occupy a slot invisibly (the feed hides non-live listings, pinned or not).
  const avail = DB.listings.filter(l => isListingLive(l) && !l.pinned);
  const el    = document.getElementById('aPinnedGrid');
  // A pin whose listing has since gone non-live (sold/withdrawn/expired) needs a warning tag.
  const notLiveTag = l => {
    if (isListingLive(l)) return '';
    const [, , label] = listingLifecycleBadge(l);
    return `<span style="font-size:10px;font-weight:700;background:#f0f0f0;color:#888;padding:1px 7px;border-radius:10px" title="This listing is hidden from the student feed — the pin slot is wasted until unpinned or relisted">${label} — not in feed</span>`;
  };

  // Fetch "pinned since" timestamps from activity log (max 3 items — trivial query)
  const pinnedTimes = {};
  if (pins.length) {
    const { data: logRows } = await supabaseClient
      .from('admin_activity_log')
      .select('target_id, created_at')
      .eq('action_type', 'pin_listing')
      .in('target_id', pins.map(l => String(l.id)))
      .order('created_at', { ascending: false });
    (logRows || []).forEach(r => { if (!pinnedTimes[r.target_id]) pinnedTimes[r.target_id] = r.created_at; });
  }

  if (!pins.length) {
    el.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-faint);font-size:13px">No pinned listings yet.</div>';
  } else {
    const toolbar = `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 14px;gap:8px">
      <span style="font-size:13px;font-weight:600;color:var(--pin)">&#128204; ${pins.length} featured listing${pins.length !== 1 ? 's' : ''}</span>
      <div class="view-toggle">
        <button class="view-btn ${_pinnedView === 'grid' ? 'active' : ''}" onclick="setPinnedView('grid')" title="Grid view">&#9632;&#9632;</button>
        <button class="view-btn ${_pinnedView === 'list' ? 'active' : ''}" onclick="setPinnedView('list')" title="List view">&#9776;</button>
      </div>
    </div>`;

    if (_pinnedView === 'grid') {
      el.innerHTML = toolbar + `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:4px">${
        pins.map(l => {
          const since = pinnedTimes[String(l.id)] ? `Pinned ${fmtActivityTime(pinnedTimes[String(l.id)])}` : '';
          return `<div style="background:var(--pin-pale);border:2px solid rgba(107,33,168,0.25);border-radius:var(--radius);padding:16px;position:relative;cursor:pointer;transition:box-shadow .15s" onclick="openListingDrawer(${l.id})" onmouseover="this.style.boxShadow='0 2px 12px rgba(107,33,168,.15)'" onmouseout="this.style.boxShadow='none'">
            <div style="position:absolute;top:11px;right:11px;font-size:10px;font-weight:700;background:var(--pin);color:#fff;padding:2px 8px;border-radius:10px">&#128204; FEATURED</div>
            <div style="font-size:26px;margin-bottom:8px">${l.emoji || '🏠'}</div>
            <div style="font-weight:600;font-size:14px;margin-bottom:4px;padding-right:72px;line-height:1.3">${esc(l.title)} ${notLiveTag(l)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px">${esc(l.type)} · $${l.rent}/mo</div>
            <div style="font-size:12px;color:var(--text-faint);margin-bottom:${since ? '4' : '12'}px">&#128205; ${esc(l.location)}</div>
            ${since ? `<div style="font-size:11px;color:var(--pin);opacity:.75;margin-bottom:12px">${since}</div>` : ''}
            <div class="arow" onclick="event.stopPropagation()">
              <button class="btn-sm-a btn-a-neutral" onclick="aOpenEdit(${l.id},'listing')">&#9998; Edit</button>
              <button class="btn-sm-a btn-a-danger" onclick="aTogglePin(${l.id})">Unpin</button>
            </div>
          </div>`;
        }).join('')
      }</div>`;
    } else {
      el.innerHTML = toolbar + `<div style="border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">${
        pins.map(l => {
          const since = pinnedTimes[String(l.id)] ? `Pinned ${fmtActivityTime(pinnedTimes[String(l.id)])}` : '';
          return `<div class="hist-row" style="align-items:center" onclick="openListingDrawer(${l.id})">
            <div style="font-size:22px;width:30px;text-align:center;flex-shrink:0">${l.emoji || '🏠'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${esc(l.title)} <span style="font-size:10px;font-weight:700;background:var(--pin);color:#fff;padding:1px 7px;border-radius:10px">FEATURED</span> ${notLiveTag(l)}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(l.type)} · $${l.rent}/mo · &#128205; ${esc(l.location)}${since ? ` · <span style="color:var(--pin);opacity:.8">${since}</span>` : ''}</div>
            </div>
            <div class="arow" onclick="event.stopPropagation()">
              <button class="btn-sm-a btn-a-neutral" onclick="aOpenEdit(${l.id},'listing')">&#9998; Edit</button>
              <button class="btn-sm-a btn-a-danger" onclick="aTogglePin(${l.id})">Unpin</button>
            </div>
            <span style="font-size:14px;color:var(--text-faint);flex-shrink:0">›</span>
          </div>`;
        }).join('')
      }</div>`;
    }
  }

  // Available-to-pin section — clickable to open drawer, Pin button stops propagation
  document.getElementById('aPinAllGrid').innerHTML = avail.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:9px">${
        avail.map(l => `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:13px;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;transition:border-color .15s" onclick="openListingDrawer(${l.id})" onmouseover="this.style.borderColor='var(--brand)'" onmouseout="this.style.borderColor='var(--border)'">
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${l.emoji || ''} ${esc(l.title)}</div>
              <div style="font-size:11px;color:var(--text-faint)">$${l.rent}/mo · ${esc(l.type)}</div>
            </div>
            <button class="btn-sm-a btn-a-pin" onclick="event.stopPropagation();aTogglePin(${l.id})">&#128204; Pin</button>
          </div>`).join('')
      }</div>`
    : '<div style="padding:14px 0;color:var(--text-faint);font-size:13px">All approved listings are already pinned.</div>';
}

function setPinnedView(v) { _pinnedView = v; renderAPinned(); }

// ADMIN STUDENTS
async function renderAStudents() {
  const filterEl = document.getElementById('aStuFilterPanel');
  const empty = msg => { document.getElementById('aStuTb').innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-faint);font-size:13px">${msg}</td></tr>`; };

  const sortMap = {
    newest:   { col: 'created_at', asc: false },
    oldest:   { col: 'created_at', asc: true  },
    az:       { col: 'first_name', asc: true   },
    za:       { col: 'first_name', asc: false  },
    listings: { col: 'created_at', asc: false  },
  };
  const srt = sortMap[_stuSort] || sortMap.newest;
  let query = supabaseClient.from('profiles').select('*').order(srt.col, { ascending: srt.asc });

  // search (server-side ilike on name + email)
  if (_stuSearch.trim()) {
    const q = _stuSearch.trim();
    query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`);
  }

  // school scoping
  let schoolSlugs = [];
  if (aAdminSchool) {
    query = query.eq('school', aAdminSchool);
  } else {
    const { data: schoolRows } = await supabaseClient.from('profiles').select('school').not('school', 'is', null);
    schoolSlugs = ['all', ...new Set((schoolRows || []).map(r => r.school).filter(Boolean))].sort((a,b) => a==='all'?-1:b==='all'?1:a.localeCompare(b));
    if (_stuSchoolFilter !== 'all') query = query.eq('school', _stuSchoolFilter);
  }

  // status (includes recently-reinstated cross-table path)
  if (_stuStatusFilter === 'active' || _stuStatusFilter === 'suspended') {
    query = query.eq('status', _stuStatusFilter);
  } else if (_stuStatusFilter === 'recently_reinstated') {
    const cutoff = new Date(Date.now() - 30*24*60*60*1000).toISOString();
    const { data: rRows } = await supabaseClient.from('suspension_history').select('profile_id').eq('action','reinstated').gte('created_at', cutoff);
    const rIds = [...new Set((rRows||[]).map(r=>r.profile_id).filter(Boolean))];
    if (!rIds.length) { empty('No students reinstated in the last 30 days.'); buildStuFilterPanel(filterEl,schoolSlugs); buildStuActiveChips(); _stuResultCount(0,true); return; }
    query = query.in('id', rIds);
  }

  // year
  if (_stuYearFilter !== 'all') query = query.eq('year', _stuYearFilter);

  // major
  if (_stuMajorSearch.trim()) query = query.ilike('major', `%${_stuMajorSearch.trim()}%`);

  // activity flags (cross-table look-up → restrict to matching IDs)
  if (_stuFlagFilter === 'has_appeal') {
    const { data: aRows } = await supabaseClient.from('appeals').select('profile_id').eq('status','open');
    const aIds = [...new Set((aRows||[]).map(r=>r.profile_id).filter(Boolean))];
    if (!aIds.length) { empty('No students with open appeals.'); buildStuFilterPanel(filterEl,schoolSlugs); buildStuActiveChips(); _stuResultCount(0,true); return; }
    query = query.in('id', aIds);
  } else if (_stuFlagFilter === 'has_report_filed') {
    const { data: rRows } = await supabaseClient.from('reports').select('reporter_id').not('reporter_id','is',null);
    const rIds = [...new Set((rRows||[]).map(r=>r.reporter_id).filter(Boolean))];
    if (!rIds.length) { empty('No students have filed reports.'); buildStuFilterPanel(filterEl,schoolSlugs); buildStuActiveChips(); _stuResultCount(0,true); return; }
    query = query.in('id', rIds);
  }

  const { data: students } = await query;
  if (!students) return;

  // listing counts (parallel fetch)
  const studentIds = students.map(s => s.id);
  const { data: lRows } = studentIds.length
    ? await supabaseClient.from('listings').select('poster_id').in('poster_id', studentIds)
    : { data: [] };
  const lCount = {};
  (lRows || []).forEach(l => { lCount[l.poster_id] = (lCount[l.poster_id] || 0) + 1; });

  // client-side sort for "most listings"
  if (_stuSort === 'listings') students.sort((a,b) => (lCount[b.id]||0) - (lCount[a.id]||0));

  // auto-open panel when panel-level filters are active
  const panelFiltered = _stuSchoolFilter !== 'all' || _stuStatusFilter !== 'all' || _stuYearFilter !== 'all' || _stuMajorSearch.trim() || _stuFlagFilter !== 'none';
  if (panelFiltered) ensureFilterOpen('aStuFilterPanel', 'aStuFilterBtn');

  buildStuFilterPanel(filterEl, schoolSlugs);
  buildStuActiveChips();

  const anyFilter = panelFiltered || _stuSearch.trim();
  _stuResultCount(students.length, !!anyFilter);

  // sync sort select
  const sortSel = document.getElementById('stuSortSelect');
  if (sortSel) sortSel.value = _stuSort;

  document.getElementById('aStuTb').innerHTML = students.length ? students.map(st => {
    const suspended = st.status === 'suspended';
    const statusPill = `<span class="pill ${suspended ? 'pill-suspended' : 'pill-active'}">${esc(st.status || 'active')}</span>`;
    const actionBtn = suspended
      ? `<button class="btn-sm-a btn-a-success" onclick="aReinstate('${st.id}')">Reinstate</button>`
      : isProtectedAdmin(st.id) ? ''
      : `<button class="btn-sm-a btn-a-danger" onclick="aOpenSuspend('${st.id}')">Suspend</button>`;
    const schoolBadge = st.school ? `<span class="school-chip">${esc(st.school)}</span>` : '—';
    return `<tr>
      <td style="font-weight:500"><span class="stu-link-a" onclick="aOpenStudentHistory('${st.id}')">${esc(st.first_name)} ${esc(st.last_name)}</span></td>
      <td style="color:var(--text-muted)">${esc(st.email || '—')}</td>
      <td>${esc(st.major || '—')}</td><td>${esc(st.year || '—')}</td>
      <td>${schoolBadge}</td>
      <td style="text-align:center">${lCount[st.id] || 0}</td>
      <td style="color:var(--text-faint)">${st.created_at ? new Date(st.created_at).toLocaleDateString() : '—'}</td>
      <td>${statusPill}</td>
      <td style="max-width:180px;color:${suspended ? 'var(--danger)' : 'var(--text-faint)'};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${suspended && st.suspension_reason ? esc(st.suspension_reason) : '—'}</td>
      <td><div class="arow">
        <button class="btn-sm-a btn-a-neutral" onclick="aViewStu('${st.id}')">View</button>
        ${actionBtn}
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-faint);font-size:13px">No students match your filters.</td></tr>`;
}

function _stuResultCount(n, show) {
  const el = document.getElementById('stuResultCount');
  if (!el) return;
  el.style.display = show ? '' : 'none';
  if (show) el.textContent = `${n} student${n === 1 ? '' : 's'} match`;
}

function buildStuFilterPanel(filterEl, schoolSlugs) {
  if (!filterEl) return;
  const toLabel = s => s === 'all' ? 'All schools' : s.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
  const secHead = aFieldLabel, chipRow = aChipRow; // shared — see top of the admin UI helpers
  const div = `<div style="border-top:1px solid var(--border);margin:2px 0"></div>`;

  const statusOpts = [
    { v:'all',                 l:'All'                  },
    { v:'active',              l:'Active'               },
    { v:'suspended',           l:'Suspended'            },
    { v:'recently_reinstated', l:'Recently reinstated'  },
  ];
  const yearOpts = [
    { v:'all',       l:'All years'  },
    { v:'Freshman',  l:'Freshman'   },
    { v:'Sophomore', l:'Sophomore'  },
    { v:'Junior',    l:'Junior'     },
    { v:'Senior',    l:'Senior'     },
    { v:'Graduate',  l:'Graduate'   },
  ];
  const flagOpts = [
    { v:'none',            l:'None'                },
    { v:'has_appeal',      l:'&#9873; Open appeal' },
    { v:'has_report_filed',l:'&#128270; Filed a report' },
  ];

  let schoolSection = '';
  if (aAdminSchool) {
    schoolSection = `<div>${secHead('School')}<span class="school-chip">&#128274; ${aAdminSchool} only</span></div>`;
  } else if (schoolSlugs.length > 1) {
    schoolSection = `<div>${secHead('School')}${chipRow(schoolSlugs.map(s=>({v:s,l:toLabel(s)})), _stuSchoolFilter, '_setStuSchool')}</div>`;
  }

  filterEl.innerHTML = `
    <div>${secHead('Status')}${chipRow(statusOpts, _stuStatusFilter, '_setStuStatus')}</div>
    ${schoolSection}
    ${div}
    <div>${secHead('Year')}${chipRow(yearOpts, _stuYearFilter, '_setStuYear')}</div>
    <div>${secHead('Major')}<input type="text" class="a-sbar" id="stuMajorInput" placeholder="Search major…" value="${_stuMajorSearch.replace(/"/g,'&quot;')}" oninput="_stuMajorSearch=this.value;renderAStudents()" style="max-width:280px"></div>
    ${div}
    <div>${secHead('Activity flags')}${chipRow(flagOpts, _stuFlagFilter, '_setStuFlag')}</div>
  `;
}

function buildStuActiveChips() {
  const el = document.getElementById('stuActiveChips');
  if (!el) return;
  const chips = [];
  const statusLabels = { active:'Active', suspended:'Suspended', recently_reinstated:'Recently reinstated' };
  const flagLabels   = { has_appeal:'Open appeal', has_report_filed:'Has filed report' };

  if (_stuSearch.trim())          chips.push([`Search: "${_stuSearch.trim()}"`,         '_stuClearSearch()']);
  if (_stuStatusFilter !== 'all') chips.push([`Status: ${statusLabels[_stuStatusFilter]}`, '_stuClearStatus()']);
  if (!aAdminSchool && _stuSchoolFilter !== 'all') {
    const sl = _stuSchoolFilter.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    chips.push([`School: ${sl}`, '_stuClearSchool()']);
  }
  if (_stuYearFilter !== 'all')   chips.push([`Year: ${_stuYearFilter}`,                 '_stuClearYear()']);
  if (_stuMajorSearch.trim())     chips.push([`Major: "${_stuMajorSearch.trim()}"`,       '_stuClearMajor()']);
  if (_stuFlagFilter !== 'none')  chips.push([`Flag: ${flagLabels[_stuFlagFilter]}`,      '_stuClearFlag()']);

  if (!chips.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.innerHTML = chips.map(([label, fn]) =>
    `<button class="filter-chip active" onclick="${fn}" style="display:flex;align-items:center;gap:4px">${label} <span style="font-size:10px;opacity:.65">&#10005;</span></button>`
  ).join('') + (chips.length > 1
    ? `<button onclick="clearStuFilters()" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px 8px;text-decoration:underline;align-self:center">Clear all</button>`
    : '');
}

function _setStuSchool(v) { _stuSchoolFilter = v; renderAStudents(); }
function _setStuStatus(v) { _stuStatusFilter = v; renderAStudents(); }
function _setStuYear(v)   { _stuYearFilter   = v; renderAStudents(); }
function _setStuFlag(v)   { _stuFlagFilter   = v; renderAStudents(); }

function _stuClearSearch() { _stuSearch = ''; const i = document.getElementById('stuSearchInput'); if (i) i.value = ''; renderAStudents(); }
function _stuClearStatus() { _stuStatusFilter = 'all';  renderAStudents(); }
function _stuClearSchool() { _stuSchoolFilter = 'all';  renderAStudents(); }
function _stuClearYear()   { _stuYearFilter   = 'all';  renderAStudents(); }
function _stuClearMajor()  { _stuMajorSearch  = '';    const i = document.getElementById('stuMajorInput'); if (i) i.value = ''; renderAStudents(); }
function _stuClearFlag()   { _stuFlagFilter   = 'none'; renderAStudents(); }

function clearStuFilters() {
  _stuSearch = ''; _stuStatusFilter = 'all'; _stuSchoolFilter = 'all';
  _stuYearFilter = 'all'; _stuMajorSearch = ''; _stuFlagFilter = 'none'; _stuSort = 'newest';
  const si = document.getElementById('stuSearchInput'); if (si) si.value = '';
  const ss = document.getElementById('stuSortSelect');  if (ss) ss.value = 'newest';
  renderAStudents();
}

function setStudentFilter(school, status) {
  if (school !== null) _stuSchoolFilter = school;
  if (status !== null) _stuStatusFilter = status;
  renderAStudents();
}

function goToStudentsFiltered(school, status) {
  _stuSchoolFilter = school || 'all';
  _stuStatusFilter = status || 'all';
  const btn = [...document.querySelectorAll('.a-nav-item')].find(b => b.getAttribute('onclick')?.includes("'students'"));
  const src = _anaNavSource;
  ago('students', btn || null);
  if (src) { _anaNavSource = src; _reapplyAnaBreadcrumb('students'); }
}

function goToListingsFiltered(school, type) {
  if (school !== null && school !== undefined) _listingSchoolFilter = school || 'all';
  if (type   !== null && type   !== undefined) _listingTypeFilter   = type   || 'all';
  const btn = [...document.querySelectorAll('.a-nav-item')].find(b => b.getAttribute('onclick')?.includes("'listings'"));
  const src = _anaNavSource;
  ago('listings', btn || null);
  if (src) { _anaNavSource = src; _reapplyAnaBreadcrumb('listings'); }
}

function goToReportsFiltered(school) {
  _reportSchoolFilter = school || 'all';
  const btn = [...document.querySelectorAll('.a-nav-item')].find(b => b.getAttribute('onclick')?.includes("'reports'"));
  const src = _anaNavSource;
  ago('reports', btn || null);
  if (src) { _anaNavSource = src; _reapplyAnaBreadcrumb('reports'); }
}

async function aViewStu(id) {
  const { data: s, error } = await supabaseClient.from('profiles').select('*').eq('id', id).single();
  if (error || !s) { toast('Could not load student profile.'); return; }
  const suspended = s.status === 'suspended';
  const initials = ((s.first_name?.[0] || '') + (s.last_name?.[0] || '')).toUpperCase();
  const color = s.color || AC[0];
  const actionBtn = suspended
    ? `<button class="btn-sm-a btn-a-success" style="flex:1;padding:9px;font-size:13px" onclick="closeModal('aStuModal');aReinstate('${s.id}')">Reinstate</button>`
    : isProtectedAdmin(s.id) ? ''
    : `<button class="btn-sm-a btn-a-danger" style="flex:1;padding:9px;font-size:13px" onclick="closeModal('aStuModal');aOpenSuspend('${s.id}')">Suspend</button>`;
  document.getElementById('aStuBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
      <div style="width:48px;height:48px;border-radius:50%;background:${escAttr(color)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600">${esc(initials)}</div>
      <div><div style="font-size:17px;font-weight:600">${esc(s.first_name)} ${esc(s.last_name)}</div><div style="font-size:12px;color:var(--text-muted)">${esc(s.email || '—')}</div><span class="pill ${suspended ? 'pill-suspended' : 'pill-active'}" style="margin-top:4px;display:inline-flex">${esc(s.status || 'active')}</span></div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><label style="color:var(--text-muted)">Major</label><span>${esc(s.major || '—')}</span></div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><label style="color:var(--text-muted)">Year</label><span>${esc(s.year || '—')}</span></div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;"><label style="color:var(--text-muted)">Listings</label><span>0</span></div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:13px;"><label style="color:var(--text-muted)">Joined</label><span>${s.created_at ? new Date(s.created_at).toLocaleDateString() : '—'}</span></div>
    <div style="margin-top:14px;display:flex;gap:8px;">${actionBtn}</div>`;
  openModal('aStuModal');
}

function aOpenSuspend(id) { aSuspendId = id; document.getElementById('suspReason').value = ''; openModal('suspendModal'); }
async function confirmSuspend() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (user && aSuspendId === user.id) { toast('You cannot suspend your own admin account.'); return; }
  const reason = document.getElementById('suspReason').value.trim();
  const [{ error }, { data: stuProfile }] = await Promise.all([
    supabaseClient.from('profiles').update({ status: 'suspended', suspension_reason: reason || null }).eq('id', aSuspendId),
    supabaseClient.from('profiles').select('school, first_name, last_name').eq('id', aSuspendId).single()
  ]);
  if (error) { toast('Could not suspend — please try again.'); console.error(error.message); return; }
  const capturedReportId = _pendingReportId;
  await supabaseClient.from('suspension_history').insert({
    profile_id: aSuspendId, action: 'suspended', reason: reason || null,
    actioned_by: user?.id, school: stuProfile?.school || null,
    report_id: _pendingReportId || null, listing_id: _pendingListingId || null
  });
  if (_pendingReportId) {
    await supabaseClient.from('reports').update({
      status: 'actioned', resolved_by: user?.id, resolved_at: new Date().toISOString(),
      resolution_note: 'Poster suspended by admin'
    }).eq('id', _pendingReportId);
    _pendingReportId = null; _pendingListingId = null;
    updateReportsBadge(); renderAReports();
  }
  const stuName = stuProfile ? `${stuProfile.first_name || ''} ${stuProfile.last_name || ''}`.trim() || 'Student' : 'Student';
  DB.log.unshift({ type: 'suspend', text: 'Student suspended', time: 'Just now', color: '#c0392b' });
  logAdminAction('suspend_student', { targetType: 'student', targetId: aSuspendId, targetLabel: stuName, school: stuProfile?.school, reason, reportId: capturedReportId });
  closeModal('suspendModal'); renderAStudents(); toast('Student suspended');
}
async function aReinstate(profileId, appealId = null) {
  const updates = [
    supabaseClient.from('profiles').update({ status: 'active', suspension_reason: null }).eq('id', profileId)
  ];
  if (appealId) updates.push(supabaseClient.from('appeals').update({ status: 'resolved_reinstated' }).eq('id', appealId));
  const results = await Promise.all(updates);
  const error = results.find(r => r.error)?.error;
  if (error) { toast('Could not reinstate — please try again.'); console.error(error.message); return; }
  const [{ data: { user } }, { data: stuProfile }] = await Promise.all([
    supabaseClient.auth.getUser(),
    supabaseClient.from('profiles').select('school, first_name, last_name').eq('id', profileId).single()
  ]);
  await supabaseClient.from('suspension_history').insert({ profile_id: profileId, action: 'reinstated', actioned_by: user?.id, school: stuProfile?.school || null });
  if (appealId) {
    const { error: logErr } = await supabaseClient.from('appeal_audit_log').insert({ appeal_id: appealId, action: 'resolved_reinstated', new_status: 'resolved_reinstated', actioned_by: user?.id });
    if (logErr) console.error('Audit log error:', logErr.message);
    aNotifyStudent(profileId, 'appeal_resolved', 'Your appeal has been reviewed. Decision: Reinstated — your account has been restored. Welcome back!');
  }
  const stuName = stuProfile ? `${stuProfile.first_name || ''} ${stuProfile.last_name || ''}`.trim() || 'Student' : 'Student';
  DB.log.unshift({ type: 'reinstate', text: 'Student reinstated', time: 'Just now', color: '#1a7a45' });
  logAdminAction('reinstate_student', { targetType: 'student', targetId: profileId, targetLabel: stuName, school: stuProfile?.school, appealId });
  await loadListings(); renderListings(); renderAStudents();
  updateAppealsBadge(); renderAppeals();
  toast('Student reinstated');
}

async function aOpenStudentHistory(profileId) {
  if (!_histGoingBack) {
    const activeSection = document.querySelector('.a-section.active');
    const curId = activeSection?.id?.replace('asec-', '') || 'students';
    if (curId === 'student-history' && _histCurrentProfileId) {
      // already inside a profile — push the current profile onto the stack
      const curName = document.getElementById('aTopTitle')?.textContent || 'Student record';
      _histStack.push({ type: 'profile', value: _histCurrentProfileId, name: curName });
    } else {
      // entering from a regular admin section — reset the stack fresh
      _histStack = [{ type: 'section', value: curId }];
    }
  }
  _histGoingBack = false;
  _histCurrentProfileId = profileId;
  document.querySelectorAll('.a-section').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.a-nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('asec-student-history').classList.add('active');
  document.getElementById('aTopTitle').textContent = 'Student record';
  document.getElementById('aHistBody').innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-faint);font-size:14px">Loading…</div>';

  const [{ data: profile }, { data: listings }, { data: books }, { data: reportsBy }, { data: suspHistory }, { data: appeals }] = await Promise.all([
    supabaseClient.from('profiles').select('*').eq('id', profileId).single(),
    supabaseClient.from('listings').select('id, title, status, created_at, category, emoji, photo_urls, price').eq('poster_id', profileId).order('created_at', { ascending: false }),
    supabaseClient.from('book_listings').select('id, title, author, status, lifecycle_status, created_at, book_type, price, photo_urls').eq('poster_id', profileId).order('created_at', { ascending: false }),
    supabaseClient.from('reports').select('*, listing:listing_id(title)').eq('reporter_id', profileId).order('created_at', { ascending: false }),
    supabaseClient.from('suspension_history').select('*').eq('profile_id', profileId).order('created_at', { ascending: false }),
    supabaseClient.from('appeals').select('id, status, created_at, message').eq('profile_id', profileId).order('created_at', { ascending: false })
  ]);

  let reportsAgainst = [];
  const listingIds = (listings || []).map(l => l.id);
  if (listingIds.length > 0) {
    const { data: ra } = await supabaseClient.from('reports').select('*, listing:listing_id(title)').in('listing_id', listingIds).order('created_at', { ascending: false });
    reportsAgainst = ra || [];
  }

  renderStudentHistory(profile, listings || [], books || [], reportsBy || [], reportsAgainst, suspHistory || [], appeals || []);
}

function renderStudentHistory(profile, listings, books, reportsBy, reportsAgainst, suspHistory, appeals) {
  const body = document.getElementById('aHistBody');
  if (!profile) {
    body.innerHTML = `<div class="tcard" style="padding:40px;text-align:center;color:var(--text-muted)">
      <div style="font-size:40px;margin-bottom:12px">👤</div>
      <div style="font-size:15px;font-weight:500">This account no longer exists.</div>
      <button onclick="aBackFromHistory()" style="margin-top:16px;background:var(--bg);border:1px solid var(--border);padding:9px 20px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-family:'DM Sans',sans-serif">← Back</button>
    </div>`;
    return;
  }

  const suspended = profile.status === 'suspended';
  const initials = ((profile.first_name?.[0] || '') + (profile.last_name?.[0] || '')).toUpperCase();
  const color = profile.color || AC[0];
  const joined = profile.created_at ? new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—';
  const timesSuspended = suspHistory.filter(e => e.action === 'suspended').length;
  const schoolLabel = profile.school || 'caldwell';
  _histListings = listings;
  _histBooks = books;
  _histListingView = 'list';
  const actionBtn = suspended
    ? `<button class="btn-sm-a btn-a-success" onclick="aReinstate('${profile.id}')">Reinstate</button>`
    : isProtectedAdmin(profile.id) ? ''
    : `<button class="btn-sm-a btn-a-danger" onclick="aOpenSuspend('${profile.id}')">Suspend</button>`;

  // pill helper
  const statusPill = s => {
    const map = { approved:'pill-approved', pinned:'pill-pinned', pending:'pill-pending', rejected:'pill-rejected' };
    return `<span class="pill ${map[s] || 'pill-pending'}" style="font-size:11px;flex-shrink:0">${s}</span>`;
  };

  // report status badge helper
  const rBadge = r => {
    const cfg = r.status === 'open' ? ['#fde8e8','#c0392b','Open'] : r.status === 'dismissed' ? ['#f0f0f0','#888','Dismissed'] : ['#e8f5e9','#1a7a45','Actioned'];
    return `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;background:${cfg[0]};color:${cfg[1]};white-space:nowrap;flex-shrink:0">${cfg[2]}</span>`;
  };

  // listings tab — built via buildListingsPaneHtml() using _histListings

  // report row helper (used in both tabs)
  const reportRow = r => `
    <div class="hist-row" style="flex-direction:column;gap:8px" onclick="openReportDrawer('${r.id}')">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%">
        <div>
          <div style="font-weight:500;font-size:14px">${esc(REPORT_LABELS[r.category] || r.category)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px">Re: <strong>${esc(r.listing?.title || r.listing_title_snapshot || 'Listing #' + r.listing_id)}</strong></div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:3px">${fmtDate(r.created_at)}</div>
        </div>
        ${rBadge(r)}
      </div>
      ${r.details ? `<div style="font-size:12px;color:var(--text-muted);background:var(--bg);padding:8px 12px;border-radius:6px;line-height:1.5;width:100%">"${esc(r.details)}"</div>` : ''}
      ${r.resolution_note ? `<div style="font-size:12px;color:var(--success);font-weight:500">✓ ${esc(r.resolution_note)}</div>` : ''}
    </div>`;

  // suspension history tab
  const historyPane = suspHistory.length ? `<div class="susp-timeline" style="padding:20px">${suspHistory.map(e => {
    const isSuspend = e.action === 'suspended';
    const triggerLine = isSuspend && e.report_id
      ? `<div style="font-size:12px;color:var(--text-faint);margin-top:3px">Triggered by a report${e.listing_id ? ` on listing #${e.listing_id}` : ''} — <span class="stu-link-a" onclick="openReportDrawer('${e.report_id}')">view report</span></div>`
      : '';
    return `<div class="susp-entry">
      <div class="susp-dot" style="background:${isSuspend ? 'var(--danger)' : 'var(--success)'}"></div>
      <div>
        <div style="font-size:14px;font-weight:600;color:${isSuspend ? 'var(--danger)' : 'var(--success)'}">${isSuspend ? 'Suspended' : 'Reinstated'}</div>
        ${e.reason ? `<div style="font-size:13px;color:var(--text-muted);margin-top:3px">${esc(e.reason)}</div>` : ''}
        ${triggerLine}
        <div style="font-size:12px;color:var(--text-faint);margin-top:3px">${fmtDate(e.created_at)}</div>
      </div>
    </div>`;
  }).join('')}</div>` : '<div class="hist-empty">No suspension history.</div>';

  body.innerHTML = `
    <button onclick="aBackFromHistory()" style="display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);font-family:'DM Sans',sans-serif;padding:0 0 16px" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-muted)'">← Back</button>

    <div class="tcard" style="margin-bottom:16px">
      <div style="padding:20px 24px;display:flex;align-items:center;gap:16px;justify-content:space-between;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:54px;height:54px;border-radius:50%;background:${escAttr(color)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:600;flex-shrink:0">${esc(initials)}</div>
          <div>
            <div style="font-size:20px;font-weight:600;line-height:1.2">${esc(profile.display_name || (profile.first_name + ' ' + profile.last_name))}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:2px">${esc(profile.email || '—')}</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
              <span class="pill ${suspended ? 'pill-suspended' : 'pill-active'}">${esc(profile.status || 'active')}</span>
              <span style="font-size:12px;background:var(--brand-pale);color:var(--brand);padding:3px 10px;border-radius:20px;font-weight:500;text-transform:capitalize">${esc(schoolLabel)}</span>
              ${profile.major ? `<span style="font-size:12px;color:var(--text-muted)">${esc(profile.major)} · ${esc(profile.year || '')}</span>` : ''}
              <span style="font-size:12px;color:var(--text-faint)">Joined ${joined}</span>
            </div>
          </div>
        </div>
        <div>${actionBtn}</div>
      </div>
      <div class="hist-stat-grid">
        <div class="hist-stat" style="cursor:pointer" onclick="switchHistoryTab('listings')">
          <div class="hist-stat-num">${listings.length + books.length}</div><div class="hist-stat-label">Listings posted</div>
        </div>
        <div class="hist-stat" style="cursor:pointer" onclick="switchHistoryTab('reports-filed')">
          <div class="hist-stat-num">${reportsBy.length}</div><div class="hist-stat-label">Reports filed</div>
        </div>
        <div class="hist-stat" style="cursor:pointer" onclick="switchHistoryTab('reports-received')">
          <div class="hist-stat-num">${reportsAgainst.length}</div><div class="hist-stat-label">Reports received</div>
        </div>
        <div class="hist-stat" style="cursor:pointer" onclick="switchHistoryTab('history')">
          <div class="hist-stat-num">${timesSuspended}</div><div class="hist-stat-label">Times suspended</div>
        </div>
        <div class="hist-stat" style="cursor:pointer" onclick="switchHistoryTab('appeals')">
          <div class="hist-stat-num">${appeals.length}</div><div class="hist-stat-label">Appeals filed</div>
        </div>
      </div>
    </div>

    <div class="tcard">
      <div style="display:flex;border-bottom:1px solid var(--border);overflow-x:auto">
        <button class="htab active" id="htab-listings"         onclick="switchHistoryTab('listings')">Listings <span style="opacity:.6">(${listings.length})</span></button>
        <button class="htab"        id="htab-books"            onclick="switchHistoryTab('books')">Books <span style="opacity:.6">(${books.length})</span></button>
        <button class="htab"        id="htab-reports-filed"    onclick="switchHistoryTab('reports-filed')">Reports filed <span style="opacity:.6">(${reportsBy.length})</span></button>
        <button class="htab"        id="htab-reports-received" onclick="switchHistoryTab('reports-received')">Reports received <span style="opacity:.6">(${reportsAgainst.length})</span></button>
        <button class="htab"        id="htab-history"          onclick="switchHistoryTab('history')">Suspension history <span style="opacity:.6">(${timesSuspended})</span></button>
        <button class="htab"        id="htab-appeals"          onclick="switchHistoryTab('appeals')">Appeals <span style="opacity:.6">(${appeals.length})</span></button>
      </div>
      <div id="htab-pane-listings"         class="htab-pane active">${buildListingsPaneHtml()}</div>
      <div id="htab-pane-books"            class="htab-pane">${buildBooksHistoryPaneHtml()}</div>
      <div id="htab-pane-reports-filed"    class="htab-pane">${reportsBy.length ? reportsBy.map(reportRow).join('') : '<div class="hist-empty">No reports filed.</div>'}</div>
      <div id="htab-pane-reports-received" class="htab-pane">${reportsAgainst.length ? reportsAgainst.map(reportRow).join('') : '<div class="hist-empty">No reports received.</div>'}</div>
      <div id="htab-pane-history"          class="htab-pane">${historyPane}</div>
      <div id="htab-pane-appeals"          class="htab-pane">${appeals.length ? appeals.map(a => {
        const statusMap = { open: ['#c0392b','Open'], resolved_reinstated: ['#1a7a45','Reinstated'], resolved_upheld: ['#888','Upheld'] };
        const [color, label] = statusMap[a.status] || ['#888', a.status];
        const excerpt = (a.message || '').slice(0, 120) + ((a.message || '').length > 120 ? '…' : '');
        return `<div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="background:${color}22;color:${color};border-radius:20px;padding:3px 11px;font-size:12px;font-weight:600">${label}</span>
            <span style="font-size:12px;color:var(--text-faint)">${fmtDate(a.created_at)}</span>
          </div>
          <div style="font-size:13px;color:var(--text-muted);line-height:1.5">${excerpt ? esc(excerpt) : '<em>No message text.</em>'}</div>
        </div>`;
      }).join('') : '<div class="hist-empty">No appeals filed.</div>'}</div>
    </div>`;
}

function switchHistoryTab(tab) {
  document.querySelectorAll('.htab').forEach(b => b.classList.remove('active'));
  document.getElementById('htab-' + tab)?.classList.add('active');
  document.querySelectorAll('.htab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('htab-pane-' + tab)?.classList.add('active');
}

function openHDrawer(title, html) {
  document.getElementById('hDrawerTitle').innerHTML = title;
  document.getElementById('hDrawerBody').innerHTML = html;
  document.getElementById('hDrawer').classList.add('open');
  document.getElementById('hDrawerOverlay').classList.add('open');
}

function closeHDrawer() {
  document.getElementById('hDrawer').classList.remove('open');
  document.getElementById('hDrawerOverlay').classList.remove('open');
}

function setHistListingView(v) {
  _histListingView = v;
  const pane = document.getElementById('htab-pane-listings');
  if (pane) pane.innerHTML = buildListingsPaneHtml();
  document.getElementById('hv-list')?.classList.toggle('active', v === 'list');
  document.getElementById('hv-grid')?.classList.toggle('active', v === 'grid');
}

function buildListingsPaneHtml() {
  if (!_histListings.length) return '<div class="hist-empty">No listings posted yet.</div>';
  const sPill = s => aStatusPill(s, true); // compact — shared helper
  const toolbar = `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);gap:8px">
    <span style="font-size:12px;color:var(--text-muted)">${_histListings.length} listing${_histListings.length !== 1 ? 's' : ''}</span>
    <div class="view-toggle">
      <button class="view-btn ${_histListingView === 'list' ? 'active' : ''}" id="hv-list" onclick="setHistListingView('list')" title="List view">&#9776;</button>
      <button class="view-btn ${_histListingView === 'grid' ? 'active' : ''}" id="hv-grid" onclick="setHistListingView('grid')" title="Grid view">&#9632;&#9632;</button>
    </div>
  </div>`;
  if (_histListingView === 'grid') {
    return toolbar + `<div class="hist-grid">${_histListings.map(l => `
      <div class="hist-card" onclick="openListingDrawer(${l.id})">
        <div style="font-size:30px;margin-bottom:10px">${l.emoji || '🏠'}</div>
        <div style="font-weight:600;font-size:14px;line-height:1.3;margin-bottom:6px">${esc(l.title)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${esc(CATEGORY_LABELS[l.category] || l.category)}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;flex-wrap:wrap">
          ${sPill(l.status)}
          <div style="font-size:11px;color:var(--text-faint)">${fmtDate(l.created_at)}</div>
        </div>
      </div>`).join('')}</div>`;
  }
  return toolbar + _histListings.map(l => `
    <div class="hist-row" onclick="openListingDrawer(${l.id})">
      <div style="font-size:24px;width:34px;text-align:center;flex-shrink:0">${l.emoji || '🏠'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:14px">${esc(l.title)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(CATEGORY_LABELS[l.category] || l.category)} · ${fmtDate(l.created_at)}</div>
      </div>
      ${sPill(l.status)}
      <span style="font-size:14px;color:var(--text-faint);flex-shrink:0">›</span>
    </div>`).join('');
}

function buildBooksHistoryPaneHtml() {
  if (!_histBooks.length) return '<div class="hist-empty">No books posted yet.</div>';
  const sPill = s => aStatusPill(s, true); // compact — shared helper
  return _histBooks.map(b => `
    <div class="hist-row" onclick="openBookHistoryDrawer(${b.id})">
      <div style="font-size:24px;width:34px;text-align:center;flex-shrink:0">&#128218;</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:14px">${esc(b.title)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${b.book_type === 'course' ? 'Textbook' : 'Book'} · ${fmtDate(b.created_at)}</div>
      </div>
      ${sPill(b.status)}
      <span style="font-size:14px;color:var(--text-faint);flex-shrink:0">›</span>
    </div>`).join('');
}

async function openBookHistoryDrawer(bookId) {
  openHDrawer('Loading…', '<div class="drawer-loading">Loading book…</div>');
  const { data: b } = await supabaseClient.from('book_listings').select('*').eq('id', bookId).single();
  if (!b) { document.getElementById('hDrawerBody').innerHTML = '<div style="color:var(--danger);padding:20px;font-size:14px">Could not load this book.</div>'; return; }
  const sPill = s => aStatusPill(s);       // shared helper
  document.getElementById('hDrawerTitle').innerHTML = `&#128218; ${esc(b.title)}`;
  document.getElementById('hDrawerBody').innerHTML = `
    ${b.photo_urls?.length ? `<div style="margin-bottom:14px">${photoGalleryHtml(b.photo_urls, { height: 220, radius: 'var(--radius-sm)', mainId: 'drawerBookGalMain' })}</div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${sPill(b.status)}
      <span style="font-size:12px;background:var(--brand-pale);color:var(--brand);padding:2px 10px;border-radius:20px;font-weight:500">${esc(b.book_type === 'course' ? (b.course_code || 'Textbook') : (b.genre || 'Book'))}</span>
      ${b.lifecycle_status && b.lifecycle_status !== 'active' ? `<span class="pill pill-pending">${esc(b.lifecycle_status)}</span>` : ''}
    </div>
    <div style="font-size:24px;font-weight:700;color:var(--brand);margin-bottom:6px">${b.price ? '$' + b.price : 'Free'}</div>
    ${b.author ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">by ${esc(b.author)}</div>` : ''}
    ${b.isbn ? `<div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">ISBN ${esc(b.isbn)}</div>` : ''}
    ${b.condition ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Condition: ${esc(b.condition)}</div>` : ''}
    ${b.description ? `<div style="font-size:14px;line-height:1.65;color:var(--text)">${esc(b.description)}</div>` : ''}
    ${b.rejection_reason ? `<div style="margin-top:14px;font-size:12px;color:var(--danger)">Rejected: ${esc(b.rejection_reason)}</div>` : ''}
  `;
}

async function openListingDrawer(listingId) {
  openHDrawer('Loading…', '<div class="drawer-loading">Loading listing…</div>');
  const [{ data: l }, { data: sh }, { data: reps }] = await Promise.all([
    supabaseClient.from('listings').select('*').eq('id', listingId).single(),
    supabaseClient.from('admin_activity_log').select('id, action_type, before_state, after_state, reason, created_at').eq('listing_id', listingId).order('created_at', { ascending: true }),
    supabaseClient.from('reports').select('*').eq('listing_id', listingId).order('created_at', { ascending: false })
  ]);
  if (!l) { document.getElementById('hDrawerBody').innerHTML = '<div style="color:var(--danger);padding:20px;font-size:14px">Could not load this listing.</div>'; return; }
  const sPill = s => aStatusPill(s);       // shared helper
  const statusColors = { approved:'var(--success)', pinned:'#7c3aed', pending:'var(--text-muted)', rejected:'var(--danger)', removed:'var(--danger)' };
  const statusLabel = { approved:'Approved', pinned:'Pinned', pending:'Pending review', rejected:'Rejected', removed:'Removed' };
  const LISTING_EVENT_META = {
    listing_submitted: { label: 'Submitted for review', col: 'var(--text-muted)' },
    approve_listing:   { label: 'Approved',              col: 'var(--success)' },
    return_to_pending: { label: 'Returned to pending',   col: 'var(--text-muted)' },
    reject_listing:    { label: 'Rejected',              col: 'var(--danger)' },
    remove_listing:    { label: 'Removed',               col: 'var(--danger)' },
    restore_listing:   { label: 'Restored',              col: 'var(--success)' },
    pin_listing:       { label: 'Pinned',                col: '#7c3aed' },
    unpin_listing:     { label: 'Unpinned',              col: 'var(--text-muted)' },
    edit_listing:      { label: 'Edited by admin',       col: '#3B5BA5' },
  };
  const shHtml = (sh || []).length ? `
    <div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:12px">Status history</div>
      <div class="susp-timeline">${(sh || []).map(e => {
        const m = LISTING_EVENT_META[e.action_type] || { label: e.action_type, col: '#888' };
        const prevStatus = e.before_state?.status;
        return `<div class="susp-entry">
          <div class="susp-dot" style="background:${m.col}"></div>
          <div>
            <div style="font-size:13px;font-weight:600;color:${m.col}">${esc(m.label)}
              ${prevStatus ? `<span style="font-weight:400;color:var(--text-faint);font-size:11px"> ← ${esc(prevStatus)}</span>` : ''}</div>
            ${e.reason ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;line-height:1.4">${esc(e.reason)}</div>` : ''}
            <div style="font-size:11px;color:var(--text-faint);margin-top:2px">${fmtDate(e.created_at)}</div>
          </div>
        </div>`;
      }).join('')}</div>
    </div>` : '';
  const repsHtml = (reps || []).length ? `
    <div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:10px">Reports (${reps.length})</div>
      ${reps.map(r => {
        const cfg = r.status === 'open' ? ['#fde8e8','#c0392b','Open'] : r.status === 'dismissed' ? ['#f0f0f0','#888','Dismissed'] : ['#e8f5e9','#1a7a45','Actioned'];
        return `<div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:${r.details ? 6 : 0}px">
            <div style="font-size:13px;font-weight:500">${esc(REPORT_LABELS[r.category] || r.category)}</div>
            <span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:${cfg[0]};color:${cfg[1]};white-space:nowrap;flex-shrink:0">${cfg[2]}</span>
          </div>
          ${r.details ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:5px">"${esc(r.details)}"</div>` : ''}
          <div style="font-size:11px;color:var(--text-faint)">${fmtDate(r.created_at)}</div>
        </div>`;
      }).join('')}
    </div>` : '';
  document.getElementById('hDrawerTitle').innerHTML = `${l.emoji || '🏠'} ${esc(l.title)}`;
  document.getElementById('hDrawerBody').innerHTML = `
    ${l.photo_urls?.length ? `<div style="margin-bottom:14px">${photoGalleryHtml(l.photo_urls, { height: 220, radius: 'var(--radius-sm)', mainId: 'drawerGalMain' })}</div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${sPill(l.status)}
      <span style="font-size:12px;background:var(--brand-pale);color:var(--brand);padding:2px 10px;border-radius:20px;font-weight:500">${esc(CATEGORY_LABELS[l.category] || l.category)}</span>
    </div>
    ${l.price ? `<div style="font-size:24px;font-weight:700;color:var(--brand);margin-bottom:6px">$${l.price}<span style="font-size:14px;font-weight:400;color:var(--text-muted)">/mo</span></div>` : ''}
    ${l.location ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">📍 ${esc(l.location)}</div>` : ''}
    ${l.description ? `<div style="font-size:14px;line-height:1.65;color:var(--text);margin-bottom:16px">${esc(l.description)}</div>` : ''}
    ${l.tags && l.tags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">${l.tags.map(t => `<span class="atag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:10px">Posted by</div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:38px;height:38px;border-radius:50%;background:${escAttr(l.poster_color || '#3B5BA5')};color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0">${esc(l.poster_initials || '?')}</div>
        <div>
          ${l.poster_id ? `<div class="stu-link-a" style="font-size:14px;font-weight:500" onclick="closeHDrawer();aOpenStudentHistory('${l.poster_id}')">${esc(l.poster_name || 'Unknown')} <span style="font-size:11px;color:var(--text-faint)">→ view profile</span></div>` : `<div style="font-size:14px;font-weight:500">${esc(l.poster_name || 'Unknown')}</div>`}
          <div style="font-size:12px;color:var(--text-faint)">${esc(l.poster_email || '—')}</div>
        </div>
      </div>
      ${l.created_at ? `<div style="font-size:11px;color:var(--text-faint);margin-top:10px">Posted ${fmtDate(l.created_at)}</div>` : ''}
    </div>
    ${shHtml}
    ${repsHtml}
  `;
}

async function openReportDrawer(reportId) {
  openHDrawer('Report', '<div class="drawer-loading">Loading…</div>');
  const { data: r } = await supabaseClient.from('reports').select('*, listing:listing_id(id, title, emoji, status, poster_name, poster_id)').eq('id', reportId).single();
  if (!r) { document.getElementById('hDrawerBody').innerHTML = '<div style="color:var(--danger);padding:20px;font-size:14px">Could not load this report.</div>'; return; }
  const cfg = r.status === 'open' ? ['#fde8e8','#c0392b','Open'] : r.status === 'dismissed' ? ['#f0f0f0','#888','Dismissed'] : ['#e8f5e9','#1a7a45','Actioned'];
  const listing = r.listing;
  document.getElementById('hDrawerTitle').textContent = REPORT_LABELS[r.category] || r.category;
  document.getElementById('hDrawerBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <span style="font-size:12px;font-weight:600;padding:3px 11px;border-radius:20px;background:${cfg[0]};color:${cfg[1]}">${cfg[2]}</span>
      <span style="font-size:12px;color:var(--text-faint)">${fmtDate(r.created_at)}</span>
    </div>
    ${r.details ? `<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;font-size:14px;line-height:1.65;color:var(--text);margin-bottom:16px">"${esc(r.details)}"</div>` : ''}
    ${r.resolution_note ? `<div style="font-size:13px;color:var(--success);font-weight:500;padding:10px 14px;background:#f0faf4;border-radius:var(--radius-sm);margin-bottom:16px">✓ ${esc(r.resolution_note)}</div>` : ''}
    ${listing ? `<div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px">Reported listing</div>
      <div class="hist-row" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;border-bottom:none;margin-bottom:0" onclick="openListingDrawer(${listing.id})">
        <div style="font-size:22px;width:30px;text-align:center;flex-shrink:0">${listing.emoji || '🏠'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:500">${esc(listing.title)}</div>
          <div style="font-size:12px;color:var(--text-muted)">by ${esc(listing.poster_name || '—')}</div>
        </div>
        <span style="font-size:14px;color:var(--text-faint)">›</span>
      </div>
    </div>` : ''}
    ${r.reporter_id ? `<div style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px">Reported by</div>
      <div class="stu-link-a" style="font-size:14px" onclick="closeHDrawer();aOpenStudentHistory('${r.reporter_id}')">View reporter's profile →</div>
    </div>` : ''}
  `;
}

function aBackFromHistory() {
  if (!_histStack.length) { ago('students', null); return; }
  const prev = _histStack.pop();
  if (prev.type === 'section') {
    _histCurrentProfileId = null;
    const btn = [...document.querySelectorAll('.a-nav-item')].find(b => b.getAttribute('onclick')?.includes(`'${prev.value}'`));
    ago(prev.value, btn || null);
  } else {
    _histGoingBack = true;
    aOpenStudentHistory(prev.value);
  }
}

// ADMIN MESSAGES
async function renderAMessages() {
  const tbody = document.getElementById('aMsgTb');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--text-faint);font-size:13px">Loading…</td></tr>';

  const { data: msgs, error } = await supabaseClient
    .from('messages')
    .select('id, conversation_key, sender_id, receiver_id, listing_id, created_at')
    .order('created_at', { ascending: false });

  if (error) { tbody.innerHTML = `<tr><td colspan="6" style="padding:20px;color:var(--danger);font-size:13px">Could not load messages. ${error.message}</td></tr>`; return; }
  if (!msgs || msgs.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:36px;color:var(--text-faint);font-size:13px">No conversations yet.</td></tr>'; return; }

  // Deduplicate: one row per conversation_key (latest message first), count total per key
  const convMap = new Map();
  const msgCount = {};
  msgs.forEach(m => {
    msgCount[m.conversation_key] = (msgCount[m.conversation_key] || 0) + 1;
    if (!convMap.has(m.conversation_key)) convMap.set(m.conversation_key, m);
  });
  const convos = [...convMap.values()];

  // Batch-fetch participant names + listing titles
  const userIds    = [...new Set(convos.flatMap(c => [c.sender_id, c.receiver_id].filter(Boolean)))];
  const listingIds = [...new Set(convos.map(c => c.listing_id).filter(Boolean))];
  const [{ data: profiles }, { data: listings }] = await Promise.all([
    userIds.length    ? supabaseClient.from('profiles').select('id, first_name, last_name, email, school').in('id', userIds) : { data: [] },
    listingIds.length ? supabaseClient.from('listings').select('id, title').in('id', listingIds)                      : { data: [] }
  ]);

  const pMap = {};
  (profiles || []).forEach(p => { pMap[p.id] = p; });
  const lMap = {};
  (listings || []).forEach(l => { lMap[l.id] = l; });

  const getName = id => {
    const p = pMap[id];
    if (!p) return '—';
    return ((p.first_name || '') + (p.last_name ? ' ' + p.last_name : '')).trim() || p.email || '—';
  };
  const getSchoolBadge = id => {
    const s = pMap[id]?.school;
    return s ? `<span class="school-chip" style="margin-left:4px;vertical-align:middle">${esc(s.replace(/_/g,' '))}</span>` : '';
  };

  tbody.innerHTML = convos.map(c => {
    // getName/listing carry student-typed text — escape here; getSchoolBadge returns finished HTML.
    const participants = `${esc(getName(c.sender_id))}${getSchoolBadge(c.sender_id)} ↔ ${esc(getName(c.receiver_id))}${getSchoolBadge(c.receiver_id)}`;
    const listing = c.listing_id ? (lMap[c.listing_id]?.title || `Listing #${c.listing_id}`) : '—';
    const count   = msgCount[c.conversation_key] || 1;
    return `<tr>
      <td style="font-weight:500">${participants}</td>
      <td style="color:var(--text-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(listing)}</td>
      <td style="text-align:center">${count}</td>
      <td style="color:var(--text-faint)">${fmtDate(c.created_at)}</td>
      <td><span class="pill pill-active">active</span></td>
      <td><button class="btn-sm-a btn-a-neutral" onclick="toast('Full viewer coming soon')">View log</button></td>
    </tr>`;
  }).join('');
}

// ADMIN REPORTS
const REPORT_LABELS = {
  scam_or_fraud: 'Scam or fraud', not_a_student: 'Not a student',
  wrong_price: 'Wrong / misleading price', duplicate_listing: 'Duplicate listing',
  inappropriate_content: 'Inappropriate content', suspicious: 'Suspicious activity', other: 'Other'
};

async function renderAReports() {
  const wrap = document.getElementById('aReportsWrap');
  wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted)">Loading reports…</p>';

  const { data: allReports, error } = await supabaseClient
    .from('reports')
    .select('*, reporter:reporter_id(first_name, last_name, email), listing:listing_id(id, title, emoji, poster_id, poster_name, school), suspension:suspension_history(profile_id)')
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted)">Could not load reports.</p>'; return; }
  if (!allReports || allReports.length === 0) { wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted)">No reports yet.</p>'; return; }

  // School list for filter panel
  const reportSchools = !aAdminSchool
    ? ['all', ...new Set(allReports.map(r => r.listing?.school).filter(Boolean))].sort((a,b) => a==='all'?-1:b==='all'?1:a.localeCompare(b))
    : [];

  // Client-side filtering on the full fetch
  const schoolF = aAdminSchool || (_reportSchoolFilter !== 'all' ? _reportSchoolFilter : null);
  let reports = schoolF ? allReports.filter(r => r.listing?.school === schoolF) : [...allReports];
  if (_reportStatusFilter !== 'all') reports = reports.filter(r => r.status === _reportStatusFilter);
  if (_reportCatFilter !== 'all')    reports = reports.filter(r => r.category === _reportCatFilter);
  if (_reportSearch.trim()) {
    const q = _reportSearch.trim().toLowerCase();
    reports = reports.filter(r => {
      const rep   = r.reporter ? `${r.reporter.first_name||''} ${r.reporter.last_name||''} ${r.reporter.email||''}`.toLowerCase() : '';
      const poster = (r.listing?.poster_name || '').toLowerCase();
      const title  = (r.listing?.title || r.listing_title_snapshot || '').toLowerCase();
      return rep.includes(q) || poster.includes(q) || title.includes(q);
    });
  }

  buildRepFilterPanel(reportSchools);
  buildRepActiveChips();

  const panelFiltered = _reportSchoolFilter !== 'all' || _reportStatusFilter !== 'all' || _reportCatFilter !== 'all';
  if (panelFiltered) ensureFilterOpen('aReportFilterPanel', 'aReportFilterBtn');

  const openCount = reports.filter(r => r.status === 'open').length;
  const countEl = document.getElementById('repResultCount');
  if (countEl) countEl.innerHTML = reports.length
    ? `${reports.length} report${reports.length===1?'':'s'} ${openCount?`<span style="color:var(--danger);font-weight:600">· ${openCount} open</span>`:''}`
    : '';

  const groupSel = document.getElementById('repGroupSelect');
  if (groupSel) groupSel.value = _reportGroupBy;

  if (!reports.length) {
    wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted);font-size:13px">No reports match your filters.</p>';
    return;
  }

  const card = r => {
    const isOpen       = r.status === 'open';
    const reporterName = r.reporter ? `${r.reporter.first_name||''} ${r.reporter.last_name||''}`.trim() || r.reporter.email : '—';
    const listingTitle = r.listing?.title || r.listing_title_snapshot || `Listing #${r.listing_id}`;
    const posterName   = r.listing?.poster_name || '—';
    const posterId     = r.listing?.poster_id  || null;
    const listingExists= !!r.listing;
    const listingEmoji = r.listing?.emoji || '🏠';
    const statusColor  = isOpen ? '#c0392b' : r.status === 'dismissed' ? '#888' : '#1a7a45';
    const statusBg     = isOpen ? '#fde8e8' : r.status === 'dismissed' ? '#f0f0f0' : '#e8f5e9';
    const statusLabel  = isOpen ? 'Open' : r.status === 'dismissed' ? 'Dismissed' : 'Actioned';
    const actionTaken  = r.status === 'actioned' ? (r.resolution_note || 'Action taken') : 'Dismissed — no action';

    const listingEl = listingExists
      ? `<button onclick="event.stopPropagation();openListingDrawer(${r.listing_id})" style="background:none;border:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--brand);padding:0;text-align:left;font-family:'DM Sans',sans-serif;text-decoration:underline dotted">${listingEmoji} ${esc(listingTitle)}</button>`
      : `<span style="font-size:13px;font-weight:500;color:var(--text-muted)">${listingEmoji} "${esc(listingTitle)}" <span style="font-size:11px;color:var(--text-faint);font-style:italic">(removed)</span></span>`;

    const repEl = r.reporter_id
      ? `<span class="stu-link-a" onclick="event.stopPropagation();aOpenStudentHistory('${r.reporter_id}')" style="font-size:12px">${esc(reporterName)}</span>`
      : `<span style="font-size:12px;color:var(--text-muted)">${esc(reporterName)}</span>`;

    const pstEl = posterId
      ? `<span class="stu-link-a" onclick="event.stopPropagation();aOpenStudentHistory('${posterId}')" style="font-size:12px">${esc(posterName)}</span>`
      : `<span style="font-size:12px;color:var(--text-muted)">${esc(posterName)}</span>`;

    return `<div style="padding:14px 18px;border-bottom:1px solid var(--border);cursor:pointer" onclick="openReportDrawer('${r.id}')" onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:var(--brand-pale);color:var(--brand)">${esc(REPORT_LABELS[r.category]||r.category)}</span>
        <span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:${statusBg};color:${statusColor}">${statusLabel}</span>
        <span style="flex:1"></span>
        <span style="font-size:11px;color:var(--text-faint)">${fmtActivityTime(r.created_at)}</span>
        <span style="color:var(--text-faint);font-size:16px;margin-left:4px">›</span>
      </div>
      <div style="margin-bottom:6px">${listingEl}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:${r.details?'8px':'0'}">
        Filed by ${repEl} <span style="color:var(--text-faint);margin:0 5px">→</span> about ${pstEl}
      </div>
      ${r.details ? `<div style="background:var(--bg);padding:8px 12px;border-radius:var(--radius-sm);font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;border-left:3px solid var(--border)">${esc(r.details)}</div>` : ''}
      ${isOpen
        ? `<div class="arow" onclick="event.stopPropagation()">
            <button class="btn-sm-a btn-a-success" onclick="dismissReport('${r.id}')">Dismiss</button>
            ${listingExists ? `<button class="btn-sm-a btn-a-danger" onclick="hideListingFromReport('${r.id}',${r.listing_id})">Remove listing</button>` : ''}
            ${posterId && !isProtectedAdmin(posterId) ? `<button class="btn-sm-a btn-a-danger" onclick="suspendFromReport('${r.id}','${posterId}',${r.listing_id||null})">Suspend poster</button>` : ''}
          </div>`
        : `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;flex-wrap:wrap;gap:8px" onclick="event.stopPropagation()">
            <div>
              <span style="font-size:12px;color:${statusColor};font-weight:500">&#10003; ${esc(actionTaken)}</span>
              ${r.suspension&&r.suspension.length>0?`<span style="font-size:12px;color:var(--danger);margin-left:8px">&#8594; <span class="stu-link-a" onclick="aOpenStudentHistory('${r.suspension[0].profile_id}')">view suspended student</span></span>`:''}
              <span style="font-size:11px;color:var(--text-faint);margin-left:8px">· ${fmtDate(r.resolved_at)}</span>
            </div>
            <button class="btn-sm-a btn-a-neutral" onclick="reopenReport('${r.id}')">&#8634; Reopen</button>
          </div>`
      }
    </div>`;
  };

  const renderGrouped = (rpts, field) => {
    const groups = {};
    rpts.forEach(r => {
      let key, name, profileId, linkListId;
      if (field === 'subject') {
        key = r.listing?.poster_id || '__unknown__'; name = r.listing?.poster_name || '(Unknown)'; profileId = r.listing?.poster_id || null;
      } else if (field === 'reporter') {
        key = r.reporter_id || '__unknown__';
        const rp = r.reporter; name = rp ? (`${rp.first_name||''} ${rp.last_name||''}`.trim() || rp.email || '—') : '—';
        profileId = r.reporter_id || null;
      } else {
        key = String(r.listing_id || '__unknown__'); name = r.listing?.title || r.listing_title_snapshot || `Listing #${r.listing_id}`; profileId = null; linkListId = r.listing_id;
      }
      if (!groups[key]) groups[key] = { key, name, profileId, linkListId, reports: [] };
      groups[key].reports.push(r);
    });
    return Object.values(groups).sort((a,b) => b.reports.length - a.reports.length).map(g => {
      const sk      = g.key.replace(/[^a-zA-Z0-9_-]/g,'_');
      const openCnt = g.reports.filter(r => r.status === 'open').length;
      const initial = (g.name[0]||'?').toUpperCase();
      const nameEl  = (field !== 'listing' && g.profileId)
        ? `<span class="stu-link-a" onclick="event.stopPropagation();aOpenStudentHistory('${g.profileId}')" style="font-weight:600;font-size:14px">${esc(g.name)}</span>`
        : (field === 'listing' && g.linkListId && g.reports[0]?.listing)
        ? `<button onclick="event.stopPropagation();openListingDrawer(${g.linkListId})" style="background:none;border:none;cursor:pointer;font-size:14px;font-weight:600;color:var(--brand);padding:0;font-family:'DM Sans',sans-serif;text-decoration:underline dotted">${esc(g.name)}</button>`
        : `<span style="font-weight:600;font-size:14px">${esc(g.name)}</span>`;
      return `<div class="tcard" style="margin-bottom:12px">
        <div style="padding:12px 18px;display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none" onclick="_toggleRepGroup('${sk}')">
          <div style="width:32px;height:32px;border-radius:50%;background:var(--brand-pale);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--brand);flex-shrink:0">${esc(initial)}</div>
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${nameEl}
            <span style="font-size:12px;color:var(--text-muted)">${g.reports.length} report${g.reports.length===1?'':'s'}</span>
            ${openCnt?`<span style="font-size:12px;color:var(--danger);font-weight:600">${openCnt} open</span>`:''}
          </div>
          <span id="rg-arrow-${sk}" style="color:var(--text-faint);font-size:14px">▾</span>
        </div>
        <div id="rg-body-${sk}" style="border-top:1px solid var(--border)">${g.reports.map(r=>card(r)).join('')}</div>
      </div>`;
    }).join('');
  };

  if (_reportGroupBy === 'date') {
    const open     = reports.filter(r => r.status === 'open');
    const resolved = reports.filter(r => r.status !== 'open');
    wrap.innerHTML = `
      <div class="tcard" style="margin-bottom:16px">
        <div class="tcard-head">
          <div class="tcard-title">Open reports</div>
          <span style="font-size:12px;color:var(--danger);font-weight:600">${open.length} open</span>
        </div>
        ${open.length ? open.map(card).join('') : '<p style="padding:16px 20px;color:var(--text-muted);font-size:13px">No open reports — all clear. &#10003;</p>'}
      </div>
      <div class="tcard">
        <div class="tcard-head">
          <div class="tcard-title">Report history</div>
          <span style="font-size:12px;color:var(--text-muted);font-weight:500">${resolved.length} resolved</span>
        </div>
        ${resolved.length ? resolved.map(card).join('') : '<p style="padding:16px 20px;color:var(--text-muted);font-size:13px">No resolved reports yet.</p>'}
      </div>`;
  } else {
    const field = { subject:'subject', reporter:'reporter', listing:'listing' }[_reportGroupBy] || 'subject';
    wrap.innerHTML = renderGrouped(reports, field);
  }
}

function buildRepFilterPanel(schoolSlugs) {
  const filterEl = document.getElementById('aReportFilterPanel');
  if (!filterEl) return;
  const secHead = aFieldLabel, chipRow = aChipRow; // shared — see top of the admin UI helpers
  const div = `<div style="border-top:1px solid var(--border);margin:2px 0"></div>`;
  const toLabel = s => s==='all'?'All schools':s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

  const statusOpts = [{v:'all',l:'All'},{v:'open',l:'Open'},{v:'actioned',l:'Actioned'},{v:'dismissed',l:'Dismissed'}];
  const catOpts    = [
    {v:'all',l:'All categories'},{v:'scam_or_fraud',l:'Scam or fraud'},{v:'not_a_student',l:'Not a student'},
    {v:'wrong_price',l:'Wrong price'},{v:'duplicate_listing',l:'Duplicate listing'},
    {v:'inappropriate_content',l:'Inappropriate'},{v:'suspicious',l:'Suspicious'},{v:'other',l:'Other'},
  ];

  let schoolSection = '';
  if (aAdminSchool) {
    schoolSection = `${div}<div>${secHead('School')}<span class="school-chip">&#128274; ${aAdminSchool} only</span></div>`;
  } else if (schoolSlugs.length > 1) {
    schoolSection = `${div}<div>${secHead('School')}${chipRow(schoolSlugs.map(s=>({v:s,l:toLabel(s)})), _reportSchoolFilter, '_setRepSchool')}</div>`;
  }

  filterEl.innerHTML = `
    <div>${secHead('Status')}${chipRow(statusOpts, _reportStatusFilter, '_setRepStatus')}</div>
    <div>${secHead('Category')}${chipRow(catOpts, _reportCatFilter, '_setRepCat')}</div>
    ${schoolSection}
  `;
}

function buildRepActiveChips() {
  const el = document.getElementById('repActiveChips');
  if (!el) return;
  const chips = [];
  const statusLabels = { open:'Open', actioned:'Actioned', dismissed:'Dismissed' };

  if (_reportSearch.trim())          chips.push([`Search: "${_reportSearch.trim()}"`,               '_repClearSearch()']);
  if (_reportStatusFilter !== 'all') chips.push([`Status: ${statusLabels[_reportStatusFilter]}`,     '_repClearStatus()']);
  if (_reportCatFilter !== 'all')    chips.push([`Category: ${REPORT_LABELS[_reportCatFilter]||_reportCatFilter}`, '_repClearCat()']);
  if (!aAdminSchool && _reportSchoolFilter !== 'all') {
    chips.push([`School: ${_reportSchoolFilter.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}`, '_repClearSchool()']);
  }

  if (!chips.length) { el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='flex';
  el.innerHTML = chips.map(([label,fn]) =>
    `<button class="filter-chip active" onclick="${fn}" style="display:flex;align-items:center;gap:4px">${label} <span style="font-size:10px;opacity:.65">&#10005;</span></button>`
  ).join('') + (chips.length>1
    ? `<button onclick="clearRepFilters()" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px 8px;text-decoration:underline;align-self:center">Clear all</button>`
    : '');
}

function _setRepStatus(v) { _reportStatusFilter = v; renderAReports(); }
function _setRepCat(v)    { _reportCatFilter    = v; renderAReports(); }
function _setRepSchool(v) { _reportSchoolFilter = v; renderAReports(); }
function _setRepGroup(v)  { _reportGroupBy      = v; renderAReports(); }

function _repClearSearch() { _reportSearch = ''; const i=document.getElementById('repSearchInput'); if(i)i.value=''; renderAReports(); }
function _repClearStatus() { _reportStatusFilter='all'; renderAReports(); }
function _repClearCat()    { _reportCatFilter   ='all'; renderAReports(); }
function _repClearSchool() { _reportSchoolFilter='all'; renderAReports(); }

function clearRepFilters() {
  _reportSearch=''; _reportStatusFilter='all'; _reportCatFilter='all'; _reportSchoolFilter='all';
  const i=document.getElementById('repSearchInput'); if(i)i.value='';
  renderAReports();
}

function _toggleRepGroup(sk) {
  const body  = document.getElementById('rg-body-'+sk);
  const arrow = document.getElementById('rg-arrow-'+sk);
  if (!body) return;
  const collapsing = body.style.display !== 'none';
  body.style.display  = collapsing ? 'none' : '';
  if (arrow) arrow.textContent = collapsing ? '▸' : '▾';
}

async function dismissReport(id) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { error } = await supabaseClient.from('reports').update({
    status: 'dismissed', resolved_by: user?.id, resolved_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { toast('Could not dismiss — please try again.'); console.error(error); return; }
  toast('Report dismissed');
  updateReportsBadge(); renderAReports();
}

async function hideListingFromReport(reportId, listingId) {
  const [{ data: { user } }, { data: listing }] = await Promise.all([
    supabaseClient.auth.getUser(),
    supabaseClient.from('listings').select('title').eq('id', listingId).single()
  ]);
  await supabaseClient.from('reports').update({
    status: 'actioned',
    resolved_by: user?.id,
    resolved_at: new Date().toISOString(),
    resolution_note: 'Listing removed by admin',
    listing_title_snapshot: listing?.title || null
  }).eq('id', reportId);
  await aRemoveListing(listingId);
  updateReportsBadge(); renderAReports();
}

let _pendingReportId = null, _pendingListingId = null;
function suspendFromReport(reportId, posterId, listingId) {
  if (isProtectedAdmin(posterId)) return;
  _pendingReportId = reportId;
  _pendingListingId = listingId || null;
  aOpenSuspend(posterId);
}

async function updateReportsBadge() {
  const { count } = await supabaseClient.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open');
  const badge = document.getElementById('reportsBadge');
  const stat = document.getElementById('ds-r');
  const n = count || 0;
  if (badge) { badge.textContent = n; badge.style.display = n > 0 ? 'inline-block' : 'none'; }
  if (stat) stat.textContent = n;
}

async function viewReportedListing(listingId) {
  const body = document.getElementById('reportListingPreviewBody');
  body.innerHTML = '<p style="color:var(--text-muted);font-size:14px">Loading…</p>';
  openModal('reportListingPreviewModal');

  const { data: l, error } = await supabaseClient.from('listings').select('*').eq('id', listingId).single();

  if (error || !l) {
    body.innerHTML = '<p style="color:var(--text-muted);font-size:14px">This listing has been removed and is no longer available.</p>';
    return;
  }

  body.innerHTML = `
    <div style="font-size:22px;text-align:center;margin-bottom:12px">${l.emoji || '🏠'}</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(l.title)}</div>
    <div style="color:var(--text-muted);font-size:13px;margin-bottom:14px">&#128205; ${esc(l.location || '—')}</div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <span class="pill pill-active">$${l.price || l.rent || '—'}/mo</span>
      <span class="pill pill-active">${esc(l.type || '—')}</span>
      <span class="pill" style="background:var(--bg)">${esc(l.status)}</span>
    </div>
    ${l.description ? `<div style="font-size:13px;color:var(--text-muted);line-height:1.7;margin-bottom:14px">${esc(l.description)}</div>` : ''}
    <div style="border-top:1px solid var(--border);padding-top:12px;font-size:12px;color:var(--text-faint)">
      Posted by <strong>${esc(l.poster_name || '—')}</strong> · ${fmtDate(l.created_at)}
    </div>`;
}

async function reopenReport(id) {
  const { error } = await supabaseClient.from('reports').update({
    status: 'open', resolved_by: null, resolved_at: null, resolution_note: null
  }).eq('id', id);
  if (error) { toast('Could not reopen — please try again.'); console.error(error); return; }
  toast('Report reopened');
  updateReportsBadge(); renderAReports();
}

// ADMIN ACTIVITY
async function renderAActivity() {
  const PAGE_SIZE = 20;
  const el      = document.getElementById('aFullLog');
  const metaEl  = document.getElementById('actMeta');
  const pageEl  = document.getElementById('actPagination');
  const chipsEl = document.getElementById('actFilterChips');

  const chips = [
    { key: 'all',        label: 'All'        },
    { key: 'approvals',  label: 'Approvals'  },
    { key: 'moderation', label: 'Moderation' },
    { key: 'appeals',    label: 'Appeals'    },
    { key: 'students',   label: 'Students'   },
    { key: 'system',     label: 'System'     },
  ];
  if (chipsEl) chipsEl.innerHTML = chips.map(c =>
    `<button class="filter-chip${_actFilter === c.key ? ' active' : ''}" onclick="_actFilter='${c.key}';_actPage=0;renderAActivity()">${c.label}</button>`
  ).join('');

  const search      = document.getElementById('actSearch')?.value.trim()  || null;
  const dateFrom    = document.getElementById('actDateFrom')?.value        || null;
  const dateTo      = document.getElementById('actDateTo')?.value          || null;
  const actionTypes = _actFilter !== 'all' ? ACTIVITY_FILTER_GROUPS[_actFilter] : null;

  const clearBtn = document.getElementById('actClearBtn');
  const anyActive = !!(actionTypes || search || dateFrom || dateTo);
  if (clearBtn) clearBtn.style.display = anyActive ? '' : 'none';
  if (anyActive) ensureFilterOpen('actFilterPanel', 'actFilterBtn');

  if (el) el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-faint);font-size:13px">Loading…</div>';

  const { data: entries, count } = await fetchActivityLog({
    limit: PAGE_SIZE, offset: _actPage * PAGE_SIZE,
    actionTypes, search,
    dateFrom: dateFrom ? `${dateFrom}T00:00:00` : null,
    dateTo:   dateTo   ? `${dateTo}T23:59:59`   : null,
    withCount: true,
  });

  const total = count ?? 0;
  const from  = total ? _actPage * PAGE_SIZE + 1 : 0;
  const to    = Math.min((_actPage + 1) * PAGE_SIZE, total);
  if (metaEl) metaEl.textContent = total ? `Showing ${from}–${to} of ${total} entries` : '';

  if (el) el.innerHTML = entries && entries.length
    ? entries.map(activityItem).join('')
    : '<div style="padding:32px;text-align:center;color:var(--text-faint);font-size:13px">No activity recorded yet.</div>';

  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (pageEl) pageEl.innerHTML = totalPages <= 1 ? '' :
    `<button class="btn-sm-a btn-a-neutral" onclick="_actPage--;renderAActivity()" ${_actPage === 0 ? 'disabled' : ''}>&#8592; Prev</button>` +
    `<span style="font-size:13px;color:var(--text-muted);padding:0 4px">Page ${_actPage + 1} of ${totalPages}</span>` +
    `<button class="btn-sm-a btn-a-neutral" onclick="_actPage++;renderAActivity()" ${_actPage >= totalPages - 1 ? 'disabled' : ''}>Next &#8594;</button>`;
}

function clearActFilters() {
  _actFilter = 'all'; _actPage = 0;
  const s = document.getElementById('actSearch');   if (s) s.value = '';
  const f = document.getElementById('actDateFrom'); if (f) f.value = '';
  const t = document.getElementById('actDateTo');   if (t) t.value = '';
  renderAActivity();
}

async function exportActivityLog() {
  toast('Preparing export…');
  const search   = document.getElementById('actSearch')?.value.trim() || null;
  const dateFrom = document.getElementById('actDateFrom')?.value      || null;
  const dateTo   = document.getElementById('actDateTo')?.value        || null;
  const actionTypes = _actFilter !== 'all' ? ACTIVITY_FILTER_GROUPS[_actFilter] : null;
  const { data: entries } = await fetchActivityLog({
    limit: 2000,
    actionTypes, search,
    dateFrom: dateFrom ? `${dateFrom}T00:00:00` : null,
    dateTo:   dateTo   ? `${dateTo}T23:59:59`   : null,
  });
  if (!entries || !entries.length) { toast('No entries to export'); return; }
  const headers = ['ID','Action','Target','School','Reason','Time'];
  const rows = entries.map(e => [
    e.id,
    ACTION_META[e.action_type]?.label || e.action_type,
    e.target_label || '',
    e.school || '',
    e.reason || '',
    new Date(e.created_at).toLocaleString('en-US'),
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `caldwellnest-activity-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast('Activity log exported');
}

// ============================================================
// ADMIN — SITE EDITOR (live updates student interface)
// ============================================================
const PRESETS = [
  { name:'Forest',brand:'#1a3a2a',accent:'#f0a500',bg:'#f5f7f6',surface:'#fff' },
  { name:'Ocean',brand:'#1a3a5c',accent:'#f0a500',bg:'#f0f5fa',surface:'#fff' },
  { name:'Berry',brand:'#5c1a4a',accent:'#f0a500',bg:'#faf5f9',surface:'#fff' },
  { name:'Slate',brand:'#2c3e50',accent:'#e74c3c',bg:'#f4f6f8',surface:'#fff' },
  { name:'Gold',brand:'#7d5a00',accent:'#2d9e5c',bg:'#fdfbf5',surface:'#fff' },
];
let curColors = { brand:'#1a3a2a', accent:'#f0a500', bg:'#f5f7f6', surface:'#ffffff' };

function buildPresets() {
  document.getElementById('presetRow').innerHTML = PRESETS.map((p, i) => `<div class="pdot" style="background:${p.brand}" title="${p.name}" onclick="applyPreset(${i})"></div>`).join('');
}

function applyPreset(i) {
  const p = PRESETS[i]; curColors = { brand: p.brand, accent: p.accent, bg: p.bg, surface: p.surface };
  document.getElementById('cBrand').value = p.brand; document.getElementById('cBrandV').textContent = p.brand;
  document.getElementById('cAccent').value = p.accent; document.getElementById('cAccentV').textContent = p.accent;
  document.getElementById('cBg').value = p.bg; document.getElementById('cBgV').textContent = p.bg;
  document.getElementById('cSurface').value = p.surface; document.getElementById('cSurfaceV').textContent = p.surface;
  updatePreview(); toast(`Preset "${p.name}" applied to preview`);
}

function liveCol(k, v) {
  curColors[k] = v;
  const vmap = { brand:'cBrandV', accent:'cAccentV', bg:'cBgV', surface:'cSurfaceV' };
  if (vmap[k]) document.getElementById(vmap[k]).textContent = v;
  updatePreview();
}

function updatePreview() {
  document.getElementById('pvNav').style.background = curColors.brand;
  document.getElementById('pvHeroDiv').style.background = curColors.brand;
  document.getElementById('pvCta').style.background = curColors.accent;
  document.getElementById('pvCta').style.color = curColors.brand;
  document.querySelectorAll('.pv-card-price').forEach(e => e.style.color = curColors.brand);
  document.querySelector('.pv-frame').style.background = curColors.bg;
}

function applyColors() {
  const r = document.documentElement;
  r.style.setProperty('--brand', curColors.brand);
  r.style.setProperty('--brand-mid', curColors.brand);
  r.style.setProperty('--accent', curColors.accent);
  r.style.setProperty('--bg', curColors.bg);
  r.style.setProperty('--surface', curColors.surface);
  DB.log.unshift({ type: 'edit', text: 'Platform colors updated', time: 'Just now', color: '#3B5BA5' });
  logAdminAction('color_edit', { targetType: 'system', meta: { section: 'colors' } });
  toast('✓ Colors applied to student platform!');
}

function resetColors() {
  curColors = { brand:'#1a3a2a', accent:'#f0a500', bg:'#f5f7f6', surface:'#ffffff' };
  const r = document.documentElement;
  r.style.setProperty('--brand','#1a3a2a'); r.style.setProperty('--brand-mid','#2d6148');
  r.style.setProperty('--accent','#f0a500'); r.style.setProperty('--bg','#f5f7f6'); r.style.setProperty('--surface','#ffffff');
  updatePreview(); toast('Colors reset');
}

function edTab(t, btn) {
  ['colors','content','layout'].forEach(x => { document.getElementById('ed'+x.charAt(0).toUpperCase()+x.slice(1)).style.display = x === t ? 'block' : 'none'; });
  document.querySelectorAll('.ed-tab').forEach(x => x.classList.remove('active')); btn.classList.add('active');
}

function liveContent() {
  const name = document.getElementById('txtName').value || 'CaldwellNest';
  const tag = document.getElementById('txtTag').value || 'Nest';
  document.getElementById('pvLogo').innerHTML = name.includes(tag) ? name.replace(tag, `<em>${tag}</em>`) : name;
  document.getElementById('pvH1').innerHTML = `${document.getElementById('txtH1').value || 'One trusted hub'}<br>for <em id="pvH2">${document.getElementById('txtH2').value || 'campus life.'}</em>`;
  document.getElementById('pvSub').textContent = document.getElementById('txtSub').value;
  document.getElementById('pvCta').textContent = document.getElementById('txtCta').value || 'Get started free';
}

function applyContent() {
  DB.content.h1 = document.getElementById('txtH1').value;
  DB.content.h2 = document.getElementById('txtH2').value;
  DB.content.sub = document.getElementById('txtSub').value;
  DB.content.cta = document.getElementById('txtCta').value;
  DB.content.listTitle = document.getElementById('txtLT').value;
  DB.content.listSub = document.getElementById('txtLS').value;
  applyDBContent();
  DB.log.unshift({ type: 'edit', text: 'Site content updated', time: 'Just now', color: '#3B5BA5' });
  logAdminAction('content_edit', { targetType: 'system', meta: { section: 'content' } });
  toast('✓ Content applied to student platform!');
}

function selCardLayout(el) {
  ['layoutGrid','layoutList'].forEach(id => { const d = document.getElementById(id); d.style.background='var(--bg)'; d.style.border='1px solid var(--border)'; d.style.color='var(--text-muted)'; });
  el.style.background='var(--brand-pale)'; el.style.border='2px solid var(--brand)'; el.style.color='var(--brand)';
}

function applyLayout() {
  const bt = document.getElementById('bannerTxt').value.trim();
  const bon = document.getElementById('bannerOn').checked;
  DB.content.banner = bt; DB.content.bannerOn = bon;
  applyDBContent();
  document.getElementById('pvBanner').style.display = (bt && bon) ? 'block' : 'none';
  document.getElementById('pvBanner').textContent = bt;
  DB.log.unshift({ type: 'edit', text: 'Layout updated', time: 'Just now', color: '#3B5BA5' });
  logAdminAction('content_edit', { targetType: 'system', meta: { section: 'layout' } });
  toast('✓ Layout applied!');
}

// ============================================================
// ADMIN — BROADCAST
// ============================================================
const BCAST_TEMPLATES = [
  // — General
  { icon:'&#127968;', label:'New listings available',     body:'Hey! New housing listings are available this week on CaldwellNest. Log in to browse and connect.' },
  { icon:'&#9989;',   label:'Verify your .edu email',     body:'Reminder: please verify your @caldwell.edu email to keep your account active.' },
  { icon:'&#9888;',   label:'Community guidelines',       body:'A reminder to keep all messages and listings respectful. Violations will result in account review.' },
  { icon:'&#127881;', label:'Welcome new students',       body:"Welcome to CaldwellNest! Browse listings, post rooms, and message other students. Good luck finding your place!" },
  // — Welcome / Onboarding
  { icon:'&#128588;', label:"You're in!",                 body:"You just joined CaldwellNest — the one place built for Caldwell students to find housing, connect with classmates, and post what you've got. Take a look around, and reach out if you need anything." },
  { icon:'&#128203;', label:'Complete your profile',      body:"Quick tip: adding your major and year to your profile helps other students know who they're connecting with. Takes 30 seconds — tap your avatar to get started." },
  // — Seasonal
  { icon:'&#128218;', label:'Welcome back — new semester',body:'New semester, fresh start! Housing listings are live for [semester]. Browse now before the good ones go fast.' },
  { icon:'&#127937;', label:'End of semester',            body:"Wrapping up [semester]? If you're moving out or passing on a room, post it on CaldwellNest — someone needs exactly what you've got." },
  { icon:'&#9749;',   label:'Finals week',                body:"Finals week is here — hang in there. CaldwellNest will be right here when it's over. Good luck from the whole team. 🤞" },
  { icon:'&#9728;',   label:'Summer break',               body:"Heading home for the summer? CaldwellNest is still here if you're looking for sublets, storage swaps, or anything else. See you in [fall semester]!" },
  { icon:'&#127939;', label:'Fall housing rush',          body:'Fall housing rush is on! New listings are coming in fast — check CaldwellNest before you commit anywhere else. [Number] listings live right now.' },
  // — Platform Updates
  { icon:'&#10024;',  label:'New feature',                body:'We just added [feature] to CaldwellNest. [One sentence on what it does.] Give it a try and let us know what you think.' },
  { icon:'&#128295;', label:'Improvement',                body:"We made [improvement] based on your feedback. Small change, big difference — thanks for telling us what wasn't working." },
  // — Safety
  { icon:'&#129309;', label:'Meeting up safely',          body:'Quick reminder: when meeting someone from CaldwellNest in person, choose a public spot on campus first. Everyone here is a verified student — and this just keeps things comfortable for both sides.' },
  { icon:'&#128681;', label:'Spotting scams',             body:"If a listing asks for payment before you've seen the place, or anything feels off — trust that instinct. Report it in-app and we'll look into it. You're looking out for the whole community." },
  // — Beta
  { icon:'&#129514;', label:'Thanks for being in beta',   body:"You're one of the first students on CaldwellNest — and honestly, that means a lot. You're helping shape what this becomes. If something bugs you or something's missing, tell us. We read every message." },
  { icon:'&#128172;', label:'Feedback ask',               body:"We've been building fast and we want to hear from you. What's one thing you wish CaldwellNest did? Reply to this or message us directly — we're listening." },
  // — School Break
  { icon:'&#127958;', label:'School on break',            body:"Caldwell is out for [break name]! CaldwellNest is still here if you need it. We'll be back in full swing on [return date] — enjoy the break." },
  { icon:'&#128276;', label:'Slower responses during break', body:"Heads up: our team is on break from [date] to [date]. We'll still be watching for anything urgent, but responses may be slower. Thanks for your patience — see you on the other side!" },
];

// ---- Markdown renderer (safe subset) ----
function renderMd(text) {
  if (!text) return '';
  let h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  h = h.replace(/^#### (.+)$/gm,'<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g,'<em>$1</em>');
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/((?:^- .+\n?)+)/gm, m => '<ul>' + m.replace(/^- (.+)$/gm,'<li>$1</li>') + '</ul>');
  h = h.replace(/\n\n+/g,'</p><p>');
  h = '<p>' + h + '</p>';
  h = h.replace(/<p>(<(?:h[234]|ul)>)/g,'$1').replace(/(<\/(?:h[234]|ul)>)<\/p>/g,'$1');
  h = h.replace(/<p><\/p>/g,'');
  return sanitizeMd(h);
}

function sanitizeMd(html) {
  const allowed = /^(h2|h3|h4|p|strong|em|ul|li|br|a)$/i;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  (function clean(node) {
    Array.from(node.childNodes).forEach(n => {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1) { n.remove(); return; }
      const tag = n.tagName.toLowerCase();
      if (!allowed.test(tag)) { n.replaceWith(...Array.from(n.childNodes)); clean(node); return; }
      if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        Array.from(n.attributes).forEach(a => n.removeAttribute(a.name));
        if (!/^javascript:/i.test(href.trim())) {
          n.setAttribute('href', href);
          n.setAttribute('target','_blank');
          n.setAttribute('rel','noopener');
        }
      } else {
        Array.from(n.attributes).forEach(a => n.removeAttribute(a.name));
      }
      clean(n);
    });
  })(tmp);
  return tmp.innerHTML;
}

function _setBLandingOpen(open) {
  const sec = document.getElementById('bLandingSection');
  const btn = document.getElementById('bLandingToggle');
  if (!sec || !btn) return;
  sec.style.display = open ? '' : 'none';
  btn.innerHTML = open
    ? '&#128214; Landing page added <span style="float:right;color:var(--brand)">&#10003; on</span>'
    : '&#128214; Add landing page <span style="float:right;opacity:.5">optional</span>';
}

function toggleBLanding() {
  _setBLandingOpen(document.getElementById('bLandingSection').style.display === 'none');
}

function previewBLanding() {
  const text = document.getElementById('bLandingBody')?.value || '';
  const prev = document.getElementById('bLandingPreview');
  if (prev) prev.innerHTML = renderMd(text) || '<span style="color:var(--text-faint);font-size:12px">Preview appears here…</span>';
}

function openBcastLanding(b) {
  if (!b) return;
  document.getElementById('bcastLandingTitle').textContent = b.landing_title || b.subject || 'Broadcast';
  document.getElementById('bcastLandingBody').innerHTML = renderMd(b.landing_body || '');
  openModal('bcastLandingModal');
}

async function renderBcastHistory() {
  const el = document.getElementById('bHistory');
  if (!el) return;
  el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-faint);font-size:13px">Loading…</div>';
  let q = supabaseClient.from('broadcasts').select('*').order('created_at', { ascending: false }).limit(50);
  if (_bHistFilter === 'deleted') {
    q = q.eq('status', 'deleted');
  } else if (_bHistFilter !== 'all') {
    q = q.eq('status', _bHistFilter);
  } else {
    q = q.neq('status', 'deleted');
  }
  const { data: rows, error } = await q;
  if (error) { el.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:13px">Could not load broadcasts.</div>'; return; }
  if (!rows || rows.length === 0) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px">No broadcasts yet.</div>';
    return;
  }
  const statusBadge = s => {
    if (s === 'sent')      return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--brand-pale);color:var(--brand)">Sent</span>`;
    if (s === 'scheduled') return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:#e8f0fe;color:#3B5BA5">Scheduled</span>`;
    if (s === 'deleted')   return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:#fde8e8;color:#c0392b">Deleted</span>`;
    return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:#f0f0f0;color:#666">Draft</span>`;
  };
  const typeBadge    = t => `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text-muted)">${t}</span>`;
  const landingChip  = b => b.landing_body ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#f0f7ff;color:#3B5BA5">&#128214; Landing page</span>` : '';
  el.innerHTML = rows.map(b => {
    const subEsc = (b.subject || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const schedLine  = b.scheduled_at ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px">Goes live: ${fmtDate(b.scheduled_at)}</div>` : '';
    const expiryLine = b.expires_at   ? `<div style="font-size:11px;color:var(--text-faint)">Expires: ${fmtDate(b.expires_at)}</div>` : '';
    return `
    <div style="padding:12px 18px;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap;">
        ${statusBadge(b.status)}${typeBadge(b.type)}${landingChip(b)}
        <span style="margin-left:auto;font-size:11px;color:var(--text-faint)">${fmtDate(b.created_at)}</span>
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:3px">${esc(b.subject)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${esc(b.body)}</div>
      ${schedLine}${expiryLine}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
        <span style="font-size:11px;color:var(--text-faint)">${b.audience || 'All students'}</span>
        <div style="display:flex;gap:6px;">
          ${b.status === 'deleted'
            ? `<button class="btn-sm-a btn-a-neutral" onclick="bRestoreBcast('${b.id}')">Restore</button>
               <button class="btn-sm-a btn-a-danger" onclick="bPermDeleteBcast('${b.id}','${subEsc}')">Delete forever</button>`
            : `<button class="btn-sm-a btn-a-neutral" onclick="bEditBcast('${b.id}')">Edit</button>
               <button class="btn-sm-a btn-a-danger" onclick="bDeleteBcast('${b.id}','${subEsc}')">Delete</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderBcastTemplates() {
  document.getElementById('bTemplates').innerHTML = BCAST_TEMPLATES.map(t => `
    <button class="tmpl-btn" onclick="applyBTemplate('${t.label.replace(/'/g,"\\'")}','${t.body.replace(/'/g,"\\'")}')"><div style="font-weight:600;margin-bottom:2px">${t.icon} ${t.label}</div><div style="font-size:11px;color:var(--text-faint);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${t.body.substring(0,55)}...</div></button>`).join('');
}

function selBType(el, type) {
  bType = type;
  document.querySelectorAll('#bTypeRow .msg-type-btn').forEach(b => b.classList.remove('active-type'));
  el.classList.add('active-type');
}

function setBDisplayType(el, type) {
  _bDisplayType = type;
  document.querySelectorAll('#bDisplayRow .msg-type-btn').forEach(b => b.classList.remove('active-type'));
  el.classList.add('active-type');
}

function setBHistFilter(tab, el) {
  _bHistFilter = tab;
  document.querySelectorAll('#bHistTabs .filter-chip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderBcastHistory();
}

function _bUpdateBtn() {
  const btn = document.getElementById('bSendBtn');
  if (!btn) return;
  const val = document.getElementById('bScheduleAt')?.value;
  const future = val && new Date(val) > new Date();
  if (_bEditId) btn.textContent = '✓ Update';
  else if (future) btn.textContent = '⏱ Schedule';
  else btn.innerHTML = '&#9993; Send Now';
}

function applyBTemplate(subject, body) {
  document.getElementById('bSubject').value = subject;
  document.getElementById('bBody').value = body;
  toast('Template applied');
}

function resetBcastForm() {
  _bEditId = null; _bPrevStatus = null;
  document.getElementById('bSubject').value = '';
  document.getElementById('bBody').value = '';
  document.getElementById('bScheduleAt').value = '';
  document.getElementById('bExpiresAt').value = '';
  document.getElementById('bAudience').selectedIndex = 0;
  bType = 'announcement';
  document.querySelectorAll('#bTypeRow .msg-type-btn').forEach((b, i) => b.classList.toggle('active-type', i === 0));
  _bDisplayType = 'both';
  document.querySelectorAll('#bDisplayRow .msg-type-btn').forEach((b, i) => b.classList.toggle('active-type', i === 2));
  document.getElementById('bCancelEditBtn').style.display = 'none';
  document.getElementById('bFormTitle').textContent = 'New broadcast';
  _bUpdateBtn();
  document.getElementById('bLandingTitle').value = '';
  document.getElementById('bLandingBody').value = '';
  document.getElementById('bLandingPreview').innerHTML = '';
  _setBLandingOpen(false);
}

async function bEditBcast(id) {
  const { data: b, error } = await supabaseClient.from('broadcasts').select('*').eq('id', id).single();
  if (error || !b) { toast('Could not load broadcast'); return; }
  _bEditId = id; _bPrevStatus = b.status;
  document.getElementById('bSubject').value = b.subject || '';
  document.getElementById('bBody').value = b.body || '';
  document.getElementById('bAudience').value = b.audience || 'All students';
  document.getElementById('bScheduleAt').value = b.scheduled_at ? b.scheduled_at.slice(0, 16) : '';
  document.getElementById('bExpiresAt').value  = b.expires_at   ? b.expires_at.slice(0, 16)   : '';
  bType = b.type || 'announcement';
  document.querySelectorAll('#bTypeRow .msg-type-btn').forEach(btn =>
    btn.classList.toggle('active-type', btn.getAttribute('onclick')?.includes(`'${bType}'`)));
  _bDisplayType = b.display_type || 'both';
  document.querySelectorAll('#bDisplayRow .msg-type-btn').forEach(btn =>
    btn.classList.toggle('active-type', btn.getAttribute('onclick')?.includes(`'${_bDisplayType}'`)));
  document.getElementById('bCancelEditBtn').style.display = '';
  document.getElementById('bFormTitle').textContent = 'Edit broadcast';
  _bUpdateBtn();
  document.getElementById('bLandingTitle').value = b.landing_title || '';
  document.getElementById('bLandingBody').value  = b.landing_body  || '';
  _setBLandingOpen(!!b.landing_body);
  if (b.landing_body) previewBLanding();
  document.getElementById('bFormTitle').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (b.status === 'sent') toast('Note: this broadcast was already delivered to students');
}

async function bDeleteBcast(id, subject) {
  if (!confirm(`Delete “${subject}”?\n\nIt will move to Deleted history and can be restored.`)) return;
  const { error } = await supabaseClient.from('broadcasts').update({ status: 'deleted' }).eq('id', id);
  if (error) { toast('Could not delete — please try again.'); console.error(error); return; }
  logAdminAction('broadcast_deleted', { targetType: 'broadcast', targetId: id, targetLabel: subject });
  toast('Broadcast deleted');
  if (_bEditId === id) resetBcastForm();
  renderBcastHistory();
}

async function bRestoreBcast(id) {
  const { error } = await supabaseClient.from('broadcasts').update({ status: 'draft' }).eq('id', id);
  if (error) { toast('Could not restore — please try again.'); console.error(error); return; }
  logAdminAction('broadcast_restored', { targetType: 'broadcast', targetId: id });
  toast('Restored as draft');
  renderBcastHistory();
}

async function bPermDeleteBcast(id, subject) {
  if (!confirm(`Permanently delete “${subject}”?\n\nThis cannot be undone.`)) return;
  const { error } = await supabaseClient.from('broadcasts').delete().eq('id', id);
  if (error) { toast('Could not delete permanently — please try again.'); console.error(error); return; }
  logAdminAction('broadcast_permanently_deleted', { targetType: 'broadcast', targetId: id, targetLabel: subject });
  toast('Permanently deleted');
  renderBcastHistory();
}

async function submitBcast(mode) {
  const sub  = document.getElementById('bSubject').value.trim();
  const body = document.getElementById('bBody').value.trim();
  if (!sub || !body) { toast('Please fill in subject and message'); return; }
  const audience   = document.getElementById('bAudience').value;
  const schedVal   = document.getElementById('bScheduleAt').value;
  const expiresVal = document.getElementById('bExpiresAt').value;
  let status = 'sent', scheduledAt = null;
  if (mode === 'draft') {
    status = 'draft';
  } else if (schedVal && new Date(schedVal) > new Date()) {
    status = 'scheduled';
    scheduledAt = new Date(schedVal).toISOString();
  }
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) { toast('Not logged in'); return; }
  const row = {
    actor_id:      user.id,
    school:        aAdminSchool,
    subject:       sub,
    body,
    type:          bType,
    display_type:  _bDisplayType,
    audience,
    status,
    scheduled_at:  scheduledAt,
    expires_at:    expiresVal ? new Date(expiresVal).toISOString() : null,
    landing_title: document.getElementById('bLandingTitle').value.trim() || null,
    landing_body:  document.getElementById('bLandingBody').value.trim()  || null,
  };
  if (_bEditId) {
    const { error } = await supabaseClient.from('broadcasts').update(row).eq('id', _bEditId);
    if (error) { toast('Could not update — please try again.'); console.error(error); return; }
    const logType = status === 'draft' ? 'broadcast_drafted' : status === 'scheduled' ? 'broadcast_scheduled' : 'broadcast_updated';
    logAdminAction(logType, { targetType: 'broadcast', targetId: _bEditId, targetLabel: sub, meta: { status, prev_status: _bPrevStatus } });
    const note = _bPrevStatus === 'sent' ? ' — already delivered to students' : '';
    toast(status === 'draft' ? 'Draft saved' : `Broadcast updated${note}`);
  } else {
    const { error } = await supabaseClient.from('broadcasts').insert(row);
    if (error) { toast('Could not send — please try again.'); console.error(error); return; }
    const logType = status === 'draft' ? 'broadcast_drafted' : status === 'scheduled' ? 'broadcast_scheduled' : 'broadcast_sent';
    logAdminAction(logType, { targetType: 'broadcast', targetLabel: sub, meta: { status, audience, type: bType } });
    const labels = { sent: '✓ Broadcast sent!', draft: 'Draft saved', scheduled: '✓ Broadcast scheduled!' };
    toast(labels[status]);
  }
  resetBcastForm();
  renderBcastHistory();
}

// ============================================================
// ADMIN — ANALYTICS
// ============================================================
function _anaRangeToDate(range) {
  const now = new Date();
  if (range === '7d')  { const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString(); }
  if (range === '30d') { const d = new Date(now); d.setDate(d.getDate() - 30); return d.toISOString(); }
  if (range === '3mo') { const d = new Date(now); d.setMonth(d.getMonth() - 3); return d.toISOString(); }
  return null; // 'all'
}

function _setAnaRange(range) {
  _anaRange = range;
  ['7d','30d','3mo','all'].forEach(r => {
    const btn = document.getElementById(`anaR-${r}`);
    if (btn) btn.classList.toggle('active', r === range);
  });
  buildAnalytics();
}

function _setAnaSchool(school) {
  _anaSchool = school;
  buildAnalytics();
}

function agoFromAnalytics(section, filterFn) {
  if (filterFn) filterFn();
  _anaNavSource = 'analytics';
  ago(section, null);
}

function goBackToAnalytics() {
  const bar = document.getElementById('ana-back-bar');
  if (bar) bar.style.display = 'none';
  _anaNavSource = null;
  ago('analytics', document.querySelector('.a-nav-item[onclick*="analytics"]'));
}

function _reapplyAnaBreadcrumb(s) {
  const bar = document.getElementById('ana-back-bar');
  if (bar) bar.style.display = 'block';
  const titleEl = document.getElementById('aTopTitle');
  const allTitles = { ...ATITLES, exports: 'Data export', health: 'Platform health', appeals: 'Appeals' };
  if (titleEl) titleEl.textContent = allTitles[s] || s;
}

function _anaDelta(curr, prev) {
  if (prev === 0 && curr === 0) return '';
  if (prev === 0) return `<span style="color:var(--success)">&#9650; ${curr} vs prior period</span>`;
  const diff = curr - prev;
  if (diff === 0) return `<span style="color:var(--text-faint)">same as prior period</span>`;
  const pct = Math.round(Math.abs(diff / prev) * 100);
  return diff > 0
    ? `<span style="color:var(--success)">&#9650; ${diff} (${pct}%) vs prior period</span>`
    : `<span style="color:var(--danger)">&#9660; ${Math.abs(diff)} (${pct}%) vs prior period</span>`;
}

async function buildAnalytics() {
  ['ana-live','ana-month','ana-rate','ana-stu'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '…'; });

  // ── Build date windows ───────────────────────────────────────────────────
  const now      = new Date();
  const since    = _anaRangeToDate(_anaRange);
  // Prior period = same length, ending at `since`
  let priorSince = null;
  if (since) {
    const windowMs = now.getTime() - new Date(since).getTime();
    priorSince = new Date(new Date(since).getTime() - windowMs).toISOString();
  }

  // ── Update range button active state ────────────────────────────────────
  ['7d','30d','3mo','all'].forEach(r => {
    const btn = document.getElementById(`anaR-${r}`);
    if (btn) btn.classList.toggle('active', r === _anaRange);
  });

  // ── School filter UI ────────────────────────────────────────────────────
  const schoolWrap = document.getElementById('anaSchoolWrap');
  if (schoolWrap) {
    if (!aAdminSchool) {
      // Super-admin: show school picker (populated after first data fetch)
      schoolWrap.style.display = 'flex';
      schoolWrap.style.alignItems = 'center';
      schoolWrap.style.gap = '6px';
    } else {
      schoolWrap.style.display = 'none';
    }
  }

  // ── Fetch listings (all-time for type chart + live count, range for stats) ──
  let listQ = supabaseClient.from('listings').select('category, status, created_at, school, poster_id, poster_name, price');
  if (aAdminSchool) listQ = listQ.eq('school', aAdminSchool);
  else if (_anaSchool !== 'all') listQ = listQ.eq('school', _anaSchool);
  const { data: allListings } = await listQ;
  const allL = allListings || [];

  // Window subsets
  const inRange  = since    ? allL.filter(l => l.created_at >= since)      : allL;
  const inPrior  = priorSince && since ? allL.filter(l => l.created_at >= priorSince && l.created_at < since) : [];
  const liveL    = allL.filter(l => l.status === 'approved');

  // ── Profiles (for student counts + major breakdown) ──────────────────────
  let profQ = supabaseClient.from('profiles').select('major, school, created_at');
  if (aAdminSchool) profQ = profQ.eq('school', aAdminSchool);
  else if (_anaSchool !== 'all') profQ = profQ.eq('school', _anaSchool);
  const { data: profiles } = await profQ;
  const allProfiles = profiles || [];

  const studentsInRange = since ? allProfiles.filter(p => p.created_at >= since)     : allProfiles;
  const studentsInPrior = (priorSince && since) ? allProfiles.filter(p => p.created_at >= priorSince && p.created_at < since) : [];

  // ── Populate school picker for super-admin ───────────────────────────────
  if (!aAdminSchool && schoolWrap) {
    const schools = [...new Set(allL.map(l => l.school).filter(Boolean))];
    if (schools.length > 1) {
      const opts = [{ v:'all', l:'All schools' }, ...schools.map(s => ({ v:s, l: s.charAt(0).toUpperCase()+s.slice(1) }))];
      schoolWrap.innerHTML = `<span style="font-size:12px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em">School</span>`
        + opts.map(o => `<button class="btn-sm-a btn-a-neutral${_anaSchool===o.v?' active':''}" onclick="_setAnaSchool('${o.v}')">${o.l}</button>`).join('');
    }
  }

  // ── Stat cards ───────────────────────────────────────────────────────────
  const postedCurr = inRange.length;
  const postedPrev = inPrior.length;
  const approvedInRange = inRange.filter(l => l.status === 'approved');
  const rejectedInRange = inRange.filter(l => l.status === 'rejected');
  const apRate = (approvedInRange.length + rejectedInRange.length) > 0
    ? Math.round((approvedInRange.length / (approvedInRange.length + rejectedInRange.length)) * 100) : null;
  const stuCurr = studentsInRange.length;
  const stuPrev = studentsInPrior.length;

  const rangeLabel = { '7d':'7 days','30d':'30 days','3mo':'3 months','all':'all time' }[_anaRange] || '';

  const el_live  = document.getElementById('ana-live');  if (el_live)  el_live.textContent  = liveL.length;
  const el_month = document.getElementById('ana-month'); if (el_month) el_month.textContent = postedCurr;
  const el_rate  = document.getElementById('ana-rate');  if (el_rate)  el_rate.textContent  = apRate != null ? `${apRate}%` : '—';
  const el_stu   = document.getElementById('ana-stu');   if (el_stu)   el_stu.textContent   = stuCurr;

  const el_posted_lbl   = document.getElementById('ana-posted-label');  if (el_posted_lbl)   el_posted_lbl.textContent  = 'Posted';
  const el_posted_delta = document.getElementById('ana-posted-delta');  if (el_posted_delta) el_posted_delta.innerHTML   = _anaRange === 'all' ? 'All time' : (_anaDelta(postedCurr, postedPrev) || `in last ${rangeLabel}`);
  const el_stu_lbl      = document.getElementById('ana-stu-label');     if (el_stu_lbl)      el_stu_lbl.textContent       = _anaRange === 'all' ? 'Total students' : 'New students';
  const el_stu_delta    = document.getElementById('ana-stu-delta');     if (el_stu_delta)    el_stu_delta.innerHTML        = _anaRange === 'all' ? 'All time' : (_anaDelta(stuCurr, stuPrev) || `in last ${rangeLabel}`);
  const el_rate_sub     = document.getElementById('ana-rate-sub');      if (el_rate_sub)     el_rate_sub.textContent       = apRate != null ? `${approvedInRange.length} approved · ${rejectedInRange.length} rejected` : 'No decided listings yet';

  // ── Monthly chart (always last 6 months regardless of range filter) ───────
  const monthLabels = [], monthKeys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push(d.toLocaleString('default', { month: 'short' }));
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();
  const monthListings = allL.filter(l => l.created_at >= sixMonthsAgo);
  const postedByM = {}, approvedByM = {};
  monthKeys.forEach(k => { postedByM[k] = 0; approvedByM[k] = 0; });
  monthListings.forEach(l => {
    const k = l.created_at?.slice(0,7);
    if (k && postedByM[k] !== undefined) { postedByM[k]++; if (l.status === 'approved') approvedByM[k]++; }
  });
  const mxM = Math.max(...monthKeys.map(k => postedByM[k]), 1);
  document.getElementById('aMonthChart').innerHTML = monthLabels.map((m, i) => {
    const pk = monthKeys[i];
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">
      <div style="display:flex;align-items:flex-end;gap:2px;height:90px;">
        <div style="width:14px;background:var(--brand-light);border-radius:3px 3px 0 0;height:${Math.round((postedByM[pk]/mxM)*86)}px" title="${postedByM[pk]} posted"></div>
        <div style="width:14px;background:var(--accent);border-radius:3px 3px 0 0;height:${Math.round((approvedByM[pk]/mxM)*86)}px" title="${approvedByM[pk]} approved"></div>
      </div>
      <div style="font-size:10px;color:var(--text-faint)">${m}</div>
    </div>`;
  }).join('');

  // ── Students by major ────────────────────────────────────────────────────
  const majorCount = {};
  allProfiles.forEach(p => { if (p.major) majorCount[p.major] = (majorCount[p.major]||0)+1; });
  const majors = Object.entries(majorCount).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([n,c])=>({n,c}));
  if (!majors.length) {
    document.getElementById('aMajorChart').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:12px">No major data yet</div>';
  } else {
    const mmax = Math.max(...majors.map(x=>x.c));
    document.getElementById('aMajorChart').innerHTML = majors.map(m => `
      <div class="maj-row">
        <div class="maj-label">${esc(m.n)}</div>
        <div class="maj-bar-outer"><div class="maj-bar-inner" style="width:${Math.round((m.c/mmax)*100)}%"></div></div>
        <div class="maj-count">${m.c}</div>
      </div>`).join('');
  }

  // ── Listings by category (real `category` field, all non-removed listings) ──
  const typeCount = {};
  allL.filter(l => l.status !== 'removed').forEach(l => {
    const c = l.category || 'other';
    typeCount[c] = (typeCount[c]||0)+1;
  });
  const types = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]);
  const typeEl = document.getElementById('aTypeChart');
  if (typeEl) {
    if (!types.length) {
      typeEl.innerHTML = '<div style="padding:16px;color:var(--text-faint);font-size:12px">No listings yet</div>';
    } else {
      const tmx = Math.max(...types.map(t=>t[1]));
      typeEl.innerHTML = types.map(([cat, count]) => {
        const label = CATEGORY_LABELS[cat] || cat;
        const emoji = CATEGORY_EMOJI[cat] || '📦';
        return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer" title="Filter listings to ${label}" onclick="_anaNavSource='analytics';goToListingsFiltered(null,'${cat}')">
          <div style="width:20px;text-align:center;font-size:14px;flex-shrink:0">${emoji}</div>
          <div style="width:110px;font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0">${label}</div>
          <div style="flex:1;height:22px;background:var(--bg);border-radius:4px;overflow:hidden">
            <div style="height:100%;width:${Math.round((count/tmx)*100)}%;background:var(--brand-light);border-radius:4px;transition:width .4s"></div>
          </div>
          <div style="width:28px;text-align:right;font-size:12px;font-weight:600;color:var(--brand)">${count}</div>
        </div>`;
      }).join('');
    }
  }

  // ── Top-posted students (real data: approved listings bucketed by poster) ──
  const posterMap = {};
  liveL.forEach(l => {
    if (!l.poster_id) return;
    if (!posterMap[l.poster_id]) posterMap[l.poster_id] = { name: l.poster_name || 'Unknown', school: l.school || '', count: 0, id: l.poster_id };
    posterMap[l.poster_id].count++;
  });
  const topPosters = Object.values(posterMap).sort((a,b)=>b.count-a.count).slice(0,8);
  const topEl = document.getElementById('anaTopStudents');
  if (topEl) {
    if (!topPosters.length) {
      topEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-faint);font-size:13px">No approved listings yet</div>';
    } else {
      const maxC = topPosters[0].count;
      topEl.innerHTML = topPosters.map((p, i) => {
        const initials = p.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';
        const schoolBadge = p.school ? `<span style="font-size:10px;background:var(--brand-pale);color:var(--brand);padding:1px 7px;border-radius:20px;margin-left:6px;text-transform:capitalize">${esc(p.school)}</span>` : '';
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="width:22px;text-align:center;font-size:11px;font-weight:700;color:var(--text-faint);flex-shrink:0">${i+1}</div>
          <div style="width:30px;height:30px;border-radius:50%;background:var(--brand-pale);color:var(--brand);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${esc(initials)}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
              <span style="font-size:13px;font-weight:500;cursor:pointer;color:var(--brand)" onclick="aOpenStudentHistory('${p.id}')">${esc(p.name)}</span>${schoolBadge}
            </div>
            <div style="height:6px;background:var(--bg);border-radius:3px;margin-top:5px;overflow:hidden;">
              <div style="height:100%;width:${Math.round((p.count/maxC)*100)}%;background:var(--brand-light);border-radius:3px;"></div>
            </div>
          </div>
          <div style="font-size:13px;font-weight:700;color:var(--brand);flex-shrink:0">${p.count}</div>
        </div>`;
      }).join('');
    }
  }
}

// ============================================================
// ADMIN — SETTINGS
// ============================================================

async function saveCNIdentity() {
  const name = document.getElementById('cnName').value.trim() || 'CaldwellNest';
  const initials = document.getElementById('cnInitials').value.trim().toUpperCase().slice(0, 3) || 'CN';
  const color = document.getElementById('cnColor').value;
  localStorage.setItem('cn_official_name', name);
  localStorage.setItem('cn_official_initials', initials);
  localStorage.setItem('cn_official_color', color);
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (user) {
    await supabaseClient.from('profiles').update({ first_name: name, last_name: '', initials, color }).eq('id', user.id);
    await supabaseClient.from('listings').update({ poster_name: name, poster_initials: initials, poster_color: color }).eq('poster_id', user.id);
    [DB.listings, DB.pending].forEach(arr => arr.forEach(l => {
      if (l.poster_id === user.id) { l.poster.name = name; l.poster.initials = initials; l.poster.color = color; }
    }));
  }
  toast('Official identity saved');
}

const SETTINGS = [
  { key:'requireApproval', label:'Require listing approval', desc:'New listings must be reviewed before going live' },
  { key:'eduOnly', label:'Enforce @caldwell.edu only', desc:'Block registrations from non-.edu emails' },
  { key:'emailAlerts', label:'Email alerts for new signups', desc:'Notify admin on new student registrations' },
  { key:'maintenance', label:'Maintenance mode', desc:'Show maintenance screen to all students' },
];
function buildASettings() {
  document.getElementById('aTogList').innerHTML = SETTINGS.map((s, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;${i<SETTINGS.length-1?'border-bottom:1px solid var(--border)':''}">
      <div><div style="font-weight:500;font-size:14px">${s.label}</div><div style="font-size:12px;color:var(--text-muted);margin-top:2px">${s.desc}</div></div>
      <div class="tog-wrap" onclick="togClick(this,'${s.key}')" data-on="${DB.settings[s.key]}">
        <div class="tog-track" style="background:${DB.settings[s.key]?'var(--brand)':'#ccc'}"></div>
        <div class="tog-thumb" style="left:${DB.settings[s.key]?'21px':'3px'}"></div>
      </div>
    </div>`).join('');
  // Populate the CN identity form with saved values
  const cn = getCNIdentity();
  const nameEl = document.getElementById('cnName');
  const initEl = document.getElementById('cnInitials');
  const colorEl = document.getElementById('cnColor');
  if (nameEl) nameEl.value = cn.name;
  if (initEl) initEl.value = cn.initials;
  if (colorEl) colorEl.value = cn.color;
}
async function togClick(el, key) {
  const on = el.dataset.on === 'true'; el.dataset.on = (!on).toString();
  el.querySelector('.tog-track').style.background = on ? '#ccc' : 'var(--brand)';
  el.querySelector('.tog-thumb').style.left = on ? '3px' : '21px';
  DB.settings[key] = !on;
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { error } = await supabaseClient.from('platform_settings').upsert(
    { key, value: !on, updated_at: new Date().toISOString(), updated_by: user?.id },
    { onConflict: 'key' }
  );
  if (error) {
    console.error('Settings save failed:', error.message);
    DB.settings[key] = on; // roll back in-memory value
    el.dataset.on = on.toString();
    el.querySelector('.tog-track').style.background = on ? 'var(--brand)' : '#ccc';
    el.querySelector('.tog-thumb').style.left = on ? '21px' : '3px';
    toast('Could not save setting — please try again.');
    return;
  }
  DB.log.unshift({ type: 'setting', text: `Setting "${key}" ${!on ? 'enabled' : 'disabled'}`, time: 'Just now', color: '#3B5BA5' });
  logAdminAction('setting_change', { targetType: 'system', meta: { setting: key, enabled: !on } });
  toast('Setting saved');
}

// ============================================================
// AI CHATBOT
// ============================================================
async function buildAISys() {
  const [{ count: stuN }, { count: suspN }, { count: repN }] = await Promise.all([
    supabaseClient.from('profiles').select('id', { count: 'exact', head: true }),
    supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'suspended'),
    supabaseClient.from('reports').select('id',  { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  const pendingDetails = DB.pending.length
    ? DB.pending.map(p => `"${p.title}" by ${p.poster?.name || '?'} $${p.rent}/mo`).join('; ')
    : 'none';
  return `You are NestBot, the AI admin assistant for CaldwellNest — a student-only housing platform at Caldwell University, NJ. Current live data:
- ${DB.pending.length} listing${DB.pending.length !== 1 ? 's' : ''} awaiting approval
- ${DB.listings.filter(l=>l.status==='approved').length} approved listings (${DB.listings.filter(l=>l.pinned).length} pinned)
- ${stuN ?? '?'} registered students (${suspN ?? '?'} suspended)
- ${repN ?? '?'} open reports
Pending listings: ${pendingDetails}
Be concise, practical, and helpful. Suggest specific actions when relevant.`;
}

const QUICK_AI = ['Summarize platform status','Show pending listings','Any open reports?','Who is suspended?','Best listings to pin?','Approve all pending'];

function initAI() {
  document.getElementById('aiMsgs').innerHTML = '';
  aiHistory = [];
  addBot("Hi! I'm NestBot 👋 I'm watching the live platform data. Ask me about listings, students, reports, or any admin tasks.");
  document.getElementById('aiQuick').innerHTML = QUICK_AI.map(q => `<button class="ai-qbtn" onclick="qAsk('${q}')">${q}</button>`).join('');
}
function toggleAI() { aiOpen = !aiOpen; document.getElementById('aiChat').classList.toggle('open', aiOpen); }
function qAsk(q) { document.getElementById('aiInput').value = q; sendAI(); }
function addBot(txt, thinking = false) {
  const m = document.getElementById('aiMsgs');
  const d = document.createElement('div'); d.className = 'ai-msg-b bot' + (thinking ? ' thinking' : '');
  if (thinking) d.id = 'aiThink'; d.textContent = txt; m.appendChild(d); m.scrollTop = m.scrollHeight;
}
function addUserMsg(txt) {
  const m = document.getElementById('aiMsgs'); const d = document.createElement('div');
  d.className = 'ai-msg-b user'; d.textContent = txt; m.appendChild(d); m.scrollTop = m.scrollHeight;
}
async function getFallbackAIReply(msg) {
  const text = msg.toLowerCase();
  const pendingCount = Array.isArray(DB.pending) ? DB.pending.length : 0;
  const approvedCount = Array.isArray(DB.listings) ? DB.listings.filter(l => l.status === 'approved').length : 0;

  if (text.includes('pending') || text.includes('approval')) {
    return `There are ${pendingCount} pending listing${pendingCount === 1 ? '' : 's'} waiting for review.`;
  }
  if (text.includes('report')) {
    // Ask the database. This used to count DB.reports — a legacy in-memory array that is never
    // populated, so NestBot confidently answered "0 open reports" even when reports were waiting.
    const { count, error } = await supabaseClient
      .from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open');
    if (error) { console.warn('[NestBot reports]', error.message); return "I couldn't read the reports table just now — try the Reports section."; }
    const n = count || 0;
    return `There ${n === 1 ? 'is' : 'are'} ${n} open report${n === 1 ? '' : 's'} right now.`;
  }
  if (text.includes('student') || text.includes('listing')) {
    return `The current view shows ${approvedCount} approved listing${approvedCount === 1 ? '' : 's'} and ${pendingCount} pending listing${pendingCount === 1 ? '' : 's'}.`;
  }
  return 'NestBot is running in local preview mode right now. It can summarize the visible platform state, but it cannot reach the Claude API from this browser session. Ask about pending listings, reports, or current listings and I will help from the data already on this page.';
}

async function sendAI() {
  const inp = document.getElementById('aiInput'); const msg = inp.value.trim(); if (!msg) return;
  inp.value = ''; addUserMsg(msg);
  document.getElementById('aiQuick').style.display = 'none';
  addBot('Thinking...', true);
  aiHistory.push({ role: 'user', content: msg });
  try {
    const reply = await getFallbackAIReply(msg); // async now — it queries the reports count
    const t = document.getElementById('aiThink'); if (t) t.remove();
    addBot(reply); aiHistory.push({ role: 'assistant', content: reply });
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-18);
  } catch (e) {
    const t = document.getElementById('aiThink'); if (t) t.remove();
    addBot('⚠️ NestBot is unavailable right now. Please try again in a moment.');
  }
  document.getElementById('aiMsgs').scrollTop = 9999;
}

// ============================================================
// SHARED UTILITIES
// ============================================================
// ============================================================
// DATA EXPORT
// ============================================================
async function renderExports() {
  const [{ count: stuN }, { count: msgN }, { count: repN }] = await Promise.all([
    supabaseClient.from('profiles').select('id', { count: 'exact', head: true }),
    supabaseClient.from('messages').select('id', { count: 'exact', head: true }),
    supabaseClient.from('reports').select('id',  { count: 'exact', head: true }),
  ]);
  document.getElementById('expStudentCount').textContent = stuN ?? '—';
  document.getElementById('expListCount').textContent = DB.listings.length + DB.pending.length;
  document.getElementById('expConvoCount').textContent = msgN ?? '—';
  document.getElementById('expRepCount').textContent = repN ?? '—';
  document.getElementById('expLogCount').textContent = DB.log.length;
}

function _downloadData(data, filename, fmt) {
  if (fmt === 'json') {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename + '.json'; a.click();
  } else {
    const flat = data.map(r => {
      const out = {};
      Object.keys(r).forEach(k => { out[k] = typeof r[k] === 'object' && r[k] !== null ? JSON.stringify(r[k]) : r[k]; });
      return out;
    });
    const keys = Object.keys(flat[0] || {});
    const csv = [keys.join(','), ...flat.map(r => keys.map(k => `"${String(r[k] || '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename + '.csv'; a.click();
  }
}

async function expData(type, fmt) {
  toast('Preparing export…');
  let data;
  if (type === 'students') {
    const { data: rows } = await supabaseClient.from('profiles').select('*').order('created_at');
    data = rows || [];
  } else if (type === 'listings') {
    data = [...DB.listings, ...DB.pending.map(p => ({ ...p, poster: p.poster?.name || '', status: 'pending' }))];
  } else if (type === 'convos') {
    const { data: rows } = await supabaseClient.from('messages').select('*').order('created_at');
    data = rows || [];
  } else if (type === 'reports') {
    const { data: rows } = await supabaseClient.from('reports').select('*').order('created_at');
    data = rows || [];
  } else if (type === 'log') {
    data = DB.log;
  } else { data = []; }

  _downloadData(data, `caldwellnest-${type}`, fmt);
  DB.log.unshift({ type: 'export', text: `${type} exported as ${fmt.toUpperCase()}`, time: 'Just now', color: '#117A65' });
  logAdminAction('export', { targetType: 'system', meta: { export_type: type, format: fmt } });
  toast(`✓ ${type} exported as ${fmt.toUpperCase()}`);
}

async function expFull() {
  toast('Preparing full backup…');
  const [{ data: students }, { data: messages }, { data: reports }] = await Promise.all([
    supabaseClient.from('profiles').select('*').order('created_at'),
    supabaseClient.from('messages').select('*').order('created_at'),
    supabaseClient.from('reports').select('*').order('created_at'),
  ]);
  const full = {
    exportedAt: new Date().toISOString(),
    students: students || [],
    listings: [...DB.listings, ...DB.pending],
    messages: messages || [],
    reports: reports || [],
    activityLog: DB.log,
    settings: DB.settings,
    content: DB.content
  };
  _downloadData(full, 'caldwellnest-full-backup', 'json');
  localStorage.setItem('cn_last_backup', new Date().toISOString());
  DB.log.unshift({ type: 'export', text: 'Full platform backup exported', time: 'Just now', color: '#117A65' });
  logAdminAction('export', { targetType: 'system', meta: { export_type: 'full_backup', format: 'json' } });
  toast('✓ Full backup downloaded');
}

// STUDENT VERIFICATION removed 2026-07-13 (PENDING_VERIFY / renderVerify / verApprove / verDeny).
// The screen rendered from an array nothing ever wrote to, so it showed "0 pending" forever.
// Supabase Auth gates .edu signups on its own — there was never anything for an admin to approve.

// ============================================================
// PLATFORM HEALTH
// ============================================================
async function renderHealth() {
  // ── DB ping ──────────────────────────────────────────────────────────────
  const dbStatusEl = document.getElementById('hDbStatus');
  const dbSubEl    = document.getElementById('hDbSub');
  if (dbStatusEl) dbStatusEl.innerHTML = '<span style="font-size:14px">&#9644;</span>';
  const t0 = Date.now();
  const { error: pingErr } = await supabaseClient.from('profiles').select('id', { count: 'exact', head: true });
  const pingMs = Date.now() - t0;
  if (dbStatusEl) {
    if (pingErr) {
      dbStatusEl.innerHTML = '&#9646; Error';
      dbStatusEl.parentElement.classList.replace('asc-success', 'asc-danger');
      if (dbSubEl) dbSubEl.textContent = 'Could not reach database';
    } else {
      dbStatusEl.innerHTML = '&#9646; Online';
      if (dbSubEl) dbSubEl.textContent = `Response: ${pingMs}ms`;
    }
  }

  // ── Today's stats ────────────────────────────────────────────────────────
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayISO   = todayStart.toISOString();

  const queries = [
    supabaseClient.from('listings').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
    supabaseClient.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', todayISO),
    supabaseClient.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabaseClient.from('reports').select('id',  { count: 'exact', head: true }).eq('status', 'open'),
  ];
  const [postedRes, signupsRes, pendingRes, reportsRes] = await Promise.all(queries);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
  set('hPostedToday',  postedRes.count  ?? '—');
  set('hSignupsToday', signupsRes.count ?? '—');
  set('hPending',      pendingRes.count ?? '—');
  set('hReports',      reportsRes.count ?? '—');

  // ── Last backup ──────────────────────────────────────────────────────────
  const backupEl = document.getElementById('hBackupAge');
  if (backupEl) {
    const lastBackup = localStorage.getItem('cn_last_backup');
    if (!lastBackup) {
      backupEl.textContent = 'Never';
    } else {
      const diffMs  = Date.now() - new Date(lastBackup).getTime();
      const diffMin = Math.floor(diffMs / 60000);
      const diffH   = Math.floor(diffMin / 60);
      const diffD   = Math.floor(diffH   / 24);
      backupEl.textContent = diffD > 0 ? `${diffD}d ago` : diffH > 0 ? `${diffH}h ago` : diffMin > 0 ? `${diffMin}m ago` : 'Just now';
      backupEl.style.fontSize = '15px';
    }
  }
}

// ============================================================
// SUSPENSION SCREEN
// ============================================================
let _suspendedProfileId = null, _suspendedHistoryId = null;

function showSuspensionScreen(email, profileId, reason, historyId) {
  _suspendedProfileId = profileId || null;
  _suspendedHistoryId = historyId || null;
  document.getElementById('studentApp').style.display = 'none';
  const screen = document.getElementById('suspendedScreen');
  screen.style.display = 'flex';
  const emailField = document.getElementById('appealEmail');
  if (emailField && email) emailField.value = email;
  const reasonEl = document.getElementById('suspensionReasonBlock');
  if (reasonEl) {
    if (reason) {
      reasonEl.style.display = 'block';
      document.getElementById('suspensionReasonText').textContent = reason;
    } else {
      reasonEl.style.display = 'none';
    }
  }
  // reset form state
  document.getElementById('appealFormWrap').style.display = 'block';
  document.getElementById('appealSuccess').style.display = 'none';
  const appealErr = document.getElementById('appealErr');
  appealErr.style.display = 'none';
  appealErr.textContent = '';
  document.getElementById('appealMessage').value = '';
}

function hideSuspensionScreen() {
  document.getElementById('suspendedScreen').style.display = 'none';
  document.getElementById('studentApp').style.display = '';
}

async function submitAppeal() {
  const emailEl = document.getElementById('appealEmail');
  const msgEl = document.getElementById('appealMessage');
  const errEl = document.getElementById('appealErr');
  const email = emailEl.value.trim();
  const message = msgEl.value.trim();

  const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
  errEl.style.display = 'none';

  if (!email.endsWith('@caldwell.edu')) {
    showErr('Please use your @caldwell.edu email address.');
    return;
  }
  if (message.length < 20) {
    showErr('Please write at least 20 characters explaining your situation.');
    return;
  }
  if (!_suspendedProfileId) {
    showErr('Session error — please log in and out again to reset.');
    return;
  }

  const { error } = await supabaseClient.from('appeals').insert({
    profile_id: _suspendedProfileId,
    email,
    message,
    status: 'open',
    suspension_history_id: _suspendedHistoryId || null
  });

  if (error) {
    showErr('Could not submit — ' + error.message);
    console.error(error);
    return;
  }

  logEvent('appeal_submitted', { targetType: 'student', targetId: _suspendedProfileId });
  document.getElementById('appealFormWrap').style.display = 'none';
  document.getElementById('appealSuccess').style.display = 'block';
}

// ============================================================
// ADMIN APPEALS
// ============================================================
async function renderAppeals() {
  const container = document.getElementById('asec-appeals');
  if (!container) return;

  // Build shell once; filter/sort re-calls skip this block
  if (!document.getElementById('appealWrap')) {
    container.innerHTML = `
      <div class="tcard" style="margin-bottom:16px">
        <div class="tcard-head">
          <div class="tcard-title">Appeals</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="a-sbar" id="appealSearchInput" placeholder="Search student…" oninput="_appealSearch=this.value;renderAppeals()">
            <select class="btn-sm-a btn-a-neutral" id="appealSortSelect" onchange="_appealSort=this.value;renderAppeals()" style="cursor:pointer">
              <option value="newest">Most recent</option>
              <option value="most">Most appeals</option>
              <option value="az">A &#8594; Z</option>
            </select>
            <button id="appealFilterBtn" class="btn-sm-a btn-a-neutral" onclick="toggleFilterPanel('appealFilterPanel','appealFilterBtn')" style="white-space:nowrap">&#9657; Filters</button>
          </div>
        </div>
        <div id="appealFilterPanel" style="padding:10px 18px 14px;border-bottom:1px solid var(--border);display:none;flex-direction:column;gap:12px"></div>
        <div id="appealActiveChips" style="padding:8px 18px 0;display:none;flex-wrap:wrap;gap:6px"></div>
        <div id="appealResultCount" style="padding:4px 18px 8px;font-size:12px;color:var(--text-faint)"></div>
      </div>
      <div id="appealWrap"></div>`;
  }

  const wrap = document.getElementById('appealWrap');

  // Fetch all appeals + join suspension context
  const { data: allAppeals, error } = await supabaseClient
    .from('appeals')
    .select('*, suspension:suspension_history_id(reason, report_id, listing_id, school)')
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted)">Could not load appeals.</p>'; return; }
  if (!allAppeals || allAppeals.length === 0) { wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted)">No appeals yet.</p>'; return; }

  // Batch-fetch profiles for names + school
  const profileIds = [...new Set(allAppeals.map(a => a.profile_id).filter(Boolean))];
  const { data: profileRows } = profileIds.length
    ? await supabaseClient.from('profiles').select('id, first_name, last_name, school').in('id', profileIds)
    : { data: [] };
  const profileMap = Object.fromEntries((profileRows || []).map(p => [p.id, p]));

  // School scoping
  let appeals = aAdminSchool
    ? allAppeals.filter(a => (profileMap[a.profile_id]?.school || a.suspension?.school) === aAdminSchool)
    : [...allAppeals];

  // Apply filters (client-side)
  if (_appealStatusFilter === 'open')        appeals = appeals.filter(a => a.status === 'open');
  else if (_appealStatusFilter === 'reinstated') appeals = appeals.filter(a => a.status === 'resolved_reinstated');
  else if (_appealStatusFilter === 'upheld')     appeals = appeals.filter(a => a.status === 'resolved_upheld');

  if (_appealSearch.trim()) {
    const q = _appealSearch.trim().toLowerCase();
    appeals = appeals.filter(a => {
      const p = profileMap[a.profile_id];
      const name = p ? `${p.first_name||''} ${p.last_name||''}`.toLowerCase() : '';
      return name.includes(q) || (a.email||'').toLowerCase().includes(q);
    });
  }

  // Build control widgets
  _buildAppealFilterPanel();
  _buildAppealActiveChips();
  if (_appealStatusFilter !== 'all') ensureFilterOpen('appealFilterPanel', 'appealFilterBtn');

  const openCount = appeals.filter(a => a.status === 'open').length;
  const countEl = document.getElementById('appealResultCount');
  if (countEl) countEl.innerHTML = appeals.length
    ? `${appeals.length} appeal${appeals.length===1?'':'s'} ${openCount?`<span style="color:var(--danger);font-weight:600">· ${openCount} open</span>`:''}`
    : '';

  const sortSel = document.getElementById('appealSortSelect');
  if (sortSel) sortSel.value = _appealSort;

  if (!appeals.length) {
    wrap.innerHTML = '<p style="padding:24px;color:var(--text-muted);font-size:13px">No appeals match your filters.</p>';
    return;
  }

  // Build grouped sections
  const openAppeals     = appeals.filter(a => a.status === 'open');
  const resolvedAppeals = appeals.filter(a => a.status !== 'open');

  const buildGroups = (sectionAppeals, collapsed) => {
    const gMap = {};
    sectionAppeals.forEach(a => {
      const key = a.profile_id || a.email || '__unknown__';
      if (!gMap[key]) gMap[key] = { key, profileId: a.profile_id, email: a.email, profile: profileMap[a.profile_id], appeals: [] };
      gMap[key].appeals.push(a);
    });
    Object.values(gMap).forEach(g => g.appeals.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
    let groups = Object.values(gMap);
    if (_appealSort === 'most') {
      groups.sort((a,b) => b.appeals.length - a.appeals.length);
    } else if (_appealSort === 'az') {
      groups.sort((a,b) => {
        const na = a.profile ? `${a.profile.first_name||''} ${a.profile.last_name||''}`.trim() || a.email : a.email || '';
        const nb = b.profile ? `${b.profile.first_name||''} ${b.profile.last_name||''}`.trim() || b.email : b.email || '';
        return na.localeCompare(nb);
      });
    } else {
      groups.sort((a,b) => new Date(b.appeals[0].created_at) - new Date(a.appeals[0].created_at));
    }
    return groups.map(g => _renderAppealGroup(g, collapsed)).join('');
  };

  wrap.innerHTML = `
    <div class="tcard" style="margin-bottom:16px">
      <div class="tcard-head">
        <div class="tcard-title">Needs action</div>
        <span style="font-size:12px;color:${openAppeals.length?'var(--danger)':'var(--success)'};font-weight:600">${openAppeals.length} open</span>
      </div>
      ${openAppeals.length ? buildGroups(openAppeals, false) : '<p style="padding:16px 20px;color:var(--text-muted);font-size:13px">No open appeals — all clear. &#10003;</p>'}
    </div>
    <div class="tcard">
      <div class="tcard-head">
        <div class="tcard-title">Resolved</div>
        <span style="font-size:12px;color:var(--text-muted);font-weight:500">${resolvedAppeals.length} resolved</span>
      </div>
      ${resolvedAppeals.length ? buildGroups(resolvedAppeals, true) : '<p style="padding:16px 20px;color:var(--text-muted);font-size:13px">No resolved appeals yet.</p>'}
    </div>`;
}

function _renderAppealGroup(g, startCollapsed) {
  const sk      = (g.key||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_');
  const p       = g.profile;
  const name    = p ? `${p.first_name||''} ${p.last_name||''}`.trim() || g.email : g.email || '—';
  const initial = (name[0]||'?').toUpperCase();
  const school  = p?.school;
  const openCnt = g.appeals.filter(a => a.status === 'open').length;
  const lastDate= fmtActivityTime(g.appeals[0].created_at);
  const schoolBadge = school
    ? `<span class="school-chip" style="margin-left:6px">${esc(school)}</span>`
    : '';
  const statusHint = openCnt
    ? `<span style="color:var(--danger);font-weight:600">${openCnt} open</span>`
    : g.appeals.every(a=>a.status==='resolved_reinstated')
    ? `<span style="color:#1a7a45;font-weight:500">Reinstated &#10003;</span>`
    : g.appeals.every(a=>a.status==='resolved_upheld')
    ? `<span style="color:#888;font-weight:500">Upheld</span>`
    : `<span style="color:var(--text-muted)">Mixed</span>`;

  return `<div style="border-bottom:1px solid var(--border)">
    <div style="padding:11px 18px;display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none" onclick="_toggleAppealGroup('${sk}')">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--brand-pale);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--brand);flex-shrink:0">${esc(initial)}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          <span class="stu-link-a" onclick="event.stopPropagation();aOpenStudentHistory('${g.profileId}')" style="font-weight:600;font-size:14px">${esc(name)}</span>
          ${schoolBadge}
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
          ${g.appeals.length} appeal${g.appeals.length===1?'':'s'} &nbsp;·&nbsp; last ${lastDate} &nbsp;·&nbsp; ${statusHint}
        </div>
      </div>
      <span id="ag-arrow-${sk}" style="color:var(--text-faint);font-size:14px">${startCollapsed?'▸':'▾'}</span>
    </div>
    <div id="ag-body-${sk}" style="display:${startCollapsed?'none':'block'}">
      ${g.appeals.map(a => _appealCard(a)).join('')}
    </div>
  </div>`;
}

function _appealCard(a) {
  const isOpen = a.status === 'open';
  const statusMap = { open:['#fde8e8','#c0392b','Open'], resolved_reinstated:['#e8f5e9','#1a7a45','Reinstated &#10003;'], resolved_upheld:['#f0f0f0','#888','Upheld'] };
  const [sbg,sc,sl] = statusMap[a.status] || ['#f0f0f0','#888',a.status];
  const badge = `<span style="background:${sbg};color:${sc};border-radius:20px;padding:3px 11px;font-size:11px;font-weight:600;white-space:nowrap">${sl}</span>`;

  return `<div style="padding:14px 18px 14px 60px;border-top:1px solid var(--border)" id="appeal-card-${a.id}">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      ${badge}
      <span style="font-size:11px;color:var(--text-faint)">${fmtActivityTime(a.created_at)}</span>
    </div>
    ${a.suspension ? `<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:var(--text-muted)">
      <span style="font-weight:600;color:var(--text)">Suspension reason:</span> ${a.suspension.reason ? esc(a.suspension.reason) : '<em>No reason recorded</em>'}
      ${a.suspension.report_id ? ` &nbsp;·&nbsp; <span class="stu-link-a" onclick="openReportDrawer('${a.suspension.report_id}')">View triggering report ↗</span>` : ''}
    </div>` : ''}
    <p style="color:var(--text-muted);font-size:13px;line-height:1.6;margin:0 0 12px">${esc(a.message || '—')}</p>
    ${isOpen
      ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
           <button class="btn-sm-a btn-a-success" onclick="aReinstate('${a.profile_id}','${a.id}')">&#10003; Reinstate — grant appeal</button>
           <button class="btn-sm-a btn-a-danger"  onclick="openUpholdForm('${a.id}')">Uphold — deny appeal</button>
         </div>
         <div id="uphold-form-${a.id}" style="display:none;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
           <div style="font-size:13px;font-weight:600;margin-bottom:8px">Reason for upholding (shown to student on their suspended screen)</div>
           <textarea id="uphold-note-${a.id}" class="form-textarea" rows="2" maxlength="500" placeholder="Why the suspension stands (optional but recommended)…" style="margin-bottom:10px"></textarea>
           <div style="display:flex;gap:8px">
             <button class="btn-sm-a btn-a-danger" onclick="confirmUphold('${a.id}','${a.profile_id}')">Confirm — uphold suspension</button>
             <button class="btn-sm-a btn-a-neutral" onclick="document.getElementById('uphold-form-${a.id}').style.display='none'">Cancel</button>
           </div>
         </div>`
      : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
           <button class="btn-sm-a btn-a-neutral" onclick="openAppealEdit('${a.id}','${a.profile_id}','${a.status}')">&#9998; Edit decision</button>
         </div>
         <div id="appeal-edit-${a.id}" style="display:none;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
           <div style="font-size:13px;font-weight:600;margin-bottom:10px">Change decision</div>
           <div style="display:flex;gap:8px;margin-bottom:10px">
             <button class="filter-chip${a.status==='resolved_reinstated'?' active':''}" id="aed-${a.id}-r" onclick="selectAppealEdit('${a.id}','reinstated')">Reinstated &#10003;</button>
             <button class="filter-chip${a.status==='resolved_upheld'?' active':''}"    id="aed-${a.id}-u" onclick="selectAppealEdit('${a.id}','upheld')">Upheld</button>
           </div>
           <textarea id="aed-note-${a.id}" class="form-textarea" rows="2" maxlength="500" placeholder="Reason for changing the decision (required)…" style="margin-bottom:10px"></textarea>
           <div style="display:flex;gap:8px">
             <button class="btn-sm-a btn-a-success" onclick="submitAppealEdit('${a.id}','${a.profile_id}')">Confirm edit</button>
             <button class="btn-sm-a btn-a-neutral" onclick="document.getElementById('appeal-edit-${a.id}').style.display='none'">Cancel</button>
           </div>
         </div>`}
    <button onclick="toggleAppealLog('${a.id}')" style="background:none;border:none;font-size:12px;color:var(--text-muted);cursor:pointer;padding:0;font-family:inherit" id="appeal-log-btn-${a.id}">&#9656; Decision history</button>
    <div id="appeal-log-${a.id}" style="display:none;margin-top:8px;border-top:1px solid var(--border);padding-top:10px"></div>
  </div>`;
}

function _buildAppealFilterPanel() {
  const el = document.getElementById('appealFilterPanel');
  if (!el) return;
  const secHead = aFieldLabel, chipRow = aChipRow; // shared — see top of the admin UI helpers
  const statusOpts = [{v:'all',l:'All'},{v:'open',l:'Open'},{v:'reinstated',l:'Reinstated &#10003;'},{v:'upheld',l:'Upheld'}];
  el.innerHTML = `<div>${secHead('Status')}${chipRow(statusOpts, _appealStatusFilter, '_setAppealStatus')}</div>`;
  if (aAdminSchool) {
    el.innerHTML += `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:10px">${secHead('School')}<span class="school-chip">&#128274; ${aAdminSchool} only</span></div>`;
  }
}

function _buildAppealActiveChips() {
  const el = document.getElementById('appealActiveChips');
  if (!el) return;
  const chips = [];
  const statusLabels = { open:'Open', reinstated:'Reinstated ✓', upheld:'Upheld' };
  if (_appealSearch.trim())          chips.push([`Search: "${_appealSearch.trim()}"`,            '_appealClearSearch()']);
  if (_appealStatusFilter !== 'all') chips.push([`Status: ${statusLabels[_appealStatusFilter]}`, '_appealClearStatus()']);
  if (!chips.length) { el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='flex';
  el.innerHTML = chips.map(([label,fn]) =>
    `<button class="filter-chip active" onclick="${fn}" style="display:flex;align-items:center;gap:4px">${label} <span style="font-size:10px;opacity:.65">&#10005;</span></button>`
  ).join('') + (chips.length>1
    ? `<button onclick="clearAppealFilters()" style="font-size:11px;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px 8px;text-decoration:underline;align-self:center">Clear all</button>`
    : '');
}

function _setAppealStatus(v)   { _appealStatusFilter = v; renderAppeals(); }
function _appealClearSearch()  { _appealSearch=''; const i=document.getElementById('appealSearchInput'); if(i)i.value=''; renderAppeals(); }
function _appealClearStatus()  { _appealStatusFilter='all'; renderAppeals(); }
function clearAppealFilters()  {
  _appealSearch=''; _appealStatusFilter='all';
  const i=document.getElementById('appealSearchInput'); if(i)i.value='';
  renderAppeals();
}
function _toggleAppealGroup(sk) {
  const body  = document.getElementById('ag-body-'+sk);
  const arrow = document.getElementById('ag-arrow-'+sk);
  if (!body) return;
  const collapsing = body.style.display !== 'none';
  body.style.display  = collapsing ? 'none' : '';
  if (arrow) arrow.textContent = collapsing ? '▸' : '▾';
}

function openUpholdForm(id) {
  const el = document.getElementById(`uphold-form-${id}`);
  if (el) { el.style.display = 'block'; document.getElementById(`uphold-note-${id}`)?.focus(); }
}

async function confirmUphold(id, profileId) {
  const note = document.getElementById(`uphold-note-${id}`)?.value.trim() || null;
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { error } = await supabaseClient.from('appeals').update({ status: 'resolved_upheld' }).eq('id', id);
  if (error) { toast('Could not resolve — please try again.'); console.error(error.message); return; }
  if (profileId && note) {
    await supabaseClient.from('profiles').update({ suspension_reason: note }).eq('id', profileId);
  }
  const { error: logErr } = await supabaseClient.from('appeal_audit_log').insert({ appeal_id: id, action: 'resolved_upheld', new_status: 'resolved_upheld', actioned_by: user?.id, note });
  if (logErr) console.error('Audit log error:', logErr.message);
  toast('Suspension upheld');
  updateAppealsBadge();
  renderAppeals();
}

function openAppealEdit(id, profileId, currentStatus) {
  const r = document.getElementById(`aed-${id}-r`);
  const u = document.getElementById(`aed-${id}-u`);
  if (r) r.classList.toggle('active', currentStatus === 'resolved_reinstated');
  if (u) u.classList.toggle('active', currentStatus === 'resolved_upheld');
  document.getElementById(`aed-note-${id}`).value = '';
  document.getElementById(`appeal-edit-${id}`).style.display = 'block';
}

function selectAppealEdit(id, choice) {
  document.getElementById(`aed-${id}-r`).classList.toggle('active', choice === 'reinstated');
  document.getElementById(`aed-${id}-u`).classList.toggle('active', choice === 'upheld');
}

async function submitAppealEdit(id, profileId) {
  const note = document.getElementById(`aed-note-${id}`).value.trim();
  if (!note) { toast('A reason is required when editing a decision.'); return; }
  const isReinstated = document.getElementById(`aed-${id}-r`).classList.contains('active');
  const newStatus = isReinstated ? 'resolved_reinstated' : 'resolved_upheld';
  const { data: { user } } = await supabaseClient.auth.getUser();

  const { error } = await supabaseClient.from('appeals').update({ status: newStatus }).eq('id', id);
  if (error) { toast('Could not update — please try again.'); console.error(error); return; }

  if (profileId) {
    if (isReinstated) {
      await supabaseClient.from('profiles').update({ status: 'active', suspension_reason: null }).eq('id', profileId);
      supabaseClient.from('suspension_history').insert({ profile_id: profileId, action: 'reinstated', reason: `Appeal decision edited: ${note}`, actioned_by: user?.id });
      aNotifyStudent(profileId, 'appeal_edited', `An admin has updated the decision on your appeal. New decision: Reinstated — your account has been restored. Reason noted: ${note}`);
    } else {
      await supabaseClient.from('profiles').update({ status: 'suspended', suspension_reason: note }).eq('id', profileId);
      supabaseClient.from('suspension_history').insert({ profile_id: profileId, action: 'suspended', reason: `Appeal decision edited (upheld): ${note}`, actioned_by: user?.id });
    }
  }

  const { error: logErr } = await supabaseClient.from('appeal_audit_log').insert({ appeal_id: id, action: 'decision_edited', new_status: newStatus, actioned_by: user?.id, note });
  if (logErr) console.error('Audit log error:', logErr.message);
  toast(`Decision updated to ${isReinstated ? 'Reinstated' : 'Upheld'}`);
  renderAppeals();
}

async function toggleAppealLog(id) {
  const logEl = document.getElementById(`appeal-log-${id}`);
  const btn   = document.getElementById(`appeal-log-btn-${id}`);
  if (logEl.style.display !== 'none') {
    logEl.style.display = 'none';
    if (btn) btn.innerHTML = '&#9656; Decision history';
    return;
  }
  logEl.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:4px 0">Loading…</div>';
  logEl.style.display = 'block';
  if (btn) btn.innerHTML = '&#9662; Decision history';

  const { data: entries } = await supabaseClient
    .from('appeal_audit_log')
    .select('action, new_status, note, created_at')
    .eq('appeal_id', id)
    .order('created_at', { ascending: true });

  if (!entries || entries.length === 0) {
    logEl.innerHTML = '<div style="font-size:12px;color:var(--text-faint);padding:4px 0">No decisions logged yet. History is recorded from this point forward — decisions made before the audit log was set up will not appear here.</div>';
    return;
  }
  const actionLabel = a => {
    if (a === 'resolved_reinstated') return '&#10003; Decided: Reinstated';
    if (a === 'resolved_upheld')     return 'Decided: Upheld';
    if (a === 'decision_edited')     return '&#9998; Decision edited';
    return a;
  };
  const statusLabel = s => s === 'resolved_reinstated' ? 'Reinstated' : s === 'resolved_upheld' ? 'Upheld' : (s || '—');
  logEl.innerHTML = entries.map(e => `
    <div style="font-size:12px;padding:7px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px">
      <div style="font-weight:600;color:var(--text)">${actionLabel(e.action)} → ${statusLabel(e.new_status)}</div>
      ${e.note ? `<div style="color:var(--text-muted)">${esc(e.note)}</div>` : ''}
      <div style="color:var(--text-faint)">${fmtDate(e.created_at)}</div>
    </div>`).join('');
}

async function updateAppealsBadge() {
  const badge = document.getElementById('appealsBadge');
  if (!badge) return;
  const { count } = await supabaseClient.from('appeals').select('id', { count: 'exact', head: true }).eq('status', 'open');
  if (count && count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ============================================================
// ADMIN SECTION ROUTER — ago() and the section → renderer map
// ============================================================
const _agoMap = {
  approvals: renderAApprovals, listings: renderAListings, pinned: renderAPinned,
  students: renderAStudents, messages: renderAMessages, reports: renderAReports,
  activity: renderAActivity, analytics: buildAnalytics,
  exports: () => { renderExports(); },
  health: renderHealth,
  appeals: renderAppeals,
};
// The one and only ago(). Switches the visible admin section, sets the title, and calls
// that section's renderer. rerenderActiveAdminSection() reuses _agoMap to repaint on reload.
function ago(s, btn) {
  document.querySelectorAll('.a-section').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.a-nav-item').forEach(x => x.classList.remove('active'));
  // handle both asec-asettings and asec-settings
  const sec = document.getElementById('asec-' + s) || document.getElementById('asec-a' + s);
  if (!sec) return;
  sec.classList.add('active');
  if (btn) { btn.classList.add('active'); _anaNavSource = null; }
  const allTitles = { ...ATITLES, exports: 'Data export', health: 'Platform health', appeals: 'Appeals' };
  const titleEl = document.getElementById('aTopTitle');
  titleEl.textContent = allTitles[s] || s;
  const backBar = document.getElementById('ana-back-bar');
  if (backBar) backBar.style.display = (_anaNavSource === 'analytics' && s !== 'analytics') ? 'block' : 'none';
  if (_agoMap[s]) _agoMap[s]();
  updateDrillCtx();
}
