// ============================================================
// PROFILE
// School picker, waitlist, username/email availability, viewing a public profile, and editing your own.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

const RESERVED_USERNAMES = new Set(['admin','caldwellnest','nestbot','support','official','mod','moderator','help','staff']);
const USERNAME_RE = /^[a-z0-9][a-z0-9_]{2,19}$/;

// SCHOOL PICKER ─────────────────────────────────────────────
// Schools change rarely, so the list is cached — but not forever. It used to be cached for the
// whole session ("if we have any, never ask again"), so a school added while a student had the
// tab open stayed invisible until a full reload — and the distance/scope filter silently had no
// coordinates for it. The cache now expires, so it self-heals within a few minutes.
const SCHOOLS_TTL_MS = 5 * 60 * 1000;
let _schoolsFetchedAt = 0;

async function loadSchools({ force = false } = {}) {
  const fresh = _schoolsList.length > 0 && (Date.now() - _schoolsFetchedAt) < SCHOOLS_TTL_MS;
  if (fresh && !force) return;
  const { data, error } = await supabaseClient.from('schools').select('id, slug, name, lat, lng').order('name');
  // A failed fetch must NOT wipe a good list — `data` is null on error, and the old code assigned
  // `data || []`, blanking every school (and the distance filter with it) on one transient blip.
  if (error) { console.error('[loadSchools] failed, keeping the cached list:', error.message); return; }
  _schoolsList = data || [];
  _schoolsFetchedAt = Date.now();
}

async function openSchoolDropdown() {
  await loadSchools();
  filterSchools(document.getElementById('schoolSearch')?.value || '');
}

function filterSchools(query) {
  const dropdown = document.getElementById('schoolDropdown');
  if (!dropdown) return;
  const q = query.trim().toLowerCase();
  const matches = q ? _schoolsList.filter(s => s.name.toLowerCase().includes(q)) : _schoolsList;
  if (!matches.length) {
    dropdown.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:var(--text-muted);">No schools found</div>`;
  } else {
    dropdown.innerHTML = matches.map(s =>
      `<div class="school-option" onclick="selectSchoolById('${s.id}')" style="display:flex;align-items:center;gap:7px">${ico('school', 13)} ${esc(s.name)}</div>`
    ).join('');
  }
  dropdown.style.display = 'block';
}

function selectSchoolById(id) {
  const school = _schoolsList.find(s => String(s.id) === String(id));
  if (school) selectSchool(school);
}

function selectSchool(school) {
  _selectedSchool = school;
  if (!_schoolsList.find(s => s.id === school.id)) _schoolsList.push(school);
  const searchEl = document.getElementById('schoolSearch');
  const dropEl   = document.getElementById('schoolDropdown');
  const badgeEl  = document.getElementById('selectedSchoolBadge');
  const nameEl   = document.getElementById('selectedSchoolName');
  if (searchEl) searchEl.style.display = 'none';
  if (dropEl)   dropEl.style.display   = 'none';
  if (badgeEl)  badgeEl.style.display  = 'flex';
  if (nameEl)   nameEl.textContent     = school.name;
  const formEl = document.getElementById('signupMainForm');
  if (formEl) formEl.style.display = 'block';
  const emailEl    = document.getElementById('sEmail');
  const statusEl   = document.getElementById('emailStatus');
  const mismatchEl = document.getElementById('emailMismatch');
  if (emailEl)    emailEl.value = '';
  if (statusEl)   statusEl.textContent = '';
  if (mismatchEl) mismatchEl.style.display = 'none';
}

function clearSchool() {
  _selectedSchool = null;
  const searchEl = document.getElementById('schoolSearch');
  const badgeEl  = document.getElementById('selectedSchoolBadge');
  const formEl   = document.getElementById('signupMainForm');
  if (searchEl) { searchEl.style.display = ''; searchEl.value = ''; }
  if (badgeEl)  badgeEl.style.display = 'none';
  if (formEl)   formEl.style.display  = 'none';
}

function showWaitlistPanel() {
  document.getElementById('schoolPickerGroup').style.display = 'none';
  document.getElementById('signupMainForm').style.display    = 'none';
  document.getElementById('waitlistPanel').style.display     = 'block';
  const existingEmail = document.getElementById('sEmail')?.value?.trim();
  if (existingEmail) { const w = document.getElementById('wEmail'); if (w) w.value = existingEmail; }
}

function hideWaitlistPanel() {
  document.getElementById('waitlistPanel').style.display    = 'none';
  document.getElementById('schoolPickerGroup').style.display = 'block';
  if (_selectedSchool) document.getElementById('signupMainForm').style.display = 'block';
}

function resetSignupModal() {
  _selectedSchool = null;
  ['sFirst','sLast','sUsername','sEmail','sMajor','sPass','wEmail','wSchoolName']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const sYear = document.getElementById('sYear'); if (sYear) sYear.value = '';
  const wRole = document.getElementById('wRole'); if (wRole) wRole.value = '';
  // Consent must be re-given every time the form is presented fresh, so this is cleared
  // like any other field. It is NOT in the list above because that list uses .value, and
  // setting .value on a checkbox does nothing to its ticked state — you need .checked.
  // Adding 'sAgree' there would look right and silently reset nothing.
  const sAgree = document.getElementById('sAgree'); if (sAgree) sAgree.checked = false;
  const searchEl = document.getElementById('schoolSearch');
  if (searchEl) { searchEl.style.display = ''; searchEl.value = ''; }
  [['schoolDropdown','none'],['selectedSchoolBadge','none'],['signupMainForm','none'],
   ['waitlistPanel','none'],['schoolPickerGroup','block'],['waitlistSuccess','none']]
    .forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.style.display = v; });
  ['emailStatus','usernameStatus'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
  ['signupErr','emailMismatch','waitlistErr'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const wb = document.getElementById('waitlistSubmitBtn');
  if (wb) { wb.disabled = false; wb.textContent = 'Notify me when Nestrel launches here →'; }
}

async function submitWaitlist() {
  const email      = document.getElementById('wEmail').value.trim().toLowerCase();
  const schoolName = document.getElementById('wSchoolName').value.trim();
  const role       = document.getElementById('wRole').value;
  const errEl      = document.getElementById('waitlistErr');
  const successEl  = document.getElementById('waitlistSuccess');
  const btn        = document.getElementById('waitlistSubmitBtn');
  errEl.style.display = 'none'; successEl.style.display = 'none';
  if (!email)      { errEl.textContent = 'Please enter your email.';       errEl.style.display = 'block'; return; }
  if (!schoolName) { errEl.textContent = 'Please enter your school name.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Submitting…';
  const { error } = await supabaseClient.from('school_interest').insert({ email, school_name: schoolName, role: role || null });
  if (error) {
    errEl.textContent = 'Something went wrong. Please try again.'; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Notify me when Nestrel launches here →';
  } else {
    successEl.textContent = '✓ You\'re on the list! We\'ll reach out when Nestrel comes to ' + schoolName + '.';
    successEl.style.display = 'block';
    btn.textContent = '✓ You\'re on the waitlist';
    ['wEmail','wSchoolName'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('wRole').value = '';
  }
}

// The single authoritative answer to "may this email sign up for this school?".
//
// Both callers use THIS: the live typeahead below for its hint, and doSignup() as the
// actual gate. Writing the rule twice is how two copies drift apart — the same trap the
// audit flagged between isListingLive() and the visible_listings view.
//
// Returns { ok, code, message, school }. Never throws, never touches the DOM — the caller
// decides how loudly to say it. Codes: empty | malformed | not_edu | unknown_domain |
// wrong_school | lookup_failed | ok.
async function validateSchoolEmail(rawEmail, selectedSchool) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return { ok: false, code: 'empty', message: 'Please enter your university email.' };

  const at = email.indexOf('@');
  const domain = at > 0 ? email.slice(at + 1) : '';
  // A second @ means it is not a single valid address, whatever the rest looks like.
  if (!domain || !domain.includes('.') || email.indexOf('@', at + 1) !== -1) {
    return { ok: false, code: 'malformed', message: 'Please enter a valid email address.' };
  }
  if (!domain.endsWith('.edu')) {
    return { ok: false, code: 'not_edu', message: 'Please use your university email address (ending in .edu).' };
  }

  const { data: domainRow, error } = await supabaseClient
    .from('school_domains')
    .select('school_id, schools(id, slug, name)')
    .eq('domain', domain)
    .maybeSingle();

  // Fail CLOSED. A gate that swings open whenever the database is unreachable is not a
  // gate — and an outage is exactly when nobody is watching. The old code ignored `error`
  // entirely, so a network blip was indistinguishable from "unrecognized domain".
  if (error) {
    console.warn('[validateSchoolEmail] domain lookup failed:', error.message);
    return { ok: false, code: 'lookup_failed', message: 'Could not verify your email domain just now. Please try again.' };
  }
  if (!domainRow || !domainRow.schools) {
    return { ok: false, code: 'unknown_domain', message: "We don't recognize that .edu domain yet." };
  }

  const matched = domainRow.schools;
  if (selectedSchool && matched.slug !== selectedSchool.slug) {
    return { ok: false, code: 'wrong_school', message: `That looks like a ${matched.name} email.`, school: matched };
  }
  return { ok: true, code: 'ok', school: matched };
}

async function checkEmailAvailability(raw) {
  const statusEl   = document.getElementById('emailStatus');
  const mismatchEl = document.getElementById('emailMismatch');
  const val = raw.trim().toLowerCase();
  clearTimeout(_emailTimer);
  statusEl.textContent = '';
  if (mismatchEl) mismatchEl.style.display = 'none';
  if (!val) return;

  _emailTimer = setTimeout(async () => {
    statusEl.textContent = '…'; statusEl.style.color = 'var(--text-muted)';
    const verdict = await validateSchoolEmail(val, _selectedSchool);

    // A half-typed address is not an error — it is someone still typing. Only the
    // finished-looking failures get said out loud.
    if (verdict.code === 'empty' || verdict.code === 'malformed') { statusEl.textContent = ''; return; }
    if (verdict.code === 'not_edu')        { statusEl.textContent = 'Must be a .edu email';     statusEl.style.color = 'var(--danger)'; return; }
    if (verdict.code === 'unknown_domain') { statusEl.textContent = 'Unrecognized .edu domain'; statusEl.style.color = 'var(--danger)'; return; }
    if (verdict.code === 'lookup_failed')  { statusEl.textContent = 'Could not check just now'; statusEl.style.color = 'var(--text-muted)'; return; }

    if (verdict.code === 'wrong_school') {
      const matched = verdict.school;
      statusEl.textContent = '';
      if (!_schoolsList.find(s => s.id === matched.id)) _schoolsList.push(matched);
      if (mismatchEl) {
        mismatchEl.innerHTML = `That looks like a <strong>${esc(matched.name)}</strong> email. Did you mean to pick ${esc(matched.name)}? <a onclick="selectSchoolById('${matched.id}')" style="color:var(--brand);cursor:pointer;font-weight:600;">Switch &#8594;</a>`;
        mismatchEl.style.display = 'block';
      }
      return;
    }

    const { data } = await supabaseClient.rpc('check_email_available', { email_to_check: val });
    if (data === false) { statusEl.textContent = '✗ already registered'; statusEl.style.color = 'var(--danger)'; }
    else { statusEl.textContent = '✓'; statusEl.style.color = 'var(--success)'; }
  }, 400);
}

async function checkUsernameAvailability(raw) {
  const statusEl = document.getElementById('usernameStatus');
  const val = raw.trim().toLowerCase();
  clearTimeout(_usernameTimer);
  if (!val) { statusEl.textContent = ''; return; }
  if (!USERNAME_RE.test(val) || RESERVED_USERNAMES.has(val)) {
    statusEl.textContent = '✗'; statusEl.style.color = 'var(--danger)'; return;
  }
  statusEl.textContent = '…'; statusEl.style.color = 'var(--text-muted)';
  _usernameTimer = setTimeout(async () => {
    const { data } = await supabaseClient.rpc('check_username_available', { username_to_check: val });
    if (data === false) { statusEl.textContent = '✗ taken'; statusEl.style.color = 'var(--danger)'; }
    else { statusEl.textContent = '✓ available'; statusEl.style.color = 'var(--success)'; }
  }, 400);
}

async function viewStudentProfile(profileId) {
  if (!profileId) return;
  const eu = getEffectiveUser();
  if (eu && profileId === eu.id) { closeModal('detailModal'); showPage('profile'); return; }

  const body = document.getElementById('pubProfileBody');
  body.innerHTML = '<div style="text-align:center;padding:32px 0;color:var(--text-faint);font-size:14px">Loading…</div>';
  // The listing detail has to close first, or the profile opens UNDERNEATH it. Both are
  // .modal-overlay with z-index 500, and when z-index ties the winner is whichever comes
  // later in the HTML -- #detailModal sits at index.html:1344 and #pubProfileModal at 1172,
  // so the listing always paints over the profile no matter which was opened last. The bug
  // looked like "tapping the avatar does nothing"; the modal was open the whole time.
  //
  // The branch a few lines above already does this when you tap your OWN avatar. This is the
  // same thing for everyone else. closeModal() on an already-closed modal is a no-op, so this
  // stays correct when the profile is opened from somewhere other than a listing.
  switchModal('detailModal', 'pubProfileModal');

  const [{ data: p }, { data: listings }, { data: books }] = await Promise.all([
    supabaseClient.from('public_profiles').select('first_name, last_name, display_name, username, bio, pronouns, year, initials, color, avatar_url, created_at').eq('id', profileId).single(),
    supabaseClient.from('listings').select('id, title, price, category, details, emoji, status, lifecycle_status, expires_at, created_at, photo_urls').eq('poster_id', profileId).eq('status', 'approved').order('created_at', { ascending: false }),
    supabaseClient.from('book_listings').select('*').eq('poster_id', profileId).eq('status', 'approved').order('created_at', { ascending: false })
  ]);

  if (!p) { body.innerHTML = '<div style="text-align:center;padding:32px 0;color:var(--text-faint);font-size:14px">This profile no longer exists.</div>'; return; }

  const displayName = p.display_name || p.first_name; // first-name-only privacy default (matches listing cards)
  const joined = p.created_at ? new Date(p.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : null;
  const normalised = (listings || []).map(l => ({
    id: l.id, title: l.title, rent: l.price, category: l.category,
    emoji: l.emoji || CATEGORY_EMOJI[l.category] || '🏠',
    status: l.status, lifecycle_status: l.lifecycle_status, expires_at: l.expires_at, created_at: l.created_at,
    photo_urls: l.photo_urls || []
  })).concat((books || []).map(bookAsListing))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  // Live items shown normally; sold/claimed ones move to a badged, dimmed "Sold" group
  // (the honest-marketplace behavior — outcomes visible, nothing vanishes mysteriously).
  // Withdrawn and expired stay fully hidden from the public view.
  const liveItems = normalised.filter(isListingLive);
  const soldItems = normalised.filter(l => l.lifecycle_status === 'sold');
  const listingsHtml = `<div style="font-weight:600;font-size:14px;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">Listings</div>${renderListingGrid(liveItems, false)}`
    + (soldItems.length ? `<div style="font-weight:600;font-size:14px;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase;margin:16px 0 10px">Sold</div><div style="opacity:.72">${renderListingGrid(soldItems, true)}</div>` : '');

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
      <div style="width:60px;height:60px;border-radius:50%;background:${escAttr(p.color)};background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;color:#fff;flex-shrink:0">${p.avatar_url ? `<img src="${escAttr(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="">` : esc(p.initials)}</div>
      <div>
        <div style="font-family:'DM Serif Display',serif;font-size:20px;line-height:1.2">${esc(displayName)}</div>
        ${p.username ? `<div style="font-size:13px;color:var(--brand);font-weight:500;margin-top:2px">@${esc(p.username)}</div>` : ''}
        <div class="edu-badge" style="margin-top:6px">&#10003; .edu verified</div>
      </div>
    </div>
    ${p.bio ? `<div style="font-size:14px;color:var(--text);line-height:1.6;margin-bottom:14px">${esc(p.bio)}</div>` : ''}
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      ${p.year ? `<span style="font-size:12px;background:var(--brand-pale);color:var(--brand);padding:4px 10px;border-radius:20px;font-weight:500">${esc(p.year)}</span>` : ''}
      ${p.pronouns ? `<span style="font-size:12px;background:var(--surface);border:1px solid var(--border);color:var(--text-muted);padding:4px 10px;border-radius:20px">${esc(p.pronouns)}</span>` : ''}
      ${joined ? `<span style="font-size:12px;background:var(--surface);border:1px solid var(--border);color:var(--text-muted);padding:4px 10px;border-radius:20px">Joined ${joined}</span>` : ''}
    </div>
    ${listingsHtml}`;
}

function openEditProfile() {
  const u = getEffectiveUser(); if (!u) return;
  document.getElementById('epDisplayName').value = u.display_name || '';
  document.getElementById('epUsername').value = u.username || '';
  document.getElementById('epBio').value = u.bio || '';
  document.getElementById('epBioCount').textContent = (u.bio || '').length;
  document.getElementById('epPronouns').value = u.pronouns || '';
  document.getElementById('epMajor').value = u.major || '';
  document.getElementById('epYear').value = u.year || '';
  document.getElementById('epUsernameStatus').textContent = '';
  _pendingAvatarFile = null;
  _avatarRemoved = false;
  paintAvatarEl(document.getElementById('epAvatarPreview'), u.avatar_url, u.initials, u.color);
  document.getElementById('epAvatarRemoveBtn').style.display = u.avatar_url ? 'inline' : 'none';
  const err = document.getElementById('editProfileErr');
  err.textContent = ''; err.style.display = 'none';
  openModal('editProfileModal');
}

let _epUsernameTimer = null;
async function checkEditUsernameAvailability(raw) {
  const statusEl = document.getElementById('epUsernameStatus');
  const val = raw.trim().toLowerCase();
  clearTimeout(_epUsernameTimer);
  statusEl.textContent = '';
  if (!val) return;
  const u = getEffectiveUser();
  if (u && val === u.username) { statusEl.textContent = '✓'; statusEl.style.color = 'var(--success)'; return; }
  if (!USERNAME_RE.test(val) || RESERVED_USERNAMES.has(val)) { statusEl.textContent = '✗'; statusEl.style.color = 'var(--danger)'; return; }
  statusEl.textContent = '…'; statusEl.style.color = 'var(--text-muted)';
  _epUsernameTimer = setTimeout(async () => {
    const { data } = await supabaseClient.rpc('check_username_available', { username_to_check: val });
    if (data === false) { statusEl.textContent = '✗ taken'; statusEl.style.color = 'var(--danger)'; }
    else { statusEl.textContent = '✓ available'; statusEl.style.color = 'var(--success)'; }
  }, 400);
}

async function saveProfile() {
  const u = getEffectiveUser(); if (!u) return;
  const displayName = document.getElementById('epDisplayName').value.trim();
  const username    = document.getElementById('epUsername').value.trim().toLowerCase();
  const bio         = document.getElementById('epBio').value.trim();
  const pronouns    = document.getElementById('epPronouns').value.trim();
  const major       = document.getElementById('epMajor').value.trim();
  const year        = document.getElementById('epYear').value;
  const err         = document.getElementById('editProfileErr');
  const showErr     = msg => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';

  if (username && !USERNAME_RE.test(username)) { showErr('Username must be 3–20 characters: letters, numbers, and underscores only.'); return; }
  if (username && RESERVED_USERNAMES.has(username)) { showErr('That username is reserved. Please choose another.'); return; }
  if (username && username !== u.username) {
    const { data } = await supabaseClient.rpc('check_username_available', { username_to_check: username });
    if (data === false) { showErr('That username is already taken.'); return; }
  }

  // Handle the avatar: upload a newly picked one, or clear it if removed.
  // avatarUrl stays undefined when nothing changed, so we don't overwrite the existing value.
  // The OLD file is not touched here — it is deleted further down, only after the
  // profile row has successfully been pointed away from it.
  const oldAvatarUrl = u.avatar_url || null;
  let avatarUrl;
  if (_pendingAvatarFile) {
    try {
      const blob = await resizeImage(_pendingAvatarFile);
      avatarUrl = await uploadAvatar(blob, u.id);
    } catch (e) { console.error('[avatar upload]', e); showErr('Could not upload photo — please try again.'); return; }
  } else if (_avatarRemoved) {
    avatarUrl = null;
  }

  const updates = {
    display_name: displayName || null, username: username || null,
    bio: bio || null, pronouns: pronouns || null,
    major: major || null, year: year || null
  };
  if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;
  const { error } = await supabaseClient.from('profiles').update(updates).eq('id', u.id);
  if (error) { showErr('Could not save — ' + error.message); return; }

  // Safe to bin the previous picture now: the row already points at the new one (or at
  // nothing). Doing it in this order means a failed save can never leave a student with
  // a broken image, which is what the old delete-first code risked.
  if (avatarUrl !== undefined && oldAvatarUrl) deleteAvatarFile(oldAvatarUrl);

  const newDisplayName = displayName || null;
  // Snapshot name kept on the listing row (used by admin surfaces + as a fallback) = preferred name or real name.
  const snapshotName = newDisplayName || u.name;
  // Public name shown to students = preferred name, else FIRST name only (privacy default — never bare last name).
  const publicName = newDisplayName || u.first || u.name;
  const nameChanged = snapshotName !== (u.display_name || u.name);
  if (nameChanged) {
    await supabaseClient.rpc('update_own_poster_name', { new_name: snapshotName });
  }
  // Immediately reflect the new preferred name + avatar on this user's own listings already in memory.
  if (nameChanged || avatarUrl !== undefined) {
    [...DB.listings, ...DB.pending].forEach(l => {
      if (l.poster_id === u.id && !l.poster.official) {
        l.poster.name = publicName;
        l.poster.fullName = snapshotName;
        if (avatarUrl !== undefined) l.poster.avatar_url = avatarUrl;
      }
    });
    renderListings();
  }

  Object.assign(sUser, { display_name: newDisplayName, username: username || null, bio: bio || null, pronouns: pronouns || null, major: major || null, year: year || null });
  if (avatarUrl !== undefined) sUser.avatar_url = avatarUrl;
  closeModal('editProfileModal');
  renderProfile();
  updateSNav();
  toast('Profile updated ✓');
}

function renderProfile() {
  const u = getEffectiveUser(); if (!u) return;

  const profAv = document.getElementById('profileAvatar');
  profAv.style.backgroundColor = u.color; // not the `background` shorthand — see paintAvatarEl
  paintAvatarEl(profAv, u.avatar_url, u.initials, u.color);
  document.getElementById('profileName').textContent = u.display_name || u.name;
  document.getElementById('profileEmail').textContent = u.email;

  const unEl = document.getElementById('profileUsername');
  if (u.username) {
    unEl.innerHTML = `<span style="font-size:14px;color:var(--brand);font-weight:500">@${esc(u.username)}</span>`;
  } else {
    unEl.innerHTML = `<a onclick="openEditProfile()" style="font-size:13px;color:var(--brand);cursor:pointer;font-weight:500">+ Pick a username</a>`;
  }

  const bioEl = document.getElementById('profileBio');
  if (u.bio) { bioEl.textContent = u.bio; bioEl.style.display = 'block'; }
  else { bioEl.style.display = 'none'; }

  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Recently';
  document.getElementById('profileInfo').innerHTML = [
    `<div class="info-item"><label>Major</label><span>${esc(u.major || 'Not set')}</span></div>`,
    `<div class="info-item"><label>Year</label><span>${esc(u.year || 'Not set')}</span></div>`,
    u.pronouns ? `<div class="info-item"><label>Pronouns</label><span>${esc(u.pronouns)}</span></div>` : '',
    `<div class="info-item"><label>Joined</label><span>${joined}</span></div>`
  ].join('');

  // What this person agreed to, and when. Deliberately silent when there is no record:
  // every account created before 2026-09-01 predates consent recording, and saying
  // nothing is truthful where "not accepted" would be a false accusation.
  const consentEl = document.getElementById('profileConsent');
  if (consentEl) {
    if (u.terms_accepted_at) {
      const when = new Date(u.terms_accepted_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      consentEl.textContent = `You accepted these on ${when}.`;
    } else {
      consentEl.textContent = '';
    }
  }

  renderMyListingsGrid(u); // async — one grid, marketplace + books together
}

// The one My Listings grid: cached marketplace rows (all statuses — owners see their
// pending/sold/etc. with badges) merged with a fresh fetch of the student's own books
// (the public `_books` cache only holds live ones, so own books need their own query).
async function renderMyListingsGrid(u) {
  const grid = document.getElementById('myListings');
  if (!grid) return;
  const mine = [...DB.listings, ...DB.pending].filter(l => l.poster_id === u.id);
  grid.innerHTML = renderListingGrid(mine, true); // paint immediately; books join in a beat
  const { data: books, error } = await supabaseClient.from('book_listings')
    .select('*').eq('poster_id', u.id).order('created_at', { ascending: false });
  if (error) { console.error('[renderMyListingsGrid]', error.message); return; }
  if (!books || !books.length) return;
  const merged = [...mine, ...books.map(bookAsListing)]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  grid.innerHTML = renderListingGrid(merged, true);
}
