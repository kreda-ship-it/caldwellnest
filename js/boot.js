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

// Early restore: paint the last-visited page immediately (no network wait) so a
// browser-forced reload shows the right page instead of flashing the landing page.
if (!adminPreviewMode) {
  const _rp = sessionStorage.getItem('cn_last_page');
  if (_rp && _rp !== 'home' && document.getElementById('page-' + _rp)) showPage(_rp);
}

(async () => {
  if (adminPreviewMode) return;
  const [, { data: { session } }] = await Promise.all([_settingsReady, _sessionReady]);
  if (!session) {
    // Signed out: the early restore above may have painted a signed-in-only page — undo that.
    if (!applyMaintenance() && ['messages', 'profile'].includes(sessionStorage.getItem('cn_last_page'))) showPage('home');
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
  // Invisible reload: return to the page the student was on before the browser reloaded the tab.
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
