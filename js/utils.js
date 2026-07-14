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

function openModal(id) { if (id === 'signupModal') resetSignupModal(); document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
function switchModal(from, to) { closeModal(from); setTimeout(() => openModal(to), 150); }
function toast(msg) { const t = document.getElementById('toastEl'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }

