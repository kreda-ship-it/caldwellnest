// ============================================================
// INBOX — the Messages / Activity tabs, and the Activity feed (2026-09-24)
// ============================================================
// From the approved Inbox design. Messages and notifications live on one page as two tabs, the
// way Instagram, Depop and Airbnb keep them: next to each other, but never mixed — a notification
// must not push a reply out of sight, and a reply must not bury "your listing was removed".
// The chat icon opens Messages, the bell opens Activity.
//
// WHAT ACTIVITY SHOWS, and where each piece comes from:
//   stored    rows in `notifications` (written by admins: a listing removed, an appeal decided)
//   worked out, from data this student can already read — nothing new is stored:
//     an event you are going to starts within a day          (event_registrations + visible_events)
//     an event you went to is waiting for your rating        (evPendingRatings in events.js)
//     a club you follow posted an event or an announcement   (visible_events, org_posts)
//     your listing is live                                   (your own listings)
// NOT here, because nothing records it yet: saves on your listing (favorites are private to
// whoever saved), saved searches, price drops. Each would need a table or a column first.
//
// READ STATE. Stored notifications use their own `read` column. Worked-out items have no row to
// mark, so which ones you have seen is kept on this device (localStorage) — the same honest limit
// as the event stories: it is a note about this screen, not a record anywhere else.
//
// Loaded as a plain script (not a module) so every function stays global; the HTML's
// onclick handlers depend on that. boot.js must stay last.

let _ibTab = 'messages';
let _actItems = [];             // the feed, newest first
let _actLoaded = false;
const ACT_SEEN_KEY = 'cn_activity_seen';

function actSeen() { try { return new Set(JSON.parse(localStorage.getItem(ACT_SEEN_KEY) || '[]')); } catch (e) { return new Set(); } }
function actMarkSeen(keys) {
  const s = actSeen(); keys.forEach(k => s.add(k));
  try { localStorage.setItem(ACT_SEEN_KEY, JSON.stringify([...s].slice(-500))); } catch (e) { /* private mode */ }
}

function ibTab(t) {
  _ibTab = t;
  document.querySelectorAll('.ib-tab').forEach(b => {
    const on = b.dataset.ibtab === t;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.getElementById('ibPane-messages')?.toggleAttribute('hidden', t !== 'messages');
  document.getElementById('ibPane-activity')?.toggleAttribute('hidden', t !== 'activity');
  const mark = document.getElementById('ibMarkAll');
  if (mark) mark.title = t === 'activity' ? 'Mark all activity as read' : 'Mark all messages as read';
  if (t === 'activity') activityRefresh(true);
}

// The two counts on the tabs: chats with something unread, and unread activity. The bell's badge
// is the activity count too (updateNotifBadge in auth.js reads actUnreadCount()).
function ibPaintCounts() {
  const msgs = typeof sUnread === 'object' && sUnread ? Object.keys(sUnread).length : 0;
  const act = actUnreadCount();
  const set = (id, n) => { const el = document.getElementById(id); if (el) { el.textContent = n; el.hidden = !n; } };
  set('ibCountMsgs', msgs);
  set('ibCountAct', act);
}
function actUnreadCount() {
  if (!_actLoaded) return (typeof _notifCache !== 'undefined' ? _notifCache : []).filter(n => !n.read).length;
  return _actItems.filter(x => x.unread).length;
}

// ✓ in the header: everything on the current tab becomes read.
async function ibMarkAllRead() {
  if (_ibTab === 'activity') {
    actMarkSeen(_actItems.filter(x => !x.notif).map(x => x.key));
    if (typeof markNotificationsRead === 'function') await markNotificationsRead();
    _actItems.forEach(x => { x.unread = false; });
    activityPaint();
    return;
  }
  const eu = getEffectiveUser();
  if (!eu) return;
  const { error } = await supabaseClient.from('messages').update({ seen_at: new Date().toISOString() })
    .eq('receiver_id', eu.id).is('seen_at', null);
  if (error) { toast('Could not mark them read — please try again.'); console.error('[ibMarkAllRead]', error); return; }
  toast('All caught up');
  renderConvos();
}

// ---------- Building the feed ----------
// A stored notification, told apart by its type. The message is text an admin wrote with the
// listing's title in it, so the title is pulled back out to make a two-line row.
function actFromNotif(n) {
  const base = { key: 'n' + n.id, notif: n, at: n.created_at, unread: !n.read };
  const removed = n.type === 'listing_removed' && n.message.match(/^Your listing "([\s\S]*)" was removed by a moderator\. Reason: ([\s\S]*)$/);
  if (removed) {
    return { ...base, icon: 'flag', tone: 'red', title: `Your listing “${esc(removed[1])}” was removed`,
             sub: `${esc(removed[2])} Tap to appeal.`, subTone: 'danger', go: () => showPage('profile') };
  }
  if (n.type === 'appeal_resolved' || n.type === 'appeal_edited') {
    return { ...base, icon: 'check', tone: 'green', title: 'Your appeal has been reviewed', sub: esc(n.message) };
  }
  return { ...base, icon: 'bell', tone: 'neutral', title: esc(n.message), sub: '' };
}

async function activityBuild() {
  const eu = getEffectiveUser();
  if (!eu) return [];
  if (typeof loadNotifications === 'function') await loadNotifications(eu.id);
  const items = (_notifCache || []).map(actFromNotif);
  const seen = actSeen();
  const now = Date.now(), week = now - 7 * 864e5;
  const add = x => items.push({ ...x, unread: !seen.has(x.key) });

  // Events: what I am going to that starts within a day, and my follows' new events and posts.
  // loadEvents fills _evFeed and _evGoing; the directory gives the follow set.
  await Promise.all([
    typeof loadEvents === 'function' && !(_evFeed || []).length ? loadEvents() : null,
    typeof loadOrgDirectory === 'function' && !_dirOrgs ? loadOrgDirectory() : null,
  ]);
  (_evFeed || []).filter(e => _evGoing?.has(e.id)).forEach(e => {
    const ms = new Date(e.starts_at).getTime() - now;
    if (ms < 0 || ms > 864e5) return;
    const h = Math.round(ms / 36e5);
    add({ key: 'soon' + e.id, at: new Date(now - 60e3).toISOString(), icon: 'calendar', tone: 'amber',
          title: `“${esc(e.title)}” starts ${h < 1 ? 'within the hour' : `in ${h} hour${h === 1 ? '' : 's'}`}`,
          sub: esc(e.location || ''),
          when: `${new Date(e.starts_at).toDateString() === new Date().toDateString() ? 'Today' : 'Tomorrow'} · ${evTime(e.starts_at)}`,
          thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
  });

  if (typeof evPendingRatings === 'function') {
    (await evPendingRatings()).slice(0, 3).forEach(e => add({
      key: 'rate' + e.id, at: e.effective_ends_at, icon: 'star', tone: 'amber',
      title: `How was “${esc(e.title)}”?`, sub: 'Rate it — 5 seconds, anonymous', go: () => evOpen(e.id) }));
  }

  const follows = typeof _dirFollows !== 'undefined' ? [..._dirFollows] : [];
  if (follows.length) {
    const since = new Date(week).toISOString();
    const [evs, posts] = await Promise.all([
      supabaseClient.from('visible_events').select('id, org_id, title, starts_at, location, poster_url, event_type, created_at, is_browsable')
        .in('org_id', follows).gte('created_at', since).order('created_at', { ascending: false }).limit(10),
      supabaseClient.from('org_posts').select('id, org_id, type, title, created_at')
        .in('org_id', follows).eq('status', 'published').gte('created_at', since).order('created_at', { ascending: false }).limit(10),
    ]);
    const orgName = id => (_dirOrgs || []).find(o => o.id === id)?.name || 'A club you follow';
    (evs.data || []).filter(e => e.is_browsable).forEach(e => {
      const when = new Date(e.starts_at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
      add({ key: 'ev' + e.id, at: e.created_at, icon: 'school', tone: 'green',
            title: `${esc(orgName(e.org_id))} posted “${esc(e.title)}”`, sub: esc([when, e.location].filter(Boolean).join(' at ')),
            thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
    });
    (posts.data || []).forEach(p => add({
      key: 'post' + p.id, at: p.created_at, icon: p.type === 'poll' ? 'check' : 'bell', tone: 'green',
      title: `${esc(orgName(p.org_id))} ${p.type === 'poll' ? 'asked' : 'posted'}: “${esc(p.title)}”`,
      sub: p.type === 'poll' ? 'A poll — vote on Home' : 'On Home, in Campus news', go: () => showPage('feed') }));
  }

  // My listings that went live this week.
  DB.listings.filter(l => l.poster_id === eu.id && l.status === 'approved' && new Date(l.created_at || 0).getTime() > week)
    .forEach(l => add({ key: 'live' + l.id, at: l.created_at, icon: 'check', tone: 'green',
      title: `Your listing “${esc(l.title)}” is live`, sub: 'Students can find it on the Marketplace now',
      thumb: { photo: l.photo_urls?.[0], cat: l.category }, go: () => openDetail(l.id) }));

  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// `show` repaints the list; without it only the counts are refreshed (used at sign-in).
async function activityRefresh(show) {
  if (show) {
    const el = document.getElementById('activityList');
    if (el && !_actLoaded) el.innerHTML = '<div class="ib-none">Loading…</div>';
  }
  _actItems = await activityBuild();
  _actLoaded = true;
  if (typeof updateNotifBadge === 'function') updateNotifBadge();
  if (show || _ibTab === 'activity') activityPaint(); else ibPaintCounts();
}

function activityPaint() {
  ibPaintCounts();
  if (typeof updateNotifBadge === 'function') updateNotifBadge();
  const el = document.getElementById('activityList');
  if (!el) return;
  if (!_actItems.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">${icon('bell', 32)}</div>
      <div class="empty-state-title">Nothing new</div>
      <div class="empty-state-sub">Updates about your listings, the events you're going to,<br>and the clubs you follow show up here.</div>
    </div>`;
    return;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const groups = [['Today', _actItems.filter(x => new Date(x.at) >= today)],
                  ['Earlier', _actItems.filter(x => new Date(x.at) < today)]];
  el.innerHTML = groups.filter(([, xs]) => xs.length).map(([label, xs]) =>
    `<div class="act-day">${label}</div>${xs.map(actRowHTML).join('')}`).join('');
}

function actWhen(ts) {
  const d = new Date(ts), ms = Date.now() - d.getTime();
  if (ms < 60e3) return 'just now';
  if (ms < 36e5) return `${Math.floor(ms / 60e3)} min ago`;
  if (ms < 864e5) { const h = Math.floor(ms / 36e5); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  if (ms < 6 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function actRowHTML(x) {
  const t = x.thumb;
  const thumb = t ? `<span class="act-thumb ev-tone-${escAttr(t.tone || 'other')}"${t.cat ? ` data-cat="${escAttr(t.cat)}"` : ''}>${t.photo ? `<img src="${escAttr(t.photo)}" alt="" loading="lazy">` : ''}</span>` : '';
  return `
    <button class="act-row${x.unread ? ' is-unread' : ''}" onclick="actOpen(${escAttr(JSON.stringify(x.key))})">
      <span class="act-icon is-${escAttr(x.tone)}">${icon(x.icon, 19)}</span>
      <span class="act-text">
        <span class="act-title">${x.title}</span>
        ${x.sub ? `<span class="act-sub${x.subTone ? ' is-' + x.subTone : ''}">${x.sub}</span>` : ''}
        <span class="act-when">${esc(x.when || actWhen(x.at))}</span>
      </span>
      ${thumb}
    </button>`;
}

// Tapping a row reads it and then goes where it points.
async function actOpen(key) {
  const x = _actItems.find(i => i.key === key);
  if (!x) return;
  if (x.unread) {
    x.unread = false;
    if (x.notif) {
      x.notif.read = true;
      const { error } = await supabaseClient.from('notifications').update({ read: true }).eq('id', x.notif.id);
      if (error) console.error('[actOpen]', error.message);
    } else actMarkSeen([x.key]);
    activityPaint();
  }
  if (x.go) x.go();
}
