// ============================================================
// AUTH
// Who is logged in: admin + student login/logout, signup, email verification, the suspension screen, and getEffectiveUser().
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

async function doAdminLogin() {
  const e = document.getElementById('aEmail').value.trim();
  const p = document.getElementById('aPass').value;
  const err = document.getElementById('adminLoginErr');
  err.style.display = 'none';
  if (!e || !p) { err.textContent = 'Please enter your email and password.'; err.style.display = 'block'; return; }

  const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({ email: e, password: p });
  if (authError) { err.textContent = 'Wrong email or password.'; err.style.display = 'block'; return; }

  const { data: roles, error: rolesError } = await supabaseClient
    .from('user_roles')
    .select('role_id, school')
    .eq('user_id', authData.user.id);

  if (rolesError || !roles || roles.length === 0) {
    await supabaseClient.auth.signOut();
    err.textContent = rolesError ? 'Permission error: ' + rolesError.message : 'This account does not have admin access.';
    err.style.display = 'block';
    return;
  }

  aAdminSchool = roles[0].school || null;
  if (aAdminSchool) {
    const { data: sc } = await supabaseClient.from('schools').select('brand_name').eq('slug', aAdminSchool).maybeSingle();
    aAdminBrand = sc?.brand_name || aAdminSchool;
    _schoolBrandCache[aAdminSchool] = aAdminBrand;
  }
  adminUUID = authData.user.id;
  closeModal('adminLoginModal');
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  document.getElementById('aiFab').style.display = 'flex';
  currentRole = 'admin';
  initAdmin();
}

async function aLogout() {
  adminPreviewMode = false;
  // Realtime listeners must die with the session — otherwise post-logout events
  // keep firing adminReload() as an anonymous client and clobber the caches.
  _adminRealtimeChannels.forEach(ch => supabaseClient.removeChannel(ch));
  _adminRealtimeChannels = [];
  clearTimeout(_adminReloadTimer);
  await supabaseClient.auth.signOut();
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('aiFab').style.display = 'none';
  document.getElementById('studentApp').style.display = 'block';
  currentRole = 'student';
}

async function enterStudentPreview() {
  adminPreviewMode = true;
  const { data: { user } } = await supabaseClient.auth.getUser();
  adminUUID = user?.id || null;
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('aiFab').style.display = 'none';
  document.getElementById('studentApp').style.display = 'block';
  updateSNav();
  showPage('listings');
}

function switchBackToAdmin() {
  if (sRealtimeChannel) { supabaseClient.removeChannel(sRealtimeChannel); sRealtimeChannel = null; }
  adminPreviewMode = false;
  adminUUID = null;
  sUser = null;
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  document.getElementById('aiFab').style.display = 'flex';
}

async function sLogout() {
  if (adminPreviewMode) { switchBackToAdmin(); return; }
  if (sRealtimeChannel)  { supabaseClient.removeChannel(sRealtimeChannel);  sRealtimeChannel  = null; }
  if (sGlobalMsgChannel) { supabaseClient.removeChannel(sGlobalMsgChannel); sGlobalMsgChannel = null; }
  if (sNotifChannel)     { supabaseClient.removeChannel(sNotifChannel);     sNotifChannel     = null; }
  if (sProfileChannel)   { supabaseClient.removeChannel(sProfileChannel);   sProfileChannel   = null; }
  await supabaseClient.auth.signOut();
  sUser = null;
  sessionStorage.removeItem('cn_last_convo');
  updateSNav();
  showPage('home');
  toast('Logged out');
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'Show' : 'Hide';
}

function forgotPassword() {
  // Placeholder — full reset flow (Supabase auth.resetPasswordForEmail) comes after launch
  toast('Password reset coming soon. For now, contact support if you need access.');
}

// ---- Email verification gate ----
let _verifyEmail = null;
let _resendCooldown = 0;
let _resendTimer = null;

function showVerifyScreen(email) {
  _verifyEmail = email || null;
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('verifyEmail').textContent = email || 'your email';
  document.getElementById('verifyMsg').textContent = '';
  document.getElementById('verifyScreen').style.display = 'flex';
}

function hideVerifyScreen() {
  document.getElementById('verifyScreen').style.display = 'none';
  document.getElementById('studentApp').style.display = '';
  clearInterval(_resendTimer); _resendCooldown = 0;
  const btn = document.getElementById('resendVerifyBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Resend email'; }
}

async function resendVerification() {
  if (_resendCooldown > 0 || !_verifyEmail) return;
  const btn = document.getElementById('resendVerifyBtn');
  const msg = document.getElementById('verifyMsg');
  btn.disabled = true;
  const { error } = await supabaseClient.auth.resend({ type: 'signup', email: _verifyEmail });
  if (error) {
    msg.style.color = 'var(--danger)';
    msg.textContent = error.message || 'Could not resend just now — please wait a moment and try again.';
    btn.disabled = false;
    return;
  }
  msg.style.color = 'var(--success)';
  msg.textContent = '✓ Sent! Check your inbox (and spam).';
  _resendCooldown = 60; // client-side cooldown so the button can't be spammed
  const tick = () => {
    if (_resendCooldown <= 0) { clearInterval(_resendTimer); btn.disabled = false; btn.textContent = 'Resend email'; return; }
    btn.textContent = `Resend in ${_resendCooldown}s`;
    _resendCooldown--;
  };
  tick();
  _resendTimer = setInterval(tick, 1000);
}

async function doSignup() {
  const first    = document.getElementById('sFirst').value.trim();
  const last     = document.getElementById('sLast').value.trim();
  const username = document.getElementById('sUsername').value.trim().toLowerCase();
  const email    = document.getElementById('sEmail').value.trim().toLowerCase();
  const major    = document.getElementById('sMajor').value.trim();
  const year     = document.getElementById('sYear').value;
  const pass     = document.getElementById('sPass').value;
  const err      = document.getElementById('signupErr');
  const showErr  = msg => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';

  if (!first || !last) { showErr('Please enter your name.'); return; }
  if (!username) { showErr('Please choose a username.'); return; }
  if (!USERNAME_RE.test(username)) { showErr('Username must be 3–20 characters: letters, numbers, and underscores only.'); return; }
  if (RESERVED_USERNAMES.has(username)) { showErr('That username is reserved. Please choose another.'); return; }
  if (!_selectedSchool) { showErr('Please select your school first.'); return; }
  if (!pass || pass.length < 6) { showErr('Password must be at least 6 characters.'); return; }

  const { data: takenUsername } = await supabaseClient.from('profiles').select('id').eq('username', username).maybeSingle();
  if (takenUsername) { showErr('That username is already taken. Please choose another.'); return; }

  const { data: takenEmail } = await supabaseClient.from('profiles').select('id').eq('email', email).maybeSingle();
  if (takenEmail) { showErr('An account already exists with that email. Try logging in instead.'); return; }

  const initials = (first[0] + last[0]).toUpperCase();
  const color = AC[Math.floor(Math.random() * AC.length)];

  // Profile fields ride along as auth metadata so the handle_new_user trigger can create the
  // profiles row even when email confirmation is ON (no client session exists at that point).
  const { data: authData, error: authError } = await supabaseClient.auth.signUp({
    email, password: pass,
    options: {
      emailRedirectTo: window.location.origin,
      data: { first_name: first, last_name: last, username, major: major || null, year: year || null, initials, color, school: _selectedSchool.slug }
    }
  });
  if (authError) { showErr(authError.message); return; }
  if (authData.user?.identities?.length === 0) { showErr('An account already exists with that email. Try logging in instead.'); return; }

  // Email confirmation ON → signUp returns no session → show the "check your email" screen.
  // (The profile row is created by the handle_new_user trigger, not here.)
  if (!authData.session) {
    closeModal('signupModal');
    showVerifyScreen(email);
    return;
  }

  // Email confirmation OFF → we have a session and can log in immediately.
  // Upsert is a safety net so this coexists with the trigger without a duplicate-key error.
  await supabaseClient.from('profiles').upsert({
    id: authData.user.id, first_name: first, last_name: last,
    email, username, major: major || null, year: year || null, initials, color, school: _selectedSchool.slug
  }, { onConflict: 'id', ignoreDuplicates: true });
  logEvent('student_signup', { targetType: 'student', targetId: authData.user.id, targetLabel: first + ' ' + last, school: _selectedSchool.slug });

  sUser = { id: authData.user.id, first, last, name: first + ' ' + last, email, username, major, year, initials, color, school: _selectedSchool.slug };
  closeModal('signupModal');
  updateSNav();
  toast('Welcome to CaldwellNest, ' + first + '!');
  await loadListings();
  showPage('listings');
  startGlobalMsgListener(authData.user.id);
  startNotifListener(authData.user.id);
  startProfileListener(authData.user.id);
  loadStudentBroadcasts();
}

async function doLogin() {
  const email = document.getElementById('lEmail').value.trim().toLowerCase();
  const pass = document.getElementById('lPass').value;
  const err = document.getElementById('loginErr');
  if (!pass) { err.textContent = 'Please enter your password'; err.style.display = 'block'; return; }
  err.style.display = 'none';

  const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password: pass });
  if (authError) {
    // Unverified accounts can't get a session — show the branded check-email screen instead of a scary error.
    if (authError.code === 'email_not_confirmed' || /not confirmed/i.test(authError.message || '')) {
      closeModal('loginModal');
      showVerifyScreen(email);
      return;
    }
    err.textContent = 'Wrong email or password.'; err.style.display = 'block'; return;
  }

  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', authData.user.id).single();
  if (!profile) { err.textContent = 'Account not found. Please sign up first.'; err.style.display = 'block'; await supabaseClient.auth.signOut(); return; }

  if (profile.status === 'suspended') {
    const { data: sh } = await supabaseClient.from('suspension_history').select('id').eq('profile_id', authData.user.id).eq('action', 'suspended').order('created_at', { ascending: false }).limit(1).maybeSingle();
    await supabaseClient.auth.signOut();
    closeModal('loginModal');
    showSuspensionScreen(profile.email || email, profile.id, profile.suspension_reason, sh?.id || null);
    return;
  }

  closeModal('loginModal');
  await enterStudentSession(profile, authData.user.id, 'Welcome back, ' + profile.first_name + '!');
}

// Shared post-authentication student setup — used by real login AND the demo login,
// so the demo session behaves byte-for-byte like any other student.
async function enterStudentSession(profile, userId, welcomeMsg) {
  sUser = {
    id: userId, first: profile.first_name, last: profile.last_name,
    name: profile.first_name + ' ' + profile.last_name,
    display_name: profile.display_name || null, email: profile.email,
    username: profile.username || null, bio: profile.bio || null, pronouns: profile.pronouns || null,
    major: profile.major, year: profile.year, initials: profile.initials, color: profile.color,
    avatar_url: profile.avatar_url || null, created_at: profile.created_at || null,
    school: profile.school || 'caldwell'
  };
  updateSNav();
  if (welcomeMsg) toast(welcomeMsg);
  if (applyMaintenance()) return;
  await loadListings();
  showPage('listings');
  checkStudentNotifications(userId);
  startGlobalMsgListener(userId);
  startNotifListener(userId);
  startProfileListener(userId);
  loadStudentBroadcasts();
}

async function loadStudentBroadcasts() {
  const el = document.getElementById('sBcastBanner');
  if (!el) return;
  const eu = getEffectiveUser();
  if (!eu) { el.innerHTML = ''; return; }
  const now = new Date().toISOString();
  const { data: rows } = await supabaseClient
    .from('broadcasts')
    .select('id, subject, body, type, display_type, school, landing_title, landing_body')
    .in('status', ['sent', 'scheduled'])
    .or(`scheduled_at.is.null,scheduled_at.lte.${now}`)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: false })
    .limit(10);
  if (!rows || rows.length === 0) { el.innerHTML = ''; return; }
  const mySchool = eu.school || null;
  let dismissed = [];
  try { dismissed = JSON.parse(localStorage.getItem('cn_dismissed_bcast') || '[]'); } catch {}
  const toShow = rows
    .filter(b => !b.school || b.school === mySchool)
    .filter(b => !dismissed.includes(b.id))
    .filter(b => b.display_type === 'banner' || b.display_type === 'both')
    .slice(0, 3);
  if (toShow.length === 0) { el.innerHTML = ''; return; }
  toShow.forEach(b => { _bcastCache[b.id] = b; });
  const colors = {
    warning:      { bg: '#fff3cd', color: '#856404' },
    reminder:     { bg: '#fff8e6', color: '#d4860a' },
    feature:      { bg: '#e8f5e9', color: '#1a7a45' },
    announcement: { bg: 'var(--brand-pale)', color: 'var(--brand)' },
  };
  el.innerHTML = toShow.map(b => {
    const c = colors[b.type] || colors.announcement;
    const readMore = b.landing_body
      ? ` <button onclick="openBcastLanding(_bcastCache['${b.id}'])" style="background:none;border:none;font-size:12px;cursor:pointer;color:inherit;font-weight:700;padding:0;text-decoration:underline;text-underline-offset:2px;font-family:'DM Sans',sans-serif;">Read more &#8594;</button>`
      : '';
    return `<div id="bcast-${b.id}" style="padding:10px 44px 10px 16px;background:${c.bg};color:${c.color};font-size:13px;line-height:1.5;position:relative;border-bottom:1px solid rgba(0,0,0,0.07);">
      <strong>${b.subject}</strong>&ensp;${b.body}${readMore}
      <button onclick="dismissBcast('${b.id}')" title="Dismiss" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;font-size:18px;cursor:pointer;opacity:.5;color:inherit;line-height:1;padding:0;">&#215;</button>
    </div>`;
  }).join('');
}

function dismissBcast(id) {
  let dismissed = [];
  try { dismissed = JSON.parse(localStorage.getItem('cn_dismissed_bcast') || '[]'); } catch {}
  if (!dismissed.includes(id)) dismissed.push(id);
  localStorage.setItem('cn_dismissed_bcast', JSON.stringify(dismissed));
  const el = document.getElementById('bcast-' + id);
  if (el) el.remove();
}

async function checkStudentNotifications(userId) {
  const { data: notifs } = await supabaseClient
    .from('notifications')
    .select('id, message, type, created_at')
    .eq('profile_id', userId)
    .eq('read', false)
    .order('created_at', { ascending: false });
  if (notifs && notifs.length > 0) showStudentNotifications(notifs);
}

function showStudentNotifications(notifs) {
  const title = document.getElementById('notifModalTitle');
  const body  = document.getElementById('notifModalBody');
  if (!title || !body) return;
  title.textContent = notifs.length === 1 ? 'Appeal update' : `${notifs.length} appeal updates`;
  body.innerHTML = notifs.map(n => `
    <div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:13px;line-height:1.6;color:var(--text)">${n.message}</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:4px">${fmtDate(n.created_at)}</div>
    </div>`).join('');
  openModal('notifModal');
  supabaseClient.from('notifications').update({ read: true }).in('id', notifs.map(n => n.id));
}

function dismissNotifications() { closeModal('notifModal'); }

function aNotifyStudent(profileId, type, message) {
  supabaseClient.from('notifications').insert({ profile_id: profileId, type, message, read: false });
}

// Demo student — a REAL, verified Supabase student account (created in the dashboard).
// Credentials are hardcoded for one-click demos; this is a plain student with no special powers.
const DEMO_EMAIL = 'demo@caldwell.edu';
const DEMO_PASSWORD = 'Demoaccount2026!';

async function demoLogin() {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  if (error) { toast('Demo login unavailable right now.'); console.error('[demo login]', error); return; }
  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', data.user.id).single();
  if (!profile) { toast('Demo profile not set up yet.'); await supabaseClient.auth.signOut(); return; }
  closeModal('loginModal');
  await enterStudentSession(profile, data.user.id, 'Logged in as demo student ✓');
}

function updateSNav() {
  const u = getEffectiveUser();
  document.getElementById('navGuest').style.display = u ? 'none' : 'flex';
  const nu = document.getElementById('navUser');
  nu.style.display = u ? 'flex' : 'none';
  if (u) {
    const navAv = document.getElementById('navAvatar');
    navAv.style.background = u.color;
    navAv.style.backgroundSize = 'cover'; navAv.style.backgroundPosition = 'center';
    paintAvatarEl(navAv, u.avatar_url, u.initials, u.color);
    const backBtn = document.getElementById('backToAdminBtn');
    if (backBtn) backBtn.style.display = adminPreviewMode ? 'inline-flex' : 'none';
  }
}

function getCNIdentity() {
  return {
    name: localStorage.getItem('cn_official_name') || 'CaldwellNest',
    initials: localStorage.getItem('cn_official_initials') || 'CN',
    color: localStorage.getItem('cn_official_color') || '#7c3aed'
  };
}

function getEffectiveUser() {
  if (adminPreviewMode) {
    const cn = getCNIdentity();
    return { id: adminUUID, name: cn.name, first: cn.name, last: '', email: 'official@caldwellnest.com', initials: cn.initials, color: cn.color };
  }
  return sUser;
}
