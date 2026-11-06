import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Admin only: create groups (folders), each with its own sign-up code, and see who is in each one.
 * Members of a group only ever see each other plus the admin. Chats stay end-to-end encrypted, so the admin can
 * message anyone but cannot read other people's conversations.
 */
export default function AdminPanel({ ask, online, onOpenChat, onClose, refreshKey, pending = [], onChanged }) {
  const [groups, setGroups] = useState(null); // null while loading
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(''); // group id, or 'new'
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState(null); // { id, value }
  const [isPrivate, setIsPrivate] = useState(false); // create form: one-to-one code
  const [privateOthers, setPrivateOthers] = useState([]); // approved people who are in no group
  const [choice, setChoice] = useState({}); // pending id -> '' (as requested) | 'none' | group id
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const { groups: list, privateOthers: others } = await api.adminGroups();
      setGroups(list);
      setPrivateOthers(others || []);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load the groups');
    }
  }, []);

  // Reload when the panel opens and whenever someone new joins.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function run(id, job) {
    setBusy(id);
    try {
      await job();
      setError('');
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  const replace = (g) => setGroups((prev) => (prev || []).map((x) => (x.id === g.id ? g : x)));

  function create(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    run('new', async () => {
      const g = await api.createGroup(name, isPrivate);
      setGroups((prev) => [...(prev || []), g]);
      setNewName('');
      setIsPrivate(false);
    });
  }

  const patch = (g, body) => run(g.id, async () => replace(await api.updateGroup(g.id, body)));

  function saveName(g) {
    const value = (editing?.value || '').trim();
    setEditing(null);
    if (value && value !== g.name) patch(g, { name: value });
  }

  function askNewCode(g) {
    ask(
      {
        title: `Make a new code for "${g.name}"?`,
        body: 'The current code stops working immediately. People who are already in the group stay in it.',
        confirmLabel: 'New code',
        danger: true,
      },
      () => patch(g, { regenerate: true })
    );
  }

  function askDelete(g) {
    ask(
      {
        title: `Delete the group "${g.name}"?`,
        body: 'It has no members, so nobody is affected. Its code stops working.',
        confirmLabel: 'Delete group',
        danger: true,
      },
      () =>
        run(g.id, async () => {
          await api.deleteGroup(g.id);
          setGroups((prev) => (prev || []).filter((x) => x.id !== g.id));
        })
    );
  }

  const sharedGroups = (groups || []).filter((g) => !g.private);

  // body for the approve call: {} = as requested, { group: null } = only me, { group: id } = that group
  function approve(p) {
    const c = choice[p.id] || '';
    const body = c === '' ? {} : c === 'none' ? { group: null } : { group: c };
    run(`p:${p.id}`, async () => {
      await api.approveUser(p.id, body);
      onChanged?.();
      await load();
    });
  }

  function askReject(p) {
    ask(
      {
        title: `Reject ${p.name}?`,
        body: 'Their request is deleted. They can sign up again with a code if you let them.',
        confirmLabel: 'Reject',
        danger: true,
      },
      () =>
        run(`p:${p.id}`, async () => {
          await api.rejectUser(p.id);
          onChanged?.();
        })
    );
  }

  function move(m, value) {
    run(`m:${m.id}`, async () => {
      await api.moveMember(m.id, value === 'none' ? null : value);
      onChanged?.();
      await load();
    });
  }

  function MoveSelect({ m, current }) {
    return (
      <select
        className="move-select"
        value=""
        disabled={busy === `m:${m.id}`}
        aria-label={`Move ${m.name}`}
        onChange={(e) => e.target.value && move(m, e.target.value)}
      >
        <option value="">Move…</option>
        {current !== 'none' && <option value="none">Only me (private)</option>}
        {sharedGroups
          .filter((x) => x.id !== current)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </select>
    );
  }

  async function copy(g) {
    try {
      await navigator.clipboard.writeText(g.display);
      setCopied(g.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Could not copy. Select the code and copy it by hand.');
    }
  }

  return (
    <section className="chat admin-panel">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onClose} aria-label="Back to chats">
          ←
        </button>
        <div className="avatar">★</div>
        <div className="head-text">
          <div className="peer-name">Groups &amp; codes</div>
          <div className="muted small-text">You are the admin</div>
        </div>
      </header>

      <div className="admin-body">
        <p className="muted admin-note">
          Each group has its own code. Someone who signs up with a code joins that group and can only see the other
          members of it, plus you. You can message anyone. Their conversations with each other stay end-to-end encrypted,
          so you can see who is in each group but cannot read their messages.
        </p>
        <p className="muted admin-note">
          New sign-ups wait below until you approve them. A <strong>private</strong> code is for one-to-one chats: everyone
          who joins with it can only talk to you, never to each other.
        </p>

        {pending.length > 0 && (
          <article className="group-card pending-card">
            <div className="group-head">
              <h3 className="group-name">Waiting for approval ({pending.length})</h3>
            </div>
            <ul className="pending-list">
              {pending.map((p) => (
                <li key={p.id} className="pending-row">
                  <div className="pending-who">
                    <span className="user-name">{p.name}</span>
                    <span className="muted small-text">{p.email}</span>
                    <span className="muted small-text">
                      Used code: {p.requested ? `${p.requested.name}${p.requested.private ? ' (private)' : ''}` : 'none'}
                    </span>
                  </div>
                  <select
                    className="move-select"
                    value={choice[p.id] || ''}
                    onChange={(e) => setChoice((c) => ({ ...c, [p.id]: e.target.value }))}
                    aria-label={`Where to put ${p.name}`}
                  >
                    <option value="">
                      {p.requested
                        ? p.requested.private
                          ? `Only me, via ${p.requested.name}`
                          : `Group: ${p.requested.name}`
                        : 'Only me (private)'}
                    </option>
                    <option value="none">Only me (private)</option>
                    {sharedGroups
                      .filter((x) => x.id !== p.requested?.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          Group: {x.name}
                        </option>
                      ))}
                  </select>
                  <div className="pending-actions">
                    <button className="btn small primary" disabled={busy === `p:${p.id}`} onClick={() => approve(p)}>
                      Approve
                    </button>
                    <button className="btn small danger" disabled={busy === `p:${p.id}`} onClick={() => askReject(p)}>
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </article>
        )}

        <form className="new-group" onSubmit={create}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            placeholder="New group name, e.g. Family"
            aria-label="New group name"
          />
          <label className="check">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            <span>Private (one-to-one with me)</span>
          </label>
          <button className="btn primary" type="submit" disabled={!newName.trim() || busy === 'new'}>
            Create group
          </button>
        </form>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {groups === null && !error && <p className="hint center">Loading…</p>}
        {groups && groups.length === 0 && (
          <p className="hint center">No groups yet. Create one to get a code you can give to people.</p>
        )}

        <div className="group-list">
          {(groups || []).map((g) => (
            <article key={g.id} className={`group-card ${g.active ? '' : 'closed'}`}>
              <div className="group-head">
                {editing?.id === g.id ? (
                  <input
                    className="rename"
                    autoFocus
                    value={editing.value}
                    maxLength={40}
                    onChange={(e) => setEditing({ id: g.id, value: e.target.value })}
                    onBlur={() => saveName(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveName(g);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    aria-label="Group name"
                  />
                ) : (
                  <h3 className="group-name">
                    {g.name}
                    <button
                      className="icon-btn"
                      title="Rename group"
                      aria-label={`Rename ${g.name}`}
                      onClick={() => setEditing({ id: g.id, value: g.name })}
                    >
                      ✎
                    </button>
                  </h3>
                )}
                {g.private && <span className="status-chip private">Private</span>}
                <span className={`status-chip ${g.active ? 'open' : ''}`}>{g.active ? 'Open for sign-ups' : 'Closed'}</span>
              </div>

              <div className="code-row">
                <code className="group-code">{g.display}</code>
                <button className="btn small" onClick={() => copy(g)}>
                  {copied === g.id ? 'Copied ✓' : 'Copy'}
                </button>
              </div>

              <div className="group-actions">
                <button className="btn small" disabled={busy === g.id} onClick={() => patch(g, { active: !g.active })}>
                  {g.active ? 'Close code' : 'Reopen code'}
                </button>
                <button className="btn small" disabled={busy === g.id} onClick={() => askNewCode(g)}>
                  New code
                </button>
                {g.members.length === 0 && (
                  <button className="btn small danger" disabled={busy === g.id} onClick={() => askDelete(g)}>
                    Delete
                  </button>
                )}
              </div>

              <div className="section-label">Members ({g.members.length})</div>
              {g.members.length === 0 ? (
                <p className="hint">Nobody has joined with this code yet.</p>
              ) : (
                <ul className="member-list">
                  {g.members.map((m) => (
                    <li key={m.id}>
                      <button className="member" onClick={() => onOpenChat(m.id)} title={`Open chat with ${m.name}`}>
                        <span className={`dot ${online.has(m.id) ? 'on' : ''}`} />
                        <span className="user-name">{m.name}</span>
                        <span className="muted small-text">Message</span>
                      </button>
                      <MoveSelect m={m} current={g.private ? 'none' : g.id} />
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>

        {privateOthers.length > 0 && (
          <article className="group-card">
            <div className="group-head">
              <h3 className="group-name">Private chats (only you)</h3>
            </div>
            <ul className="member-list">
              {privateOthers.map((m) => (
                <li key={m.id}>
                  <button className="member" onClick={() => onOpenChat(m.id)} title={`Open chat with ${m.name}`}>
                    <span className={`dot ${online.has(m.id) ? 'on' : ''}`} />
                    <span className="user-name">{m.name}</span>
                    <span className="muted small-text">Message</span>
                  </button>
                  <MoveSelect m={m} current="none" />
                </li>
              ))}
            </ul>
          </article>
        )}
      </div>
    </section>
  );
}
