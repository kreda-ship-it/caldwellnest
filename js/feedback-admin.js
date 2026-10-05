// ============================================================
// FEEDBACK — the admin page (Admin → Feedback)
// Overview cards, four small charts, patterns ("students mentioning this"), the inbox with filters and
// search, one response in the side drawer (status, tags, internal notes), product changes and
// "You asked, we built", CSV export, and checking a completion ID a professor was shown.
// The student side is js/feedback.js, which this file borrows its labels from.
// Added 2026-10-05. Loaded as a plain script (not a module) so every function stays global — the
// HTML's onclick="..." handlers depend on that. Load order is set in index.html; boot.js must stay last.
//
// What this file shows is decided by the database, not here (sql/changes/2026-10-05_student_feedback.sql):
//   - rows come from the view app_feedback_admin, which returns nothing without view_feedback, and gives
//     the student's name and email ONLY when they ticked "You can message me";
//   - status, tags and notes change through admin_update_feedback(), which needs manage_feedback;
//   - "N students" comes from admin_feedback_student_counts(), which counts and never names.
// aCan() below only decides which buttons to draw.
// ============================================================

const FA_STATUSES = [
  { key: 'new',         label: 'New' },
  { key: 'reviewing',   label: 'Reviewing' },
  { key: 'planned',     label: 'Planned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'completed',   label: 'Completed' },
  { key: 'wont_do',     label: 'Won’t do' },
  { key: 'duplicate',   label: 'Duplicate' },
];
const FA_STATUS_LABEL = Object.fromEntries(FA_STATUSES.map(s => [s.key, s.label]));
// The suggested tags. A short, stable list is what lets September's "Search" mean the same as March's.
const FA_TAGS = ['Bug', 'UX', 'Performance', 'Mobile', 'Search', 'Events', 'Housing', 'Marketplace', 'Textbooks',
                 'Clubs', 'Messaging', 'Announcements', 'Feature Request', 'Positive'];
const FA_SOURCES = {
  general: 'General feedback', student_evaluation: 'Student evaluation', course_evaluation: 'Professor / course evaluation',
  usability_study: 'Usability study', focus_group: 'Focus group', term_survey: 'Term survey', other: 'Other',
};
const FA_KIND_LABEL = { bug: 'Something’s broken', confusing: 'Something’s confusing', idea: 'Idea', praise: 'Likes something' };
const FA_CHANGE_STATUSES = [
  { key: 'planned', label: 'Planned' }, { key: 'in_progress', label: 'In progress' },
  { key: 'shipped', label: 'Shipped' }, { key: 'dropped', label: 'Dropped' },
];
const FA_CHANGE_LABEL = Object.fromEntries(FA_CHANGE_STATUSES.map(s => [s.key, s.label]));
const FA_PAGE = 25;
const FA_PATTERN_MIN = 3;      // the rule of three: fewer students than this is a story, not a pattern
const FA_SMALL_SAMPLE = 30;    // under this many answers, a percentage swings too much to trust
const FA_RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']];

let _fa = {
  rows: [], changes: [], links: [], counts: null, loaded: false, error: '', missing: false,
  range: 'all', from: '', to: '',
  f: { source: '', rating: '', feature: '', miss: '', contact: '', status: '', tag: '', kind: '', change: '' },
  q: '', tab: 'inbox', shown: FA_PAGE, sel: new Set(), openId: null, linkIds: null,
};
let _faCountsSeq = 0;
let _faSearchTimer = null;

// ---------------------------------------------------------------- loading
function faSince() {
  if (_fa.range === 'custom') return _fa.from ? new Date(_fa.from + 'T00:00:00').toISOString() : null;
  if (_fa.range === 'all') return null;
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - Number(_fa.range) + 1);
  return d.toISOString();
}
function faUntil() {
  return _fa.range === 'custom' && _fa.to ? new Date(_fa.to + 'T23:59:59.999').toISOString() : null;
}

async function faLoad() {
  _fa.error = ''; _fa.missing = false;
  const since = faSince(), until = faUntil();
  const rows = [];
  // Supabase answers at most 1,000 rows a request (see fetchAllRows in js/admin.js), so read in pages.
  for (let from = 0; from < 20000; from += 1000) {
    let q = supabaseClient.from('app_feedback_admin').select('*')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 999);
    if (since) q = q.gte('created_at', since);
    if (until) q = q.lte('created_at', until);
    const { data, error } = await q;
    if (error) {
      _fa.error = error.message || 'unknown error';
      _fa.missing = error.code === 'PGRST205' || error.code === '42P01' || /schema cache|does not exist/i.test(_fa.error);
      return;
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  _fa.rows = rows;
  await faLoadChanges();
  _fa.loaded = true;
  _fa.sel = new Set([..._fa.sel].filter(id => rows.some(r => r.id === id)));
}

async function faLoadChanges() {
  const [chRes, lkRes] = await Promise.all([
    supabaseClient.from('product_changes').select('*').order('created_at', { ascending: false }),
    supabaseClient.from('product_change_feedback').select('change_id, feedback_id'),
  ]);
  if (chRes.error) console.error('[feedback-admin] product changes:', chRes.error.message);
  _fa.changes = chRes.data || [];
  _fa.links = lkRes.data || [];
}

// "6 students", not "6 messages": one call that counts different students in every group the page shows.
async function faRefreshCounts() {
  const seq = ++_faCountsSeq;
  const groups = { all: _fa.rows.map(r => r.id), filtered: faFiltered().map(r => r.id), sel: [..._fa.sel] };
  const byTag = new Map(), byFeat = new Map(), byImp = new Map();
  for (const r of _fa.rows) {
    for (const t of r.tags || []) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(r.id); }
    for (const k of r.features_used || []) { if (!byFeat.has(k)) byFeat.set(k, []); byFeat.get(k).push(r.id); }
    if (faIsImprovement(r)) for (const t of r.tags || []) { if (!byImp.has(t)) byImp.set(t, []); byImp.get(t).push(r.id); }
  }
  [...byTag].slice(0, 80).forEach(([t, ids]) => { groups['tag:' + t] = ids; });
  [...byImp].slice(0, 40).forEach(([t, ids]) => { groups['imp:' + t] = ids; });
  byFeat.forEach((ids, k) => { groups['feat:' + k] = ids; });
  _fa.changes.slice(0, 60).forEach(c => { groups['ch:' + c.id] = faChangeFeedbackIds(c.id); });
  const { data, error } = await supabaseClient.rpc('admin_feedback_student_counts', { p_groups: groups });
  if (seq !== _faCountsSeq) return;            // a newer request has been sent since
  if (error) { console.error('[feedback-admin] counts:', error.message); return; }
  _fa.counts = data || {};
  faPaintCounts();
}
const faCount = key => (_fa.counts && typeof _fa.counts[key] === 'number') ? _fa.counts[key] : null;
const faStudents = (key, fallbackRows) => {
  const n = faCount(key);
  return n == null ? `${fallbackRows} response${fallbackRows === 1 ? '' : 's'}` : `${n} student${n === 1 ? '' : 's'}`;
};
const faChangeFeedbackIds = id => _fa.links.filter(l => l.change_id === id).map(l => l.feedback_id);
// An answer that asks for something: a wish, a problem, or a quick note that is not praise.
const faIsImprovement = r => !!(r.one_thing_to_change || r.confusing_or_missing || ['idea', 'bug', 'confusing'].includes(r.kind));

// ---------------------------------------------------------------- the page
async function renderFeedbackAdmin(reload = true) {
  const host = document.getElementById('asec-feedback');
  if (!host) return;
  if (!aCan('view_feedback')) {
    host.innerHTML = '<div class="fa-empty">Your role doesn’t include feedback.</div>';
    return;
  }
  if (reload || !_fa.loaded) {
    host.innerHTML = '<div class="fa-empty">Loading feedback…</div>';
    await faLoad();
  }
  if (_fa.error) {
    host.innerHTML = _fa.missing
      ? '<div class="fa-empty"><b>Feedback isn’t set up in the database yet.</b><br>Run <code>sql/changes/2026-10-05_student_feedback.sql</code> (PART 1) in the Supabase SQL Editor, then reload.</div>'
      : `<div class="fa-empty">Could not load feedback: ${esc(_fa.error)}</div>`;
    return;
  }
  host.innerHTML = `<div class="fa">
    ${faRangeBarHTML()}
    <div id="faOverview"></div>
    <div class="fa-tabs" role="tablist">
      <button type="button" role="tab" class="fa-tab ${_fa.tab === 'inbox' ? 'is-on' : ''}" aria-selected="${_fa.tab === 'inbox'}" onclick="faSetTab('inbox')">Responses <span class="fa-tab-n">${_fa.rows.length}</span></button>
      <button type="button" role="tab" class="fa-tab ${_fa.tab === 'changes' ? 'is-on' : ''}" aria-selected="${_fa.tab === 'changes'}" onclick="faSetTab('changes')">You asked, we built <span class="fa-tab-n">${_fa.changes.length}</span></button>
    </div>
    <div id="faTabBody"></div>
  </div>`;
  faPaintOverview();
  faPaintTab();
  faRefreshCounts();
}

function faRangeBarHTML() {
  const btns = FA_RANGES.map(([k, l]) =>
    `<button type="button" class="btn-sm-a btn-a-neutral ${_fa.range === k ? 'active' : ''}" onclick="faSetRange('${k}')">${l}</button>`).join('');
  return `<div class="fa-col">
    <div class="fa-range" role="group" aria-label="Date range">${btns}
      <span class="fa-custom">
        <label class="fa-sr" for="faFrom">From</label><input type="date" id="faFrom" class="fa-input" value="${escAttr(_fa.from)}">
        <span aria-hidden="true">–</span>
        <label class="fa-sr" for="faTo">To</label><input type="date" id="faTo" class="fa-input" value="${escAttr(_fa.to)}">
        <button type="button" class="btn-sm-a btn-a-neutral ${_fa.range === 'custom' ? 'active' : ''}" onclick="faApplyCustom()">Apply</button>
      </span>
    </div>
    <div class="fa-actions">
      <button type="button" class="btn-sm-a btn-a-neutral" onclick="faOpenVerify()">Check a completion ID</button>
      ${aCan('export_data') ? '<button type="button" class="btn-sm-a btn-a-brand" onclick="faExport()">Export CSV</button>' : ''}
    </div>
  </div>`;
}

function faSetRange(r) { _fa.range = r; renderFeedbackAdmin(true); }
function faApplyCustom() {
  _fa.from = document.getElementById('faFrom')?.value || '';
  _fa.to = document.getElementById('faTo')?.value || '';
  if (!_fa.from && !_fa.to) { toast('Pick a start or end date'); return; }
  _fa.range = 'custom';
  renderFeedbackAdmin(true);
}
function faSetTab(t) {
  _fa.tab = t;
  document.querySelectorAll('#asec-feedback .fa-tab').forEach((b, i) => {
    const on = (i === 0 && t === 'inbox') || (i === 1 && t === 'changes');
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  faPaintTab();
}

// ---------------------------------------------------------------- overview: cards, charts, patterns
function faEvalRows() { return _fa.rows.filter(r => r.overall_rating || r.would_miss_nestrel); }

function faPaintOverview() {
  const el = document.getElementById('faOverview');
  if (!el) return;
  const rows = _fa.rows;
  if (!rows.length) {
    el.innerHTML = `<div class="fa-empty">No feedback ${_fa.range === 'all' ? 'yet' : 'in this period'}. Students send it from the round Feedback button, or at <b>nestrel.org/#/feedback</b>.</div>`;
    return;
  }
  const rated = rows.filter(r => r.overall_rating);
  const avg = rated.length ? rated.reduce((s, r) => s + r.overall_rating, 0) / rated.length : null;
  const missed = rows.filter(r => r.would_miss_nestrel);
  const very = missed.filter(r => r.would_miss_nestrel === 'very_disappointed').length;
  const now = Date.now(), wk = 7 * 864e5;
  const thisWeek = rows.filter(r => now - new Date(r.created_at) < wk).length;
  const lastWeek = rows.filter(r => { const a = now - new Date(r.created_at); return a >= wk && a < 2 * wk; }).length;
  const feat = faFeatureTotals()[0];
  const card = (label, num, sub, extra = '') =>
    `<div class="asc fa-card"><div class="asc-label">${label}</div><div class="asc-num">${num}</div><div class="asc-sub">${sub}</div>${extra}</div>`;
  el.innerHTML = `<div class="fa-cards">
      ${card('Total responses', rows.length, `<span data-fa-count="all">${faStudents('all', rows.length)}</span>`)}
      ${card('Average rating', avg == null ? '—' : `${avg.toFixed(1)}<small> / 5</small>`, avg == null ? 'No ratings yet' : `from ${rated.length} evaluation${rated.length === 1 ? '' : 's'}`)}
      ${card('Very disappointed', missed.length ? Math.round(100 * very / missed.length) + '%' : '—',
             missed.length ? `${very} of ${missed.length} would be very disappointed without Nestrel` : 'No answers yet',
             missed.length && missed.length < FA_SMALL_SAMPLE ? `<div class="fa-caution">Fewer than ${FA_SMALL_SAMPLE} answers: read it as a hint. 40% is the usual sign students really need it.</div>` : '')}
      ${card('Last 7 days', thisWeek, `${lastWeek} the 7 days before`)}
      ${card('Most used feature', feat ? esc(FB_FEATURE_LABEL[feat.key] || feat.key) : '—',
             feat ? `<span data-fa-count="feat:${escAttr(feat.key)}">${faStudents('feat:' + feat.key, feat.n)}</span> said they used it` : 'No answers yet')}
      <div class="asc fa-card" id="faTopImp">${faTopImprovementHTML()}</div>
    </div>
    <div class="fa-charts">
      ${faChartCard('Average rating by ' + faBucketWord(), faRatingChartSVG(), 'Each bar is the average of that period’s 1–5 ratings.')}
      ${faChartCard('Responses by ' + faBucketWord(), faVolumeChartSVG(), 'Every kind of feedback, by when it was sent.')}
      ${faChartCard('Would students miss Nestrel?', faValueChartHTML(missed), 'The “very disappointed” share is the number to watch over time.')}
      ${faChartCard('What students used', '<div id="faFeatChart">' + faFeatureChartSVG() + '</div>', 'Different students who said they tried each part.')}
    </div>
    <div class="tcard fa-patterns"><div class="tcard-head"><div class="tcard-title">What students keep mentioning</div>
      <span class="fa-muted">From the tags you add while reading. ${FA_PATTERN_MIN}+ different students = a pattern.</span></div>
      <div id="faPatterns">${faPatternsHTML()}</div></div>`;
}

// Tags on answers that ask for something, ranked by how many different students they come from.
function faTopImprovementHTML() {
  const tags = new Map();
  _fa.rows.filter(faIsImprovement).forEach(r => (r.tags || []).forEach(t => tags.set(t, (tags.get(t) || 0) + 1)));
  if (!tags.size) {
    return '<div class="asc-label">Top requested improvement</div><div class="asc-num">—</div><div class="asc-sub">Tag responses to see this</div>';
  }
  const ranked = [...tags].map(([t, n]) => ({ t, n, s: faCount('imp:' + t) ?? n })).sort((a, b) => b.s - a.s || b.n - a.n);
  const top = ranked[0];
  return `<div class="asc-label">Top requested improvement</div><div class="asc-num fa-num-text">${esc(top.t)}</div>
    <div class="asc-sub">${faCount('imp:' + top.t) == null ? `${top.n} response${top.n === 1 ? '' : 's'}` : `${top.s} student${top.s === 1 ? '' : 's'}`} asked about it</div>`;
}

function faPatternsHTML() {
  const tags = new Map();
  _fa.rows.forEach(r => (r.tags || []).forEach(t => tags.set(t, (tags.get(t) || 0) + 1)));
  if (!tags.size) {
    return '<div class="fa-empty fa-empty-sm">Nothing tagged yet. Open a response and add tags such as “Search” or “Bug”; tags that 3 or more different students share show up here.</div>';
  }
  const list = [...tags].map(([t, n]) => ({ t, n, s: faCount('tag:' + t) })).sort((a, b) => (b.s ?? b.n) - (a.s ?? a.n) || b.n - a.n);
  return `<div class="fa-pat-list">${list.map(x => {
    const students = x.s ?? null;
    const pattern = students != null && students >= FA_PATTERN_MIN;
    return `<button type="button" class="fa-pat ${pattern ? 'is-pattern' : ''}" data-tag="${escAttr(x.t)}" onclick="faFilterTag(this.dataset.tag)">
      <span class="fa-pat-name">${esc(x.t)}</span>
      <span class="fa-pat-n">${students == null ? '…' : `${students} student${students === 1 ? '' : 's'}`} · ${x.n} response${x.n === 1 ? '' : 's'}</span>
      <span class="fa-pat-badge">${pattern ? 'Pattern' : 'Watch'}</span></button>`;
  }).join('')}</div>`;
}

// Fills in the "N students" numbers once the database has counted them, without redrawing the page.
function faPaintCounts() {
  document.querySelectorAll('#asec-feedback [data-fa-count]').forEach(el => {
    const key = el.dataset.faCount;
    const n = faCount(key);
    if (n != null) el.textContent = `${n} student${n === 1 ? '' : 's'}`;
  });
  const top = document.getElementById('faTopImp'); if (top) top.innerHTML = faTopImprovementHTML();
  const pat = document.getElementById('faPatterns'); if (pat) pat.innerHTML = faPatternsHTML();
  const feat = document.getElementById('faFeatChart'); if (feat) feat.innerHTML = faFeatureChartSVG();
  faPaintSummary();
  faPaintSelBar();
  if (_fa.tab === 'changes') faPaintChanges();
}

// ---------------------------------------------------------------- charts (plain SVG, one hue)
function faChartCard(title, inner, note) {
  return `<figure class="tcard fa-chart"><figcaption class="tcard-head"><span class="tcard-title">${title}</span></figcaption>
    <div class="fa-chart-body">${inner}</div><p class="fa-chart-note">${note}</p></figure>`;
}

// Weeks (starting Monday) for up to 26 weeks of data, months beyond that.
function faBuckets() {
  if (!_fa.rows.length) return { unit: 'week', keys: [] };
  const times = _fa.rows.map(r => new Date(r.created_at).getTime());
  const first = new Date(Math.min(...times)), last = new Date(Math.max(Date.now(), ...times));
  const weeks = (last - first) / (7 * 864e5);
  const keys = [];
  if (weeks <= 26) {
    const d = faWeekStart(first);
    while (d <= last && keys.length < 60) { keys.push(faYMD(d)); d.setDate(d.getDate() + 7); }
    return { unit: 'week', keys };
  }
  const d = new Date(first.getFullYear(), first.getMonth(), 1);
  while (d <= last && keys.length < 60) { keys.push(faYMD(d)); d.setMonth(d.getMonth() + 1); }
  return { unit: 'month', keys };
}
const faBucketWord = () => faBuckets().unit;
function faWeekStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
const faYMD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function faBucketOf(iso, unit) {
  const d = new Date(iso);
  return unit === 'week' ? faYMD(faWeekStart(d)) : faYMD(new Date(d.getFullYear(), d.getMonth(), 1));
}
function faBucketLabel(key, unit) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return unit === 'week' ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                         : date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// A bar chart: [{label, value, tip}], value from 0 to max. Bars rise from one baseline; a native
// <title> on each is its hover tooltip; at most ~6 x labels so they never collide.
function faBarsSVG(points, max, fmt) {
  if (!points.length) return '<div class="fa-empty fa-empty-sm">No data yet</div>';
  const W = 480, H = 150, L = 26, B = 22, T = 10;
  const w = (W - L - 4) / points.length;
  const bw = Math.max(3, Math.min(28, w - 3));
  const y = v => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(points.length / 6));
  const grid = ticks.map(t => `<line class="fa-grid" x1="${L}" x2="${W - 2}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
      <text class="fa-axis" x="${L - 5}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${fmt(t)}</text>`).join('');
  const bars = points.map((p, i) => {
    const x = L + i * w + (w - bw) / 2;
    const top = p.value > 0 ? y(p.value) : H - B;
    const h = Math.max(0, H - B - top);
    const lbl = i % every === 0 ? `<text class="fa-axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(p.label)}</text>` : '';
    return `<g class="fa-mark"><rect class="fa-hit" x="${(L + i * w).toFixed(1)}" y="${T}" width="${w.toFixed(1)}" height="${H - T - B}"/>
      ${h > 0 ? `<rect class="fa-col" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>` : ''}
      <title>${esc(p.tip)}</title></g>${lbl}`;
  }).join('');
  return `<svg class="fa-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(points.map(p => p.tip).join('; '))}">${grid}
    <line class="fa-base" x1="${L}" x2="${W - 2}" y1="${H - B}" y2="${H - B}"/>${bars}</svg>`;
}

function faRatingChartSVG() {
  const { unit, keys } = faBuckets();
  const sums = new Map();
  _fa.rows.filter(r => r.overall_rating).forEach(r => {
    const k = faBucketOf(r.created_at, unit);
    const s = sums.get(k) || { t: 0, n: 0 }; s.t += r.overall_rating; s.n += 1; sums.set(k, s);
  });
  if (!sums.size) return '<div class="fa-empty fa-empty-sm">No ratings yet</div>';
  const pts = keys.map(k => {
    const s = sums.get(k);
    const lbl = faBucketLabel(k, unit);
    return { label: lbl, value: s ? s.t / s.n : 0,
             tip: s ? `${unit === 'week' ? 'Week of ' : ''}${lbl}: ${(s.t / s.n).toFixed(1)} / 5 from ${s.n} rating${s.n === 1 ? '' : 's'}` : `${lbl}: no ratings` };
  });
  return faBarsSVG(pts, 5, v => String(Math.round(v * 10) / 10));
}

function faVolumeChartSVG() {
  const { unit, keys } = faBuckets();
  const n = new Map();
  _fa.rows.forEach(r => { const k = faBucketOf(r.created_at, unit); n.set(k, (n.get(k) || 0) + 1); });
  const max = Math.max(4, ...n.values());
  const nice = Math.ceil(max / 4) * 4;
  const pts = keys.map(k => {
    const lbl = faBucketLabel(k, unit), v = n.get(k) || 0;
    return { label: lbl, value: v, tip: `${unit === 'week' ? 'Week of ' : ''}${lbl}: ${v} response${v === 1 ? '' : 's'}` };
  });
  return faBarsSVG(pts, nice, v => String(Math.round(v)));
}

// Parts of a whole: one bar split three ways, darkest = very disappointed, with every part labelled in
// words (colour is never the only cue).
function faValueChartHTML(missed) {
  if (!missed.length) return '<div class="fa-empty fa-empty-sm">No answers yet</div>';
  const parts = FB_MISS.map((m, i) => {
    const n = missed.filter(r => r.would_miss_nestrel === m.key).length;
    return { ...m, n, pct: 100 * n / missed.length, cls: 'fa-v' + i };
  });
  let x = 0;
  const segs = parts.filter(p => p.n).map(p => {
    const seg = `<rect class="${p.cls}" x="${x.toFixed(2)}" y="0" width="${Math.max(0, p.pct - 0.6).toFixed(2)}" height="18" rx="2"><title>${esc(p.label)}: ${p.n} (${Math.round(p.pct)}%)</title></rect>`;
    x += p.pct;
    return seg;
  }).join('');
  return `<svg class="fa-svg fa-svg-strip" viewBox="0 0 100 18" preserveAspectRatio="none" role="img"
      aria-label="${escAttr(parts.map(p => `${p.label} ${Math.round(p.pct)}%`).join(', '))}">${segs}</svg>
    <ul class="fa-legend">${parts.map(p => `<li><span class="fa-key ${p.cls}" aria-hidden="true"></span>
      <span class="fa-legend-lbl">${p.emoji} ${esc(p.label)}</span><b>${Math.round(p.pct)}%</b><span class="fa-muted">${p.n}</span></li>`).join('')}</ul>`;
}

function faFeatureTotals() {
  const n = new Map();
  _fa.rows.forEach(r => (r.features_used || []).forEach(k => n.set(k, (n.get(k) || 0) + 1)));
  return [...n].map(([key, rows]) => ({ key, n: rows, s: faCount('feat:' + key) })).sort((a, b) => (b.s ?? b.n) - (a.s ?? a.n));
}

// One measure across items: horizontal bars, longest first, the number written at the end of each.
function faFeatureChartSVG() {
  const list = faFeatureTotals();
  if (!list.length) return '<div class="fa-empty fa-empty-sm">No answers yet</div>';
  const max = Math.max(...list.map(x => x.s ?? x.n));
  const row = 22, L = 112, W = 480, H = list.length * row + 4;
  const bars = list.map((x, i) => {
    const v = x.s ?? x.n;
    const w = Math.max(2, (W - L - 40) * v / max);
    const yy = i * row + 4;
    const word = x.s == null ? `${x.n} response${x.n === 1 ? '' : 's'}` : `${v} student${v === 1 ? '' : 's'}`;
    return `<g class="fa-mark"><title>${esc(FB_FEATURE_LABEL[x.key] || x.key)}: ${word}</title>
      <text class="fa-axis fa-axis-l" x="${L - 8}" y="${yy + 12}" text-anchor="end">${esc(FB_FEATURE_LABEL[x.key] || x.key)}</text>
      <rect class="fa-col" x="${L}" y="${yy + 2}" width="${w.toFixed(1)}" height="14" rx="2"/>
      <text class="fa-val" x="${(L + w + 5).toFixed(1)}" y="${yy + 13}">${v}</text></g>`;
  }).join('');
  return `<svg class="fa-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Features students used">${bars}</svg>`;
}

// ---------------------------------------------------------------- the inbox
function faFiltered() {
  const f = _fa.f, q = _fa.q.trim().toLowerCase();
  return _fa.rows.filter(r =>
    (!f.source  || r.feedback_source === f.source) &&
    (!f.rating  || r.overall_rating === Number(f.rating)) &&
    (!f.feature || (r.features_used || []).includes(f.feature)) &&
    (!f.miss    || r.would_miss_nestrel === f.miss) &&
    (!f.contact || (f.contact === 'yes') === !!r.contact_allowed) &&
    (!f.status  || r.status === f.status) &&
    (!f.tag     || (r.tags || []).includes(f.tag)) &&
    (!f.kind    || r.kind === f.kind) &&
    (!f.change  || (r.change_ids || []).map(Number).includes(Number(f.change))) &&
    (!q || faText(r).includes(q)));
}
const faText = r => [r.liked, r.confusing_or_missing, r.one_thing_to_change, r.message, r.admin_notes,
  ...(r.tags || []), ...(r.features_used || []).map(k => FB_FEATURE_LABEL[k] || k)].filter(Boolean).join('\n').toLowerCase();

function faPaintTab() {
  const el = document.getElementById('faTabBody');
  if (!el) return;
  if (_fa.tab === 'changes') { el.innerHTML = '<div id="faChanges"></div>'; faPaintChanges(); return; }
  const sel = (id, label, cur, opts) => `<label class="fa-filter"><span>${label}</span><select class="fa-input" id="${id}" onchange="faSetFilter('${id.slice(3).toLowerCase()}', this.value)">
      <option value="">Any</option>${opts.map(([v, l]) => `<option value="${escAttr(String(v))}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const tags = [...new Set([...FA_TAGS, ..._fa.rows.flatMap(r => r.tags || [])])].sort((a, b) => a.localeCompare(b));
  const f = _fa.f;
  const linked = f.change ? _fa.changes.find(c => c.id === Number(f.change)) : null;
  el.innerHTML = `<div class="tcard fa-inbox">
    <div class="fa-filters">
      <label class="fa-filter fa-filter-q"><span>Search feedback</span>
        <input type="search" class="fa-input" id="faSearch" placeholder="events, housing, slow, bug…" value="${escAttr(_fa.q)}" oninput="faSearchInput(this.value)" autocomplete="off"></label>
      ${sel('faFSource', 'Source', f.source, Object.entries(FA_SOURCES))}
      ${sel('faFRating', 'Rating', f.rating, [5, 4, 3, 2, 1].map(n => [n, `${n} / 5`]))}
      ${sel('faFFeature', 'Feature used', f.feature, FB_FEATURES.map(x => [x.key, x.label]))}
      ${sel('faFMiss', 'Would miss Nestrel', f.miss, FB_MISS.map(m => [m.key, m.label]))}
      ${sel('faFContact', 'Can contact', f.contact, [['yes', 'Yes'], ['no', 'No']])}
      ${sel('faFStatus', 'Status', f.status, FA_STATUSES.map(s => [s.key, s.label]))}
      ${sel('faFTag', 'Tag', f.tag, tags.map(t => [t, t]))}
      ${sel('faFKind', 'Quick note', f.kind, Object.entries(FA_KIND_LABEL))}
      <button type="button" class="btn-sm-a btn-a-neutral fa-clear" onclick="faClearFilters()">Clear</button>
    </div>
    ${linked ? `<div class="fa-chip-row"><span class="fa-chip-on">Linked to “${esc(linked.title)}” <button type="button" aria-label="Stop showing only this change" onclick="faSetFilter('change','')">&times;</button></span></div>` : ''}
    <div class="fa-summary" id="faSummary"></div>
    <div id="faSelBar"></div>
    <div id="faInbox"></div>
  </div>`;
  faPaintInbox();
}

function faSetFilter(key, value) {
  _fa.f[key] = value;
  _fa.shown = FA_PAGE;
  if (key === 'change') { faPaintTab(); } else { faPaintInbox(); }
  faRefreshCounts();
}
function faClearFilters() {
  Object.keys(_fa.f).forEach(k => { _fa.f[k] = ''; });
  _fa.q = '';
  _fa.shown = FA_PAGE;
  faPaintTab();
  faRefreshCounts();
}
function faFilterTag(tag) {
  Object.keys(_fa.f).forEach(k => { _fa.f[k] = ''; });
  _fa.f.tag = tag;
  _fa.q = '';
  _fa.tab = 'inbox';
  faSetTab('inbox');
  faRefreshCounts();
  document.getElementById('faTabBody')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function faSearchInput(v) {
  _fa.q = v;
  _fa.shown = FA_PAGE;
  clearTimeout(_faSearchTimer);
  _faSearchTimer = setTimeout(() => { faPaintInbox(); faRefreshCounts(); }, 250);
}

function faPaintSummary() {
  const el = document.getElementById('faSummary');
  if (!el) return;
  const rows = faFiltered();
  const n = faCount('filtered');
  const q = _fa.q.trim();
  const who = n == null ? '' : ` from <b>${n}</b> different student${n === 1 ? '' : 's'}`;
  el.innerHTML = q
    ? `Students mentioning “${esc(q)}”: <b>${n == null ? '…' : n}</b> <span class="fa-muted">(${rows.length} response${rows.length === 1 ? '' : 's'})</span>`
      + (n != null && n > 0 && n < FA_PATTERN_MIN ? ' <span class="fa-muted">· fewer than 3 students: a story, not yet a pattern</span>' : '')
    : `Showing <b>${rows.length}</b> response${rows.length === 1 ? '' : 's'}${who}.`;
}

function faPaintInbox() {
  const el = document.getElementById('faInbox');
  if (!el) return;
  faPaintSummary();
  faPaintSelBar();
  const rows = faFiltered();
  if (!rows.length) { el.innerHTML = '<div class="fa-empty fa-empty-sm">No responses match.</div>'; return; }
  el.innerHTML = rows.slice(0, _fa.shown).map(faItemHTML).join('')
    + (rows.length > _fa.shown ? `<button type="button" class="btn-sm-a btn-a-neutral fa-more" onclick="faMore()">Show ${Math.min(FA_PAGE, rows.length - _fa.shown)} more</button>` : '');
}
function faMore() { _fa.shown += FA_PAGE; faPaintInbox(); }

const faWhen = iso => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};
const faWho = r => r.contact_allowed ? (r.account_deleted ? 'Account deleted' : (r.student_name || r.student_email || 'Student')) : 'Anonymous';
const faClip = (s, n = 240) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const faStatusPill = s => `<span class="fa-status fa-st-${escAttr(s)}">${esc(FA_STATUS_LABEL[s] || s)}</span>`;

function faItemHTML(r) {
  const manage = aCan('manage_feedback');
  const ans = (label, text) => text ? `<div class="fa-ans"><div class="fa-ans-q">${label}</div><div class="fa-ans-a">${esc(faClip(text))}</div></div>` : '';
  const miss = r.would_miss_nestrel ? FB_MISS_LABEL[r.would_miss_nestrel] : null;
  const body = r.feedback_source === 'general' || r.kind
    ? `${r.kind ? `<div class="fa-kind">${esc(FA_KIND_LABEL[r.kind] || r.kind)}</div>` : ''}${ans('Note', r.message) || '<div class="fa-muted">No words, just the choice.</div>'}`
    : `${(r.features_used || []).length ? `<div class="fa-meta-line"><b>Features used:</b> ${esc(r.features_used.map(k => FB_FEATURE_LABEL[k] || k).join(', '))}</div>` : ''}
       ${ans('What did you like?', r.liked)}${ans('What was confusing or missing?', r.confusing_or_missing)}${ans('One thing to change', r.one_thing_to_change)}
       ${miss ? `<div class="fa-meta-line"><b>Nestrel value:</b> ${miss.emoji} ${esc(miss.label)}</div>` : ''}`;
  return `<article class="fa-item ${_fa.sel.has(r.id) ? 'is-sel' : ''}" onclick="faOpen(${Number(r.id)})">
    <div class="fa-item-head">
      ${manage ? `<input type="checkbox" class="fa-item-sel" aria-label="Select response ${Number(r.id)}" ${_fa.sel.has(r.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="faSelect(${Number(r.id)}, this.checked)">` : ''}
      <button type="button" class="fa-who" onclick="event.stopPropagation();faOpen(${Number(r.id)})">${esc(faWho(r))}</button>
      ${r.contact_allowed ? '<span class="fa-pill fa-pill-ok">Can contact</span>' : '<span class="fa-pill">No follow-up</span>'}
      ${r.overall_rating ? `<span class="fa-stars" aria-label="Rating ${r.overall_rating} out of 5">&#9733; ${r.overall_rating}/5</span>` : ''}
      ${faStatusPill(r.status)}
      <span class="fa-when">${faWhen(r.created_at)} · ${esc(FA_SOURCES[r.feedback_source] || r.feedback_source)}</span>
    </div>
    <div class="fa-item-body">${body}</div>
    ${(r.tags || []).length ? `<div class="fa-tags">${r.tags.map(t => `<span class="fa-tag">${esc(t)}</span>`).join('')}</div>` : ''}
  </article>`;
}

// ---------------------------------------------------------------- choosing several responses
function faSelect(id, on) {
  if (on) _fa.sel.add(id); else _fa.sel.delete(id);
  document.querySelectorAll('#faInbox .fa-item').forEach(a => {
    const box = a.querySelector('.fa-item-sel');
    if (box) a.classList.toggle('is-sel', box.checked);
  });
  faPaintSelBar();
  faRefreshCounts();
}
function faPaintSelBar() {
  const el = document.getElementById('faSelBar');
  if (!el) return;
  if (!_fa.sel.size || !aCan('manage_feedback')) { el.innerHTML = ''; return; }
  const n = faCount('sel');
  const opts = _fa.changes.map(c => `<option value="${Number(c.id)}">${esc(faClip(c.title, 60))}</option>`).join('');
  el.innerHTML = `<div class="fa-selbar">
    <span><b>${_fa.sel.size}</b> selected${n == null ? '' : ` · <b>${n}</b> different student${n === 1 ? '' : 's'}`}</span>
    <button type="button" class="btn-sm-a btn-a-brand" onclick="faNewChange([..._fa.sel])">Create product change</button>
    ${_fa.changes.length ? `<select class="fa-input" id="faLinkTo" aria-label="Link to an existing product change"><option value="">Link to a change…</option>${opts}</select>
      <button type="button" class="btn-sm-a btn-a-neutral" onclick="faLinkSelected()">Link</button>` : ''}
    <button type="button" class="btn-sm-a btn-a-neutral" onclick="faClearSel()">Clear</button></div>`;
}
function faClearSel() { _fa.sel.clear(); faPaintInbox(); }
async function faLinkSelected() {
  const id = Number(document.getElementById('faLinkTo')?.value || 0);
  if (!id) { toast('Choose a product change first'); return; }
  if (await faLink(id, [..._fa.sel])) { _fa.sel.clear(); faPaintInbox(); faRefreshCounts(); }
}

// ---------------------------------------------------------------- one response, in the side drawer
function faOpen(id) {
  const r = _fa.rows.find(x => x.id === id);
  if (!r) return;
  _fa.openId = id;
  openHDrawer(`${esc(faWho(r))} <span class="fa-muted">· ${esc(FA_SOURCES[r.feedback_source] || r.feedback_source)}</span>`, faDetailHTML(r));
}
function faRepaintOpen() {
  const r = _fa.rows.find(x => x.id === _fa.openId);
  const body = document.getElementById('hDrawerBody');
  if (r && body && document.getElementById('hDrawer')?.classList.contains('open') && body.querySelector('.fa-detail')) {
    body.innerHTML = faDetailHTML(r);
  }
}

function faDetailHTML(r) {
  const manage = aCan('manage_feedback');
  const block = (label, text) => `<div class="fa-d-block"><div class="fa-d-label">${label}</div><div class="fa-d-text">${text ? esc(text) : '<span class="fa-muted">No answer</span>'}</div></div>`;
  const miss = r.would_miss_nestrel ? FB_MISS_LABEL[r.would_miss_nestrel] : null;
  const who = r.contact_allowed
    ? (r.account_deleted ? '<p class="fa-muted">This student said you could contact them, but has since deleted their account.</p>'
       : `<p><b>${esc(r.student_name || 'Student')}</b><br><span class="fa-muted">${esc(r.student_email || '')}</span></p><p class="fa-muted">They ticked “You can message me about this.”</p>`)
    : '<p class="fa-muted">Anonymous. The student did not tick “You can message me”, so their name is not shown.</p>';
  const secs = r.completion_seconds;
  const ctx = [
    ['Sent', faWhen(r.created_at)], ['From page', r.page_context || '—'], ['Device', r.device_type || '—'],
    ['Browser', r.browser || '—'], ['App version', r.app_version || '—'],
    ...(secs != null ? [['Time to complete', `${Math.floor(secs / 60)} min ${secs % 60} s`]] : []),
    ...(r.course_ref ? [['Course', r.course_ref]] : []),
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  const answers = r.feedback_source === 'general' || r.kind
    ? `${block(FA_KIND_LABEL[r.kind] || 'Quick note', r.message)}`
    : `<div class="fa-d-row">
         <div><div class="fa-d-label">Rating</div><div class="fa-d-big">${r.overall_rating ? `&#9733; ${r.overall_rating} / 5` : '—'}</div></div>
         <div><div class="fa-d-label">Would miss Nestrel</div><div class="fa-d-big">${miss ? `${miss.emoji} ${esc(miss.label)}` : '—'}</div></div>
       </div>
       ${block('Features used', (r.features_used || []).map(k => FB_FEATURE_LABEL[k] || k).join(', '))}
       ${block('What did you like?', r.liked)}
       ${block('Was anything confusing, difficult, or missing?', r.confusing_or_missing)}
       ${block('If you could change ONE thing…', r.one_thing_to_change)}`;
  const allTags = [...new Set([...FA_TAGS, ...(r.tags || [])])];
  const tagsUI = manage
    ? `<div class="fa-tagpick">${allTags.map(t => `<button type="button" class="fa-tagbtn ${(r.tags || []).includes(t) ? 'is-on' : ''}" aria-pressed="${(r.tags || []).includes(t)}" data-tag="${escAttr(t)}" onclick="faToggleTag(${Number(r.id)}, this.dataset.tag)">${esc(t)}</button>`).join('')}</div>
       <div class="fa-addtag"><input type="text" class="fa-input" id="faNewTag" maxlength="30" placeholder="Add a tag" autocomplete="off" aria-label="New tag">
         <button type="button" class="btn-sm-a btn-a-neutral" onclick="faAddTag(${Number(r.id)})">Add</button></div>`
    : `<div class="fa-tags">${(r.tags || []).map(t => `<span class="fa-tag">${esc(t)}</span>`).join('') || '<span class="fa-muted">None</span>'}</div>`;
  const statusUI = manage
    ? `<select class="fa-input" aria-label="Status" onchange="faSetStatus(${Number(r.id)}, this.value)">${FA_STATUSES.map(s => `<option value="${s.key}" ${r.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`
    : faStatusPill(r.status);
  const notesUI = manage
    ? `<textarea class="fa-input fa-notes" id="faNotes" rows="4" maxlength="4000" placeholder="e.g. Three students mentioned this. Look at search.">${esc(r.admin_notes || '')}</textarea>
       <button type="button" class="btn-sm-a btn-a-brand" onclick="faSaveNotes(${Number(r.id)})">Save notes</button>`
    : `<div class="fa-d-text">${r.admin_notes ? esc(r.admin_notes) : '<span class="fa-muted">No notes</span>'}</div>`;
  const linked = (r.change_ids || []).map(Number).map(cid => _fa.changes.find(c => c.id === cid)).filter(Boolean);
  const changeOpts = _fa.changes.filter(c => !linked.includes(c)).map(c => `<option value="${Number(c.id)}">${esc(faClip(c.title, 60))}</option>`).join('');
  return `<div class="fa-detail">
    <section class="fa-d-sec">${who}</section>
    <section class="fa-d-sec">${answers}</section>
    <section class="fa-d-sec fa-d-manage">
      <div class="fa-d-label">Status</div>${statusUI}
      <div class="fa-d-label">Tags</div>${tagsUI}
      <div class="fa-d-label">Internal notes <span class="fa-muted">· never shown to students</span></div>${notesUI}
    </section>
    <section class="fa-d-sec">
      <div class="fa-d-label">Product changes</div>
      ${linked.length ? `<ul class="fa-linked">${linked.map(c => `<li><span>${esc(c.title)}</span> <span class="fa-pill">${esc(FA_CHANGE_LABEL[c.status] || c.status)}</span>
          ${manage ? `<button type="button" class="fa-x" aria-label="Unlink" onclick="faUnlink(${Number(c.id)}, ${Number(r.id)})">&times;</button>` : ''}</li>`).join('')}</ul>` : '<p class="fa-muted">Not linked to a change yet.</p>'}
      ${manage ? `<div class="fa-d-actions">
          <button type="button" class="btn-sm-a btn-a-brand" onclick="faNewChange([${Number(r.id)}])">Create product change from this</button>
          ${changeOpts ? `<select class="fa-input" id="faLinkOneSel" aria-label="Link to an existing change"><option value="">Link to a change…</option>${changeOpts}</select>
            <button type="button" class="btn-sm-a btn-a-neutral" onclick="faLinkOne(${Number(r.id)})">Link</button>` : ''}</div>` : ''}
    </section>
    <section class="fa-d-sec"><div class="fa-d-label">Details the app attached</div><dl class="fa-ctx">${ctx}</dl></section>
  </div>`;
}

// ---------------------------------------------------------------- changing a response
async function faUpdate(id, patch, logType) {
  const { data, error } = await supabaseClient.rpc('admin_update_feedback', { p_id: id, p_patch: patch });
  if (error) { toast('Could not save: ' + error.message); return false; }
  const row = _fa.rows.find(r => r.id === id);
  if (row) {
    if ('status' in patch) row.status = data?.after?.status ?? patch.status;
    if ('tags' in patch) row.tags = data?.after?.tags ?? patch.tags;
    if ('admin_notes' in patch) row.admin_notes = String(patch.admin_notes || '').trim() || null;
  }
  // The log names the response by number only: student words never go into the activity log.
  logAdminAction(logType, { targetType: 'feedback', targetId: id, targetLabel: `Feedback #${id}`,
                            before: data?.before || null, after: data?.after || null });
  return true;
}

async function faSetStatus(id, status) {
  if (!FA_STATUS_LABEL[status]) return;
  if (await faUpdate(id, { status }, 'feedback_status_changed')) {
    toast('Status: ' + FA_STATUS_LABEL[status]);
    faPaintInbox();
    faRepaintOpen();
  }
}

// "search" typed by hand becomes the suggested "Search", so one theme never splits into two tags.
function faCanonTag(t) {
  const clean = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return FA_TAGS.find(x => x.toLowerCase() === clean.toLowerCase())
    || [...new Set(_fa.rows.flatMap(r => r.tags || []))].find(x => x.toLowerCase() === clean.toLowerCase())
    || clean;
}
async function faToggleTag(id, tag) {
  const r = _fa.rows.find(x => x.id === id);
  if (!r) return;
  const has = (r.tags || []).includes(tag);
  const tags = has ? r.tags.filter(t => t !== tag) : [...(r.tags || []), tag];
  if (await faUpdate(id, { tags }, 'feedback_tags_changed')) { faAfterTags(); }
}
async function faAddTag(id) {
  const input = document.getElementById('faNewTag');
  const tag = faCanonTag(input?.value);
  if (!tag) { toast('Type a tag first'); return; }
  const r = _fa.rows.find(x => x.id === id);
  if (!r) return;
  if ((r.tags || []).includes(tag)) { toast('Already tagged ' + tag); return; }
  if ((r.tags || []).length >= 20) { toast('20 tags is the most one response can have'); return; }
  if (await faUpdate(id, { tags: [...(r.tags || []), tag] }, 'feedback_tags_changed')) { faAfterTags(); }
}
function faAfterTags() {
  faRepaintOpen();
  faPaintInbox();
  const pat = document.getElementById('faPatterns'); if (pat) pat.innerHTML = faPatternsHTML();
  const top = document.getElementById('faTopImp'); if (top) top.innerHTML = faTopImprovementHTML();
  faRefreshCounts();
}
async function faSaveNotes(id) {
  const v = document.getElementById('faNotes')?.value || '';
  if (await faUpdate(id, { admin_notes: v }, 'feedback_note_edited')) { toast('Notes saved'); faPaintInbox(); }
}

// ---------------------------------------------------------------- product changes
async function faLink(changeId, ids) {
  const have = new Set(_fa.links.filter(l => l.change_id === changeId).map(l => l.feedback_id));
  const add = ids.filter(id => !have.has(id)).map(id => ({ change_id: changeId, feedback_id: id }));
  if (!add.length) { toast('Already linked'); return false; }
  const { error } = await supabaseClient.from('product_change_feedback').insert(add);
  if (error) { toast('Could not link: ' + error.message); return false; }
  _fa.links.push(...add);
  add.forEach(l => { const r = _fa.rows.find(x => x.id === l.feedback_id); if (r) r.change_ids = [...(r.change_ids || []), changeId]; });
  const c = _fa.changes.find(x => x.id === changeId);
  logAdminAction('feedback_linked', { targetType: 'product_change', targetId: changeId, targetLabel: c?.title || `Change #${changeId}`,
                                      meta: { feedback_ids: add.map(l => l.feedback_id) } });
  toast(`Linked ${add.length} response${add.length === 1 ? '' : 's'}`);
  return true;
}
async function faLinkOne(feedbackId) {
  const id = Number(document.getElementById('faLinkOneSel')?.value || 0);
  if (!id) { toast('Choose a product change first'); return; }
  if (await faLink(id, [feedbackId])) { faRepaintOpen(); faRefreshCounts(); }
}
async function faUnlink(changeId, feedbackId) {
  const { error } = await supabaseClient.from('product_change_feedback').delete().eq('change_id', changeId).eq('feedback_id', feedbackId);
  if (error) { toast('Could not unlink: ' + error.message); return; }
  _fa.links = _fa.links.filter(l => !(l.change_id === changeId && l.feedback_id === feedbackId));
  const r = _fa.rows.find(x => x.id === feedbackId);
  if (r) r.change_ids = (r.change_ids || []).filter(c => Number(c) !== changeId);
  const c = _fa.changes.find(x => x.id === changeId);
  logAdminAction('feedback_unlinked', { targetType: 'product_change', targetId: changeId, targetLabel: c?.title || `Change #${changeId}`,
                                        meta: { feedback_ids: [feedbackId] } });
  faRepaintOpen();
  faRefreshCounts();
}

// The form, for a new change (from one or several responses) or an existing one. It opens in the drawer.
async function faNewChange(ids) {
  _fa.linkIds = ids && ids.length ? ids : null;
  let reason = '';
  if (_fa.linkIds) {
    const { data } = await supabaseClient.rpc('admin_feedback_student_counts', { p_groups: { pick: _fa.linkIds } });
    const n = data?.pick;
    reason = n != null ? `${n} student${n === 1 ? '' : 's'} mentioned this (${_fa.linkIds.length} response${_fa.linkIds.length === 1 ? '' : 's'}).`
                       : `${_fa.linkIds.length} response${_fa.linkIds.length === 1 ? '' : 's'} mentioned this.`;
  }
  openHDrawer('New product change', faChangeFormHTML({ reason, status: 'planned' }));
}
function faEditChange(id) {
  const c = _fa.changes.find(x => x.id === id);
  if (!c) return;
  _fa.linkIds = null;
  openHDrawer('Edit product change', faChangeFormHTML(c));
}

function faChangeFormHTML(c) {
  const field = (id, label, html, hint = '') => `<label class="fa-form-row" for="${id}"><span class="fa-d-label">${label}</span>${html}${hint ? `<span class="fa-muted fa-hint">${hint}</span>` : ''}</label>`;
  const ta = (id, v, ph, rows = 3, max = 2000) => `<textarea class="fa-input" id="${id}" rows="${rows}" maxlength="${max}" placeholder="${escAttr(ph)}">${esc(v || '')}</textarea>`;
  return `<form class="fa-form" onsubmit="return false" autocomplete="off">
    ${_fa.linkIds ? `<p class="fa-note">Will be linked to ${_fa.linkIds.length} response${_fa.linkIds.length === 1 ? '' : 's'}.</p>` : ''}
    ${field('faChTitle', 'Title', `<input type="text" class="fa-input" id="faChTitle" maxlength="120" value="${escAttr(c.title || '')}" placeholder="Improve search">`)}
    ${field('faChReason', 'What students asked for', ta('faChReason', c.reason, '7 students reported search difficulty.', 3, 1000))}
    ${field('faChStatus', 'Status', `<select class="fa-input" id="faChStatus">${FA_CHANGE_STATUSES.map(s => `<option value="${s.key}" ${c.status === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`)}
    ${field('faChExpected', 'Expected impact', ta('faChExpected', c.expected_impact, 'Students find campus content faster.', 2, 1000))}
    ${field('faChWhat', 'What was changed', ta('faChWhat', c.what_changed, 'Fill in once it ships.'))}
    ${field('faChShipped', 'Date shipped', `<input type="date" class="fa-input" id="faChShipped" value="${escAttr(c.shipped_on || '')}">`)}
    ${field('faChResult', 'Actual result', ta('faChResult', c.actual_result, 'Check 2–4 weeks after shipping. “It didn’t help” is a result too.'))}
    ${field('faChCommit', 'Commit or reference', `<input type="text" class="fa-input" id="faChCommit" maxlength="80" value="${escAttr(c.commit_ref || '')}" placeholder="optional">`)}
    <div class="fa-d-actions">
      <button type="button" class="btn-sm-a btn-a-brand" onclick="faSaveChange(${c.id ? Number(c.id) : 'null'})">Save</button>
      <button type="button" class="btn-sm-a btn-a-neutral" onclick="closeHDrawer()">Cancel</button>
      ${c.id ? `<button type="button" class="btn-sm-a btn-a-danger fa-push" onclick="faDeleteChange(${Number(c.id)})">Delete</button>` : ''}
    </div></form>`;
}

async function faSaveChange(id) {
  const v = k => (document.getElementById(k)?.value || '').trim();
  const rec = {
    title: v('faChTitle'), reason: v('faChReason') || null, status: v('faChStatus') || 'planned',
    expected_impact: v('faChExpected') || null, what_changed: v('faChWhat') || null,
    shipped_on: v('faChShipped') || null, actual_result: v('faChResult') || null, commit_ref: v('faChCommit') || null,
  };
  if (rec.title.length < 3) { toast('Give the change a title (3 characters or more)'); return; }
  if (rec.status === 'shipped' && !rec.shipped_on) rec.shipped_on = faYMD(new Date());
  if (id) {
    const before = _fa.changes.find(c => c.id === id);
    const { error } = await supabaseClient.from('product_changes').update(rec).eq('id', id);
    if (error) { toast('Could not save: ' + error.message); return; }
    logAdminAction('product_change_updated', { targetType: 'product_change', targetId: id, targetLabel: rec.title,
                                               before: { status: before?.status }, after: { status: rec.status } });
  } else {
    const { data, error } = await supabaseClient.from('product_changes').insert(rec).select('id').single();
    if (error) { toast('Could not save: ' + error.message); return; }
    logAdminAction('product_change_created', { targetType: 'product_change', targetId: data.id, targetLabel: rec.title,
                                               meta: { feedback_count: _fa.linkIds?.length || 0 } });
    if (_fa.linkIds) {
      const links = _fa.linkIds.map(fid => ({ change_id: data.id, feedback_id: fid }));
      const { error: lerr } = await supabaseClient.from('product_change_feedback').insert(links);
      if (lerr) toast('Saved, but linking the responses failed: ' + lerr.message);
    }
    _fa.sel.clear();
  }
  _fa.linkIds = null;
  closeHDrawer();
  toast('Product change saved');
  await faLoadChanges();
  faSyncChangeIds();
  _fa.tab = 'changes';
  renderFeedbackAdmin(false);
}

async function faDeleteChange(id) {
  const c = _fa.changes.find(x => x.id === id);
  if (!c || !confirm(`Delete “${c.title}”? The responses stay; only the change and its links go.`)) return;
  const { error } = await supabaseClient.from('product_changes').delete().eq('id', id);
  if (error) { toast('Could not delete: ' + error.message); return; }
  logAdminAction('product_change_deleted', { targetType: 'product_change', targetId: id, targetLabel: c.title });
  closeHDrawer();
  await faLoadChanges();
  faSyncChangeIds();
  renderFeedbackAdmin(false);
}

// Keeps each loaded response's change_ids in step after links are added or removed in bulk.
function faSyncChangeIds() {
  const by = new Map();
  _fa.links.forEach(l => { if (!by.has(l.feedback_id)) by.set(l.feedback_id, []); by.get(l.feedback_id).push(l.change_id); });
  _fa.rows.forEach(r => { r.change_ids = (by.get(r.id) || []).sort((a, b) => a - b); });
}

async function faNotifyChange(id) {
  const c = _fa.changes.find(x => x.id === id);
  if (!c) return;
  if (!confirm(`Tell every student whose feedback is linked to “${c.title}” that it shipped? It appears in their Activity. This can be sent once.`)) return;
  const { data, error } = await supabaseClient.rpc('admin_notify_change_students', { p_change_id: id });
  if (error) { toast(error.message); return; }
  logAdminAction('students_told_of_change', { targetType: 'product_change', targetId: id, targetLabel: c.title, meta: { students: data } });
  toast(`Told ${data} student${data === 1 ? '' : 's'}`);
  await faLoadChanges();
  faPaintChanges();
}

// "You asked, we built": what came from student feedback, and what happened.
const FA_CHANGE_ORDER = { shipped: 0, in_progress: 1, planned: 2, dropped: 3 };
function faPaintChanges() {
  const el = document.getElementById('faChanges');
  if (!el) return;
  const manage = aCan('manage_feedback');
  const head = `<div class="fa-ch-head"><div><div class="tcard-title">Changes that came from student feedback</div>
      <p class="fa-muted">Link responses to a change, ship it, then tell the students who asked.</p></div>
      ${manage ? '<button type="button" class="btn-sm-a btn-a-brand" onclick="faNewChange([])">New product change</button>' : ''}</div>`;
  if (!_fa.changes.length) {
    el.innerHTML = `<div class="tcard fa-inbox">${head}<div class="fa-empty fa-empty-sm">No product changes yet. Select responses in the Responses tab and choose “Create product change”.</div></div>`;
    return;
  }
  const list = [..._fa.changes].sort((a, b) => (FA_CHANGE_ORDER[a.status] ?? 9) - (FA_CHANGE_ORDER[b.status] ?? 9)
    || String(b.shipped_on || b.created_at).localeCompare(String(a.shipped_on || a.created_at)));
  el.innerHTML = `<div class="tcard fa-inbox">${head}${list.map(c => {
    const ids = faChangeFeedbackIds(c.id);
    const n = faCount('ch:' + c.id);
    const quotes = ids.map(fid => _fa.rows.find(r => r.id === fid)).filter(Boolean)
      .map(r => r.one_thing_to_change || r.confusing_or_missing || r.message || r.liked).filter(Boolean).slice(0, 2);
    const dd = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    return `<article class="fa-change">
      <div class="fa-item-head"><b class="fa-ch-title">${esc(c.title)}</b><span class="fa-status fa-ch-${escAttr(c.status)}">${esc(FA_CHANGE_LABEL[c.status] || c.status)}</span>
        ${c.students_notified ? '<span class="fa-pill fa-pill-ok">Students told</span>' : ''}</div>
      <dl class="fa-ctx fa-ch-dl">
        ${dd('What students asked for', c.reason ? esc(c.reason) : '<span class="fa-muted">—</span>')}
        ${dd('Students who mentioned it', ids.length ? `<b>${n == null ? '…' : n}</b> <span class="fa-muted">(${ids.length} response${ids.length === 1 ? '' : 's'})</span>
            <button type="button" class="fa-linkbtn" onclick="faShowChangeResponses(${Number(c.id)})">See them</button>` : '<span class="fa-muted">None linked</span>')}
        ${quotes.length ? dd('In their words', quotes.map(q => `<q>${esc(faClip(q, 160))}</q>`).join('<br>')) : ''}
        ${dd('What was changed', c.what_changed ? esc(c.what_changed) : '<span class="fa-muted">Not yet</span>')}
        ${dd('Date shipped', c.shipped_on ? esc(new Date(c.shipped_on + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : '<span class="fa-muted">—</span>')}
        ${dd('Expected impact', c.expected_impact ? esc(c.expected_impact) : '<span class="fa-muted">—</span>')}
        ${dd('Actual result', c.actual_result ? esc(c.actual_result) : '<span class="fa-muted">Not measured yet</span>')}
      </dl>
      ${manage ? `<div class="fa-d-actions"><button type="button" class="btn-sm-a btn-a-neutral" onclick="faEditChange(${Number(c.id)})">Edit</button>
        ${c.status === 'shipped' && !c.students_notified && ids.length ? `<button type="button" class="btn-sm-a btn-a-success" onclick="faNotifyChange(${Number(c.id)})">Tell the students who asked</button>` : ''}</div>` : ''}
    </article>`;
  }).join('')}</div>`;
}
function faShowChangeResponses(id) {
  Object.keys(_fa.f).forEach(k => { _fa.f[k] = ''; });
  _fa.q = '';
  _fa.f.change = String(id);
  faSetTab('inbox');
  faRefreshCounts();
}

// ---------------------------------------------------------------- checking a completion ID
function faOpenVerify() {
  openHDrawer('Check a completion ID', `<form class="fa-form" onsubmit="faVerify();return false" autocomplete="off">
    <p class="fa-muted">A student’s confirmation shows a Feedback ID like NSTR-7K4Q-92XD. Type it here to see whether it is real. You see who and which day — never their answers.</p>
    <label class="fa-form-row" for="faVerifyCode"><span class="fa-d-label">Feedback ID</span>
      <input type="text" class="fa-input fa-mono" id="faVerifyCode" maxlength="20" placeholder="NSTR-XXXX-XXXX" autocapitalize="characters"></label>
    <div class="fa-d-actions"><button type="submit" class="btn-sm-a btn-a-brand">Check</button></div>
    <div id="faVerifyOut" aria-live="polite"></div></form>`);
  setTimeout(() => document.getElementById('faVerifyCode')?.focus(), 50);
}
async function faVerify() {
  const code = (document.getElementById('faVerifyCode')?.value || '').trim().toUpperCase();
  const out = document.getElementById('faVerifyOut');
  if (!out) return;
  if (!/^NSTR-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code.replace(/\s/g, ''))) { out.innerHTML = '<p class="fa-bad">That doesn’t look like a Feedback ID (NSTR-XXXX-XXXX).</p>'; return; }
  const norm = code.replace(/\s/g, '').replace(/^NSTR-?([A-Z0-9]{4})-?([A-Z0-9]{4})$/, 'NSTR-$1-$2');
  out.innerHTML = '<p class="fa-muted">Checking…</p>';
  const { data, error } = await supabaseClient.rpc('admin_verify_completion', { p_code: norm });
  if (error) { out.innerHTML = `<p class="fa-bad">${esc(error.message)}</p>`; return; }
  logAdminAction('completion_verified', { targetType: 'feedback_completion', targetLabel: norm, meta: { valid: !!data?.valid } });
  out.innerHTML = data?.valid
    ? `<div class="fa-good"><b>&#10003; Real.</b> ${esc(data.name || 'Unnamed student')} <span class="fa-muted">(${esc(data.email || '')})</span> completed the Nestrel feedback on <b>${esc(fbLongDate(data.completed_on))}</b>.</div>`
    : '<p class="fa-bad">&#10007; No completion has this ID. The screenshot may be edited, or the ID mistyped.</p>';
}

// ---------------------------------------------------------------- export
// What is on screen (the date range and the filters), one row per response. Name and email are filled
// only where the student ticked "You can message me" — the view leaves them empty otherwise.
function faExport() {
  if (!aCan('export_data')) { toast('Your role doesn’t include data export'); return; }
  const rows = faFiltered();
  if (!rows.length) { toast('Nothing to export'); return; }
  const head = ['ID', 'Submitted', 'Source', 'Quick note', 'Rating', 'Features used', 'Liked', 'Confusing or missing',
                'One thing to change', 'Note', 'Would miss Nestrel', 'Can contact', 'Student name', 'Student email',
                'Page', 'Device', 'Browser', 'App version', 'Seconds to complete', 'Status', 'Tags', 'Internal notes', 'Product changes'];
  const lines = rows.map(r => [
    r.id, new Date(r.created_at).toISOString(), FA_SOURCES[r.feedback_source] || r.feedback_source, FA_KIND_LABEL[r.kind] || '',
    r.overall_rating ?? '', (r.features_used || []).map(k => FB_FEATURE_LABEL[k] || k).join('; '), r.liked || '',
    r.confusing_or_missing || '', r.one_thing_to_change || '', r.message || '',
    r.would_miss_nestrel ? FB_MISS_LABEL[r.would_miss_nestrel]?.label || r.would_miss_nestrel : '',
    r.contact_allowed ? 'Yes' : 'No', r.student_name || '', r.student_email || '', r.page_context || '', r.device_type || '',
    r.browser || '', r.app_version || '', r.completion_seconds ?? '', FA_STATUS_LABEL[r.status] || r.status,
    (r.tags || []).join('; '), r.admin_notes || '',
    (r.change_ids || []).map(cid => _fa.changes.find(c => c.id === Number(cid))?.title || `#${cid}`).join('; '),
  ].map(csvCell).join(','));
  const csv = [head.map(csvCell).join(','), ...lines].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `nestrel-feedback-${faYMD(new Date())}.csv`;
  a.click();
  logAdminAction('export', { targetType: 'feedback', targetLabel: 'Feedback CSV', meta: { rows: rows.length } });
  toast(`Exported ${rows.length} response${rows.length === 1 ? '' : 's'}`);
}
