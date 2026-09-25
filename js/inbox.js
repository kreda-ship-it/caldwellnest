// ============================================================
// INBOX — the Messages / Activity tabs, and the Activity feed (2026-09-24)
// ============================================================
// From the approved Inbox design. Messages and notifications live on one page as two tabs, the
// way Instagram, Depop and Airbnb keep them: next to each other, but never mixed — a notification
// must not push a reply out of sight, and a reply must not bury "your listing was removed".
// The chat icon opens Messages, the bell opens Activity.
//
// WHAT ACTIVITY SHOWS, and where each piece comes from (brought up to date 2026-09-25, so every
// feature that has shipped since the Inbox did tells you when something happens):
//   stored    rows in `notifications` (written by admins: a listing removed, an appeal decided)
//   worked out, from data this student can already read — nothing new is stored:
//   YOUR EVENTS
//     one you are going to starts within a day                (event_registrations + visible_events)
//     one you are going to was CANCELLED, and why             (visible_events: status, cancelled_reason)
//     one you are going to CHANGED after you signed up        (events.updated_at, set only by an
//                                                              officer's edit, publish or cancel)
//     one you went to is waiting for your rating              (evPendingRatings in events.js)
//     one you went to has its recap photos up                 (_evRecaps, events.js)
//   CLUBS YOU FOLLOW
//     a new event, announcement or poll                       (visible_events, org_posts)
//     a recap shared from one of their events                 (_evRecaps)
//     the result of a poll you voted in, once it closes       (poll_votes, poll_options)
//   YOURS
//     your listing is live                                    (your own listings)
//     people waiting to join a club you run (officers only)   (ocLoadClubs, orgs.js)
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
  if (t === 'activity') { activityRefresh(true); actKeepFresh(); }
}

// Up to date without a reload: while Activity is on screen it refreshes every two minutes, and at
// once when you come back to the tab or window. Wired the first time Activity opens (inbox.js runs
// nothing at load — boot.js is the only file that does).
let _actFresh = null;
function actKeepFresh() {
  const onScreen = () => _ibTab === 'activity' && document.getElementById('page-messages')?.classList.contains('active')
    && document.visibilityState === 'visible';
  if (_actFresh) return;
  _actFresh = setInterval(() => { if (onScreen()) activityRefresh(false); }, 120e3);
  document.addEventListener('visibilitychange', () => { if (onScreen()) activityRefresh(false); });
}

// The one way in (the Inbox button in the nav). With no tab named, it opens on the tab that needs
// you: Messages when a person is waiting for a reply — the more urgent of the two — Activity when
// only activity is new, and otherwise wherever you were last.
function openInbox(tab) {
  const chats = typeof sUnread === 'object' && sUnread ? Object.keys(sUnread).length : 0;
  const t = tab || (chats ? 'messages' : actUnreadCount() ? 'activity' : _ibTab);
  showPage('messages');
  ibTab(t);
}

// The Inbox button's badge: everything waiting, in one number — unread chats plus unread activity.
function paintInboxBadge() {
  const el = document.getElementById('inboxBadge');
  if (!el) return;
  const chats = typeof sUnread === 'object' && sUnread ? Object.keys(sUnread).length : 0;
  const n = chats + actUnreadCount();
  el.textContent = n > 9 ? '9+' : String(n);
  el.classList.toggle('show', n > 0);
}

// The two counts on the tabs: chats with something unread, and unread activity. The bell's badge
// is the activity count too (updateNotifBadge in auth.js reads actUnreadCount()).
function ibPaintCounts() {
  const msgs = typeof sUnread === 'object' && sUnread ? Object.keys(sUnread).length : 0;
  const act = actUnreadCount();
  const set = (id, n) => { const el = document.getElementById(id); if (el) { el.textContent = n; el.hidden = !n; } };
  set('ibCountMsgs', msgs);
  set('ibCountAct', act);
  paintInboxBadge();
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
  const now = Date.now(), day = 864e5, week = now - 7 * day;
  const add = x => items.push({ ...x, unread: !seen.has(x.key) });
  const within = (ts, ms) => ts && now - new Date(ts).getTime() < ms;

  // loadEvents fills _evFeed, _evPast, _evGoing and _evRecaps; the directory gives the follow set;
  // the org context says whether this student runs any club.
  await Promise.all([
    typeof loadEvents === 'function' && !(_evFeed || []).length && !(_evPast || []).length ? loadEvents() : null,
    typeof loadOrgDirectory === 'function' && !_dirOrgs ? loadOrgDirectory() : null,
    typeof loadOrgContext === 'function' ? loadOrgContext() : null,
  ]);
  const orgName = id => (_dirOrgs || []).find(o => o.id === id)?.name
    || (typeof _evOrgs !== 'undefined' ? _evOrgs.get(id)?.name : '') || 'A club you follow';
  const follows = typeof _dirFollows !== 'undefined' ? [..._dirFollows] : [];
  const since = new Date(week).toISOString();

  // Everything that needs a query, at once.
  const none = Promise.resolve({ data: [] });
  const [regs, evs, posts, votes] = await Promise.all([
    supabaseClient.from('event_registrations').select('event_id, status, created_at').eq('user_id', eu.id),
    follows.length ? supabaseClient.from('visible_events').select('id, org_id, title, starts_at, location, poster_url, event_type, created_at, is_browsable')
      .in('org_id', follows).gte('created_at', since).order('created_at', { ascending: false }).limit(10) : none,
    follows.length ? supabaseClient.from('org_posts').select('id, org_id, type, title, poll_closes_at, created_at')
      .in('org_id', follows).eq('status', 'published').gte('created_at', since).order('created_at', { ascending: false }).limit(10) : none,
    supabaseClient.from('poll_votes').select('post_id, option_id').eq('user_id', eu.id),
  ]);
  const myRegs = new Map((regs.data || []).filter(r => r.status !== 'cancelled').map(r => [r.event_id, r]));

  // ---- Your events ----
  (_evFeed || []).filter(e => _evGoing?.has(e.id)).forEach(e => {
    const ms = new Date(e.starts_at).getTime() - now;
    if (ms < 0 || ms > day) return;
    const h = Math.round(ms / 36e5);
    add({ key: 'soon' + e.id, at: new Date(now - 60e3).toISOString(), icon: 'calendar', tone: 'amber',
          title: `“${esc(e.title)}” starts ${h < 1 ? 'within the hour' : `in ${h} hour${h === 1 ? '' : 's'}`}`,
          sub: esc(e.location || ''),
          when: `${new Date(e.starts_at).toDateString() === new Date().toDateString() ? 'Today' : 'Tomorrow'} · ${evTime(e.starts_at)}`,
          thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
  });

  // Cancelled, or changed after you signed up. One query for every event you are registered for;
  // the view still returns a cancelled event to the people registered for it.
  if (myRegs.size) {
    const { data: mine } = await supabaseClient.from('visible_events')
      .select('id, title, status, starts_at, location, cancelled_reason, updated_at, poster_url, event_type, has_ended')
      .in('id', [...myRegs.keys()]);
    (mine || []).forEach(e => {
      if (e.status === 'cancelled' && within(e.updated_at, 14 * day)) {
        add({ key: 'cancel' + e.id, at: e.updated_at, icon: 'x', tone: 'red',
              title: `“${esc(e.title)}” was cancelled`,
              sub: e.cancelled_reason ? esc(e.cancelled_reason) : 'The organizers cancelled it.', subTone: 'danger',
              thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
        return;
      }
      // An edit after your registration: the organizers changed something you signed up for. The
      // key carries the time, so a second change shows up as new again.
      const reg = myRegs.get(e.id);
      if (e.status === 'published' && !e.has_ended && reg && within(e.updated_at, 7 * day)
          && new Date(e.updated_at).getTime() > new Date(reg.created_at).getTime() + 120e3) {
        add({ key: 'chg' + e.id + '@' + e.updated_at, at: e.updated_at, icon: 'clock', tone: 'amber',
              title: `“${esc(e.title)}” was updated`,
              sub: `Check the time and place — ${esc(new Date(e.starts_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${e.location ? ' · ' + esc(e.location) : ''}`,
              thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
      }
    });
  }

  if (typeof evPendingRatings === 'function') {
    (await evPendingRatings()).slice(0, 3).forEach(e => add({
      key: 'rate' + e.id, at: e.effective_ends_at, icon: 'star', tone: 'amber',
      title: `How was “${esc(e.title)}”?`, sub: 'Rate it — 5 seconds, anonymous', go: () => evOpen(e.id) }));
  }

  // Recaps: for an event you signed up for, it is about you ("you were there"); for a club you
  // follow, it is news. Two weeks, the same window the rest of the app treats a recap as recent.
  const recaps = typeof _evRecaps !== 'undefined' ? _evRecaps : new Map();
  (_evPast || []).forEach(e => {
    const r = recaps.get(e.id);
    if (!r || !r.photos.length || !within(r.sharedAt, 14 * day)) return;
    const reg = myRegs.get(e.id);
    const n = r.photos.length;
    if (reg) {
      const was = ['checked_in', 'walk_in'].includes(reg.status);
      add({ key: 'recap' + e.id, at: r.sharedAt, icon: 'image', tone: 'green',
            title: `Photos from “${esc(e.title)}” are up`,
            sub: `${n} photo${n === 1 ? '' : 's'}${was ? ' · you were there' : ''}`,
            thumb: { photo: r.photos[0] }, go: () => evOpen(e.id) });
    } else if (follows.includes(e.org_id)) {
      add({ key: 'recap' + e.id, at: r.sharedAt, icon: 'image', tone: 'green',
            title: `${esc(orgName(e.org_id))} shared photos from “${esc(e.title)}”`,
            sub: `${n} photo${n === 1 ? '' : 's'} · tap to see them`,
            thumb: { photo: r.photos[0] }, go: () => evOpen(e.id) });
    }
  });

  // ---- Clubs you follow ----
  (evs.data || []).filter(e => e.is_browsable).forEach(e => {
    const when = new Date(e.starts_at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
    add({ key: 'ev' + e.id, at: e.created_at, icon: 'school', tone: 'green',
          title: `${esc(orgName(e.org_id))} posted “${esc(e.title)}”`, sub: esc([when, e.location].filter(Boolean).join(' at ')),
          thumb: { photo: e.poster_url, tone: e.event_type }, go: () => evOpen(e.id) });
  });
  // Posts open on the club's own page, Posts tab — where a poll can be answered too.
  const toPosts = id => () => orgPageOpen(id).then(() => orgPageTab('posts'));
  // A poll says where it stands: open and waiting for you, voted, or closed. A closed one you voted
  // in is left to its "Results are in" row below, so it is not listed twice.
  const votedOn = new Set((votes.data || []).map(v => v.post_id));
  (posts.data || []).forEach(p => {
    const poll = p.type === 'poll';
    const closed = poll && p.poll_closes_at && new Date(p.poll_closes_at).getTime() <= now;
    if (closed && votedOn.has(p.id)) return;
    add({ key: 'post' + p.id, at: p.created_at, icon: poll ? 'list' : 'bell', tone: 'green',
      title: `${esc(orgName(p.org_id))} ${poll ? 'asked' : 'posted'}: “${esc(p.title)}”`,
      sub: !poll ? 'An announcement' : closed ? 'Voting has closed' : votedOn.has(p.id) ? 'You voted · tap to see how it stands'
        : `A poll — tap to vote${p.poll_closes_at ? ' · ' + feedClosesLabel(p.poll_closes_at) : ''}`,
      go: toPosts(p.org_id) });
  });

  // Results of polls you voted in, once they close (the last week). After voting, RLS lets you read
  // everyone's votes on that poll, which is what makes the count possible here.
  const myVotes = votes.data || [];
  if (myVotes.length) {
    const { data: closed } = await supabaseClient.from('org_posts').select('id, org_id, title, poll_closes_at')
      .in('id', myVotes.map(v => v.post_id)).eq('status', 'published')
      .lte('poll_closes_at', new Date(now).toISOString()).gte('poll_closes_at', since);
    if (closed && closed.length) {
      const ids = closed.map(p => p.id);
      const [o, v] = await Promise.all([
        supabaseClient.from('poll_options').select('id, post_id, label, position').in('post_id', ids),
        supabaseClient.from('poll_votes').select('post_id, option_id').in('post_id', ids),
      ]);
      closed.forEach(p => {
        const opts = (o.data || []).filter(x => x.post_id === p.id);
        const pv = (v.data || []).filter(x => x.post_id === p.id);
        const total = pv.length;
        const ranked = opts.map(x => ({ x, n: pv.filter(y => y.option_id === x.id).length })).sort((a, b) => b.n - a.n);
        const top = ranked[0];
        const tie = ranked.length > 1 && ranked[1].n === top?.n;
        const mine = opts.find(x => x.id === myVotes.find(y => y.post_id === p.id)?.option_id);
        const pct = n => total ? Math.round(n / total * 100) : 0;
        add({ key: 'pollres' + p.id, at: p.poll_closes_at, icon: 'list', tone: 'green',
              title: `Results are in: “${esc(p.title)}”`,
              sub: (top && top.n && !tie ? `${esc(top.x.label)} won with ${pct(top.n)}%` : 'It was a tie')
                + (mine ? ` · you picked ${esc(mine.label)}` : '') + ` · ${total} vote${total === 1 ? '' : 's'}`,
              go: toPosts(p.org_id) });
      });
    }
  }

  // ---- Yours ----
  DB.listings.filter(l => l.poster_id === eu.id && l.status === 'approved' && new Date(l.created_at || 0).getTime() > week)
    .forEach(l => add({ key: 'live' + l.id, at: l.created_at, icon: 'check', tone: 'green',
      title: `Your listing “${esc(l.title)}” is live`, sub: 'Students can find it on the Marketplace now',
      thumb: { photo: l.photo_urls?.[0], cat: l.category }, go: () => openDetail(l.id) }));

  // Officers: people waiting to join a club you run — the one console job that is somebody else
  // waiting on you. The count is in the key, so a new request surfaces as new.
  if (typeof orgIsOfficerAnywhere === 'function' && orgIsOfficerAnywhere() && typeof ocLoadClubs === 'function') {
    const clubs = await ocLoadClubs();
    orgMemberships().filter(m => m.role === 'officer').forEach(m => {
      const n = clubs.get(m.org_id)?.pending || 0;
      if (!n) return;
      add({ key: `req${m.org_id}-${n}`, at: new Date(now - 120e3).toISOString(), icon: 'user', tone: 'amber',
            title: `${n} ${n === 1 ? 'person wants' : 'people want'} to join ${esc(m.org.name)}`,
            sub: 'Approve or decline in the club console',
            go: () => { saveUiState('ocSection:' + m.org_id, 'members'); orgConsoleOpen(m.org_id); } });
    });
  }

  // Newest first. A row without a time goes last rather than scrambling the sort (NaN compares
  // as neither bigger nor smaller, which leaves the order undefined).
  const t = x => { const v = new Date(x.at).getTime(); return Number.isFinite(v) ? v : 0; };
  return items.sort((a, b) => t(b) - t(a));
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
      <div class="empty-state-sub">Updates about your listings, the events you're going to, recaps and poll results,<br>and the clubs you follow show up here.</div>
    </div>`;
    return;
  }
  // Today, This week, Earlier — the grouping Instagram and LinkedIn use, so the eye lands on what
  // is new and the rest reads as history.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const wk = today.getTime() - 6 * 864e5;
  const t = x => new Date(x.at).getTime() || 0;
  const groups = [['Today', _actItems.filter(x => t(x) >= today.getTime())],
                  ['This week', _actItems.filter(x => t(x) < today.getTime() && t(x) >= wk)],
                  ['Earlier', _actItems.filter(x => t(x) < wk)]];
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
