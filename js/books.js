// ============================================================
// BOOKS
// Everything books: the course catalog, typeahead, book detail, and posting a book.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ══════════════════════ BOOKS SECTION ══════════════════════
let _courses = null;                 // full course catalog, loaded once per session
let _books = [];                     // live (approved+active) book_listings rows — feeds browseItems()
let _bookPosterMap = {};             // poster_id -> profile (live join, same idea as loadListings)
let _pendingBookPhotos = [];
let _postBookType = null;            // 'course' | 'other' while the post form is open
let _bkSelCourse = null;             // selected course code, 'NOT_LISTED', or null
let _bkCourseAC = null;              // post-form course typeahead instance

const BOOK_COLORS = { course: { bg: '#E8EEF5', text: '#2C476A' }, other: { bg: '#F7EFE1', text: '#6B5128' } };

async function loadCourses() {
  const { data, error } = await supabaseClient
    .from('courses').select('code, name, department, aliases').order('code');
  if (error) { console.error('[courses]', error.message); _courses = []; return; }
  _courses = data || [];
}

async function loadBooks() {
  const { data, error } = await supabaseClient
    .from('book_listings').select('*').eq('status', 'approved').eq('lifecycle_status', 'active')
    .order('created_at', { ascending: false });
  if (error) { console.error('[books]', error.message); return; }
  _books = data || [];
  const ids = [...new Set(_books.map(b => b.poster_id).filter(Boolean))];
  _bookPosterMap = {};
  if (ids.length) {
    const { data: profs } = await supabaseClient.from('profiles')
      .select('id, display_name, first_name, last_name, initials, color, avatar_url, school, year, major, created_at')
      .in('id', ids);
    (profs || []).forEach(p => { _bookPosterMap[p.id] = p; });
  }
}

function courseByCode(code) { return (_courses || []).find(c => c.code === code); }

// Matches against code ("NU 301" / "nu301"), name, and aliases. Code matches rank first.
function courseMatches(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const sc = s.replace(/\s+/g, '');
  const codeHits = [], nameHits = [];
  for (const c of _courses) {
    const code = c.code.toLowerCase();
    if (code.startsWith(s) || code.replace(/\s+/g, '').startsWith(sc)) codeHits.push(c);
    else if (c.name.toLowerCase().includes(s) || (c.aliases || []).some(a => a.toLowerCase().includes(s))) nameHits.push(c);
  }
  return codeHits.concat(nameHits).slice(0, 40);
}

// Reusable autocomplete: students can only pick from the list, never free-type a course.
// opts.allowNotListed adds a "My course isn't listed" row that selects the special value 'NOT_LISTED'.
function attachCourseAC(input, list, opts) {
  let items = [], active = -1, selected = null;

  function close() { list.style.display = 'none'; active = -1; }

  function paint() {
    let html = items.map((c, i) =>
      `<div class="course-ac-item${i === active ? ' ac-active' : ''}" data-i="${i}"><span class="course-ac-code">${esc(c.code)}</span><span class="course-ac-name">${esc(c.name)}</span></div>`
    ).join('');
    if (!items.length) html = `<div class="course-ac-none">No matching course — try the code, like NU 301</div>`;
    if (opts.allowNotListed) html += `<div class="course-ac-item course-ac-notlisted${active === items.length ? ' ac-active' : ''}" data-i="-2">My course isn&rsquo;t listed</div>`;
    list.innerHTML = html;
    list.style.display = 'block';
    list.querySelectorAll('.course-ac-item').forEach(el => {
      el.addEventListener('mousedown', e => e.preventDefault()); // keep focus so blur doesn't fire first
      el.addEventListener('click', () => pick(parseInt(el.dataset.i, 10)));
    });
  }

  function pick(i) {
    if (isNaN(i)) return;
    if (i === -2) { selected = 'NOT_LISTED'; input.value = 'My course isn’t listed'; }
    else {
      const c = items[i]; if (!c) return;
      selected = c.code;
      input.value = `${c.code} – ${c.name}`;
    }
    close();
    opts.onSelect(selected);
  }

  input.addEventListener('input', () => {
    if (selected) { selected = null; opts.onSelect(null); }
    const q = input.value;
    if (!q.trim()) { close(); return; }
    items = courseMatches(q); active = -1; paint();
  });

  input.addEventListener('keydown', e => {
    if (list.style.display === 'none') return;
    const max = items.length - 1 + (opts.allowNotListed ? 1 : 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, max); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active === items.length && opts.allowNotListed) pick(-2);
      else pick(active >= 0 ? active : 0);
    }
    else if (e.key === 'Escape') close();
  });

  // No valid pick = no value. The field clears itself so a half-typed course can't linger.
  input.addEventListener('blur', () => setTimeout(() => {
    if (!selected && input.value.trim()) { input.value = ''; opts.onSelect(null); }
    close();
  }, 150));

  return {
    reset() { selected = null; input.value = ''; close(); },
    get selected() { return selected; }
  };
}

// The post-a-book form's course typeahead — attached once, lazily, the first time the
// form opens (books used to init this via the old browse mode, which no longer exists).
async function ensurePostBookAC() {
  if (_bkCourseAC) return;
  if (!_courses) await loadCourses();
  _bkCourseAC = attachCourseAC(
    document.getElementById('bkCourseInput'),
    document.getElementById('bkCourseList'),
    { allowNotListed: true, onSelect: code => { _bkSelCourse = code; } }
  );
}

function bookChipLabel(b) {
  if (b.book_type === 'course') return b.course_code || 'Textbook';
  return b.genre || 'Book';
}

async function openBookDetail(id) {
  // The public cache only holds approved+active books; a student's own pending/sold
  // book (opened from the profile) has to be fetched directly.
  let b = _books.find(x => x.id === id);
  if (!b) {
    const { data } = await supabaseClient.from('book_listings').select('*').eq('id', id).single();
    if (!data) { toast('Could not load this book.'); return; }
    b = data;
  }
  const col = BOOK_COLORS[b.book_type] || BOOK_COLORS.other;
  const course = b.course_code ? courseByCode(b.course_code) : null;
  const hero = b.photo_urls?.length
    ? photoGalleryHtml(b.photo_urls, { natural: true, maxHeight: '60vh', radius: '0', mainId: 'bookGalMain', alt: b.title })
    : `<div style="background:${col.bg};color:${col.text};padding:40px 28px;text-align:center;font-size:20px;font-weight:600;">${esc(b.title)}</div>`;

  const facts = [];
  if (b.book_type === 'course') facts.push(['Course', course ? `${course.code} – ${course.name}` : 'Not listed yet']);
  if (b.book_type === 'other' && b.genre) facts.push(['Genre', b.genre]);
  if (b.author)  facts.push(['Author', b.author]);
  if (b.edition) facts.push(['Edition', b.edition]);
  facts.push(['Condition', b.condition]);
  if (b.isbn) facts.push(['ISBN', b.isbn]);

  const p = _bookPosterMap[b.poster_id];
  const posterName = p ? (p.display_name || `${p.first_name} ${p.last_name}`) : 'Caldwell student';
  const own = getEffectiveUser()?.id === b.poster_id;
  const isLive = b.status === 'approved' && (b.lifecycle_status || 'active') === 'active';
  const [sBg, sCol, sLabel] = listingLifecycleBadge({ status: b.status, lifecycle_status: b.lifecycle_status, expires_at: b.expires_at, rent: b.price, pinned: false });
  const canRelist = own && b.status === 'approved' && b.lifecycle_status === 'sold';
  const actionBtn = own
    ? (isLive
        ? `<button class="btn-full" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:12px;border-radius:var(--radius-sm);font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;" onclick="markBookSold(${b.id})">Mark as sold</button>`
        : `<div style="text-align:center;padding:11px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;color:var(--text-muted)">Status: <span class="pill" style="background:${sBg};color:${sCol}">${sLabel}</span>${b.rejection_reason ? `<div style="margin-top:6px;font-size:12px;color:var(--danger)">${esc(b.rejection_reason)}</div>` : ''}</div>`
          + (canRelist ? `<button class="btn-full btn-brand" style="margin-top:10px" onclick="relistBook(${b.id})">Mark as active again</button>` : ''))
    : `<button class="btn-full btn-brand" onclick="closeModal('bookDetailModal');bContact(${b.id})">Message seller</button>`;

  document.getElementById('bookDetailContent').innerHTML = `
    ${hero}
    <div style="padding:20px 24px 24px;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${esc(bookChipLabel(b))} · Posted ${new Date(b.created_at).toLocaleDateString()}</div>
      <div style="font-size:19px;font-weight:700;margin-bottom:4px;">${esc(b.title)}</div>
      <div style="font-size:20px;font-weight:700;color:var(--brand);margin-bottom:14px;">${b.price > 0 ? '$' + b.price : 'Free'}</div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin-bottom:14px;">
        ${facts.map(([k, v]) => `<div style="color:var(--text-muted)">${esc(k)}</div><div>${esc(v)}</div>`).join('')}
      </div>
      ${b.description ? `<div style="font-size:14px;line-height:1.6;color:var(--text);margin-bottom:16px;">${esc(b.description)}</div>` : ''}
      <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-top:1px solid var(--border);margin-bottom:16px;">
        ${p ? avatarHTML({ ...p, name: posterName }, 38) : ''}
        <div style="font-size:13px;"><div style="font-weight:600">${esc(posterName)}</div><div style="color:var(--text-muted)">Caldwell University</div></div>
      </div>
      ${actionBtn}
    </div>`;
  openModal('bookDetailModal');
}

async function bContact(bookId) {
  const eu = getEffectiveUser();
  if (!eu) { openModal('loginModal'); return; }
  const b = _books.find(x => x.id === bookId); if (!b) return;
  if (b.poster_id === eu.id) { toast("That's your own listing!"); return; }
  let p = _bookPosterMap[b.poster_id];
  if (!p) {
    const { data } = await supabaseClient.from('profiles').select('display_name, first_name, last_name, initials, color').eq('id', b.poster_id).single();
    p = data;
  }
  if (!p) { toast('Messaging not available for this listing yet.'); return; }
  const info = { name: p.display_name || `${p.first_name} ${p.last_name}`, initials: p.initials, color: p.color };
  showPage('messages');
  setTimeout(() => openConvo(b.poster_id, info, null), 100);
}

async function markBookSold(id) {
  if (!confirm('Mark this book as sold? It will disappear from the Books feed.')) return;
  const b = _books.find(x => x.id === id);
  const { error } = await supabaseClient.from('book_listings')
    .update({ lifecycle_status: 'sold', sold_at: new Date().toISOString() }).eq('id', id);
  if (error) { toast('Could not update — please try again.'); console.error(error.message); return; }
  logEvent('book_sold', { targetType: 'book_listing', targetId: id, targetLabel: b?.title, before: { lifecycle_status: 'active' }, after: { lifecycle_status: 'sold' } });
  closeModal('bookDetailModal');
  toast('Marked as sold — congrats!');
  await loadBooks();
  renderListings(); // books live in the main grid now
  if (document.getElementById('page-profile')?.classList.contains('active')) renderProfile();
}

// "Actually it's available again" — sold → active via the same lifecycle RPC as
// marketplace listings (validates the transition + ownership server-side).
async function relistBook(id) {
  const { error } = await supabaseClient.rpc('change_listing_status', { p_listing_id: id, p_new_status: 'active', p_table: 'book_listings' });
  if (error) { toast('Could not relist — please try again.'); console.error('[relistBook]', error.message); return; }
  logEvent('book_relisted', { targetType: 'book_listing', targetId: id, before: { lifecycle_status: 'sold' }, after: { lifecycle_status: 'active' } });
  closeModal('bookDetailModal');
  toast('✓ Book is live again');
  await loadBooks();
  renderListings();
  if (document.getElementById('page-profile')?.classList.contains('active')) renderProfile();
}

// ---- Post-a-book form ----
function openPostBook() {
  if (!getEffectiveUser()) { openModal('loginModal'); return; }
  resetBookForm();
  ensurePostBookAC(); // async; typeahead is live by the time the user reaches the course field
  openModal('postBookModal');
}
function closePostBook() {
  closeModal('postBookModal');
  setTimeout(resetBookForm, 200);
}
function resetBookForm() {
  _postBookType = null; _bkSelCourse = null; _pendingBookPhotos = [];
  if (_bkCourseAC) _bkCourseAC.reset();
  ['bkIsbn', 'bkTitle', 'bkAuthor', 'bkEdition', 'bkPrice', 'bkDesc'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('bkCondition').value = 'Good';
  document.getElementById('bkGenre').selectedIndex = 0;
  document.getElementById('bookFormFields').style.display = 'none';
  document.getElementById('btypeCourse').style.outline = '';
  document.getElementById('btypeOther').style.outline = '';
  const inp = document.getElementById('bkPhotoInput'); if (inp) inp.value = '';
  renderBookPhotoPreviews();
  const btn = document.getElementById('bkSubmitBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Post book'; }
}
function selectBookType(t) {
  _postBookType = t;
  document.getElementById('btypeCourse').style.outline = t === 'course' ? '2px solid #2C476A' : '';
  document.getElementById('btypeOther').style.outline = t === 'other' ? '2px solid #6B5128' : '';
  document.getElementById('bookFormFields').style.display = 'block';
  document.getElementById('bkCourseGroup').style.display = t === 'course' ? 'block' : 'none';
  document.getElementById('bkEditionGroup').style.display = t === 'course' ? 'block' : 'none';
  document.getElementById('bkGenreGroup').style.display = t === 'other' ? 'block' : 'none';
}

function pickBookPhoto(input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  for (const file of files) {
    if (_pendingBookPhotos.length >= MAX_LISTING_PHOTOS) { toast(`You can add up to ${MAX_LISTING_PHOTOS} photos.`); break; }
    const isHEIC = file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
    if (isHEIC) { toast(`"${file.name}" is HEIC — not supported yet, skipped.`); continue; }
    if (!file.type.startsWith('image/')) { toast(`"${file.name}" isn't an image — skipped.`); continue; }
    if (file.size > 10 * 1024 * 1024) { toast(`"${file.name}" is over 10 MB — skipped.`); continue; }
    _pendingBookPhotos.push(file);
  }
  renderBookPhotoPreviews();
}
function renderBookPhotoPreviews() {
  const prev = document.getElementById('bkPhotoPreview');
  if (!prev) return;
  if (!_pendingBookPhotos.length) { prev.innerHTML = ''; return; }
  prev.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;gap:8px;">` +
    _pendingBookPhotos.map((file, i) => `<div style="position:relative;display:inline-block;">
        <img src="${URL.createObjectURL(file)}" style="width:84px;height:64px;object-fit:cover;border-radius:6px;display:block;">
        ${i === 0 ? '<span style="position:absolute;bottom:3px;left:3px;background:rgba(0,0,0,.6);color:#fff;font-size:9px;font-weight:600;padding:1px 5px;border-radius:8px;">Cover</span>' : ''}
        <button type="button" onclick="removeBookPhoto(${i})" style="position:absolute;top:-7px;right:-7px;background:#fff;border:1px solid var(--border);border-radius:50%;width:22px;height:22px;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.15);">&#215;</button>
      </div>`).join('') +
    `</div>
    <div style="font-size:11px;color:var(--text-faint);margin-top:6px;">${_pendingBookPhotos.length} of ${MAX_LISTING_PHOTOS} photos · first photo is the cover · compressed before upload</div>`;
}
function removeBookPhoto(i) {
  _pendingBookPhotos.splice(i, 1);
  renderBookPhotoPreviews();
}

async function submitBook() {
  if (!_postBookType) { toast('Please choose Textbook or Other book'); return; }
  const title = document.getElementById('bkTitle').value.trim();
  if (!title) { toast('Please add the book title'); return; }
  if (_postBookType === 'course' && !_bkSelCourse) { toast('Please pick your course from the list (or "My course isn’t listed")'); return; }
  const price = parseFloat(document.getElementById('bkPrice').value);
  if (isNaN(price) || price < 0) { toast('Please enter a price — use 0 if it’s free'); return; }
  const u = getEffectiveUser();
  if (!u || !u.id) { openModal('loginModal'); return; }

  if (!_pendingBookPhotos.length) {
    if (!confirm('Books with a photo sell much faster.\n\nPost without a photo?')) return;
  }

  const btn = document.getElementById('bkSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // Same all-or-nothing photo batch behavior as marketplace listings
  let photoUrls = [];
  if (_pendingBookPhotos.length) {
    try {
      for (let i = 0; i < _pendingBookPhotos.length; i++) {
        if (btn) btn.textContent = `Uploading photo ${i + 1} of ${_pendingBookPhotos.length}…`;
        const blob = await resizeImage(_pendingBookPhotos[i]);
        photoUrls.push(await uploadListingPhoto(blob, u.id));
      }
    } catch (err) {
      console.error('[book photo upload]', err);
      if (photoUrls.length) deleteListingPhotos(photoUrls);
      photoUrls = [];
      toast('Photos could not be uploaded — book will be saved without them.');
    }
    if (btn) btn.textContent = 'Saving…';
  }

  const initialStatus = DB.settings.requireApproval ? 'pending' : 'approved';
  const { data, error } = await supabaseClient.from('book_listings').insert({
    book_type: _postBookType,
    course_code: _postBookType === 'course' && _bkSelCourse !== 'NOT_LISTED' ? _bkSelCourse : null,
    genre: _postBookType === 'other' ? document.getElementById('bkGenre').value : null,
    title,
    author: document.getElementById('bkAuthor').value.trim() || null,
    isbn: document.getElementById('bkIsbn').value.trim() || null,
    edition: _postBookType === 'course' ? (document.getElementById('bkEdition').value.trim() || null) : null,
    price,
    condition: document.getElementById('bkCondition').value,
    description: document.getElementById('bkDesc').value.trim() || null,
    photo_urls: photoUrls,
    poster_id: u.id,
    status: initialStatus
  }).select().single();
  if (error) {
    toast('Could not save your book — please try again.');
    console.error('[book insert]', error.message);
    if (photoUrls.length) deleteListingPhotos(photoUrls);
    if (btn) { btn.disabled = false; btn.textContent = 'Post book'; }
    return;
  }
  logEvent('book_submitted', { targetType: 'book_listing', targetId: data.id, targetLabel: title, after: { status: initialStatus, hasPhoto: photoUrls.length > 0, photoCount: photoUrls.length } });
  closePostBook();
  toast(initialStatus === 'pending' ? '✓ Book submitted for admin review!' : '✓ Your book is live!');
  await loadBooks();
  renderListings(); // books live in the main grid now
}
// ══════════════════════ END BOOKS SECTION ══════════════════════
