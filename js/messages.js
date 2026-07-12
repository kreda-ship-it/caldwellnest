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
let msgOpenTimer = null;
let msgCloseTimer = null;

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
  return `<div class="bubble-quote" onclick="scrollToMsg('${replyToId}')"><span class="bq-name">${name}</span><span class="bq-text">${text}</span></div>`;
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
  bar.innerHTML = `<div class="reply-bar-body"><span class="bq-name">${sReplyTo.name}</span><span class="bq-text">${sReplyTo.content}</span></div><button class="reply-bar-x" onclick="cancelReply()" aria-label="Cancel reply">&times;</button>`;
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

async function renderConvos() {
  const eu = getEffectiveUser();
  if (!eu) return;
  await refreshUnread();
  const { data: msgs } = await supabaseClient
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${eu.id},receiver_id.eq.${eu.id}`)
    .order('created_at', { ascending: false });

  if (!msgs || msgs.length === 0) {
    document.getElementById('convoList').innerHTML = '<div style="padding:20px;color:var(--text-faint);font-size:13px;text-align:center">No messages yet.<br>Find a listing and tap Message.</div>';
    return;
  }

  const seen = new Set();
  const latest = [];
  for (const m of msgs) {
    if (!seen.has(m.conversation_key)) { seen.add(m.conversation_key); latest.push(m); }
  }

  const otherIds = latest.map(m => m.sender_id === eu.id ? m.receiver_id : m.sender_id);
  const { data: profiles } = await supabaseClient.from('profiles').select('id, first_name, last_name, display_name, initials, color').in('id', otherIds);
  const pMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

  for (const [id, p] of Object.entries(pMap)) {
    sConvoCache[id] = { name: p.display_name || (p.first_name + ' ' + p.last_name), initials: p.initials, color: p.color };
  }

  document.getElementById('convoList').innerHTML = latest.map(m => {
    const otherId = m.sender_id === eu.id ? m.receiver_id : m.sender_id;
    const p = pMap[otherId] || { display_name: null, first_name: 'User', last_name: '', initials: '?', color: '#888' };
    const isActive = sConvoActive && sConvoActive.userId === otherId;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const unread = sUnread[m.conversation_key] || 0;
    return `<div class="convo-item ${isActive ? 'active-convo' : ''}" onclick="openConvo('${otherId}')">
      <div class="convo-avatar" style="background:${p.color}">${p.initials}</div>
      <div class="convo-info"><div class="convo-name">${p.display_name || (p.first_name + ' ' + p.last_name)}</div><div class="convo-preview${unread ? ' unread' : ''}">${m.content}</div></div>
      <div class="convo-meta"><div class="convo-time">${time}</div>${unread ? `<div class="convo-badge">${unread}</div>` : ''}</div>
    </div>`;
  }).join('');
}

function filterConvos(q) { document.querySelectorAll('.convo-item').forEach(item => { item.style.display = item.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none'; }); }

async function openConvo(otherUserId, otherInfo, listingId) {
  const info = otherInfo || sConvoCache[otherUserId];
  if (!info) return;
  if (isMobileView()) enterConvoMode(); // phones: full-screen chat, chrome hidden
  if (sRealtimeChannel) { supabaseClient.removeChannel(sRealtimeChannel); sRealtimeChannel = null; }
  sReplyTo = null; sMsgCache = {}; // reply state never carries across conversations
  sConvoActive = { userId: otherUserId, name: info.name, initials: info.initials, color: info.color, listingId: listingId || null };
  sConvoCache[otherUserId] = { name: info.name, initials: info.initials, color: info.color };
  const _owner = getEffectiveUser();
  if (_owner) sessionStorage.setItem('cn_last_convo', JSON.stringify({ ownerId: _owner.id, userId: otherUserId, info: sConvoCache[otherUserId], listingId: listingId || null }));
  renderConvos();

  const eu = getEffectiveUser();
  const convKey = [eu.id, otherUserId].sort().join(':');
  const { data: msgs } = await supabaseClient
    .from('messages').select('*')
    .eq('conversation_key', convKey)
    .order('created_at', { ascending: true });

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
      sLastDivLabel = dLabel;
    }
    const mine = m.sender_id === eu.id;
    const mTime = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ticks = mine ? `<span class="ticks${m.seen_at ? ' seen' : ''}">${m.seen_at ? '&#10003;&#10003;' : '&#10003;'}</span>` : '';
    const isCard = m.message_type === 'listing';
    const body = isCard ? listingCardHtml(m.listing_id) : m.content;
    parts.push(`<div class="msg-row ${mine ? 'mine' : ''}" data-mid="${m.id}"><div class="bubble ${mine ? 'mine' : 'theirs'}${isCard ? ' bubble-listing' : ''}">${quoteHtml(m.reply_to)}${body}<span class="bubble-meta">${mTime}${ticks}</span></div><button class="reply-hover" onclick="startReply('${m.id}')" title="Reply"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button></div>`);
  }
  const bubbles = parts.join('') || '<div style="text-align:center;color:var(--text-faint);font-size:13px;padding:40px 0">No messages yet. Say hello!</div>';

  document.getElementById('chatArea').innerHTML = `
    <div class="chat-header">
      <button class="m-back" onclick="closeConvo()" aria-label="Back to conversations"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <button class="msg-reopen-btn" onclick="reopenMsgSidebar()" title="Show conversations">&#8250;</button>
      <div class="convo-avatar" style="background:${info.color};width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#fff;cursor:pointer" onclick="viewStudentProfile('${otherUserId}')">${info.initials}</div>
      <div><div class="chat-header-name"><span class="stu-link" onclick="viewStudentProfile('${otherUserId}')">${info.name}</span></div></div>
    </div>
    <div class="chat-messages" id="chatMsgs">${bubbles}</div>
    <div class="chat-input-area">
      <button class="composer-plus" onclick="openListingPicker()" title="Share a listing"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      <textarea class="chat-input" id="msgInput" placeholder="Write a message..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!isMobileView()){event.preventDefault();sMsg()}"></textarea>
      <button class="send-btn" onclick="sMsg()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
    </div>`;
  scrollChat();
  if (sConvoActive.userId !== otherUserId) return;
  sRealtimeChannel = supabaseClient.channel('msgs-' + convKey)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_key=eq.${convKey}` }, handleRealtimeMessage)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_key=eq.${convKey}` }, handleSeenUpdate)
    .subscribe();
}

async function sMsg() {
  const inp = document.getElementById('msgInput');
  const text = inp.value.trim();
  const eu = getEffectiveUser();
  if (!text || !sConvoActive || !eu) return;

  const payload = {
    sender_id: eu.id,
    receiver_id: sConvoActive.userId,
    listing_id: sConvoActive.listingId || null,
    content: text
  };
  if (sReplyTo) payload.reply_to = sReplyTo.id; // column is reply_to (see ROADMAP note — reply_to_id was never created)
  const { data: sent, error } = await supabaseClient.from('messages').insert(payload).select().single();
  if (error) { toast('Could not send — please try again.'); console.error('sMsg error:', error); return; }

  inp.value = '';
  const quote = sReplyTo ? quoteHtml(sReplyTo.id) : '';
  cancelReply();
  if (sent) sMsgCache[sent.id] = { content: sent.content, senderId: sent.sender_id };
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgs = document.getElementById('chatMsgs');
  const ph = msgs.firstElementChild;
  if (ph && ph.textContent.includes('No messages yet')) ph.remove(); // clear the empty-thread placeholder on first send
  appendDateDivider(msgs, new Date());
  const div = document.createElement('div'); div.className = 'msg-row mine';
  if (sent) div.dataset.mid = sent.id;
  div.innerHTML = `<div class="bubble mine">${quote}${text}<span class="bubble-meta">${time}<span class="ticks">&#10003;</span></span></div><button class="reply-hover" onclick="startReply('${sent?.id ?? ''}')" title="Reply"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>`;
  msgs.appendChild(div);
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
        <button class="filter-chip" id="lpChip-theirs" onclick="setLpScope('theirs')">${sConvoActive.name}'s listings</button>
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
    .filter(l => !q || l.title.toLowerCase().includes(q))
    .slice(0, 30);
  const results = document.getElementById('lpResults');
  results.classList.toggle('lp-grid', _lpView === 'grid');
  if (!list.length) { results.innerHTML = '<div class="lp-none">No listings found.</div>'; return; }
  results.innerHTML = _lpView === 'grid'
    ? list.map(l => {
      // Photo tiles carry the title below; no-photo tiles put the title INSIDE the
      // colored panel (browse-card style) so nothing is written twice.
      const cat = CATEGORY_COLORS[l.category] || CATEGORY_COLORS.other;
      const tile = l.photo_urls?.[0]
        ? `<img class="lp-gthumb" src="${l.photo_urls[0]}" alt="">`
        : `<div class="lp-gthumb lp-gnoimg" style="background:${cat.bg};color:${cat.text}"><span class="lp-gtitle">${l.title}</span></div>`;
      return `<div class="lp-gitem" onclick="sendListingMsg(${l.id})">${tile}${l.photo_urls?.[0] ? `<div class="lp-gname">${l.title}</div>` : ''}<div class="lp-item-price">${l.rent ? '$' + l.rent : 'Free'}</div></div>`;
    }).join('')
    : list.map(l => `
      <div class="lp-item" onclick="sendListingMsg(${l.id})">
        ${l.photo_urls?.[0] ? `<img class="lp-thumb" src="${l.photo_urls[0]}" alt="">` : lpCatTile(l, 'lp-thumb')}
        <div><div class="lp-item-title">${l.title}</div><div class="lp-item-price">${l.rent ? '$' + l.rent : 'Free'}</div></div>
      </div>`).join('');
}

// Compact card rendered inside a bubble for message_type === 'listing'.
// Looks the listing up in the already-loaded DB.listings — if it was removed
// since, a quiet placeholder renders instead of a broken card. A card shared
// last week stays honest: sold/expired/pending-sale get a badge today.
function listingCardHtml(listingId) {
  const l = DB.listings.find(x => String(x.id) === String(listingId) && x.status === 'approved');
  if (!l) return '<div class="msg-listing-card msg-listing-gone">Listing no longer available</div>';
  const thumb = l.photo_urls?.[0] ? `<img class="mlc-thumb" src="${l.photo_urls[0]}" alt="">` : lpCatTile(l, 'mlc-thumb');
  let stateBadge = '';
  if (!isListingLive(l) || l.lifecycle_status === 'pending_sale') {
    const [bg, col, label] = listingLifecycleBadge(l);
    stateBadge = `<span class="pill" style="background:${bg};color:${col};font-size:10px;margin-left:6px">${label}</span>`;
  }
  return `<div class="msg-listing-card" onclick="openDetail(${l.id})">${thumb}<div><div class="mlc-title">${l.title}${stateBadge}</div><div class="mlc-price">${l.rent ? '$' + l.rent : 'Free'}</div></div></div>`;
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
    appendDateDivider(msgs, new Date());
    sMsgCache[sent.id] = { content: l.title, senderId: eu.id };
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div'); div.className = 'msg-row mine'; div.dataset.mid = sent.id;
    div.innerHTML = `<div class="bubble mine bubble-listing">${listingCardHtml(l.id)}<span class="bubble-meta">${time}<span class="ticks">&#10003;</span></span></div>`;
    msgs.appendChild(div);
    scrollChat();
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
      const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const div = document.createElement('div'); div.className = 'msg-row';
      div.dataset.mid = msg.id;
      const isCard = msg.message_type === 'listing';
      div.innerHTML = `<div class="bubble theirs${isCard ? ' bubble-listing' : ''}">${quoteHtml(msg.reply_to)}${isCard ? listingCardHtml(msg.listing_id) : msg.content}<span class="bubble-meta">${time}</span></div><button class="reply-hover" onclick="startReply('${msg.id}')" title="Reply"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></button>`;
      msgs.appendChild(div);
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
  const tick = document.querySelector(`.msg-row[data-mid="${m.id}"] .ticks`);
  if (tick) { tick.innerHTML = '&#10003;&#10003;'; tick.classList.add('seen'); }
}

// Tappable banner for a message arriving while the user is anywhere but the Messages page.
async function msgToastFor(msg) {
  if (document.getElementById('page-messages')?.classList.contains('active')) return;
  let info = sConvoCache[msg.sender_id];
  if (!info) {
    const { data: p } = await supabaseClient.from('profiles').select('first_name, last_name, display_name, initials, color').eq('id', msg.sender_id).single();
    if (p) { info = { name: p.display_name || (p.first_name + ' ' + p.last_name), initials: p.initials, color: p.color }; sConvoCache[msg.sender_id] = info; }
  }
  document.getElementById('msgToast')?.remove();
  const t = document.createElement('div');
  t.id = 'msgToast';
  t.className = 'msg-toast';
  t.innerHTML = `<div class="msg-toast-name">${info?.name || 'New message'}</div><div class="msg-toast-preview">${msg.content}</div>`;
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
      ? `<img src="${l.photo_urls[0]}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" loading="lazy" alt="${escAttr(l.title)}">
         <div class="lg-cap"><div class="lg-cap-title">${l.title}</div><div class="lg-cap-rent">${rent}</div></div>`
      : `<div class="lg-fill" style="background:${cat.bg};color:${cat.text}"><div class="lg-fill-title">${l.title}</div></div>
         <div class="lg-cap"><div class="lg-cap-rent">${rent}</div></div>`;
    return `<div class="lg-cell" onclick="${l.isBook ? 'openBookDetail' : 'openDetail'}(${l.id})">
      ${inner}
      ${isOwn ? `<div class="lg-badge" style="background:${bg};color:${col}">${label}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}
