// ============================================================
// MESSAGES
// Chat: the sidebar, full-screen conversation mode, swipe-to-reply, sending, realtime, and sharing a listing.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

// ============================================================
// STUDENT — INIT & AUTH
// ============================================================
// ── Messaging sidebar collapse ──────────────────────────────
let msgSidebarPinned = true;

function toggleMsgSidebar() {
  const sidebar = document.getElementById('msgSidebar');
  const toggleBtn = document.getElementById('msgToggleBtn');
  if (!sidebar.classList.contains('msg-collapsed')) {
    msgSidebarPinned = false;
    sidebar.classList.add('msg-collapsed');
    toggleBtn.title = 'Show sidebar';
    localStorage.setItem('cn_msg_sidebar', 'collapsed');
  } else {
    msgSidebarPinned = true;
    sidebar.classList.remove('msg-collapsed');
    toggleBtn.title = 'Hide sidebar';
    localStorage.setItem('cn_msg_sidebar', 'open');
  }
}

function reopenMsgSidebar() {
  msgSidebarPinned = true;
  const sidebar = document.getElementById('msgSidebar');
  sidebar.classList.remove('msg-collapsed');
  localStorage.setItem('cn_msg_sidebar', 'open');
}

// ── Mobile messages: one pane at a time ──────────────────────
// Single source of truth for "are we on a phone-width screen".
const mqMobile = window.matchMedia('(max-width: 768px)');
function isMobileView() { return mqMobile.matches; }

// Conversation mode: full-screen chat, global top/tab bars hidden (body.chat-open).
// A history entry is pushed so the phone's back gesture exits the chat instead of
// leaving the app with the chrome stuck hidden.
function enterConvoMode() {
  if (document.body.classList.contains('chat-open')) return;
  document.body.classList.add('chat-open');
  if (!history.state?.cnChat) history.pushState({ cnChat: true }, '');
}

function closeConvo(fromPop = false) {
  document.body.classList.remove('chat-open');
  // If the user tapped ‹ (rather than using the back gesture), consume the history
  // entry we pushed, so their next back press behaves normally.
  if (!fromPop && history.state?.cnChat) history.back();
  if (sRealtimeChannel) { supabaseClient.removeChannel(sRealtimeChannel); sRealtimeChannel = null; }
  sConvoActive = null;
  sessionStorage.removeItem('cn_last_convo');
  renderConvos(); // drop the active-row highlight in the list
}

window.addEventListener('popstate', () => {
  if (document.body.classList.contains('chat-open')) closeConvo(true);
});

// A conversation only counts as "being read" when it is genuinely on screen:
// Messages page active, tab visible AND window focused, and on mobile the
// full-screen chat actually open. Anything less (background window, other tab,
// thread restored behind another page) leaves messages unread — WhatsApp rules.
function isViewingActiveConvo() {
  if (!sConvoActive) return false;
  if (!document.getElementById('page-messages')?.classList.contains('active')) return false;
  if (document.hidden || !document.hasFocus()) return false;
  if (isMobileView() && !document.body.classList.contains('chat-open')) return false;
  return true;
}

// Marks everything addressed to me in the active thread as seen — but only if
// I'm really looking at it. Called whenever that becomes true: opening the thread,
// returning to the Messages page, or the window regaining focus/visibility.
function markActiveConvoSeen() {
  const eu = getEffectiveUser();
  if (!eu || !isViewingActiveConvo()) return;
  const convKey = [eu.id, sConvoActive.userId].sort().join(':');
  supabaseClient.from('messages')
    .update({ seen_at: new Date().toISOString() })
    .eq('conversation_key', convKey).eq('receiver_id', eu.id).is('seen_at', null)
    .select('id') // a GRANT/RLS block "succeeds" with zero rows — count them so it can't hide
    .then(({ data, error }) => {
      if (error) { console.warn('mark seen:', error.message); return; }
      if (data && data.length > 0) renderConvos();
      else if ((sUnread[convKey] || 0) > 0) console.warn('mark seen updated 0 rows despite unread — check GRANT UPDATE + receiver UPDATE policy on messages');
    });
}
window.addEventListener('focus', () => markActiveConvoSeen());
document.addEventListener('visibilitychange', () => { if (!document.hidden) markActiveConvoSeen(); });

// Crossing the 768px line must never strand the layout: growing past it restores
// the desktop split pane (the open chat stays in the right pane); shrinking with
// a chat open re-enters full-screen conversation mode.
mqMobile.addEventListener('change', e => {
  if (!e.matches) document.body.classList.remove('chat-open');
  else if (sConvoActive) enterConvoMode();
});

// ── Reply to a message ───────────────────────────────────────
// Touch: swipe a bubble a short way right (WhatsApp-style) — the row follows the
// finger up to 72px, always snaps back, and past 48px arms a reply. Desktop uses
// the hover ↩ button instead. Scoped to message rows only, so it can never fire
// on other pages or fight vertical scrolling (axis lock, same as before).
let sReplyTo = null;   // { id, name, content } of the message being replied to
let sMsgCache = {};    // message id → { content, senderId }, for quotes & scroll-to

// Touch events (not pointer events) on purpose: iOS Safari silently cancels pointer
// events once it decides a drag is a scroll, even with touch-action set — but it honors
// preventDefault() on a non-passive touchmove. Same pattern as the filter drawer's
// swipe-to-close, which is proven to work on iOS.
(function initReplySwipe() {
  const chat = document.getElementById('chatArea');
  if (!chat) return;
  let g = null; // gesture in progress: {row, x, y, active, aborted}

  chat.addEventListener('touchstart', e => {
    const row = e.target.closest('.msg-row');
    if (!row || !row.dataset.mid) return;
    g = { row, x: e.touches[0].clientX, y: e.touches[0].clientY, active: false, aborted: false };
  }, { passive: true });

  chat.addEventListener('touchmove', e => {
    if (!g || g.aborted) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.active) {
      // Axis lock: decide once, on the first ~10px, whether this is a scroll or a swipe.
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g.aborted = true; return; }
      if (dx > 10 && dx > Math.abs(dy)) {
        g.active = true;
        g.row.style.transition = 'none';
      }
      return;
    }
    e.preventDefault(); // the gesture is ours now — stop iOS from scrolling or cancelling
    g.row.style.transform = `translateX(${Math.min(Math.max(dx, 0), 72)}px)`;
  }, { passive: false });

  const finish = e => {
    if (!g) return;
    const s = g;
    g = null;
    if (!s.active) return;
    const dx = (e.changedTouches?.[0]?.clientX ?? s.x) - s.x;
    s.row.style.transition = 'transform .18s ease';
    s.row.style.transform = 'translateX(0)';
    setTimeout(() => { s.row.style.transition = ''; }, 190);
    if (e.type === 'touchend' && dx > 48) startReply(s.row.dataset.mid);
  };
  chat.addEventListener('touchend', finish);
  chat.addEventListener('touchcancel', finish);
})();

// Quoted block rendered inside a reply bubble; tapping it jumps to the original.
function quoteHtml(replyToId) {
  if (!replyToId) return '';
  const q = sMsgCache[replyToId];
  const eu = getEffectiveUser();
  const name = q ? (q.senderId === eu?.id ? 'You' : (sConvoActive?.name || '')) : '';
  const text = q ? q.content : 'Original message unavailable';
  return `<div class="bubble-quote" onclick="scrollToMsg('${replyToId}')"><span class="bq-name">${esc(name)}</span><span class="bq-text">${esc(text)}</span></div>`;
}

function startReply(id) {
  const m = sMsgCache[id];
  if (!m || !sConvoActive) return;
  const eu = getEffectiveUser();
  sReplyTo = { id, name: m.senderId === eu?.id ? 'You' : sConvoActive.name, content: m.content };
  document.getElementById('replyBar')?.remove();
  const bar = document.createElement('div');
  bar.id = 'replyBar';
  bar.className = 'reply-bar';
  bar.innerHTML = `<div class="reply-bar-body"><span class="bq-name">${esc(sReplyTo.name)}</span><span class="bq-text">${esc(sReplyTo.content)}</span></div><button class="reply-bar-x" onclick="cancelReply()" aria-label="Cancel reply">&times;</button>`;
  document.querySelector('.chat-input-area')?.before(bar);
  document.getElementById('msgInput')?.focus();
}

function cancelReply() {
  sReplyTo = null;
  document.getElementById('replyBar')?.remove();
}

function scrollToMsg(id) {
  const row = document.querySelector(`.msg-row[data-mid="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('msg-flash');
  setTimeout(() => row.classList.remove('msg-flash'), 1200);
}


// STUDENT MESSAGES
let sConvoCache = {}; // keyed by userId: { name, initials, color }
let sLastDivLabel = null; // date label of the last divider in the open thread

// WhatsApp-style date labels: Today, Yesterday, weekday within the last week, full date beyond.
function chatDateLabel(d) {
  const date = new Date(d), now = new Date();
  const startOfDay = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

// Live-appended messages (sent or received) also need a divider when the day changed.
function appendDateDivider(msgsEl, when) {
  const dLabel = chatDateLabel(when);
  if (dLabel === sLastDivLabel) return;
  msgsEl.insertAdjacentHTML('beforeend', `<div class="divider date-divider">${dLabel}</div>`);
  sLastDivLabel = dLabel;
}

// Unread = database truth: messages addressed to me with no seen_at yet.
// Survives refresh; only actually opening a conversation clears its count.
async function refreshUnread() {
  const eu = getEffectiveUser();
  if (!eu) return;
  const { data, error } = await supabaseClient
    .from('messages')
    .select('conversation_key')
    .eq('receiver_id', eu.id)
    .is('seen_at', null);
  if (error) { console.warn('refreshUnread:', error.message); return; } // seen_at column not migrated yet — badges stay off
  sUnread = {};
  (data || []).forEach(m => { sUnread[m.conversation_key] = (sUnread[m.conversation_key] || 0) + 1; });
  sUnreadCount = (data || []).length;
  updateMsgBadges();
}

// ---- LOADING SKELETONS -------------------------------------------------
// Same idea as the browse feed's: rather than a blank panel while Supabase
// answers, show placeholder shapes the real content will slot into, so the
// layout never jumps and the app reads as loading rather than broken.
// Shapes and the shimmer live in styles.css (.sk*).

function convoSkeletonHTML(n = 5) {
  return Array.from({ length: n }, () => `<div class="sk-convo" aria-hidden="true">
    <div class="sk sk-convo-avatar"></div>
    <div class="sk-convo-info"><div class="sk sk-convo-name"></div><div class="sk sk-convo-preview"></div></div>
    <div class="sk sk-convo-time"></div>
  </div>`).join('');
}

// Mixed sides and widths so it looks like a conversation rather than a list.
const SK_BUBBLES = [
  'sk-bubble-theirs sk-bubble-m', 'sk-bubble-s', 'sk-bubble-theirs sk-bubble-l',
  'sk-bubble-m', 'sk-bubble-theirs sk-bubble-s'
];

function threadSkeletonHTML() {
  return `<div class="sk-thread" aria-hidden="true">${
    SK_BUBBLES.map(c => `<div class="sk sk-bubble ${c}"></div>`).join('')
  }</div>`;
}

// ---- THE CHAT LIST (rebuilt 2026-09-24 from the approved Inbox design) ----
// A marketplace inbox has to say WHAT each chat is about as clearly as WHO it is with — Facebook
// Marketplace, Depop and Vinted all put the item's photo and title on the row. So each row shows:
// the person, the last message ("You: …" when it was yours), the time, an unread count, and a
// line naming the listing(s) with a Buying / Selling tag, plus the listing's photo on the right.
// Buying and Selling are also the filters people use, so they are the chips above the list.
//
// Everything comes from what the messages already record: each message carries the listing it
// was about, so the listings in a chat, and whose they are, need no new columns.
let _convoSummaries = [];                 // one per conversation, newest first (see convoSummaries)
let _convoFilter = { chip: 'all', q: '' };

// "now", "12m", "3h", "Tue", "Sep 3" — short, because it shares a line with the name.
function msgAgo(ts) {
  const d = new Date(ts), ms = Date.now() - d.getTime();
  if (ms < 60e3) return 'now';
  if (ms < 36e5) return Math.floor(ms / 60e3) + 'm';
  if (ms < 864e5) return Math.floor(ms / 36e5) + 'h';
  if (ms < 6 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A listing or book this chat mentions, as { kind, id, title, photo, price, mine, sold, cat }.
function convoRef(kind, id, meId) {
  if (kind === 'book') {
    const b = (typeof _books !== 'undefined' ? _books : []).find(x => String(x.id) === String(id));
    if (!b) return null;
    return { kind, id, title: b.title, photo: b.photo_urls?.[0] || null, price: b.price > 0 ? '$' + b.price : 'Free',
             mine: b.poster_id === meId, sold: b.lifecycle_status === 'sold', cat: 'books' };
  }
  const l = DB.listings.find(x => String(x.id) === String(id)) || DB.pending.find(x => String(x.id) === String(id));
  if (!l) return null;
  return { kind, id, title: l.title, photo: l.photo_urls?.[0] || null, price: priceLabel(l),
           mine: l.poster_id === meId, sold: l.lifecycle_status === 'sold', cat: l.category };
}

// One summary per conversation from ALL my messages (newest first).
function convoSummaries(msgs, meId) {
  const byKey = new Map();
  for (const m of msgs) {
    let c = byKey.get(m.conversation_key);
    if (!c) {
      c = { key: m.conversation_key, otherId: m.sender_id === meId ? m.receiver_id : m.sender_id,
            last: m, unread: 0, refs: [], refKeys: new Set() };
      byKey.set(m.conversation_key, c);
    }
    if (m.receiver_id === meId && !m.seen_at) c.unread++;
    const add = (kind, id) => {
      const k = kind + ':' + id;
      if (id == null || c.refKeys.has(k)) return;
      c.refKeys.add(k);
      const r = convoRef(kind, id, meId);
      if (r) c.refs.push(r);
    };
    add('listing', m.listing_id);
    add('book', m.book_id);
  }
  return [...byKey.values()].map(c => ({
    ...c,
    // Selling if any listing in the chat is mine, Buying if any is theirs — a chat can be both.
    selling: c.refs.some(r => r.mine), buying: c.refs.some(r => !r.mine),
  }));
}

async function renderConvos() {
  const eu = getEffectiveUser();
  if (!eu) return;
  // Only on the very first paint. renderConvos() also runs on every new message,
  // and flashing grey rows over a list that is already up would be worse than no
  // skeleton at all.
  const listEl = document.getElementById('convoList');
  if (listEl && !listEl.children.length) {
    listEl.setAttribute('aria-busy', 'true');
    listEl.innerHTML = convoSkeletonHTML();
  }
  await refreshUnread();
  const { data: msgs } = await supabaseClient
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${eu.id},receiver_id.eq.${eu.id}`)
    .order('created_at', { ascending: false });

  _convoSummaries = convoSummaries(msgs || [], eu.id);
  const otherIds = [...new Set(_convoSummaries.map(c => c.otherId))];
  if (otherIds.length) {
    const { data: profiles } = await supabaseClient.from('public_profiles')
      .select('id, first_name, last_name, display_name, initials, color, avatar_url, school').in('id', otherIds);
    for (const p of (profiles || [])) {
      sConvoCache[p.id] = { name: p.display_name || (p.first_name + ' ' + p.last_name), initials: p.initials,
                            color: p.color, avatar_url: p.avatar_url || null, school: p.school || null, verified: true };
    }
  }
  document.getElementById('convoList')?.removeAttribute('aria-busy');
  convoPaint();
}

function convoFilterSet(kind, value) {
  if (kind === 'chip') _convoFilter.chip = value;
  if (kind === 'q') _convoFilter.q = value;
  convoPaint();
}

function convoPaint() {
  const listEl = document.getElementById('convoList');
  if (!listEl) return;
  if (typeof ibPaintCounts === 'function') ibPaintCounts();
  const all = _convoSummaries;
  const n = { all: all.length, unread: all.filter(c => c.unread).length,
              buying: all.filter(c => c.buying).length, selling: all.filter(c => c.selling).length };
  const chipsEl = document.getElementById('convoChips');
  if (chipsEl) chipsEl.innerHTML = all.length ? [['all', 'All'], ['unread', 'Unread'], ['buying', 'Buying'], ['selling', 'Selling']]
    .filter(([k]) => k === 'all' || n[k] || _convoFilter.chip === k)
    .map(([k, l]) => `<button class="ib-chip${_convoFilter.chip === k ? ' is-on' : ''}" onclick="convoFilterSet('chip','${k}')">${l}<span>${n[k]}</span></button>`).join('') : '';

  if (!all.length) {
    listEl.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">${icon('message', 34)}</div>
      <div class="empty-state-title">No conversations yet</div>
      <div class="empty-state-sub">Message someone about a listing and<br>the thread will show up here.</div>
      <button class="empty-state-btn" onclick="showPage('listings')">Browse listings</button>
    </div>`;
    return;
  }

  const q = _convoFilter.q.trim().toLowerCase();
  const rows = all.filter(c => {
    if (_convoFilter.chip === 'unread' && !c.unread) return false;
    if (_convoFilter.chip === 'buying' && !c.buying) return false;
    if (_convoFilter.chip === 'selling' && !c.selling) return false;
    if (!q) return true;
    const p = sConvoCache[c.otherId];
    return [p?.name, ...c.refs.map(r => r.title)].some(v => (v || '').toLowerCase().includes(q));
  });
  listEl.innerHTML = rows.length ? rows.map(convoRowHTML).join('')
    : `<div class="ib-none">No chats match${q ? ` “${esc(_convoFilter.q.trim())}”` : ''}.
        <button class="hn-link" onclick="convoFilterSet('chip','all');document.getElementById('convoSearch').value='';convoFilterSet('q','')">Show all</button></div>`;
}

function convoRowHTML(c) {
  const eu = getEffectiveUser();
  const p = sConvoCache[c.otherId] || { name: 'Student', initials: '?', color: '#888' };
  const m = c.last;
  const mine = m.sender_id === eu?.id;
  const text = m.message_type === 'listing' ? `Shared “${m.content}”` : m.content;
  const first = c.refs[0];
  const tag = !first ? '' : first.sold ? ['Sold', 'is-sold'] : first.mine ? ['Selling', 'is-selling'] : ['Buying', 'is-buying'];
  const about = first ? esc(first.title) + (c.refs.length > 1 ? ` <span class="convo-more">+${c.refs.length - 1} more</span>` : '') : '';
  const active = sConvoActive && sConvoActive.userId === c.otherId;
  return `
    <div class="convo-item${c.unread ? ' is-unread' : ''}${active ? ' active-convo' : ''}" onclick="openConvo('${escAttr(c.otherId)}')">
      ${avatarHTML({ ...p, name: p.name }, 50)}
      <div class="convo-info">
        <div class="convo-top"><span class="convo-name">${esc(p.name)}</span><span class="convo-time">${esc(msgAgo(m.created_at))}</span></div>
        <div class="convo-mid"><span class="convo-preview">${mine ? 'You: ' : ''}${esc(text)}</span>${c.unread ? `<span class="convo-badge">${c.unread}</span>` : ''}</div>
        ${first ? `<div class="convo-ctx"><span class="convo-tag ${tag[1]}">${tag[0]}</span><span class="convo-about">${about}</span></div>` : ''}
      </div>
      ${first ? `<div class="convo-thumb" data-cat="${escAttr(first.cat || 'other')}">${first.photo ? `<img src="${escAttr(first.photo)}" alt="" loading="lazy">` : catIcon(first.cat || 'other', 20)}</div>` : ''}
    </div>`;
}

// The whole chat pane: header, the listings this chat is about, the messages, and the composer.
// One template for the loading skeleton and the finished thread — two copies would drift.
// `bodyHtml` is whatever goes in #chatMsgs: skeleton bubbles, real bubbles, or the empty state.
//
// Rebuilt 2026-09-24 from the approved design: who you are talking to (verified, which school),
// the listings the chat is about pinned under the header (the way every marketplace keeps the item
// in view), day markers as pills, a line about keeping things in the app, and a round composer.
function chatShellHTML(otherUserId, info, bodyHtml) {
  const school = (typeof _schoolsList !== 'undefined' ? _schoolsList : []).find(s => s.slug === info.school)?.name || '';
  return `
    <div class="chat-header">
      <button class="m-back" onclick="closeConvo()" aria-label="Back to conversations"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <button class="msg-reopen-btn" onclick="reopenMsgSidebar()" title="Show conversations">&#8250;</button>
      <button class="ch-who" onclick="viewStudentProfile('${escAttr(otherUserId)}')" aria-label="View ${escAttr(info.name)}'s profile">
        ${avatarHTML({ ...info }, 40)}
        <span class="ch-who-text">
          <span class="ch-name">${esc(info.name)}${info.verified !== false ? `<span class="ld-verified">${icon('check', 11)} Verified</span>` : ''}</span>
          ${school ? `<span class="ch-school">${esc(school)}</span>` : ''}
        </span>
      </button>
    </div>
    <div class="ch-strip" id="chStrip"></div>
    <div class="chat-messages" id="chatMsgs">${bodyHtml}</div>
    <div class="ch-attach" id="chAttach"></div>
    <div class="chat-input-area">
      <button class="composer-plus" onclick="openListingPicker()" title="Share a listing" aria-label="Share a listing"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      <textarea class="chat-input" id="msgInput" placeholder="Message…" rows="1" aria-label="Message" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!isMobileView()){event.preventDefault();sMsg()}"></textarea>
      <button class="send-btn" onclick="sMsg()" aria-label="Send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>`;
}

// ---- The listings this chat is about ----
// One chat per pair of students, even across several listings (Kal's rule). So the strip under
// the header names them: one listing reads "About: Desk lamp · $25"; several fold into "3 listings
// in this chat" with their thumbnails, and open into a list.
let _chStripOpen = false;
function chStripPaint(refs) {
  const el = document.getElementById('chStrip');
  if (!el) return;
  if (!refs.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const thumb = r => `<span class="ch-thumb" data-cat="${escAttr(r.cat || 'other')}">${r.photo ? `<img src="${escAttr(r.photo)}" alt="">` : catIcon(r.cat || 'other', 16)}</span>`;
  const openFn = r => r.kind === 'book' ? `openBookDetail(${Number(r.id)})` : `openDetail(${Number(r.id)})`;
  const tag = r => r.sold ? '<span class="convo-tag is-sold">Sold</span>' : r.mine ? '<span class="convo-tag is-selling">Yours</span>' : '';
  if (refs.length === 1) {
    const r = refs[0];
    const act = openFn(r);
    el.innerHTML = `<button class="ch-strip-row" onclick="${act}">${thumb(r)}
      <span class="ch-strip-text"><b>${esc(r.title)}</b><span>${r.price}</span></span>${tag(r)}${icon('chevRight', 16)}</button>`;
    return;
  }
  el.innerHTML = `
    <button class="ch-strip-row" onclick="_chStripOpen=!_chStripOpen;chStripPaint(_chRefs)" aria-expanded="${_chStripOpen}">
      <span class="ch-stack">${refs.slice(0, 3).map(thumb).join('')}</span>
      <span class="ch-strip-text"><b>${refs.length} listings in this chat</b><span>${esc(refs.map(r => r.title).join(', '))}</span></span>
      <span class="ch-chev${_chStripOpen ? ' is-open' : ''}">${icon('chevDown', 16)}</span>
    </button>
    ${_chStripOpen ? `<div class="ch-strip-list">${refs.map(r => { const act = openFn(r); return `
      <button class="ch-strip-item" onclick="${act}">${thumb(r)}
        <span class="ch-strip-text"><b>${esc(r.title)}</b><span>${r.price}</span></span>${tag(r)}</button>`; }).join('')}</div>` : ''}`;
}
let _chRefs = [];

// ---- "Message the seller" sends the listing with the first message ----
// Opening a chat from a listing puts that listing above the composer, with a few quick replies
// (Facebook Marketplace's "Is this still available?" pattern: most first messages are one of a
// handful, and a tap is faster than typing on a phone). It goes WITH the first message — the
// card first, then the words — so the seller knows at once what the message is about. The × keeps
// it out; a listing already shared in this chat is not offered again.
const CH_QUICK = ['Hi! Is this still available?', 'Can I see it this week?', 'Is the price flexible?'];
function chAttachPaint() {
  const el = document.getElementById('chAttach');
  if (!el) return;
  const id = sConvoActive?.attach;
  const r = id ? convoRef('listing', id, getEffectiveUser()?.id) : null;
  if (!r) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="ch-quick">${CH_QUICK.map(t => `<button class="ch-quick-chip" onclick="chQuick(${escAttr(JSON.stringify(t))})">${esc(t)}</button>`).join('')}</div>
    <div class="ch-attach-card">
      <span class="ch-thumb" data-cat="${escAttr(r.cat || 'other')}">${r.photo ? `<img src="${escAttr(r.photo)}" alt="">` : catIcon(r.cat || 'other', 16)}</span>
      <span class="ch-strip-text"><span class="ch-attach-k">Sends with your message</span><b>${esc(r.title)}</b></span>
      <button class="ch-attach-x" onclick="sConvoActive.attach=null;chAttachPaint()" aria-label="Don't include this listing">${icon('x', 14)}</button>
    </div>`;
}
function chQuick(text) {
  const inp = document.getElementById('msgInput');
  if (!inp) return;
  inp.value = text;
  inp.focus();
}

// One bubble, for the thread, a sent message and a message arriving live — three places that used
// to build it separately.
function msgBubbleHTML(m, mine) {
  const mTime = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const ticks = mine ? `<span class="ticks${m.seen_at ? ' seen' : ''}">${m.seen_at ? icon('checkDouble', 15) : icon('check', 13)}</span>` : '';
  const isCard = m.message_type === 'listing';
  const body = isCard ? listingCardHtml(m.listing_id) : esc(m.content); // listingCardHtml builds its own escaped HTML
  return `<div class="msg-row ${mine ? 'mine' : ''}" data-mid="${m.id}"${mine && m.seen_at ? ' data-seen="1"' : ''}><div class="bubble ${mine ? 'mine' : 'theirs'}${isCard ? ' bubble-listing' : ''}">${quoteHtml(m.reply_to)}${body}<span class="bubble-meta">${mTime}${ticks}</span></div><button class="reply-hover" onclick="startReply('${m.id}')" title="Reply"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button></div>`;
}

// "Seen" under the last message I sent, once they have read it — the one read receipt that
// matters, instead of a double tick on every bubble being the only signal.
function chSeenPaint() {
  const msgs = document.getElementById('chatMsgs');
  if (!msgs) return;
  msgs.querySelectorAll('.msg-seen').forEach(n => n.remove());
  const mineRows = msgs.querySelectorAll('.msg-row.mine');
  const last = mineRows[mineRows.length - 1];
  if (last && last.dataset.seen === '1' && last === msgs.querySelector('.msg-row:last-of-type')) {
    last.insertAdjacentHTML('afterend', '<div class="msg-seen">Seen</div>');
  }
}

// A new thread's first message gets the safety line under its day marker, like a loaded one.
function chFirstDay(msgs) {
  if (!msgs.querySelector('.date-divider')) { appendDateDivider(msgs, new Date()); msgs.insertAdjacentHTML('beforeend', CH_SAFETY); }
}
const CH_SAFETY = `<div class="chat-safety">${icon('lock', 12)} Keep it in Nestrel until you've met. You never have to share your number.</div>`;

async function openConvo(otherUserId, otherInfo, listingId) {
  // What a caller passes (name, initials, colour) merged over what the list already loaded
  // (photo, school) — so opening from a listing does not lose the avatar the inbox had.
  const info = { ...(sConvoCache[otherUserId] || {}), ...(otherInfo || {}) };
  if (!info.name) return;
  if (isMobileView()) enterConvoMode(); // phones: full-screen chat, chrome hidden
  if (typeof ibTab === 'function' && _ibTab !== 'messages') ibTab('messages');   // a chat belongs to the Messages tab
  if (sRealtimeChannel) { supabaseClient.removeChannel(sRealtimeChannel); sRealtimeChannel = null; }
  sReplyTo = null; sMsgCache = {}; // reply state never carries across conversations
  sConvoActive = { userId: otherUserId, name: info.name, initials: info.initials, color: info.color, listingId: listingId || null };
  sConvoCache[otherUserId] = info;
  _chStripOpen = false;
  const _owner = getEffectiveUser();
  if (_owner) sessionStorage.setItem('cn_last_convo', JSON.stringify({ ownerId: _owner.id, userId: otherUserId, info: sConvoCache[otherUserId], listingId: listingId || null }));
  renderConvos();

  const eu = getEffectiveUser();
  const convKey = [eu.id, otherUserId].sort().join(':');

  // Paint the shell straight away. We already know who this conversation is with,
  // so the header and composer are real from the first frame — only the bubbles
  // are placeholders while the messages come down.
  document.getElementById('chatArea').innerHTML = chatShellHTML(otherUserId, info, threadSkeletonHTML());

  const { data: msgs } = await supabaseClient
    .from('messages').select('*')
    .eq('conversation_key', convKey)
    .order('created_at', { ascending: true });

  // Bail if the user switched to a DIFFERENT conversation while this was in flight.
  // Everything below writes shared state (sMsgCache, sLastDivLabel, #chatArea), so a
  // late reply from the previous conversation used to paint its messages into the
  // pane now labelled with someone else's name.
  // Note the deliberate `sConvoActive &&`: if the chat was *closed* mid-fetch
  // sConvoActive is null, and we let the paint finish rather than leaving the
  // loading skeleton shimmering in the pane forever.
  if (sConvoActive && sConvoActive.userId !== otherUserId) return;

  // Viewing the thread is what "reads" it — the helper checks the window is
  // actually visible/focused, so a background window can't fake a read receipt.
  markActiveConvoSeen();

  sLastDivLabel = null;
  const parts = [];
  for (const m of (msgs || [])) sMsgCache[m.id] = { content: m.content, senderId: m.sender_id }; // fill before rendering so quotes can look up any message, even earlier ones
  for (const m of (msgs || [])) {
    const dLabel = chatDateLabel(m.created_at);
    if (dLabel !== sLastDivLabel) {
      parts.push(`<div class="divider date-divider">${dLabel}</div>`);
      if (sLastDivLabel === null) parts.push(CH_SAFETY);   // once, under the first day
      sLastDivLabel = dLabel;
    }
    parts.push(msgBubbleHTML(m, m.sender_id === eu.id));
  }
  // The listings this chat is about, newest first; and whether the one it was opened from still
  // needs sending (not if its card is already in the thread).
  _chRefs = (convoSummaries([...(msgs || [])].reverse(), eu.id)[0] || { refs: [] }).refs;
  const shared = (msgs || []).some(m => m.message_type === 'listing' && String(m.listing_id) === String(listingId));
  sConvoActive.attach = listingId && !shared ? listingId : null;
  // Keep the words "No messages yet" — sMsg() and the realtime handlers find this
  // placeholder by that text and remove it when the first message lands.
  const bubbles = parts.join('') || `<div class="empty-state">
      <div class="empty-state-title">No messages yet</div>
      <div class="empty-state-sub">Say hello — this is the start of your conversation.</div>
    </div>`;

  document.getElementById('chatArea').innerHTML = chatShellHTML(otherUserId, info, bubbles);
  chStripPaint(_chRefs);
  chAttachPaint();
  chSeenPaint();
  scrollChat();
  sRealtimeChannel = supabaseClient.channel('msgs-' + convKey)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_key=eq.${convKey}` }, handleRealtimeMessage)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_key=eq.${convKey}` }, handleSeenUpdate)
    .subscribe();
}

async function sMsg() {
  const inp = document.getElementById('msgInput');
  const text = inp.value.trim();
  const eu = getEffectiveUser();
  if (!sConvoActive || !eu) return;
  // Held here: sending the listing card below clears the reply state, and the words still reply.
  const replyTo = sReplyTo;
  if (!text) {
    // A listing waiting to go can be sent on its own; otherwise an empty send does nothing.
    if (sConvoActive.attach) { const id = sConvoActive.attach; sConvoActive.attach = null; chAttachPaint(); await sendListingMsg(id); }
    return;
  }
  // The listing this chat was opened from goes first, so the words arrive under it.
  if (sConvoActive.attach) {
    const id = sConvoActive.attach;
    sConvoActive.attach = null;
    chAttachPaint();
    await sendListingMsg(id);
  }

  const payload = {
    sender_id: eu.id,
    receiver_id: sConvoActive.userId,
    listing_id: sConvoActive.listingId || null,
    content: text
  };
  if (replyTo) payload.reply_to = replyTo.id; // column is reply_to (see ROADMAP note — reply_to_id was never created)
  const { data: sent, error } = await supabaseClient.from('messages').insert(payload).select().single();
  if (error) { toast('Could not send — please try again.'); console.error('sMsg error:', error); return; }

  inp.value = '';
  const quote = replyTo ? quoteHtml(replyTo.id) : '';
  cancelReply();
  if (sent) sMsgCache[sent.id] = { content: sent.content, senderId: sent.sender_id };
  const msgs = document.getElementById('chatMsgs');
  const ph = msgs.firstElementChild;
  if (ph && ph.textContent.includes('No messages yet')) ph.remove(); // clear the empty-thread placeholder on first send
  chFirstDay(msgs);
  appendDateDivider(msgs, new Date());
  msgs.insertAdjacentHTML('beforeend', msgBubbleHTML(sent || { id: '', created_at: new Date().toISOString(), content: text }, true));
  // quoteHtml is read from the message's reply_to, which the local row may not carry yet
  if (quote && sent && !sent.reply_to) msgs.lastElementChild.querySelector('.bubble')?.insertAdjacentHTML('afterbegin', quote);
  chSeenPaint();
  scrollChat();
  renderConvos();
}

function scrollChat() { setTimeout(() => { const m = document.getElementById('chatMsgs'); if (m) m.scrollTop = m.scrollHeight; }, 50); }

// ── Listing sharing in chat ──────────────────────────────────
let _lpScope = 'all'; // picker filter: all | mine | theirs
let _lpView = localStorage.getItem('cn_lp_view') || 'list'; // list | grid — remembered across sessions

function openListingPicker() {
  if (!sConvoActive) return;
  _lpScope = 'all';
  document.getElementById('listingPicker')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'listingPicker';
  wrap.innerHTML = `
    <div class="lp-backdrop" onclick="closeListingPicker()"></div>
    <div class="lp-sheet">
      <div class="lp-head">
        <div class="lp-title">Share a listing</div>
        <div class="lp-view-btns">
          <button class="lp-view-btn" id="lpView-list" onclick="setLpView('list')" title="List view"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
          <button class="lp-view-btn" id="lpView-grid" onclick="setLpView('grid')" title="Grid view"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg></button>
        </div>
      </div>
      <input class="search-input" id="lpSearch" placeholder="Search listings..." oninput="renderListingPicker()">
      <div class="lp-chips">
        <button class="filter-chip active" id="lpChip-all" onclick="setLpScope('all')">All</button>
        <button class="filter-chip" id="lpChip-mine" onclick="setLpScope('mine')">My listings</button>
        <button class="filter-chip" id="lpChip-theirs" onclick="setLpScope('theirs')">${esc(sConvoActive.name)}'s listings</button>
      </div>
      <div class="lp-results" id="lpResults"></div>
    </div>`;
  document.body.appendChild(wrap);
  setLpView(_lpView); // paints toggle state + renders results
  if (!isMobileView()) document.getElementById('lpSearch').focus(); // no keyboard jump on phones
}

function closeListingPicker() { document.getElementById('listingPicker')?.remove(); }

function setLpScope(s) {
  _lpScope = s;
  ['all', 'mine', 'theirs'].forEach(k => document.getElementById('lpChip-' + k)?.classList.toggle('active', k === s));
  renderListingPicker();
}

function setLpView(v) {
  _lpView = v;
  localStorage.setItem('cn_lp_view', v);
  ['list', 'grid'].forEach(k => document.getElementById('lpView-' + k)?.classList.toggle('active', k === v));
  renderListingPicker();
}

// No-photo fallback for small thumbs: category-colored tile with the category's
// line-art icon — same palette as the browse cards, no text to overflow the box.
function lpCatTile(l, extraClass) {
  const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
  return `<div class="${extraClass} lp-cat-tile" style="background:${cat.bg};color:${cat.text}">${catIcon(l.category, 18)}</div>`;
}

function renderListingPicker() {
  const eu = getEffectiveUser();
  if (!eu || !sConvoActive) return;
  const q = (document.getElementById('lpSearch')?.value || '').trim().toLowerCase();
  const list = DB.listings
    .filter(l => l.status === 'approved')
    .filter(l => _lpScope === 'mine' ? l.poster_id === eu.id : _lpScope === 'theirs' ? l.poster_id === sConvoActive.userId : true)
    .filter(l => !q || (l.title || '').toLowerCase().includes(q))
    .slice(0, 30);
  const results = document.getElementById('lpResults');
  results.classList.toggle('lp-grid', _lpView === 'grid');
  if (!list.length) {
    // Say WHICH of the three reasons it's empty, so the fix is obvious.
    const why = q ? `Nothing matches “${esc(q)}”.`
      : _lpScope === 'mine'   ? 'You haven\'t posted anything yet.'
      : _lpScope === 'theirs' ? 'They haven\'t posted anything yet.'
      : 'There\'s nothing to share yet.';
    results.innerHTML = `<div class="lp-none">${why}</div>`;
    return;
  }
  results.innerHTML = _lpView === 'grid'
    ? list.map(l => {
      // Photo tiles carry the title below; no-photo tiles put the title INSIDE the
      // colored panel (browse-card style) so nothing is written twice.
      const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
      const tile = l.photo_urls?.[0]
        ? `<img class="lp-gthumb" src="${escAttr(l.photo_urls[0])}" alt="">`
        : `<div class="lp-gthumb lp-gnoimg" style="background:${cat.bg};color:${cat.text}"><span class="lp-gtitle">${esc(l.title)}</span></div>`;
      return `<div class="lp-gitem" onclick="sendListingMsg(${l.id})">${tile}${l.photo_urls?.[0] ? `<div class="lp-gname">${esc(l.title)}</div>` : ''}<div class="lp-item-price">${l.rent ? '$' + l.rent : 'Free'}</div></div>`;
    }).join('')
    : list.map(l => `
      <div class="lp-item" onclick="sendListingMsg(${l.id})">
        ${l.photo_urls?.[0] ? `<img class="lp-thumb" src="${escAttr(l.photo_urls[0])}" alt="">` : lpCatTile(l, 'lp-thumb')}
        <div><div class="lp-item-title">${esc(l.title)}</div><div class="lp-item-price">${l.rent ? '$' + l.rent : 'Free'}</div></div>
      </div>`).join('');
}

// Compact card rendered inside a bubble for message_type === 'listing'.
// Looks the listing up in the already-loaded DB.listings — if it was removed
// since, a quiet placeholder renders instead of a broken card. A card shared
// last week stays honest: sold/expired/pending-sale get a badge today.
function listingCardHtml(listingId) {
  const l = DB.listings.find(x => String(x.id) === String(listingId) && x.status === 'approved');
  if (!l) return '<div class="msg-listing-card msg-listing-gone">Listing no longer available</div>';
  let stateBadge = '';
  if (!isListingLive(l) || l.lifecycle_status === 'pending_sale') {
    const [bg, col, label] = listingLifecycleBadge(l);
    stateBadge = `<span class="pill" style="background:${bg};color:${col};font-size:10px;margin-left:6px">${label}</span>`;
  }
  // A mini listing card, as in the approved chat design: the photo on top, then what it is, its
  // title and its price — enough to recognise it without opening it.
  const img = l.photo_urls?.[0] ? `<img src="${escAttr(l.photo_urls[0])}" alt="">` : catIcon(l.category, 26);
  return `<div class="msg-listing-card" onclick="openDetail(${l.id})">
    <div class="mlc-img" data-cat="${escAttr(l.category)}">${img}</div>
    <div class="mlc-body"><span class="mlc-cat" data-cat="${escAttr(l.category)}">${esc(CATEGORY_LABELS[l.category] || 'Listing')}</span>
      <div class="mlc-title">${esc(l.title)}${stateBadge}</div><div class="mlc-price">${priceLabel(l)}</div></div></div>`;
}

async function sendListingMsg(listingId) {
  const eu = getEffectiveUser();
  const l = DB.listings.find(x => String(x.id) === String(listingId));
  if (!eu || !sConvoActive || !l) return;
  closeListingPicker();
  cancelReply(); // a shared card replaces whatever reply was being composed
  const { data: sent, error } = await supabaseClient.from('messages').insert({
    sender_id: eu.id,
    receiver_id: sConvoActive.userId,
    listing_id: l.id,
    message_type: 'listing',
    content: l.title // conversation-list previews show the title, not an empty row
  }).select().single();
  if (error) { toast('Could not share — please try again.'); console.error('sendListingMsg:', error); return; }
  const msgs = document.getElementById('chatMsgs');
  if (msgs && sent) {
    const ph = msgs.firstElementChild;
    if (ph && ph.textContent.includes('No messages yet')) ph.remove();
    chFirstDay(msgs);
    appendDateDivider(msgs, new Date());
    sMsgCache[sent.id] = { content: l.title, senderId: eu.id };
    msgs.insertAdjacentHTML('beforeend', msgBubbleHTML(sent, true));
    chSeenPaint();
    scrollChat();
  }
  // The strip under the header learns about the listing straight away.
  if (!_chRefs.some(r => r.kind === 'listing' && String(r.id) === String(l.id))) {
    const r = convoRef('listing', l.id, eu.id);
    if (r) { _chRefs.unshift(r); chStripPaint(_chRefs); }
  }
  renderConvos();
}

async function handleRealtimeMessage(payload) {
  const msg = payload.new;
  const eu = getEffectiveUser();
  if (!msg || !eu) return;
  if (msg.sender_id === eu.id) return; // already rendered locally on send
  if (isViewingActiveConvo()) {
    // The thread is genuinely on screen — this message is seen the moment it lands.
    const { data, error } = await supabaseClient.from('messages').update({ seen_at: new Date().toISOString() }).eq('id', msg.id).select('id');
    if (error) console.warn('mark seen:', error.message);
    else if (!data || data.length === 0) console.warn('mark seen updated 0 rows — messages table is missing GRANT UPDATE and/or the receiver UPDATE policy');
  } else {
    msgToastFor(msg); // convo open in the background (desktop) — banner + badges
  }
  if (sConvoActive) {
    const msgs = document.getElementById('chatMsgs');
    if (msgs) {
      const first = msgs.firstElementChild;
      if (first && first.textContent.includes('No messages yet')) first.remove();
      appendDateDivider(msgs, msg.created_at);
      sMsgCache[msg.id] = { content: msg.content, senderId: msg.sender_id };
      msgs.insertAdjacentHTML('beforeend', msgBubbleHTML(msg, false));
      chSeenPaint();   // their reply is now the last message, so "Seen" steps aside
      if (msg.listing_id && !_chRefs.some(r => r.kind === 'listing' && String(r.id) === String(msg.listing_id))) {
        const r = convoRef('listing', msg.listing_id, eu.id);
        if (r) { _chRefs.unshift(r); chStripPaint(_chRefs); }
      }
      scrollChat();
    }
  }
  renderConvos(); // repaints list + DB-derived badges (after mark-seen, so counts are right)
}

// The other side marked my messages seen → flip ✓ to ✓✓ live on the open thread.
function handleSeenUpdate(payload) {
  const m = payload.new;
  const eu = getEffectiveUser();
  if (!m || !eu || !m.seen_at || m.sender_id !== eu.id) return;
  const row = document.querySelector(`.msg-row[data-mid="${m.id}"]`);
  const tick = row?.querySelector('.ticks');
  if (tick) { tick.innerHTML = icon('checkDouble',15); tick.classList.add('seen'); }
  if (row) { row.dataset.seen = '1'; chSeenPaint(); }
}

// Tappable banner for a message arriving while the user is anywhere but the Messages page.
async function msgToastFor(msg) {
  if (document.getElementById('page-messages')?.classList.contains('active')) return;
  let info = sConvoCache[msg.sender_id];
  if (!info) {
    const { data: p } = await supabaseClient.from('public_profiles').select('first_name, last_name, display_name, initials, color').eq('id', msg.sender_id).single();
    if (p) { info = { name: p.display_name || (p.first_name + ' ' + p.last_name), initials: p.initials, color: p.color }; sConvoCache[msg.sender_id] = info; }
  }
  document.getElementById('msgToast')?.remove();
  const t = document.createElement('div');
  t.id = 'msgToast';
  t.className = 'msg-toast';
  t.innerHTML = `<div class="msg-toast-name">${esc(info?.name || 'New message')}</div><div class="msg-toast-preview">${esc(msg.content)}</div>`;
  t.onclick = () => { t.remove(); showPage('messages'); openConvo(msg.sender_id); };
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4500);
}

function startGlobalMsgListener(userId) {
  if (sGlobalMsgChannel) { supabaseClient.removeChannel(sGlobalMsgChannel); sGlobalMsgChannel = null; }
  sGlobalMsgChannel = supabaseClient
    .channel('global-msgs-' + userId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${userId}` }, handleGlobalMessage)
    .subscribe();
  refreshUnread(); // badges are correct from the moment of login/refresh
}

function startNotifListener(userId) {
  if (sNotifChannel) { supabaseClient.removeChannel(sNotifChannel); sNotifChannel = null; }
  sNotifChannel = supabaseClient
    .channel('notifs-' + userId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `profile_id=eq.${userId}` }, handleNotif)
    .subscribe();
}

function handleNotif(payload) {
  if (!payload.new) return;
  const eu = getEffectiveUser();
  if (!eu) return;
  checkStudentNotifications(eu.id);
}

function startProfileListener(userId) {
  if (sProfileChannel) { supabaseClient.removeChannel(sProfileChannel); sProfileChannel = null; }
  sProfileChannel = supabaseClient
    .channel('profile-status-' + userId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` }, handleProfileUpdate)
    .subscribe();
}

async function handleProfileUpdate(payload) {
  const profile = payload.new;
  if (!profile) return;
  if (profile.status === 'suspended') {
    const { data: sh } = await supabaseClient
      .from('suspension_history')
      .select('id')
      .eq('profile_id', profile.id)
      .eq('action', 'suspended')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    showSuspensionScreen(profile.email || sUser?.email, profile.id, profile.suspension_reason, sh?.id || null);
  } else if (profile.status === 'active') {
    const screen = document.getElementById('suspendedScreen');
    if (screen && screen.style.display !== 'none') {
      hideSuspensionScreen();
      toast('Your account has been reinstated. Welcome back!');
    }
  }
}

function handleGlobalMessage(payload) {
  const msg = payload.new;
  const eu = getEffectiveUser();
  if (!msg || !eu) return;
  if (msg.sender_id === eu.id) return;
  // Skip if this is the active conversation — sRealtimeChannel already handles it
  if (sConvoActive) {
    const activeKey = [eu.id, sConvoActive.userId].sort().join(':');
    if (msg.conversation_key === activeKey) return;
  }
  msgToastFor(msg); // no-op if the Messages page is on screen (list row + badge suffice)
  renderConvos();   // repaints list + DB-derived badges
}

// Owner-facing status badge — folds the moderation status AND the student lifecycle
// state into one label, since a listing can be status='approved' but sold/withdrawn/expired.
function listingLifecycleBadge(l) {
  const modBadge = { pinned: ['#e8f5e9','#1a7a45','Pinned'], pending: ['#fff8e1','#b87a00','Pending review'], rejected: ['#fde8e8','#c0392b','Rejected'], removed: ['#f0f0f0','#888','Removed'] };
  if (l.pinned) return modBadge.pinned;
  if (l.status !== 'approved') return modBadge[l.status] || modBadge.pending;
  const isExpired = l.expires_at && new Date(l.expires_at) <= new Date();
  if (isExpired && (l.lifecycle_status === 'active' || l.lifecycle_status === 'pending_sale')) return ['#f0f0f0','#888','Expired'];
  const soldLabel = l.rent ? 'Sold' : 'Claimed';
  const lcBadge = { active: ['#e8f5e9','#1a7a45','Active'], pending_sale: ['#e8f0fd','#3B5BA5','Pending sale'], sold: ['#f0f0f0','#888', soldLabel], withdrawn: ['#f0f0f0','#888','Withdrawn'] };
  return lcBadge[l.lifecycle_status] || lcBadge.active;
}

function renderListingGrid(listings, isOwn) {
  // Everything a student typed is escaped on the way in. viewStudentProfile() draws someone
  // ELSE's listings with this, so a raw title would be markup authored by a stranger running in
  // the viewer's browser, and a raw photo URL could close src="…" and add an attribute of its
  // own. Guarded by check 6 in tests/load-order.js.
  if (!listings || !listings.length) {
    return `<div style="text-align:center;padding:28px 0;color:var(--text-faint);font-size:13px">
      ${isOwn ? `No listings yet. <a onclick="openModal('postModal')" style="color:var(--brand);cursor:pointer">Post one now →</a>` : 'No active listings yet.'}
    </div>`;
  }
  return `<div class="listing-grid">${listings.map(l => {
    const [bg, col, label] = listingLifecycleBadge(l);
    const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
    const rent = l.rent ? (l.category === 'housing' ? `$${l.rent}/mo` : `$${l.rent}`) : '';
    const inner = l.photo_urls?.[0]
      ? `<img src="${escAttr(l.photo_urls[0])}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" loading="lazy" alt="${escAttr(l.title)}">
         <div class="lg-cap"><div class="lg-cap-title">${esc(l.title)}</div><div class="lg-cap-rent">${esc(rent)}</div></div>`
      : `<div class="lg-fill" style="background:${cat.bg};color:${cat.text}"><div class="lg-fill-title">${esc(l.title)}</div></div>
         <div class="lg-cap"><div class="lg-cap-rent">${esc(rent)}</div></div>`;
    return `<div class="lg-cell" onclick="${l.isBook ? 'openBookDetail' : 'openDetail'}(${l.id})">
      ${inner}
      ${isOwn ? `<div class="lg-badge" style="background:${bg};color:${col}">${label}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}
