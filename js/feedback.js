// ============================================================
// FEEDBACK — the student side
// The small round Feedback button on every page, the Feedback page with its two paths (the 2-minute
// evaluation and a quick note), the completion card a student can screenshot for a professor, and the
// #/feedback link. The admin Feedback page is js/feedback-admin.js.
// Added 2026-10-05. Loaded as a plain script (not a module) so every function stays global — the
// HTML's onclick="..." handlers depend on that. Load order is set in index.html; boot.js must stay last.
//
// Everything a student sends goes through ONE database function, submit_app_feedback()
// (sql/changes/2026-10-05_student_feedback.sql). It decides status, tags and the time itself, limits
// how often, and refuses a suspended account — so nothing here is security. The student cannot read
// the feedback table at all; they can read only their own completion codes.
// ============================================================

// What the student tried (question 2). `key` must match the list in app_feedback_features_known.
const FB_FEATURES = [
  { key: 'events',        label: 'Events' },
  { key: 'marketplace',   label: 'Marketplace' },
  { key: 'housing',       label: 'Housing' },
  { key: 'textbooks',     label: 'Textbooks' },
  { key: 'clubs',         label: 'Clubs' },
  { key: 'messaging',     label: 'Messaging' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'search',        label: 'Search / browsing' },
  { key: 'other',         label: 'Other' },
];
const FB_FEATURE_LABEL = Object.fromEntries(FB_FEATURES.map(f => [f.key, f.label]));

// "If Nestrel were no longer available, how would you feel?" — the Sean Ellis question. Kept apart from
// the 1–5 rating on purpose: it measures whether Nestrel is becoming something students need.
const FB_MISS = [
  { key: 'very_disappointed',     emoji: '😢', label: 'Very disappointed' },
  { key: 'somewhat_disappointed', emoji: '😐', label: 'Somewhat disappointed' },
  { key: 'not_disappointed',      emoji: '🙂', label: 'Not disappointed' },
];
const FB_MISS_LABEL = Object.fromEntries(FB_MISS.map(m => [m.key, m]));

const FB_RATING_WORDS = { 1: 'Not great', 3: 'Okay', 5: 'Great' };

const FB_ICON = {
  bug:     '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  confusing: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  idea:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
  praise:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
};

// The four quick notes. Each asks one question, and the answer is optional.
const FB_KINDS = {
  bug:       { label: 'Something’s broken',    prompt: 'What were you trying to do?' },
  confusing: { label: 'Something’s confusing', prompt: 'What did you expect to happen?' },
  idea:      { label: 'I have an idea',        prompt: 'What would make Nestrel more useful to you?' },
  praise:    { label: 'I like something',      prompt: 'What’s working for you?' },
};

const FB_STEPS = 5;
const FB_TEXT_MAX = 1000;          // the database allows 2,000; the box stops at 1,000
const FB_STATE_KEY = 'cn_fb_state';
const FB_FAB_KEY = 'cn_fb_fab';
const FB_INTENT_KEY = 'cn_pending_feedback';

// The app version is this file's own ?v= marker (CLAUDE.md, "Browser cache"), read once at load.
const FB_APP_VERSION = (() => {
  const m = (document.currentScript?.src || '').match(/[?&]v=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
})();

let _fb = null;              // the page's state, kept in sessionStorage so a reload loses nothing
let _fbSending = false;      // a submit is in flight: the button stays off until it answers
let _fbLast = null;          // the student's latest completion, read from the database for the start page

// ---------------------------------------------------------------- state
function fbBlankAnswers() {
  return { overall_rating: null, features_used: [], liked: '', confusing_or_missing: '',
           one_thing_to_change: '', would_miss_nestrel: null, contact_allowed: false };
}
function fbFresh() {
  return { ownerId: getEffectiveUser()?.id || null, mode: 'home', step: 1, a: fbBlankAnswers(),
           startedAt: null, kind: null, note: '', noteContact: false, from: 'feed', completion: null };
}
function fbLoadState() {
  try {
    const s = JSON.parse(sessionStorage.getItem(FB_STATE_KEY));
    // Never pick up another account's half-finished answers on a shared tab.
    if (s && s.ownerId && s.ownerId === getEffectiveUser()?.id && s.a) return s;
  } catch (e) { /* unavailable or corrupt: start fresh */ }
  return fbFresh();
}
function fbSaveState() {
  try { sessionStorage.setItem(FB_STATE_KEY, JSON.stringify(_fb)); } catch (e) { /* private mode */ }
}
function fbState() {
  const uid = getEffectiveUser()?.id || null;
  if (!_fb || _fb.ownerId !== uid) _fb = fbLoadState();
  return _fb;
}
const fbInProgress = s => s.mode === 'eval' || !!(s.a.overall_rating || s.a.features_used.length);

// ---------------------------------------------------------------- entry points
// Every way in: the round button, the sidebar item, the profile page, and the #/feedback link.
// `mode`: 'eval' to go straight into the evaluation, a quick-note kind, or nothing for the start page.
function openFeedback(mode) {
  if (typeof adminPreviewMode !== 'undefined' && adminPreviewMode) { toast('Feedback is for students'); return; }
  if (!getEffectiveUser()) {
    try { sessionStorage.setItem(FB_INTENT_KEY, mode || 'home'); } catch (e) { /* private mode */ }
    openModal('loginModal');
    return;
  }
  const s = fbState();
  const here = sessionStorage.getItem('cn_last_page');
  if (here && here !== 'feedback') s.from = here;
  if (mode === 'eval') fbStartEval(false);
  else if (mode && FB_KINDS[mode]) fbStartQuick(mode, false);
  else if (s.mode === 'done' || s.mode === 'quickdone' || s.mode === 'quick') s.mode = 'home';
  fbSaveState();
  showPage('feedback');
}

// Called by showPage() for EVERY page (js/listings.js): draws this page when it is the one, and hides
// the round button where it would be in the way.
function fbOnPage(name) {
  const fab = document.getElementById('fbFab');
  if (fab) fab.hidden = name === 'feedback' || name === 'maintenance'
    || (typeof adminPreviewMode !== 'undefined' && adminPreviewMode);
  if (name === 'feedback') renderFeedbackPage();
}

// Back to wherever the student was before they opened Feedback.
function fbLeave() {
  const s = fbState();
  if (s.mode === 'done' || s.mode === 'quickdone') { s.mode = 'home'; fbSaveState(); }
  const to = s.from;
  if (to && to !== 'feedback' && to !== 'home' && document.getElementById('page-' + to)) showPage(to);
  else goHome();
}

function fbHome() {
  const s = fbState();
  s.mode = 'home';
  fbSaveState();
  renderFeedbackPage();
}

function fbStartEval(draw = true) {
  const s = fbState();
  if (s.mode !== 'eval') {
    if (!fbInProgress(s)) { s.a = fbBlankAnswers(); s.step = 1; }
    if (!s.startedAt) s.startedAt = Date.now();
    s.mode = 'eval';
  }
  fbSaveState();
  if (draw) { renderFeedbackPage(); fbFocusHeading(); }
}

function fbStartQuick(kind, draw = true) {
  const s = fbState();
  if (!FB_KINDS[kind]) return;
  if (s.kind !== kind) { s.note = ''; s.noteContact = false; }
  s.kind = kind;
  s.mode = 'quick';
  fbSaveState();
  if (draw) { renderFeedbackPage(); fbFocusHeading(); }
}

// ---------------------------------------------------------------- drawing
function renderFeedbackPage() {
  const el = document.getElementById('page-feedback');
  if (!el) return;
  const u = getEffectiveUser();
  if (!u || (typeof adminPreviewMode !== 'undefined' && adminPreviewMode)) {
    el.innerHTML = `<div class="fb-wrap">
      <header class="fb-head"><h1 class="fb-title">Help us improve Nestrel</h1>
        <p class="fb-sub">Log in with your Caldwell account to share feedback.</p></header>
      <button type="button" class="fb-btn fb-btn-primary" onclick="openFeedback()">Log in</button></div>`;
    return;
  }
  const s = fbState();
  el.innerHTML = s.mode === 'eval' ? fbEvalHTML(s)
    : s.mode === 'quick' ? fbQuickHTML(s)
    : s.mode === 'done' && s.completion ? fbDoneHTML(s.completion)
    : s.mode === 'quickdone' ? fbQuickDoneHTML()
    : fbHomeHTML(s);
  fbSyncNav();
  if (s.mode === 'home' || (s.mode === 'done' && !s.completion)) fbLoadLastCompletion();
}

function fbFocusHeading() {
  const h = document.getElementById('fbFocus');
  if (h) h.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function fbHomeHTML(s) {
  const going = fbInProgress(s);
  const kinds = Object.entries(FB_KINDS).map(([k, v]) =>
    `<button type="button" class="fb-kind" onclick="fbStartQuick('${k}')"><span class="fb-kind-ico">${FB_ICON[k]}</span><span>${v.label}</span></button>`
  ).join('');
  return `<div class="fb-wrap">
    <button type="button" class="fb-back" onclick="fbLeave()">&#8249; Back</button>
    <header class="fb-head">
      <h1 class="fb-title" id="fbFocus" tabindex="-1">Help us improve Nestrel</h1>
      <p class="fb-sub">Tell us what works and what doesn’t. We read every response.</p>
    </header>
    <section class="fb-card fb-card-main" aria-labelledby="fbEvalTitle">
      <p class="fb-kicker">About 2–3 minutes &#183; 5 short steps</p>
      <h2 class="fb-card-title" id="fbEvalTitle">Share your experience</h2>
      <p class="fb-card-text">Rate Nestrel, tell us what you tried, and what you would change. You get a confirmation at the end.</p>
      <div id="fbEvalAction">
        <button type="button" class="fb-btn fb-btn-primary" onclick="fbStartEval()">${going ? `Continue (step ${s.step} of ${FB_STEPS})` : 'Start'}</button>
      </div>
      <p class="fb-last" id="fbLastDone" hidden></p>
    </section>
    <section class="fb-card" aria-labelledby="fbQuickTitle">
      <h2 class="fb-card-title" id="fbQuickTitle">Or send a quick note</h2>
      <div class="fb-kinds">${kinds}</div>
    </section>
  </div>`;
}

// The small header every evaluation step shares: what this is, how long, and where you are.
function fbStepTop(s) {
  const bars = Array.from({ length: FB_STEPS }, (_, i) => `<span class="${i < s.step ? 'is-on' : ''}"></span>`).join('');
  return `<div class="fb-topline">
      <button type="button" class="fb-back" onclick="fbBack()">&#8249; Back</button>
      <span class="fb-count">${s.step} of ${FB_STEPS}</span>
    </div>
    <div class="fb-progress" aria-hidden="true">${bars}</div>
    ${s.step === 1 ? `<header class="fb-head fb-head-tight"><p class="fb-title-sm">Help us improve Nestrel</p>
      <p class="fb-sub">This will only take about 2–3 minutes.</p></header>` : ''}`;
}

function fbEvalHTML(s) {
  const a = s.a;
  let body = '';
  if (s.step === 1) {
    const opts = [1, 2, 3, 4, 5].map(n => `<label class="fb-scale-opt">
        <input class="fb-sr" type="radio" name="fbRating" value="${n}" ${a.overall_rating === n ? 'checked' : ''} onchange="fbPick('overall_rating', ${n})">
        <span class="fb-opt-box"><span class="fb-scale-num">${n}</span><span class="fb-scale-lbl">${FB_RATING_WORDS[n] || '&nbsp;'}</span></span></label>`).join('');
    body = `<h1 class="fb-q" id="fbFocus" tabindex="-1">How would you rate your experience with Nestrel?</h1>
      <div class="fb-scale" role="radiogroup" aria-labelledby="fbFocus">${opts}</div>`;
  } else if (s.step === 2) {
    const chips = FB_FEATURES.map(f => `<label class="fb-chip">
        <input class="fb-sr" type="checkbox" value="${f.key}" ${a.features_used.includes(f.key) ? 'checked' : ''} onchange="fbToggleFeature('${f.key}', this.checked)">
        <span class="fb-opt-box">${f.label}</span></label>`).join('');
    body = `<h1 class="fb-q" id="fbFocus" tabindex="-1">What did you try on Nestrel?</h1>
      <p class="fb-hint" id="fbFeatHint">Choose all that apply.</p>
      <div class="fb-chips" role="group" aria-labelledby="fbFocus" aria-describedby="fbFeatHint">${chips}</div>`;
  } else if (s.step === 3) {
    body = `<h1 class="fb-q" id="fbFocus" tabindex="-1"><label for="fbLiked">What did you like about Nestrel?</label></h1>
      <textarea class="fb-text" id="fbLiked" rows="3" maxlength="${FB_TEXT_MAX}" placeholder="Tell us what worked well for you."
        oninput="fbType('liked', this.value)">${esc(a.liked)}</textarea>
      <h2 class="fb-q fb-q-next"><label for="fbConfusing">Was anything confusing, difficult, or missing?</label></h2>
      <textarea class="fb-text" id="fbConfusing" rows="3" maxlength="${FB_TEXT_MAX}" placeholder="Tell us what could be better."
        oninput="fbType('confusing_or_missing', this.value)">${esc(a.confusing_or_missing)}</textarea>
      <p class="fb-hint">Both are optional. A few words is plenty.</p>`;
  } else if (s.step === 4) {
    body = `<h1 class="fb-q" id="fbFocus" tabindex="-1"><label for="fbOne">If you could change ONE thing about Nestrel, what would it be?</label></h1>
      <textarea class="fb-text" id="fbOne" rows="3" maxlength="${FB_TEXT_MAX}" placeholder="What’s the one thing you would improve?"
        oninput="fbType('one_thing_to_change', this.value)">${esc(a.one_thing_to_change)}</textarea>
      <p class="fb-hint">Optional, but this is the answer we learn the most from.</p>`;
  } else {
    const opts = FB_MISS.map(m => `<label class="fb-miss-opt">
        <input class="fb-sr" type="radio" name="fbMiss" value="${m.key}" ${a.would_miss_nestrel === m.key ? 'checked' : ''} onchange="fbPick('would_miss_nestrel', '${m.key}')">
        <span class="fb-opt-box"><span class="fb-miss-emoji" aria-hidden="true">${m.emoji}</span><span>${m.label}</span></span></label>`).join('');
    body = `<h1 class="fb-q" id="fbFocus" tabindex="-1">If Nestrel were no longer available, how would you feel?</h1>
      <div class="fb-miss" role="radiogroup" aria-labelledby="fbFocus">${opts}</div>
      <h2 class="fb-q fb-q-next fb-q-small">Can we contact you about your feedback?</h2>
      <label class="fb-check"><input type="checkbox" ${a.contact_allowed ? 'checked' : ''} onchange="fbPick('contact_allowed', this.checked)">
        <span>You can message me about this.</span></label>
      <p class="fb-hint">If you leave this unticked, your name is not shown to the Nestrel team.</p>`;
  }
  return `<div class="fb-wrap">${fbStepTop(s)}
    <form class="form-shell" onsubmit="return false" autocomplete="off">
      ${body}
      <p class="fb-error" id="fbErr" role="alert" hidden></p>
      <div class="fb-nav">
        <button type="button" class="fb-btn fb-btn-primary" id="fbGo" onclick="fbNext()">Next</button>
        <p class="fb-nav-hint" id="fbNavHint" hidden></p>
      </div>
    </form>
  </div>`;
}

function fbQuickHTML(s) {
  const k = FB_KINDS[s.kind] || FB_KINDS.idea;
  return `<div class="fb-wrap">
    <div class="fb-topline"><button type="button" class="fb-back" onclick="fbBack()">&#8249; Back</button></div>
    <form class="form-shell" onsubmit="return false" autocomplete="off">
      <p class="fb-kind-tag"><span class="fb-kind-ico">${FB_ICON[s.kind] || ''}</span>${k.label}</p>
      <h1 class="fb-q" id="fbFocus" tabindex="-1"><label for="fbNote">${k.prompt}</label></h1>
      <textarea class="fb-text" id="fbNote" rows="4" maxlength="${FB_TEXT_MAX}" placeholder="Optional — a few words is plenty."
        oninput="fbTypeNote(this.value)">${esc(s.note)}</textarea>
      <label class="fb-check"><input type="checkbox" ${s.noteContact ? 'checked' : ''} onchange="fbNoteContact(this.checked)">
        <span>You can message me about this.</span></label>
      <p class="fb-hint">If you leave this unticked, your name is not shown to the Nestrel team.</p>
      <p class="fb-error" id="fbErr" role="alert" hidden></p>
      <div class="fb-nav"><button type="button" class="fb-btn fb-btn-primary" id="fbGo" onclick="fbSubmitNote()">Send</button></div>
    </form>
  </div>`;
}

// The page a student screenshots for a professor. It proves completion — name, Caldwell email, date and
// a code only Nestrel can confirm — and shows NONE of their answers.
function fbDoneHTML(c) {
  const u = getEffectiveUser() || {};
  const first = c.first || u.first || '';
  const name = `${c.first || u.first || ''} ${c.last || u.last || ''}`.trim();
  return `<div class="fb-wrap fb-wrap-done">
    <div class="fb-done">
      <div class="fb-done-emoji" aria-hidden="true">🎉</div>
      <h1 class="fb-done-title" id="fbFocus" tabindex="-1">Thank you${first ? ', ' + esc(first) : ''}!</h1>
      <p class="fb-done-lead">Your feedback has been submitted.</p>
      <p class="fb-done-sub">Your feedback helps make Nestrel better for Caldwell students. <span aria-hidden="true">❤️</span></p>
      <div class="fb-cert" role="group" aria-label="Feedback completion confirmation">
        <div class="fb-cert-top"><span class="fb-cert-brand">Nest<span>rel</span></span><span class="fb-cert-check">&#10003; Feedback completed</span></div>
        <div class="fb-cert-name">${esc(name || 'Nestrel student')}</div>
        <div class="fb-cert-email">${esc(c.email || u.email || '')}</div>
        <div class="fb-cert-rows">
          <div class="fb-cert-row"><span>Date</span><b>${esc(fbLongDate(c.completed_on))}</b></div>
          <div class="fb-cert-row"><span>Feedback ID</span><b class="fb-cert-code">${esc(c.code)}</b></div>
        </div>
      </div>
      <div class="fb-prof">
        <p class="fb-prof-title">Need to show your professor?</p>
        <p>You can screenshot this page as confirmation that you completed the Nestrel feedback. Your answers are not shown here, to keep them private.</p>
        <p class="fb-prof-small">Professors: Nestrel can confirm any Feedback ID on request.</p>
      </div>
      ${c.already ? '<p class="fb-hint fb-center">You had already completed the feedback in the last 24 hours, so this is the same confirmation.</p>' : ''}
      <div class="fb-done-actions">
        <button type="button" class="fb-btn fb-btn-primary" onclick="fbLeave()">Back to Nestrel</button>
        <button type="button" class="fb-btn fb-btn-ghost" onclick="fbHome()">Send a quick note</button>
      </div>
    </div>
  </div>`;
}

function fbQuickDoneHTML() {
  return `<div class="fb-wrap fb-wrap-done">
    <div class="fb-done">
      <div class="fb-done-emoji" aria-hidden="true">🙌</div>
      <h1 class="fb-done-title" id="fbFocus" tabindex="-1">Thanks, we got it!</h1>
      <p class="fb-done-lead">We read every note. It helps make Nestrel better for Caldwell students.</p>
      <div class="fb-done-actions">
        <button type="button" class="fb-btn fb-btn-primary" onclick="fbLeave()">Back to Nestrel</button>
        <button type="button" class="fb-btn fb-btn-ghost" onclick="fbHome()">Send another</button>
      </div>
    </div>
  </div>`;
}

// "October 5, 2026" from "2026-10-05", read as a calendar day — new Date("2026-10-05") would be
// midnight UTC, which is the evening BEFORE in New Jersey.
function fbLongDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
const fbLocalYMD = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The start page offers the student's latest confirmation, so a reload or a lost screenshot is never a
// problem. Within 24 hours it replaces Start: a second evaluation the same day would not be saved.
async function fbLoadLastCompletion() {
  const { data, error } = await supabaseClient.from('feedback_completions')
    .select('code, completed_at').order('completed_at', { ascending: false }).limit(1);
  if (error || !data || !data.length) return;
  const c = data[0];
  const u = getEffectiveUser() || {};
  _fbLast = { code: c.code, completed_on: fbLocalYMD(c.completed_at), first: u.first, last: u.last, email: u.email };
  const recent = Date.now() - new Date(c.completed_at).getTime() < 24 * 3600 * 1000;
  const box = document.getElementById('fbLastDone');
  if (box) {
    box.hidden = false;
    box.innerHTML = `&#10003; You completed the feedback on ${esc(fbLongDate(_fbLast.completed_on))}. `
      + `<button type="button" class="fb-link" onclick="fbShowLast()">View confirmation</button>`;
  }
  const act = document.getElementById('fbEvalAction');
  if (act && recent && !fbInProgress(fbState())) {
    act.innerHTML = `<button type="button" class="fb-btn fb-btn-primary" onclick="fbShowLast()">View your confirmation</button>`;
  }
}

function fbShowLast() {
  if (!_fbLast) return;
  const s = fbState();
  s.completion = { ..._fbLast, already: false };
  s.mode = 'done';
  fbSaveState();
  renderFeedbackPage();
  fbFocusHeading();
}

// ---------------------------------------------------------------- answering
function fbPick(field, value) {
  const s = fbState();
  s.a[field] = value;
  fbSaveState();
  fbShowErr('');
  fbSyncNav();
}

function fbToggleFeature(key, on) {
  const s = fbState();
  const set = new Set(s.a.features_used);
  if (on) set.add(key); else set.delete(key);
  s.a.features_used = FB_FEATURES.map(f => f.key).filter(k => set.has(k));
  fbSaveState();
  fbSyncNav();
}

// Typing does not redraw anything (a redraw would take the cursor out of the box); it only saves.
function fbType(field, value) {
  const s = fbState();
  s.a[field] = String(value || '').slice(0, FB_TEXT_MAX);
  fbSaveState();
  fbSyncNav();
}
function fbTypeNote(value) { const s = fbState(); s.note = String(value || '').slice(0, FB_TEXT_MAX); fbSaveState(); }
function fbNoteContact(on) { const s = fbState(); s.noteContact = !!on; fbSaveState(); }

// The one button at the bottom: what it says and whether it can be pressed, for the step on screen.
function fbSyncNav() {
  const btn = document.getElementById('fbGo');
  if (!btn) return;
  const s = fbState();
  const hint = document.getElementById('fbNavHint');
  let label = 'Next', ready = true, why = '';
  if (s.mode === 'quick') {
    label = 'Send';
  } else if (s.step === 1) {
    ready = !!s.a.overall_rating; why = 'Tap a number to continue.';
  } else if (s.step === 2) {
    ready = s.a.features_used.length > 0; why = 'Choose at least one. “Other” is fine.';
  } else if (s.step === 3) {
    label = (s.a.liked.trim() || s.a.confusing_or_missing.trim()) ? 'Next' : 'Skip';
  } else if (s.step === 4) {
    label = s.a.one_thing_to_change.trim() ? 'Next' : 'Skip';
  } else {
    label = 'Submit Feedback'; ready = !!s.a.would_miss_nestrel; why = 'Choose one answer to submit.';
  }
  if (_fbSending) { label = s.mode === 'quick' ? 'Sending…' : 'Submitting…'; }
  btn.innerHTML = _fbSending ? `<span class="fb-spin" aria-hidden="true"></span>${label}` : label;
  btn.disabled = _fbSending || !ready;
  btn.setAttribute('aria-busy', _fbSending ? 'true' : 'false');
  if (hint) { hint.hidden = ready || _fbSending; hint.textContent = why; }
}

function fbShowErr(msg) {
  const el = document.getElementById('fbErr');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
}

function fbNext() {
  const s = fbState();
  if (_fbSending) return;
  if (s.step < FB_STEPS) {
    s.step += 1;
    fbSaveState();
    renderFeedbackPage();
    fbFocusHeading();
  } else {
    fbSubmitEval();
  }
}

function fbBack() {
  const s = fbState();
  if (_fbSending) return;
  if (s.mode === 'eval' && s.step > 1) { s.step -= 1; fbSaveState(); renderFeedbackPage(); fbFocusHeading(); return; }
  // Leaving step 1 keeps the answers: the start page then offers "Continue".
  s.mode = 'home';
  fbSaveState();
  renderFeedbackPage();
  fbFocusHeading();
}

// ---------------------------------------------------------------- sending
// Phone, tablet or laptop, the browser and its major version, the app version, and the page the student
// came from. Never typed by them, and never an IP address.
function fbContext() {
  const ua = navigator.userAgent || '';
  const tablet = /iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const device = tablet ? 'tablet' : (/Mobi|iPhone|Android/i.test(ua) || window.innerWidth <= 768) ? 'phone' : 'desktop';
  const tests = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
                 [/CriOS\/(\d+)/, 'Chrome iOS'], [/FxiOS\/(\d+)/, 'Firefox iOS'], [/Firefox\/(\d+)/, 'Firefox'],
                 [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+)[\d.]* .*Safari/, 'Safari']];
  let browser = 'Other';
  for (const [re, name] of tests) { const m = ua.match(re); if (m) { browser = `${name} ${m[1]}`; break; } }
  const from = fbState().from;
  return { page_context: from && from !== 'feedback' ? from : '', device_type: device, browser, app_version: FB_APP_VERSION };
}

function fbErrText(error) {
  const msg = String(error?.message || '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You seem to be offline. Your answers are saved — reconnect and press the button again.';
  }
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return 'We couldn’t reach Nestrel. Your answers are saved — check your connection and try again.';
  }
  if (error?.code === 'PGRST202' || /Could not find the function/i.test(msg)) {
    return 'Feedback isn’t switched on yet. Please try again later.';
  }
  // The database's own refusals (not logged in, suspended, a missing answer, the daily limit) are written
  // to be read by a student; anything else is not.
  if (['42501', '23514'].includes(error?.code) && msg) return msg;
  return 'Something went wrong. Your answers are saved — please try again.';
}

async function fbSubmitEval() {
  const s = fbState();
  if (_fbSending) return;
  const a = s.a;
  if (!a.overall_rating || !a.features_used.length || !a.would_miss_nestrel) {
    fbShowErr('Please answer the rating (step 1), what you tried (step 2), and the last question.');
    return;
  }
  _fbSending = true;
  fbShowErr('');
  fbSyncNav();
  const payload = {
    feedback_source: 'student_evaluation',
    overall_rating: a.overall_rating,
    features_used: a.features_used,
    liked: a.liked.trim(),
    confusing_or_missing: a.confusing_or_missing.trim(),
    one_thing_to_change: a.one_thing_to_change.trim(),
    would_miss_nestrel: a.would_miss_nestrel,
    contact_allowed: !!a.contact_allowed,
    completion_seconds: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : null,
    ...fbContext(),
  };
  let data = null, error = null;
  try { ({ data, error } = await supabaseClient.rpc('submit_app_feedback', { p: payload })); }
  catch (e) { error = e; }
  _fbSending = false;
  if (error || !data || !data.code) {
    if (error) console.error('[feedback] submit failed:', error);
    fbShowErr(fbErrText(error));
    fbSyncNav();
    return;
  }
  s.completion = { code: data.code, completed_on: data.completed_on, first: data.first_name, last: data.last_name,
                   email: data.email, already: !!data.already };
  s.a = fbBlankAnswers();
  s.step = 1;
  s.startedAt = null;
  s.mode = 'done';
  fbSaveState();
  renderFeedbackPage();
  fbFocusHeading();
}

async function fbSubmitNote() {
  const s = fbState();
  if (_fbSending || !FB_KINDS[s.kind]) return;
  _fbSending = true;
  fbShowErr('');
  fbSyncNav();
  const payload = { feedback_source: 'general', kind: s.kind, message: s.note.trim(),
                    contact_allowed: !!s.noteContact, ...fbContext() };
  let data = null, error = null;
  try { ({ data, error } = await supabaseClient.rpc('submit_app_feedback', { p: payload })); }
  catch (e) { error = e; }
  _fbSending = false;
  if (error || !data) {
    if (error) console.error('[feedback] note failed:', error);
    fbShowErr(fbErrText(error));
    fbSyncNav();
    return;
  }
  s.note = '';
  s.noteContact = false;
  s.mode = 'quickdone';
  fbSaveState();
  renderFeedbackPage();
  fbFocusHeading();
}

// ---------------------------------------------------------------- the #/feedback link
// For professors: "go to nestrel.org/#/feedback". Same two rules as evRouteFromHash() in js/events.js —
// a route starts with #/, and anything carrying a Supabase auth marker is never a route.
function fbRouteFromHash() {
  const h = window.location.hash || '';
  if (!h.startsWith('#/')) return false;
  if (AUTH_HASH_MARKERS.test(h)) return false;
  return /^#\/feedback\/?$/.test(h);
}
function fbClearRoute() {
  if (fbRouteFromHash()) history.replaceState(null, '', window.location.pathname + window.location.search);
}

// A cold load on the link (js/boot.js). Returns true when it has taken the screen.
function fbHandleColdRoute(signedIn) {
  if (!fbRouteFromHash()) return false;
  fbClearRoute();
  if (!signedIn) {
    try { sessionStorage.setItem(FB_INTENT_KEY, 'home'); } catch (e) { /* private mode */ }
    openModal('loginModal');
    return true;
  }
  openFeedback();
  return true;
}

// After logging in (enterStudentSession in js/auth.js): finish the trip the student started signed out.
function fbResumeIntent() {
  let mode = null;
  try { mode = sessionStorage.getItem(FB_INTENT_KEY); sessionStorage.removeItem(FB_INTENT_KEY); } catch (e) { /* private mode */ }
  if (!mode) return false;
  openFeedback(mode === 'home' ? undefined : mode);
  return true;
}

window.addEventListener('hashchange', () => {
  if (!fbRouteFromHash()) return;
  fbClearRoute();
  openFeedback();
});

// ---------------------------------------------------------------- the round button
// Bottom right by default, above the phone's tab bar. A student can drag it anywhere; it settles against
// the nearer side and stays there (this device only). Touch events, not pointer events: iOS Safari
// cancels pointer drags silently (CLAUDE.md).
function fbLoadFabPos() {
  try { const p = JSON.parse(localStorage.getItem(FB_FAB_KEY)); if (p && (p.side === 'left' || p.side === 'right')) return p; }
  catch (e) { /* unavailable: default place */ }
  return null;
}

function fbPlaceFab(fab, pos) {
  if (!pos) { fab.style.left = fab.style.right = fab.style.top = fab.style.bottom = ''; return; }
  const size = fab.offsetHeight || 48;
  const phone = window.innerWidth <= 768;
  const minTop = phone ? 64 : 12;
  const maxTop = window.innerHeight - size - (phone ? 80 : 12);
  const top = Math.max(minTop, Math.min(maxTop, Math.round(pos.y * window.innerHeight)));
  fab.style.top = top + 'px';
  fab.style.bottom = 'auto';
  fab.style.left = pos.side === 'left' ? '14px' : 'auto';
  fab.style.right = pos.side === 'right' ? '14px' : 'auto';
}

// Called once from js/boot.js — the only file that runs code at load.
function fbInitFab() {
  const fab = document.getElementById('fbFab');
  if (!fab) return;
  fbPlaceFab(fab, fbLoadFabPos());
  let start = null, moved = false;
  const begin = (x, y) => { const r = fab.getBoundingClientRect(); start = { x, y, left: r.left, top: r.top }; moved = false; };
  const move = (x, y) => {
    if (!start) return false;
    const dx = x - start.x, dy = y - start.y;
    if (!moved && Math.hypot(dx, dy) < 8) return false;
    moved = true;
    fab.classList.add('is-dragging');
    const size = fab.offsetWidth || 48;
    fab.style.left = Math.max(4, Math.min(window.innerWidth - size - 4, start.left + dx)) + 'px';
    fab.style.top = Math.max(4, Math.min(window.innerHeight - size - 4, start.top + dy)) + 'px';
    fab.style.right = fab.style.bottom = 'auto';
    return true;
  };
  const finish = () => {
    if (!start) return false;
    const was = moved;
    start = null;
    fab.classList.remove('is-dragging');
    if (was) {
      const r = fab.getBoundingClientRect();
      const pos = { side: r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right', y: r.top / window.innerHeight };
      try { localStorage.setItem(FB_FAB_KEY, JSON.stringify(pos)); } catch (e) { /* not kept: fine */ }
      fbPlaceFab(fab, pos);
    }
    return was;
  };
  fab.addEventListener('touchstart', e => { const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: true });
  fab.addEventListener('touchmove', e => { const t = e.touches[0]; if (move(t.clientX, t.clientY)) e.preventDefault(); }, { passive: false });
  fab.addEventListener('touchend', e => { if (finish()) e.preventDefault(); });   // a drag is not a tap
  fab.addEventListener('touchcancel', () => { finish(); });
  fab.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    begin(e.clientX, e.clientY);
    const mm = ev => { move(ev.clientX, ev.clientY); };
    const mu = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      if (finish()) fab.dataset.dragged = '1';
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });
  fab.addEventListener('click', e => {
    if (fab.dataset.dragged) { delete fab.dataset.dragged; e.preventDefault(); return; }
    openFeedback();
  });
  window.addEventListener('resize', () => fbPlaceFab(fab, fbLoadFabPos()));
}
