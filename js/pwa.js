// ============================================================
// KEEP NESTREL CLOSE — installing Nestrel as an app, sharing it, and a gentle reminder (2026-10-12)
//
//  - pwaInit()           registers the service worker (sw.js), catches the browser's install offer,
//                        and, a few seconds after a signed-in visit starts, considers the reminder.
//                        Called once from boot.js.
//  - pwaShowKeepClose()  the "Keep Nestrel Close" screen, shown ONCE, right after a first signup
//                        (finishSetup in auth.js). Explains Add to Home Screen for the student's own
//                        device, offers the real install button where the browser has one, and
//                        Explore / Share / Maybe later. Never in the way: closing it is always one tap.
//  - pwaShare()          Share Nestrel: the phone's own share sheet where there is one, otherwise
//                        copying https://nestrel.org. Shares the public front page only.
//  - the reminder        a small card for students who have been back on 3 different days and still
//                        use Nestrel in a browser tab. Dismissed once: quiet for 30 days. Twice: never.
//
// What is remembered, and where: Nestrel has no saved-preferences table, so these choices live in
// this browser (localStorage), one key per account: nestrel_pwa_<user id> = { onboard, days, last,
// dismissed, dismissedAt }. Only on/off flags and dates — nothing personal. On another device the
// student simply starts fresh, which is right: installing is per device anyway.
// Not done here: notifications — they live in js/push.js (2026-10-12). Not done at all, on purpose:
// streaks, forced redirects.
// ============================================================

const PWA_URL = 'https://nestrel.org';
let _pwaPrompt = null;          // the browser's install offer (Chrome/Edge/Android), kept until used

function pwaInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
// Which instructions fit this device. iPadOS reports itself as a Mac, so touch decides.
function pwaPlatform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
function pwaKey(id) { return 'nestrel_pwa_' + id; }
function pwaLoad(id) { try { return JSON.parse(localStorage.getItem(pwaKey(id))) || {}; } catch { return {}; } }
function pwaSave(id, st) { try { localStorage.setItem(pwaKey(id), JSON.stringify(st)); } catch { /* private mode: just don't remember */ } }

function pwaInit() {
  // Only on a real site (https, or localhost while testing). A file:// page cannot have a worker.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('[pwa] service worker', err.message));
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();                 // keep the offer for our own button instead of the browser's mini-bar
    _pwaPrompt = e;
    document.querySelectorAll('[data-pwa-install]').forEach(b => { b.hidden = false; });
  });
  window.addEventListener('appinstalled', () => {
    _pwaPrompt = null;
    const u = getEffectiveUser();
    if (u) pwaSave(u.id, { ...pwaLoad(u.id), installed: true });
    pwaHideReminder();
  });
  setTimeout(pwaMaybeRemind, 6000);
}

// ---- The "Keep Nestrel Close" screen ----
function pwaStepsHTML() {
  const p = pwaPlatform();
  // The iOS share symbol (a box with an arrow out of it), drawn here: the app's icon set has none.
  const share = '<svg class="kc-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  if (p === 'ios') return `
    <ol class="kc-steps">
      <li>Tap <b>Share</b> ${share} at the bottom of Safari (in Chrome, it's at the top).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>. Nestrel opens from your home screen like an app.</li>
    </ol>`;
  if (p === 'android') return `
    <ol class="kc-steps">
      <li>Tap the <b>⋮ menu</b> at the top right of Chrome.</li>
      <li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li>
      <li>Nestrel opens from your home screen like an app.</li>
    </ol>`;
  return `
    <ol class="kc-steps">
      <li>In Chrome or Edge, click the <b>install</b> icon at the right of the address bar.</li>
      <li>Or bookmark Nestrel: press <b>${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} + D</b>.</li>
    </ol>`;
}

function pwaShowKeepClose() {
  const u = getEffectiveUser();
  if (!u || pwaInstalled()) return;
  const st = pwaLoad(u.id);
  if (st.onboard) return;               // seen once already: never again
  pwaSave(u.id, { ...st, onboard: 'shown' });
  pwaHideReminder();
  document.getElementById('kcSteps').innerHTML = pwaStepsHTML();
  document.querySelectorAll('[data-pwa-install]').forEach(b => { b.hidden = !_pwaPrompt; });
  openModal('keepCloseModal');
}

function pwaCloseKeepClose(how) {
  const u = getEffectiveUser();
  if (u) pwaSave(u.id, { ...pwaLoad(u.id), onboard: how });
  closeModal('keepCloseModal');
}

async function pwaInstall() {
  if (!_pwaPrompt) return;
  _pwaPrompt.prompt();
  const { outcome } = await _pwaPrompt.userChoice;
  _pwaPrompt = null;
  document.querySelectorAll('[data-pwa-install]').forEach(b => { b.hidden = true; });
  if (outcome === 'accepted') { pwaCloseKeepClose('installed'); pwaHideReminder(); toast('Nestrel is on your home screen'); }
}

// ---- Sharing ----
async function pwaShare() {
  const data = { title: 'Nestrel', text: 'Caldwell\'s student marketplace, events and clubs, all in one place.', url: PWA_URL };
  if (navigator.share) {
    try { await navigator.share(data); return; }
    catch (e) { if (e.name === 'AbortError') return; }   // they closed the sheet: nothing to do
  }
  try { await navigator.clipboard.writeText(PWA_URL); toast('Link copied: nestrel.org'); }
  catch { window.prompt('Copy this link to share Nestrel:', PWA_URL); }
}

// ---- The return reminder ----
// Counts the days a student opens Nestrel in a browser tab; from the third, offers to install once.
function pwaMaybeRemind() {
  const u = getEffectiveUser();
  if (!u || currentRole !== 'student' || (typeof adminPreviewMode !== 'undefined' && adminPreviewMode)) return;
  if (pwaInstalled()) return;
  const st = pwaLoad(u.id);
  const today = new Date().toISOString().slice(0, 10);
  if (st.last !== today) { st.days = (st.days || 0) + 1; st.last = today; pwaSave(u.id, st); }
  if (st.installed || (st.dismissed || 0) >= 2 || (st.days || 0) < 3) return;
  if (st.dismissedAt && Date.now() - st.dismissedAt < 30 * 864e5) return;
  if (document.getElementById('keepCloseModal')?.classList.contains('open')) return;
  const el = document.getElementById('pwaReminder');
  if (!el) return;
  document.getElementById('pwaRemindText').textContent = pwaPlatform() === 'desktop'
    ? 'Install Nestrel or bookmark it, so it\'s one click away.'
    : 'Add Nestrel to your home screen, so it\'s one tap away.';
  el.hidden = false;
}
function pwaHideReminder() { const el = document.getElementById('pwaReminder'); if (el) el.hidden = true; }
function pwaDismissReminder() {
  const u = getEffectiveUser();
  if (u) { const st = pwaLoad(u.id); pwaSave(u.id, { ...st, dismissed: (st.dismissed || 0) + 1, dismissedAt: Date.now() }); }
  pwaHideReminder();
}
// "Show me how" on the reminder: the full screen again, whatever it said before.
function pwaReminderHow() {
  pwaHideReminder();
  document.getElementById('kcSteps').innerHTML = pwaStepsHTML();
  document.querySelectorAll('[data-pwa-install]').forEach(b => { b.hidden = !_pwaPrompt; });
  openModal('keepCloseModal');
}
