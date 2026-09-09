// ============================================================
// UTILS
// Tiny helpers used by every screen: open/close a modal, show a toast.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ============================================================
// SHARED UTILITIES
// ============================================================
// Escapes user-typed text so the browser shows it as TEXT instead of running it
// as HTML. Every ${...} that carries something a person typed (titles, messages,
// bios, names, report details…) must go through esc() — otherwise a listing
// titled <img src=x onerror=…> would execute in every viewer's browser.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Same idea for double-quoted HTML attributes (src="…", alt="…", value="…").
// Also covers user-influenced URLs, where a stray " would break out of the attribute.
function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// prepLoginModal (auth.js) applies the "welcome back, <name>" treatment when this device
// remembers a prior student. Hooking it here means all eight routes into the login modal
// behave the same. Both callees live in later files, which is fine: they are only *called*
// at runtime, never at load time.
function openModal(id) {
  if (id === 'signupModal') resetSignupModal();
  if (id === 'loginModal')  prepLoginModal();
  document.getElementById(id).classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
function switchModal(from, to) { closeModal(from); setTimeout(() => openModal(to), 150); }
function toast(msg) { const t = document.getElementById('toastEl'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }



// ------------------------------------------------------------
// Remembering what the student was looking at
// ------------------------------------------------------------
// THE RULE, and everything in this app follows it:
//
//     sessionStorage remembers WHERE YOU WERE.   It dies with the tab.
//     localStorage   remembers WHAT YOU PREFER.  It does not.
//
// Where you were is the page, the filters, the open section, the organization you were
// reading. Reloading keeps your place; closing the app starts clean — which is what a student
// expects from both actions, and localStorage would instead present a filter set three weeks
// ago as the state of the marketplace.
//
// What you prefer is recent searches (js/search.js) and grid-versus-list (js/search.js).
// Those are not positions, and losing them on every visit is the papercut they exist to
// remove. Anything added here should be sorted into one of those two sentences first; if it
// fits neither, it probably belongs in the database rather than in the browser.
//
// Every access is wrapped: a private window, or a browser set to block site data, throws on
// read AND on write rather than returning null, and an unguarded call takes the page down.
// Losing the memory is a papercut; losing the render is a broken app.
function saveUiState(key, value) {
  try { sessionStorage.setItem('cn_ui_' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
}

function loadUiState(key, fallback = null) {
  try {
    const raw = sessionStorage.getItem('cn_ui_' + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }   // unreadable or corrupt: start clean rather than throw
}
