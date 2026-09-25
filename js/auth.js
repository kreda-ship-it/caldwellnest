// ============================================================
// AUTH
// Who is logged in: admin + student login/logout, signup, email verification, the suspension screen, and getEffectiveUser().
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// The shortest password a student may CHOOSE (the Google finish screen, and reset). Raised from 6 to 8 on
// 2026-09-23. Logging in never checks it, so an existing shorter password keeps working until
// its owner changes it. Supabase enforces its own minimum too (Authentication → Sign In /
// Providers → Email → Minimum password length); keep that at 8 as well, because this check
// runs in the browser and can be skipped.
const MIN_PASSWORD_LENGTH = 8;

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
  currentRole = 'admin';
  initAdmin();
}

async function aLogout() {
  adminPreviewMode = false;
  // Realtime listeners must die with the session — otherwise post-logout events
  // keep firing as an anonymous client and clobber the caches. (Defined in js/admin.js.)
  stopAdminRealtimeListeners();
  await supabaseClient.auth.signOut();
  clearOrgContext();
  clearOrgDirectory();
  clearFavorites();
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('studentApp').style.display = 'block';
  currentRole = 'student';
}

async function enterStudentPreview() {
  adminPreviewMode = true;
  const { data: { user } } = await supabaseClient.auth.getUser();
  adminUUID = user?.id || null;
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('studentApp').style.display = 'block';
  updateSNav();
  showPage('feed');
}

function switchBackToAdmin() {
  if (sRealtimeChannel) { supabaseClient.removeChannel(sRealtimeChannel); sRealtimeChannel = null; }
  adminPreviewMode = false;
  adminUUID = null;
  sUser = null;
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
}

async function sLogout() {
  if (adminPreviewMode) { switchBackToAdmin(); return; }
  if (sRealtimeChannel)  { supabaseClient.removeChannel(sRealtimeChannel);  sRealtimeChannel  = null; }
  if (sGlobalMsgChannel) { supabaseClient.removeChannel(sGlobalMsgChannel); sGlobalMsgChannel = null; }
  if (sNotifChannel)     { supabaseClient.removeChannel(sNotifChannel);     sNotifChannel     = null; }
  if (sProfileChannel)   { supabaseClient.removeChannel(sProfileChannel);   sProfileChannel   = null; }
  await supabaseClient.auth.signOut();
  sUser = null;
  // Both of these are per-ACCOUNT caches, and neither was being cleared here. Log out and
  // back in as somebody else in the same tab and you inherited the previous student's
  // officer buttons — and, since 2026-09-06, their follow state on every directory card.
  // A cache added without its invalidation is a bug shipped on purpose. (js/orgs.js,
  // js/orgdir.js.)
  clearOrgContext();
  clearOrgDirectory();
  clearFavorites();
  sessionStorage.removeItem('cn_last_convo');
  updateSNav();
  // The hint deliberately SURVIVES logout — this is still their device, so the way back in
  // should greet them. Only "Not you?" forgets. A known student gets the welcome-back login
  // over the feed; a stranger gets the Join us landing.
  const prior = getPriorUser();
  if (prior) { showPage('feed'); openModal('loginModal'); }
  else showPage('home');
  toast('Logged out');
}

// Two button styles: the eye icon on the auth pages (.ap-eye), and the older "Show"/"Hide"
// text button that other screens still use.
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  if (btn.classList.contains('ap-eye')) {
    btn.innerHTML = icon(showing ? 'eye' : 'eyeOff', 18);
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  } else {
    btn.textContent = showing ? 'Show' : 'Hide';
  }
}

// ---- Password reset ----
// Step 1 of 3: ask Supabase to email a recovery link.
//
// The confirmation deliberately says "IF that address has an account". Supabase returns
// success whether or not the email exists, precisely so this form can't be used to discover
// who has an account — and we must not undo that by checking first and saying "no such user".
async function forgotPassword() {
  const emailEl = document.getElementById('lEmail');
  const err     = document.getElementById('loginErr');
  const showErr = msg => { if (err) { err.textContent = msg; err.style.display = 'block'; } };
  const email = (emailEl?.value || getPriorUser()?.email || '').trim().toLowerCase();

  if (!email) {
    showErr('Enter your email address above first, then tap "Forgot password?".');
    emailEl?.focus();
    return;
  }
  if (err) { err.textContent = ''; err.style.display = 'none'; }

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });
  // An error here means we could not SEND (rate limit, transport) — never "no such account".
  if (error) { console.warn('[forgotPassword]', error.message); showErr('Could not send the reset email just now. Please try again in a moment.'); return; }

  const label = document.getElementById('lResetEmail');
  if (label) label.textContent = email; // textContent, not innerHTML — this is user input
  document.querySelector('#loginModal form')?.classList.add('is-hidden');
  document.querySelector('#loginModal .switch-link')?.classList.add('is-hidden');
  ['lGoogleBtn','lGoogleOr','lFreshHead'].forEach(id => document.getElementById(id)?.classList.add('is-hidden'));
  document.getElementById('lNotYou')?.classList.remove('is-on');
  document.getElementById('lResetSent')?.classList.add('is-on');
}

// Returns the login modal from the "check your email" panel to the normal form.
function backToLogin() {
  document.getElementById('lResetSent')?.classList.remove('is-on');
  document.querySelector('#loginModal form')?.classList.remove('is-hidden');
  document.querySelector('#loginModal .switch-link')?.classList.remove('is-hidden');
  ['lGoogleBtn','lGoogleOr','lFreshHead'].forEach(id => document.getElementById(id)?.classList.remove('is-hidden'));
  prepLoginModal();
}

// Step 2 of 3: the student clicked the emailed link and is back here.
//
// supabase-js consumes the recovery token from the URL itself and creates a REAL session,
// which means without this screen boot.js would see a valid session and route them happily
// into the feed — password never reset. _recoveryMode stops that routing.
function showResetScreen() {
  if (_recoveryMode) return; // idempotent: hash check and PASSWORD_RECOVERY event can both fire
  _recoveryMode = true;
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('resetPwScreen')?.classList.add('is-on');
  // Drop the token from the address bar so a refresh doesn't replay it.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

function hideResetScreen() {
  _recoveryMode = false;
  document.getElementById('resetPwScreen')?.classList.remove('is-on');
  document.getElementById('studentApp').style.display = '';
  const p = document.getElementById('rpPass'); if (p) p.value = '';
}

// Step 3 of 3: set the new password. The recovery session already proves they control the
// inbox, so on success we take them straight into the app rather than back to a login form.
async function submitNewPassword() {
  const pass = document.getElementById('rpPass').value;
  const err  = document.getElementById('rpErr');
  const btn  = document.getElementById('rpSubmitBtn');
  const showErr = msg => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';

  if (!pass || pass.length < MIN_PASSWORD_LENGTH) { showErr(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return; }

  btn.disabled = true; btn.textContent = 'Updating…';
  const { error } = await supabaseClient.auth.updateUser({ password: pass });
  btn.disabled = false; btn.textContent = 'Update password';
  if (error) { showErr(error.message || 'Could not update your password. The link may have expired — request a new one.'); return; }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) { showErr('Your reset link has expired. Please request a new one.'); return; }
  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).single();
  if (!profile) { showErr('Account not found. Please sign up first.'); return; }

  // A suspended student must not walk back in through the reset door.
  if (profile.status === 'suspended') {
    const { data: sh } = await supabaseClient.from('suspension_history').select('id').eq('profile_id', profile.id).eq('action', 'suspended').order('created_at', { ascending: false }).limit(1).maybeSingle();
    await supabaseClient.auth.signOut();
    hideResetScreen();
    showSuspensionScreen(profile.email || user.email, profile.id, profile.suspension_reason, sh?.id || null);
    return;
  }

  hideResetScreen();
  await enterStudentSession(profile, user.id, 'Password updated');
}

// ---- Continue with Google ----
// The ONLY way to create an account (2026-09-23), and one of two ways to log in. Google checks
// the student's password and proves they own the address, so there is no verification email.
// Supabase then sends them back to this page with a session. The FIRST time, the account has
// no username, password or recorded consent yet, so boot.js shows the finish screen
// (needsGoogleFinish). Every time after that it is an ordinary login.
//
// Caldwell-only, enforced twice:
//   1. Here: `hd` asks Google to offer only accounts on SIGNUP_GOOGLE_DOMAIN. That is a request
//      sent from the browser, so it can be edited out — it is the front door, not the lock.
//   2. The lock: handle_new_user() in the database refuses any other domain while the account
//      is being created. Supabase then sends the student back with an error in the URL, which
//      showGoogleReturnError() turns into plain words.
// Changing the school means changing BOTH (sql/2026-09-23_google_signup.sql).
const SIGNUP_GOOGLE_DOMAIN = 'caldwell.edu';

// Set just before leaving for Google, read once when the page loads again. It is how boot.js
// tells "back from Google" apart from every other page load — including other error links,
// like an expired password-reset link, which must keep their own handling. The value is
// which pop-up they left from, so an error comes back to the same one.
const GOOGLE_RETURN_KEY = 'cn_google_return';

async function signInWithGoogle(from) {
  const errEl = document.getElementById(from === 'signup' ? 'signupErr' : 'loginErr');
  if (errEl) errEl.style.display = 'none';
  try { sessionStorage.setItem(GOOGLE_RETURN_KEY, from); } catch (e) { /* private mode: errors just show less nicely */ }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      // hd: only offer @caldwell.edu accounts (see the note above — a hint, not the lock).
      // prompt: always show the chooser. Without it, a student already signed into a
      // personal Gmail in this browser is sent straight through on the wrong account.
      queryParams: { hd: SIGNUP_GOOGLE_DOMAIN, prompt: 'select_account' }
    }
  });
  // Success leaves this page, so anything after this line only runs on a failure to start.
  if (error && errEl) {
    errEl.textContent = 'Could not reach Google just now. Please try again.';
    errEl.style.display = 'block';
  }
}

// Called once by boot.js, before anything else reads the URL. Returns 'signup' or 'login' if
// this page load is the student coming back from Google (null otherwise), and forgets it so a
// later reload is not.
function takeGoogleReturnFlag() {
  try {
    const v = sessionStorage.getItem(GOOGLE_RETURN_KEY);
    sessionStorage.removeItem(GOOGLE_RETURN_KEY);
    return v === 'signup' || v === 'login' ? v : null;
  } catch (e) { return null; }
}

// Back from Google with no session: something refused. Shows why in the pop-up they left
// from (`from` is 'signup' or 'login'). Returns true if it showed a message.
function showGoogleReturnError(from) {
  const raw = (window.location.hash || '').replace(/^#/, '') + '&' + (window.location.search || '').replace(/^\?/, '');
  const params = new URLSearchParams(raw);
  const code = params.get('error');
  const desc = params.get('error_description') || '';
  if (!code && !desc) return false;

  // Drop the error from the address bar so a refresh does not show it again.
  history.replaceState(null, '', window.location.pathname);

  let msg;
  if (/database error saving new user/i.test(desc)) {
    // handle_new_user() refused a non-Caldwell account. Supabase hides the database's own
    // message and only says "Database error", so this is the likely reason, not a certain one.
    msg = 'Nestrel is for Caldwell students. Please use your @caldwell.edu Google account.';
  } else if (code === 'access_denied') {
    msg = 'Google sign-in was cancelled.';
  } else {
    msg = 'Google sign-in didn\'t work: ' + desc;
  }
  const onSignup = from === 'signup';
  openModal(onSignup ? 'signupModal' : 'loginModal');
  // After openModal: opening a pop-up clears its error box.
  const err = document.getElementById(onSignup ? 'signupErr' : 'loginErr');
  if (err) { err.textContent = msg; err.style.display = 'block'; } // textContent: desc came from the URL
  return true;
}

// A Google account that has not finished signing up: created by Google (not the email form)
// and still without a username. complete_google_signup() sets the username, so this is true
// exactly until the finish screen succeeds, and never for an email-signup account.
function needsGoogleFinish(user, profile) {
  return !profile.username && user?.app_metadata?.provider === 'google';
}

// Suggests a username from the email ("j.smith@caldwell.edu" → "j_smith"), adding a number if
// it is taken. Only a starting point: the student can change it before submitting.
async function suggestUsername(email) {
  let base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').slice(0, 16);
  if (base.length < 3) base = (base + 'student').slice(0, 16);
  for (let i = 0; i < 5; i++) {
    const cand = i === 0 ? base : base + Math.floor(10 + Math.random() * 990);
    if (!USERNAME_RE.test(cand) || RESERVED_USERNAMES.has(cand)) continue;
    const { data } = await supabaseClient.rpc('check_username_available', { username_to_check: cand });
    if (data !== false) return cand;
  }
  return '';
}

// ---- The setup page: steps 2 and 3 of signup (#googleFinishScreen) ----
// Step 2 (required) creates the login: name, username, password, consent. Step 3 (optional)
// personalises the profile and can be skipped. The avatar and name at the top are a live
// preview of what classmates will see, updated as the student types.
let _gfUser = null;            // { id, email, school, schoolName } for the student being set up
let _gfPhotoFile = null;       // a photo picked on step 3, uploaded only when they press Finish
let _gfUsernameTimer = null;

async function showGoogleFinishScreen(user, profile) {
  _gfUser = { id: user.id, email: profile.email || user.email, school: profile.school, schoolName: null };
  _gfPhotoFile = null;
  document.getElementById('studentApp').style.display = 'none';
  document.getElementById('gfEmail').textContent = _gfUser.email;
  document.getElementById('gfFirst').value = profile.first_name || '';
  document.getElementById('gfLast').value  = profile.last_name  || '';
  document.getElementById('gfAvatar').style.backgroundColor = profile.color || '';
  gfShowStep(2);
  document.getElementById('googleFinishScreen').classList.add('is-on');
  // The session token may still be in the address bar; a refresh must not replay it.
  history.replaceState(null, '', window.location.pathname + window.location.search);
  gfPreview();
  // Screen first, then the two lookups: each takes a network round trip, and a moment of
  // empty field beats a blank page. The suggestion only fills a field nobody has typed in.
  const [suggestion] = await Promise.all([suggestUsername(_gfUser.email), loadSchools()]);
  _gfUser.schoolName = (_schoolsList.find(s => s.slug === _gfUser.school) || {}).name || null;
  const u = document.getElementById('gfUsername');
  if (u && !u.value && suggestion) { u.value = suggestion; gfUsernameInput(suggestion); }
  gfPreview();
}

function gfShowStep(n) {
  document.getElementById('gfStepAccount').classList.toggle('is-hidden', n !== 2);
  document.getElementById('gfStepProfile').classList.toggle('is-hidden', n !== 3);
  document.getElementById('gfStepLabel').textContent = 'Step ' + n + ' of 3';
  document.getElementById('gfBar3').classList.toggle('on', n === 3);
  // The photo is part of step 3 only, so it is saved (or skipped) with the rest of it.
  document.getElementById('gfPhotoBtn').disabled = n !== 3;
  document.getElementById('googleFinishScreen').scrollTo(0, 0);
}

// The live preview: display name if they've given one, otherwise their real name, and the
// handle underneath — the same order a classmate sees on their profile.
function gfPreview() {
  const first = document.getElementById('gfFirst').value.trim();
  const last  = document.getElementById('gfLast').value.trim();
  const shown = document.getElementById('gfDisplayName').value.trim() || [first, last].filter(Boolean).join(' ');
  const username = document.getElementById('gfUsername').value.trim().toLowerCase();
  // textContent throughout: every one of these was typed by the student.
  document.getElementById('gfPreviewName').textContent = shown || 'Your name';
  document.getElementById('gfPreviewHandle').textContent =
    [username ? '@' + username : null, _gfUser?.schoolName].filter(Boolean).join(' · ');
  if (!_gfPhotoFile) {
    const initials = ((first[0] || '') + (last[0] || '')).toUpperCase() || '?';
    const av = document.getElementById('gfAvatar');
    paintAvatarEl(av, null, initials, av.style.backgroundColor);
  }
}

// Live "Available" / "Taken" under the username, 400ms after they stop typing. Only a hint:
// submitGoogleFinish() checks again, and the database's unique index has the last word.
function gfUsernameInput(raw) {
  const el  = document.getElementById('gfUsernameStatus');
  const val = String(raw || '').trim().toLowerCase();
  const say = (text, cls) => { el.textContent = text; el.className = 'ap-hint' + (cls ? ' ' + cls : ''); };
  clearTimeout(_gfUsernameTimer);
  gfPreview();
  if (!val) { say('3–20 characters. Letters, numbers, and underscores only.'); return; }
  if (!USERNAME_RE.test(val)) { say('3–20 characters. Letters, numbers, and underscores only.', 'is-bad'); return; }
  if (RESERVED_USERNAMES.has(val)) { say('That username is reserved.', 'is-bad'); return; }
  say('Checking…');
  _gfUsernameTimer = setTimeout(async () => {
    const { data } = await supabaseClient.rpc('check_username_available', { username_to_check: val });
    if (document.getElementById('gfUsername').value.trim().toLowerCase() !== val) return; // they kept typing
    if (data === false) say('Taken — try another.', 'is-bad');
    else say('✓ Available', 'is-ok');
  }, 400);
}

function gfBioCount() {
  document.getElementById('gfBioCount').textContent = document.getElementById('gfBio').value.length + ' / 150';
}

// Same checks as pickAvatar() in media.js, which is wired to the Edit Profile screen.
function pickSetupPhoto(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const isHEIC = file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
  if (isHEIC) { toast('HEIC photos aren\'t supported yet — please choose a JPEG or PNG.'); return; }
  if (!file.type.startsWith('image/')) { toast('Please choose an image file (JPEG, PNG, or WebP).'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('That photo is over 10 MB — please choose a smaller one.'); return; }
  _gfPhotoFile = file;
  paintAvatarEl(document.getElementById('gfAvatar'), URL.createObjectURL(file), null, null);
}

function hideGoogleFinishScreen() {
  document.getElementById('googleFinishScreen').classList.remove('is-on');
  document.getElementById('studentApp').style.display = '';
  ['gfPass', 'gfUsername', 'gfDisplayName', 'gfBio', 'gfPronouns', 'gfMajor', 'gfYear']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('gfAgree').checked = false;
  document.getElementById('gfBeta').checked = false;
  ['gfErr', 'gfProfileErr'].forEach(id => { document.getElementById(id).style.display = 'none'; });
  _gfPhotoFile = null;
  gfShowStep(2);
}

// Step 2 → the account exists. Moves on to step 3 instead of into the app.
async function submitGoogleFinish() {
  const first    = document.getElementById('gfFirst').value.trim();
  const last     = document.getElementById('gfLast').value.trim();
  const username = document.getElementById('gfUsername').value.trim().toLowerCase();
  const pass     = document.getElementById('gfPass').value;
  const err      = document.getElementById('gfErr');
  const btn      = document.getElementById('gfSubmitBtn');
  const label    = btn.querySelector('span');
  const showErr  = msg => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';

  // The rules match the database's: username_format and the unique index on profiles.username.
  if (!first || !last) { showErr('Please enter your first and last name.'); return; }
  if (!username) { showErr('Please choose a username.'); return; }
  if (!USERNAME_RE.test(username)) { showErr('Username must be 3–20 characters: letters, numbers, and underscores only.'); return; }
  if (RESERVED_USERNAMES.has(username)) { showErr('That username is reserved. Please choose another.'); return; }
  if (!pass || pass.length < MIN_PASSWORD_LENGTH) { showErr(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
  if (!document.getElementById('gfAgree').checked) {
    showErr('Please confirm you are 18+ and agree to the Terms and Privacy Policy.');
    return;
  }
  // The beta acknowledgement: this is live, and the student answers for what they do on it.
  if (!document.getElementById('gfBeta').checked) {
    showErr('Please tick the red box to confirm you understand Nestrel is a live beta and that you are responsible for what you post and do.');
    return;
  }
  if (!_gfUser) { showErr('Your Google sign-in has expired. Please cancel and try again.'); return; }

  btn.disabled = true; label.textContent = 'Creating your account…';
  try {
    const { data: usernameFree } = await supabaseClient.rpc('check_username_available', { username_to_check: username });
    if (usernameFree === false) { showErr('That username is already taken. Please choose another.'); return; }

    // Password BEFORE the profile. If this step fails, the profile is still unfinished and
    // the student simply sees this screen again. The other order could leave a finished
    // profile with no password — and this screen, which is the only place to set one,
    // would never show again.
    const { error: pwErr } = await supabaseClient.auth.updateUser({ password: pass });
    if (pwErr) { showErr(pwErr.message || 'Could not set your password. Please try again.'); return; }

    // Consent's timestamp is set by the database with now(); only the VERSION is sent.
    // A time supplied by the browser is a number the sender picked; a server clock isn't.
    // Major and year are saved on step 3 instead, with the rest of the profile.
    const { error } = await supabaseClient.rpc('complete_google_signup', {
      p_first: first, p_last: last, p_username: username,
      p_major: null, p_year: null, p_terms_version: TERMS_VERSION
    });
    if (error) {
      // 23505 = unique violation: someone took the username between the check and now.
      showErr(error.code === '23505' ? 'That username was just taken. Please choose another.' : (error.message || 'Could not finish signing up. Please try again.'));
      return;
    }

    logEvent('student_signup', { targetType: 'student', targetId: _gfUser.id, targetLabel: first + ' ' + last, school: _gfUser.school });
    document.getElementById('gfPass').value = '';
    gfShowStep(3);
  } finally {
    btn.disabled = false; label.textContent = 'Create my account';
  }
}

// Step 3 → saves whatever they filled in, then into the app. Mirrors saveProfile() in
// profile.js, minus the listing-name refresh: a brand-new account has no listings yet.
async function submitSetupProfile() {
  const err   = document.getElementById('gfProfileErr');
  const btn   = document.getElementById('gfProfileBtn');
  const label = btn.querySelector('span');
  const showErr = msg => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';
  if (!_gfUser) { showErr('Your session has expired. Please refresh the page.'); return; }

  const updates = {
    display_name: document.getElementById('gfDisplayName').value.trim() || null,
    bio:          document.getElementById('gfBio').value.trim() || null,
    pronouns:     document.getElementById('gfPronouns').value.trim() || null,
    major:        document.getElementById('gfMajor').value.trim() || null,
    year:         document.getElementById('gfYear').value || null
  };

  btn.disabled = true; label.textContent = 'Saving…';
  try {
    if (_gfPhotoFile) {
      try {
        const blob = await resizeImage(_gfPhotoFile);
        updates.avatar_url = await uploadAvatar(blob, _gfUser.id);
      } catch (e) { console.error('[setup photo upload]', e); showErr('Could not upload your photo — try again, or skip it for now.'); return; }
    }
    const { error } = await supabaseClient.from('profiles').update(updates).eq('id', _gfUser.id);
    if (error) { showErr('Could not save — ' + error.message); return; }
    await finishSetup();
  } finally {
    btn.disabled = false; label.textContent = 'Finish';
  }
}

async function skipSetupProfile() { await finishSetup(); }

async function finishSetup() {
  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', _gfUser.id).single();
  if (!profile) { toast('Your account is ready, but could not be loaded. Please refresh the page.'); return; }
  hideGoogleFinishScreen();
  _gfUser = null;
  await enterStudentSession(profile, profile.id, 'Welcome to Nestrel, ' + (profile.display_name || profile.first_name) + '!');
}

// Only reachable from step 2. The account already exists (Google created it), but without a
// username it can't be used, and this screen shows again next time they continue with Google.
async function cancelGoogleFinish() {
  await supabaseClient.auth.signOut();
  _gfUser = null;
  hideGoogleFinishScreen();
  showPage('home');
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
  msg.innerHTML = icon('check',13) + ' Sent! Check your inbox (and spam).';
  _resendCooldown = 60; // client-side cooldown so the button can't be spammed
  const tick = () => {
    if (_resendCooldown <= 0) { clearInterval(_resendTimer); btn.disabled = false; btn.textContent = 'Resend email'; return; }
    btn.textContent = `Resend in ${_resendCooldown}s`;
    _resendCooldown--;
  };
  tick();
  _resendTimer = setInterval(tick, 1000);
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

// Shared post-authentication student setup — everything that must happen once a
// student is confirmed signed in, kept in one place so login and signup can't drift.
async function enterStudentSession(profile, userId, welcomeMsg) {
  rememberUser(profile);
  sUser = {
    id: userId, first: profile.first_name, last: profile.last_name,
    name: profile.first_name + ' ' + profile.last_name,
    display_name: profile.display_name || null, email: profile.email,
    username: profile.username || null, bio: profile.bio || null, pronouns: profile.pronouns || null,
    major: profile.major, year: profile.year, initials: profile.initials, color: profile.color,
    avatar_url: profile.avatar_url || null, created_at: profile.created_at || null,
    school: profile.school || 'caldwell',
    // Read-only here. Nothing in the student UI ever writes these back; they exist so the
    // profile page can show a person what they agreed to and when.
    terms_accepted_at: profile.terms_accepted_at || null, terms_version: profile.terms_version || null
  };
  updateSNav();
  if (welcomeMsg) toast(welcomeMsg);
  if (applyMaintenance()) return;
  // Loaded BEFORE the first render, because every listing card draws a star and a card painted
  // without the set shows an empty one for something the student already saved. Correcting it
  // afterwards would flip stars on under their eyes.
  await Promise.all([loadListings(), loadFavorites(true)]);
  // Return-to-intent. A student who scanned a poster while signed out was sent to login;
  // this is where they get sent back to THAT EVENT rather than dumped on the home feed,
  // which is the single most likely thing to make a QR feel broken at a real door.
  // Placed in enterStudentSession() because it is the one path login and signup share.
  if (!evResumeIntent()) showPage('feed');
  checkStudentNotifications(userId);
  startGlobalMsgListener(userId);
  startNotifListener(userId);
  startProfileListener(userId);
}

// The thin broadcast bar that used to run across the top of every page (loadStudentBroadcasts,
// dismissBcast) was removed 2026-09-24. Official announcements now appear on Home — as
// "Official" cards in Campus news, and type 'warning' as the urgent banner — see js/feed.js.

// ── Notifications ────────────────────────────────────────────────────────────
// Rewritten 2026-09-04. The old version fetched ONLY unread rows, showed them, and marked
// them read in the same breath. So a student who got the pop-up and dismissed it without
// reading had permanently lost the notice that their listing was removed: there was no bell,
// no history, and the next fetch asked for unread rows only, of which there were now none.
//
// Now the recent list is kept whatever its read state, a bell in the nav carries the unread
// count, and "read" is applied AFTER rendering rather than as a side effect of it. Marking
// read on display is fine once the history is reachable — nothing is destroyed, only dimmed.
//
// Delivery is still passive: a student who never opens the app is still never told. That is
// A1 in docs/nestrel-campus-engagement-plan.md and it needs an email layer, which needs a
// backend this project does not have yet.
let _notifCache = [];

async function loadNotifications(userId) {
  const id = userId || getEffectiveUser()?.id;
  if (!id) { _notifCache = []; updateNotifBadge(); return; }
  const { data, error } = await supabaseClient
    .from('notifications')
    .select('id, message, type, read, created_at')
    .eq('profile_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  // A failed load and an empty inbox are different things. Leaving the cache alone on error
  // keeps the badge showing what was last known true rather than silently reading zero.
  if (error) { console.error('[loadNotifications]', error.message); return; }
  _notifCache = data || [];
  updateNotifBadge();
}

// The badge is the Inbox button's, shared with unread chats (paintInboxBadge in js/inbox.js).
function updateNotifBadge() {
  if (typeof paintInboxBadge === 'function') paintInboxBadge();
}

function renderNotifications() {
  const title = document.getElementById('notifModalTitle');
  const body  = document.getElementById('notifModalBody');
  if (!title || !body) return;

  const unread = _notifCache.filter(n => !n.read).length;
  title.textContent = unread ? `Notifications · ${unread} new` : 'Notifications';

  // esc() on the message, which the old version omitted. These messages embed listing titles
  // -- `Your listing "${l.title}" was removed` in js/admin.js -- and a listing title is
  // student-authored text. Only the poster receives their own title back, so this was
  // self-inflicted at worst, but rendering user input as HTML is not a habit worth keeping
  // anywhere. See tests/xss-test.html.
  body.innerHTML = _notifCache.length
    ? _notifCache.map(n => `
        <div class="notif-row${n.read ? '' : ' notif-unread'}">
          <div class="notif-msg">${esc(n.message)}</div>
          <div class="notif-time">${fmtDate(n.created_at)}</div>
        </div>`).join('')
    : '<div class="notif-empty">Nothing yet. Updates about your listings and appeals appear here.</div>';
}

async function markNotificationsRead() {
  const ids = _notifCache.filter(n => !n.read).map(n => n.id);
  if (!ids.length) return;
  const { error } = await supabaseClient.from('notifications').update({ read: true }).in('id', ids);
  if (error) { console.error('[markNotificationsRead]', error.message); return; }
  _notifCache.forEach(n => { n.read = true; });
  updateNotifBadge();
}

// The bell opens the Inbox on its Activity tab (2026-09-24; it used to open a pop-up list). The
// Activity feed is js/inbox.js; it marks things read when they are tapped, or all at once with ✓.
function openNotifications() { openInbox('activity'); }
// Called at boot and after login. Pops up only when something is genuinely unread; otherwise
// it just refreshes the badge and stays out of the way.
async function checkStudentNotifications(userId) {
  await loadNotifications(userId);
  // The rest of Activity (events starting, club posts…) is worked out in the background, for the badge.
  if (typeof activityRefresh === 'function') activityRefresh(false);
  if (!_notifCache.some(n => !n.read)) return;
  renderNotifications();
  openModal('notifModal');
  await markNotificationsRead();
}

function dismissNotifications() { closeModal('notifModal'); }

async function aNotifyStudent(profileId, type, message) {
  const { error } = await supabaseClient.from('notifications')
    .insert({ profile_id: profileId, type, message, read: false });
  // Fire-and-forget until 2026-09-04: this insert was never awaited and its error never
  // read, so a rejected write failed in total silence -- the student simply never heard
  // that their listing was removed, and nothing anywhere said why. That is the one thing
  // this path must not do, because the student cannot tell "nothing happened" from
  // "nobody told me". Callers still do not await; the point is the console line.
  if (error) console.error('[aNotifyStudent] insert failed:', error.message, { profileId, type });
}

// ============================================================
// RETURNING-USER HINT
// ============================================================
// A DISPLAY hint and nothing more: first name + email, so a student who has signed in
// on this device before is greeted with "Welcome back, Kal" instead of being pitched the
// "Join us" landing they already acted on.
//
// This is NEVER a credential. No token, no password, no Supabase session object —
// supabase-js persists the real session itself (under its own `sb-…` key) and must stay
// the only thing that does. Losing or clearing this key costs a greeting, nothing else:
// it can't sign anyone in, and every screen still checks the real session.
const PRIOR_USER_KEY = 'cn_prior_user';

// Pass the profile row. Since 2026-09-23 the hint also keeps what the "welcome back" header
// draws — initials, colour, photo, username, school — and still nothing that could sign
// anyone in. Everything here is already on the student's public profile except the email.
function rememberUser(profile, emailFallback) {
  const first = profile?.first_name || null;
  const email = profile?.email || emailFallback || null;
  if (!first && !email) return;
  try {
    localStorage.setItem(PRIOR_USER_KEY, JSON.stringify({
      first, email,
      initials: profile?.initials || null, color: profile?.color || null,
      avatar_url: profile?.avatar_url || null, username: profile?.username || null,
      school: profile?.school || null
    }));
  } catch (e) { /* private mode / quota — a greeting is optional, never break sign-in over it */ }
}

function getPriorUser() {
  try {
    const p = JSON.parse(localStorage.getItem(PRIOR_USER_KEY) || 'null');
    return (p && (p.first || p.email)) ? p : null;
  } catch (e) { return null; } // corrupt value behaves as "nobody known", never as an error
}

function forgetPriorUser() {
  try { localStorage.removeItem(PRIOR_USER_KEY); } catch (e) {}
}

// Called by openModal() for every route into the login modal, so the greeting can't
// depend on which of the eight buttons you pressed to get here.
function prepLoginModal() {
  // Always restore the form: reopening the modal after requesting a reset link must not
  // leave the "check your email" panel showing with no way back to logging in.
  document.getElementById('lResetSent')?.classList.remove('is-on');
  document.querySelector('#loginModal form')?.classList.remove('is-hidden');
  document.querySelector('#loginModal .switch-link')?.classList.remove('is-hidden');
  ['lGoogleBtn','lGoogleOr','lFreshHead'].forEach(id => document.getElementById(id)?.classList.remove('is-hidden'));
  const prior = getPriorUser();
  if (prior) applyWelcomeBack(prior); else resetLoginModal();
}

function applyWelcomeBack(prior) {
  const title = document.getElementById('loginModalTitle');
  // textContent, not innerHTML — this string came out of storage, so it is treated as text.
  if (title) title.textContent = prior.first ? `Welcome back, ${prior.first}` : 'Welcome back';
  const emailInput = document.getElementById('lEmail');
  if (emailInput && prior.email) emailInput.value = prior.email; // only the password left to type
  document.getElementById('lNotYou')?.classList.add('is-on');
  // The "known device" look hides the email field, so it needs an email to have filled in.
  if (!prior.email) return;
  document.getElementById('loginModal').classList.add('is-known');
  const initials = prior.initials || (prior.first || '?')[0].toUpperCase();
  paintAvatarEl(document.getElementById('lKnownAvatar'), prior.avatar_url, initials, prior.color || '');
  // A hint saved before 2026-09-23 has no username; the email is the honest fallback.
  const handle = document.getElementById('lKnownHandle');
  const setHandle = schoolName => {
    handle.textContent = prior.username
      ? ['@' + prior.username, schoolName].filter(Boolean).join(' · ')
      : prior.email;
  };
  setHandle(null);
  if (prior.school) loadSchools().then(() => setHandle((_schoolsList.find(s => s.slug === prior.school) || {}).name));
}

function resetLoginModal() {
  const title = document.getElementById('loginModalTitle');
  if (title) title.textContent = 'Welcome back';
  document.getElementById('loginModal')?.classList.remove('is-known');
  document.getElementById('lNotYou')?.classList.remove('is-on');
  const email = document.getElementById('lEmail'); if (email) email.value = '';
  const pass  = document.getElementById('lPass');  if (pass)  pass.value  = '';
  const err   = document.getElementById('loginErr');
  if (err) { err.textContent = ''; err.style.display = 'none'; }
}

// The ONLY thing that clears the hint. Logging out deliberately keeps it, so a student on
// their own phone is still greeted next time; this is the escape hatch for a shared campus
// computer, or for signing in as a different person.
function signInAsSomeoneElse() {
  forgetPriorUser();
  resetLoginModal();
  document.getElementById('lEmail')?.focus();
}

function updateSNav() {
  const u = getEffectiveUser();
  document.getElementById('navGuest').style.display = u ? 'none' : 'flex';
  const nu = document.getElementById('navUser');
  nu.style.display = u ? 'flex' : 'none';
  // Signed in: on desktop the nav becomes the left sidebar (styles.css, DESKTOP SIDEBAR).
  // Signed out keeps the top bar with Log in / Sign up.
  document.body.classList.toggle('s-signed', !!u);
  if (u) {
    const navAv = document.getElementById('navAvatar');
    navAv.style.backgroundColor = u.color; // not the `background` shorthand — see paintAvatarEl
    paintAvatarEl(navAv, u.avatar_url, u.initials, u.color);
    // The phone's You tab shows the same avatar (the top one is hidden on phones).
    const tabAv = document.getElementById('mTabAvatar');
    if (tabAv) { tabAv.style.backgroundColor = u.color; paintAvatarEl(tabAv, u.avatar_url, u.initials, u.color); }
    document.getElementById('mtab-you')?.classList.add('has-avatar');
    const youName = document.getElementById('navYouName');
    if (youName) youName.textContent = u.display_name || u.first || 'You';
    const backBtn = document.getElementById('backToAdminBtn');
    if (backBtn) backBtn.style.display = adminPreviewMode ? 'inline-flex' : 'none';
    // Officers get a route into the org console from their own profile. Not awaited: it is a
    // button, and updateSNav() is called from synchronous paths that must not block on a query.
    renderOrgConsoleEntry();
  } else {
    document.getElementById('mtab-you')?.classList.remove('has-avatar');
  }
}

function getCNIdentity() {
  return {
    name: localStorage.getItem('cn_official_name') || 'Nestrel',
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
