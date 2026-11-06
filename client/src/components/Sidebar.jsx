import { useState } from 'react';
import { askPermission, notificationPermission } from '../notify.js';
import { ActivityLabel } from './Ticks.jsx';

export default function Sidebar({
  me,
  users,
  online,
  unread,
  activity,
  pinnedChats,
  active,
  view,
  pendingCount = 0,
  onOpen,
  onOpenAdmin,
  onTogglePin,
  onDeleteChat,
  onLogout,
}) {
  const [perm, setPerm] = useState(notificationPermission());
  const iAmAdmin = me.role === 'admin';

  // Pinned chats float to the top, then the admin, then everyone else (alphabetical, as sent by the server).
  const pinnedSet = new Set(pinnedChats);
  const rank = (u) => (u.role === 'admin' ? 0 : 1);
  const sortFn = (a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)) || rank(a) - rank(b);
  const sorted = [...users].sort(sortFn);

  // The admin sees people in folders (one per group). Everyone else gets one plain list.
  let sections = [{ key: 'all', label: null, users: sorted }];
  if (iAmAdmin) {
    const byKey = new Map();
    for (const u of sorted) {
      const key = u.role === 'admin' ? 'admins' : u.group?.id || u.via?.id || 'none';
      const label = u.role === 'admin' ? 'Admins' : u.group?.name || (u.via ? `${u.via.name} (private)` : 'Private chats');
      if (!byKey.has(key)) byKey.set(key, { key, label, users: [] });
      byKey.get(key).users.push(u);
    }
    sections = [...byKey.values()].sort((a, b) => {
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      return a.label.localeCompare(b.label);
    });
  }

  function renderUser(u) {
    const isPinned = pinnedSet.has(u.id);
    const act = activity[u.id];
    return (
      <li key={u.id} className="user-row">
        <button className={`user-item ${view === 'chat' && active === u.id ? 'active' : ''}`} onClick={() => onOpen(u.id)}>
          <span className={`dot ${online.has(u.id) ? 'on' : ''}`} title={online.has(u.id) ? 'online' : 'offline'} />
          <span className="user-text">
            <span className="user-name">
              {u.name}
              {u.role === 'admin' && <span className="role-badge">Admin</span>}
            </span>
            {act && (
              <span className="user-sub small-text">
                <ActivityLabel kind={act} short />
              </span>
            )}
          </span>
          {isPinned && (
            <span className="pin-mark" title="Pinned chat">
              📌
            </span>
          )}
          {unread[u.id] > 0 && <span className="badge">{unread[u.id]}</span>}
        </button>
        <div className="row-actions">
          <button
            className="icon-btn"
            title={isPinned ? 'Unpin chat' : 'Pin chat to top'}
            aria-label={isPinned ? `Unpin chat with ${u.name}` : `Pin chat with ${u.name}`}
            onClick={() => onTogglePin(u.id)}
          >
            📌
          </button>
          <button
            className="icon-btn"
            title="Delete chat"
            aria-label={`Delete chat with ${u.name}`}
            onClick={() => onDeleteChat(u)}
          >
            🗑
          </button>
        </div>
      </li>
    );
  }

  return (
    <aside className="sidebar">
      <div className="side-head">
        <span className="logo">ChatBro</span>
        <button className="btn small" onClick={onLogout}>
          Log out
        </button>
      </div>

      <div className="me-card">
        <div className="avatar">{me.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="me-name">
            {me.name}
            {iAmAdmin && <span className="role-badge">Admin</span>}
          </div>
          <div className="muted small-text">🔒 end-to-end encrypted</div>
        </div>
      </div>

      {iAmAdmin && (
        <button className={`btn wide admin-btn ${view === 'admin' ? 'on' : ''}`} onClick={onOpenAdmin}>
          🗂 Groups &amp; codes
          {pendingCount > 0 && <span className="badge nav-badge">{pendingCount}</span>}
        </button>
      )}

      {perm === 'default' && (
        <button className="btn wide" onClick={async () => setPerm(await askPermission())}>
          🔔 Enable desktop pop-ups
        </button>
      )}
      {perm === 'denied' && (
        <p className="hint">Pop-ups are blocked. Allow notifications for this site in your browser settings.</p>
      )}

      <div className="section-label">{iAmAdmin ? 'Everyone' : 'Chats'}</div>
      <ul className="user-list">
        {users.length === 0 && (
          <li className="hint">
            {iAmAdmin
              ? 'Nobody has joined yet. Open "Groups & codes", make a group and give its code to people.'
              : 'Nobody else is in your group yet.'}
          </li>
        )}
        {sections.map((s) => (
          <li key={s.key} className="folder">
            {s.label && (
              <div className="folder-label">
                <span>📁 {s.label}</span>
                <span className="muted small-text">{s.users.length}</span>
              </div>
            )}
            <ul className="folder-list">{s.users.map(renderUser)}</ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}
