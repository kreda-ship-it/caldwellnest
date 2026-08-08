// ============================================================
// BOOT
// Starts the app. MUST load last — it is the only file that runs code instead of just defining it.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

currentRole = 'student';
const _settingsReady = loadPlatformSettings();
// Wait for Supabase to finish restoring the saved login BEFORE the first data load.
// initStudent() used to fire immediately and race the session restore: when its
// queries went out before the auth token was ready, RLS answered as if we were an
// anonymous visitor and returned a partial/empty feed — listings then "randomly"
// appeared or vanished depending on which request won the race on each reload.
const _sessionReady = supabaseClient.auth.getSession();
_sessionReady.then(() => initStudent());

// Password-recovery return. Two detectors on purpose, both idempotent:
//  - the hash, if supabase-js has not yet stripped it (it removes it once it consumes the token)
//  - the PASSWORD_RECOVERY event, which fires whether or not we won that race
// Registered here rather than later because the event fires as soon as the client finishes
// parsing the URL. Without this, the recovery session looks like a normal login and STATE A
// below sends them to the feed with their password still unchanged.
if (/[#&]type=recovery/.test(window.location.hash)) showResetScreen();
supabaseClient.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showResetScreen();
});

// Early restore: paint the last-visited page immediately (no network wait) so a
// browser-forced reload shows the right page instead of flashing the landing page.
//
// cn_last_page lives in sessionStorage, which dies with the TAB — so reloading a live tab
// keeps it, but closing the app and reopening it does not. That is the common case, and it
// used to land a perfectly signed-in student on the "Join us" pitch. We cannot know yet
// whether the session is still valid (getSession() is async and may hit the network to
// refresh), but we DO know synchronously whether this device has signed in before. If it
// has, painting the feed is right far more often than painting the landing page; the async
// block below corrects to the welcome-back login on the rare miss.
if (!adminPreviewMode && !_recoveryMode) {
  const _rp = sessionStorage.getItem('cn_last_page');
  if (_rp && _rp !== 'home' && document.getElementById('page-' + _rp)) showPage(_rp);
  else if (getPriorUser()) showPage('listings');
}

(async () => {
  if (adminPreviewMode) return;
  // Mid-reset: the session is real but the student has not set their password yet.
  if (_recoveryMode) return;
  const [, { data: { session } }] = await Promise.all([_settingsReady, _sessionReady]);
  if (!session) {
    if (applyMaintenance()) return;
    const lastPage = sessionStorage.getItem('cn_last_page');
    const onPrivatePage = ['messages', 'profile'].includes(lastPage); // the early restore may have painted a signed-in-only page
    const prior = getPriorUser();
    if (prior) {
      // STATE B — this device knows someone, but the session is gone or expired.
      // Feed behind, welcome-back login in front. Never the "Join us" pitch: they joined.
      if (onPrivatePage || !lastPage) showPage('listings');
      openModal('loginModal');
    } else if (onPrivatePage) {
      // STATE C — nobody known here, and we're sitting on a page that needs an account.
      showPage('home');
    }
    // STATE C otherwise: leave the landing page exactly as it is (or the feed, if a
    // signed-out visitor was browsing it — that has always been allowed).
    return;
  }

  // Check if this is an admin account
  const { data: roles } = await supabaseClient.from('user_roles').select('role_id, school').eq('user_id', session.user.id);
  if (roles && roles.length > 0) {
    // Admin session — restore admin panel directly
    aAdminSchool = roles[0].school || null;
    if (aAdminSchool) {
      const { data: sc } = await supabaseClient.from('schools').select('brand_name').eq('slug', aAdminSchool).maybeSingle();
      aAdminBrand = sc?.brand_name || aAdminSchool;
      _schoolBrandCache[aAdminSchool] = aAdminBrand;
    }
    document.getElementById('studentApp').style.display = 'none';
    document.getElementById('adminApp').style.display = 'block';
    document.getElementById('aiFab').style.display = 'flex';
    currentRole = 'admin';
    adminUUID = session.user.id;
    initAdmin();
    return;
  }

  // Student session — restore normally
  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile) return;

  if (profile.status === 'suspended') {
    const { data: sh } = await supabaseClient.from('suspension_history').select('id').eq('profile_id', profile.id).eq('action', 'suspended').order('created_at', { ascending: false }).limit(1).maybeSingle();
    await supabaseClient.auth.signOut();
    showSuspensionScreen(profile.email || session.user.email, profile.id, profile.suspension_reason, sh?.id || null);
    return;
  }

  sUser = { id: session.user.id, first: profile.first_name, last: profile.last_name, name: profile.first_name + ' ' + profile.last_name, display_name: profile.display_name || null, email: profile.email || session.user.email, username: profile.username || null, bio: profile.bio || null, pronouns: profile.pronouns || null, major: profile.major, year: profile.year, initials: profile.initials, color: profile.color, avatar_url: profile.avatar_url || null, created_at: profile.created_at || null, school: profile.school || 'caldwell' };
  if (applyMaintenance()) return;
  updateSNav();
  rememberUser(profile.first_name, profile.email || session.user.email); // keep the hint fresh
  // STATE A — valid session. Invisible reload: return to the page the student was on before
  // the browser reloaded the tab, and otherwise go straight to the feed. That `else` is the
  // fix: without it, a signed-in student with no cn_last_page (i.e. anyone reopening the app
  // rather than reloading a live tab) simply stayed on the "Join us" landing page.
  const lastPage = sessionStorage.getItem('cn_last_page');
  if (lastPage && lastPage !== 'home' && document.getElementById('page-' + lastPage)) {
    showPage(lastPage);
    if (lastPage === 'messages') {
      try {
        const c = JSON.parse(sessionStorage.getItem('cn_last_convo'));
        // ownerId check: never reopen a conversation saved by a different account on this tab
        if (c && c.userId && c.ownerId === session.user.id) openConvo(c.userId, c.info, c.listingId);
      } catch (e) { /* corrupt saved value — ignore, student just sees the convo list */ }
    }
  } else {
    showPage('listings');
  }
  // Just clicked the email-verification link → Supabase set the session and redirected here.
  if (/[#&]type=signup/.test(window.location.hash)) {
    toast('✓ Email verified — welcome to CaldwellNest!');
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  checkStudentNotifications(session.user.id);
  startGlobalMsgListener(session.user.id);
  startNotifListener(session.user.id);
  startProfileListener(session.user.id);
  loadStudentBroadcasts();
})();
