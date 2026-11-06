import { useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, onUnauthorized } from './api.js';
import { loadKey, saveKey, clearKeys } from './keystore.js';
import { sharedKeyFor, encryptJson, decryptJson, encryptBytes, clearSharedCache } from './crypto.js';
import { connectSocket, disconnectSocket, sendActivity } from './socket.js';
import { desktopNotify, ping } from './notify.js';
import AuthScreen from './components/AuthScreen.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import Toasts from './components/Toasts.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import { previewOf } from './util.js';

const byTime = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null); // { user, privateKey }
  const [users, setUsers] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState({}); // peerId -> decrypted messages
  const [loadingChat, setLoadingChat] = useState(false);
  const [unread, setUnread] = useState({});
  const [toasts, setToasts] = useState([]);
  const [activity, setActivity] = useState({}); // peerId -> 'typing' | 'speaking'
  const [pinnedChats, setPinnedChats] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [focusTick, setFocusTick] = useState(0);
  const [view, setView] = useState('chat'); // 'chat' | 'admin' (the admin's groups & codes screen)
  const [adminTick, setAdminTick] = useState(0); // bumped when something changes, so the admin screens reload
  const [pending, setPending] = useState([]); // admin only: people waiting for approval
  const [connTick, setConnTick] = useState(0); // bumped to reconnect the live connection (e.g. after being moved)

  // Refs let long-lived socket/notification callbacks always see the latest state.
  const usersRef = useRef([]);
  const activeRef = useRef(null);
  const live = useRef({});
  const activityTimers = useRef({});
  const seenInFlight = useRef(false);
  const tmpCounter = useRef(0);
  usersRef.current = users;
  activeRef.current = active;

  /* ---------- session ---------- */

  async function logout() {
    disconnectSocket();
    setToken(null);
    clearSharedCache();
    await clearKeys().catch(() => {});
    setSession(null);
    setUsers([]);
    setMessages({});
    setActive(null);
    setUnread({});
    setToasts([]);
    setOnline(new Set());
    setActivity({});
    setPinnedChats([]);
    setConfirm(null);
    setView('chat');
    setPending([]);
    Object.values(activityTimers.current).forEach(clearTimeout);
    activityTimers.current = {};
  }
  live.current.logout = logout;

  async function onAuthed({ user, privateKey, token }) {
    setToken(token);
    await saveKey(privateKey).catch(() => {}); // if this fails you simply log in again after a reload
    setSession({ user, privateKey });
  }

  useEffect(() => {
    onUnauthorized(() => live.current.logout?.());
    (async () => {
      try {
        if (getToken()) {
          const key = await loadKey();
          if (key) {
            const { user } = await api.me();
            setSession({ user, privateKey: key });
          } else {
            setToken(null);
          }
        }
      } catch (e) {
        if (e.status === 401) {
          setToken(null);
          await clearKeys().catch(() => {});
        }
      }
      setBooting(false);
    })();
  }, []);

  /* ---------- realtime ---------- */

  useEffect(() => {
    if (!session) return undefined;
    let alive = true;

    const loadUsers = () =>
      api
        .users()
        .then(({ users: list, pinnedChats: pins }) => {
          if (!alive) return;
          setUsers(list);
          setPinnedChats(pins || []);
        })
        .catch(() => {});
    loadUsers();

    const socket = connectSocket(getToken());
    socket.on('presence:list', (ids) => setOnline(new Set(ids)));
    socket.on('presence', ({ userId, online: isOnline }) =>
      setOnline((prev) => {
        const next = new Set(prev);
        if (isOnline) next.add(userId);
        else next.delete(userId);
        return next;
      })
    );
    // The server only sends this for people you are allowed to see.
    socket.on('user:new', (u) => {
      setUsers((prev) => (u.id === session.user.id || prev.some((x) => x.id === u.id) ? prev : [...prev, u]));
      setAdminTick((t) => t + 1);
    });
    socket.on('message', (raw) => live.current.onMessage?.(raw));
    socket.on('message:update', (raw) => live.current.onUpdate?.(raw));
    socket.on('status', (s) => live.current.onStatus?.(s));
    socket.on('activity', (a) => live.current.onActivity?.(a));
    socket.on('chat:deleted', ({ peerId }) => live.current.clearChat?.(peerId));
    socket.on('chats:pinned', (ids) => setPinnedChats(ids));

    // Groups changed (someone was approved or moved): reload who you can see.
    socket.on('users:changed', loadUsers);
    // Admin only: a sign-up request arrived, or the admin screens need a refresh.
    socket.on('signup:pending', (p) => {
      setAdminTick((t) => t + 1);
      live.current.onSignup?.(p);
    });
    socket.on('admin:changed', () => {
      setAdminTick((t) => t + 1);
      loadUsers();
    });
    // The admin moved you: reconnect so your live updates match your new group.
    socket.on('session:refresh', () => setConnTick((t) => t + 1));

    return () => {
      alive = false;
      disconnectSocket();
    };
  }, [session, connTick]);

  // Admin only: the list of people waiting for approval.
  useEffect(() => {
    if (!session || session.user.role !== 'admin') {
      setPending([]);
      return undefined;
    }
    let ok = true;
    api
      .adminPending()
      .then(({ pending: list }) => ok && setPending(list))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, [session, adminTick]);

  /* ---------- decrypt / store ---------- */

  async function decode(raw) {
    const myId = session.user.id;
    const peerId = raw.from === myId ? raw.to : raw.from;
    const base = {
      id: raw._id,
      from: raw.from,
      to: raw.to,
      peerId,
      fileId: raw.fileId,
      createdAt: raw.createdAt,
      deliveredAt: raw.deliveredAt || null,
      seenAt: raw.seenAt || null,
      pinned: Boolean(raw.pinned),
      pinnedAt: raw.pinnedAt || null,
      unsent: Boolean(raw.unsent),
      reactions: [],
    };
    if (raw.unsent) return base; // nothing left to decrypt

    let peer = usersRef.current.find((u) => u.id === peerId);
    if (!peer) {
      try {
        const { users: fresh } = await api.users();
        usersRef.current = fresh;
        setUsers(fresh);
        peer = fresh.find((u) => u.id === peerId);
      } catch {
        /* handled below */
      }
    }
    if (!peer) return { ...base, error: 'Message from an unknown user' };

    try {
      const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
      const payload = await decryptJson(key, raw.iv, raw.ct, `${raw.from}>${raw.to}`);
      // Reactions are emoji encrypted by whoever reacted; ones that fail to decrypt are ignored.
      const reactions = [];
      for (const r of raw.reactions || []) {
        try {
          const { e } = await decryptJson(key, r.iv, r.ct, `react:${raw._id}:${r.by}`);
          if (typeof e === 'string' && e.length > 0 && e.length <= 16) reactions.push({ by: r.by, emoji: e });
        } catch {
          /* ignore */
        }
      }
      return { ...base, payload, reactions };
    } catch {
      return { ...base, error: 'This message could not be decrypted' };
    }
  }

  function addMessage(m) {
    setMessages((prev) => {
      const list = prev[m.peerId] || [];
      if (list.some((x) => x.id === m.id)) return prev;
      return { ...prev, [m.peerId]: [...list, m].sort(byTime) };
    });
  }

  // Replace a message that is already on screen (reactions, pins, unsend). Unknown ones are ignored:
  // their chat has not been opened yet, and history is fetched fresh when it is.
  function applyUpdate(m) {
    setMessages((prev) => {
      const list = prev[m.peerId];
      const i = list ? list.findIndex((x) => x.id === m.id) : -1;
      if (i < 0) return prev;
      const next = [...list];
      next[i] = m;
      return { ...prev, [m.peerId]: next };
    });
  }

  function patchMessages(ids, patch) {
    const set = new Set(ids);
    setMessages((prev) => {
      let changed = false;
      const out = {};
      for (const [peerId, list] of Object.entries(prev)) {
        out[peerId] = list.map((m) => {
          if (!set.has(m.id)) return m;
          changed = true;
          return { ...m, ...patch(m) };
        });
      }
      return changed ? out : prev;
    });
  }

  function clearActivity(peerId) {
    clearTimeout(activityTimers.current[peerId]);
    delete activityTimers.current[peerId];
    setActivity((a) => {
      if (!a[peerId]) return a;
      const n = { ...a };
      delete n[peerId];
      return n;
    });
  }

  function openChat(id) {
    setView('chat');
    setActive(id);
    setUnread((u) => ({ ...u, [id]: 0 }));
    setToasts((t) => t.filter((x) => x.peerId !== id));
  }

  function openAdmin() {
    setActive(null);
    setView('admin');
  }

  // Admin only: someone signed up and is waiting to be approved.
  live.current.onSignup = (p) => {
    const title = 'New sign-up request';
    const body = `${p.name} is waiting for your approval`;
    setToasts((t) => [...t.slice(-3), { id: `signup-${p.id}`, peerId: null, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== `signup-${p.id}`)), 8000);
    if (!document.hasFocus()) desktopNotify({ title, body, tag: 'signup', onClick: openAdmin });
    ping();
  };

  // A toast opens the chat it is about; the sign-up toast has no chat, so it opens the admin screen.
  function openToast(peerId) {
    setToasts((t) => t.filter((x) => x.peerId !== peerId));
    if (peerId) openChat(peerId);
    else openAdmin();
  }

  // New message from the server (yours or a friend's).
  live.current.onMessage = async (raw) => {
    const m = await decode(raw);
    addMessage(m);
    if (m.from === session.user.id) return;
    clearActivity(m.peerId); // they sent it, so they are no longer typing

    const viewing =
      document.visibilityState === 'visible' && document.hasFocus() && activeRef.current === m.peerId;
    if (viewing) return;

    const name = usersRef.current.find((u) => u.id === m.peerId)?.name || 'Someone';
    const title = `${name} sent this`;
    const body = previewOf(m);

    setUnread((u) => ({ ...u, [m.peerId]: (u[m.peerId] || 0) + 1 }));

    if (document.visibilityState === 'visible') {
      setToasts((t) => [...t.slice(-3), { id: m.id, peerId: m.peerId, title, body }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== m.id)), 6500);
    }
    if (!document.hasFocus()) {
      desktopNotify({ title, body, tag: m.peerId, onClick: () => openChat(m.peerId) });
    }
    ping();
  };

  live.current.onUpdate = async (raw) => applyUpdate(await decode(raw));

  live.current.onStatus = ({ ids, deliveredAt, seenAt }) =>
    patchMessages(ids, (m) => ({
      deliveredAt: m.deliveredAt || deliveredAt || null,
      seenAt: seenAt || m.seenAt,
    }));

  live.current.onActivity = ({ from, kind, on }) => {
    if (!on) return clearActivity(from);
    setActivity((a) => (a[from] === kind ? a : { ...a, [from]: kind }));
    clearTimeout(activityTimers.current[from]);
    // The friend's app repeats the signal while it is true; silence for 6 s means it stopped.
    activityTimers.current[from] = setTimeout(() => clearActivity(from), 6000);
  };

  live.current.clearChat = (peerId) => {
    setMessages((prev) => ({ ...prev, [peerId]: [] }));
    setUnread((u) => ({ ...u, [peerId]: 0 }));
    setToasts((t) => t.filter((x) => x.peerId !== peerId));
    setActive((cur) => (cur === peerId ? null : cur));
  };

  // Load history when you open a chat.
  useEffect(() => {
    if (!session || !active || users.length === 0) return undefined;
    let ok = true;
    setLoadingChat(true);
    (async () => {
      try {
        const { messages: raws } = await api.messages(active);
        const decoded = await Promise.all(raws.map(decode));
        if (!ok) return;
        setMessages((prev) => {
          const merged = new Map((prev[active] || []).map((m) => [m.id, m]));
          decoded.forEach((m) => merged.set(m.id, m));
          return { ...prev, [active]: [...merged.values()].sort(byTime) };
        });
      } catch {
        /* the chat stays empty; a reload retries */
      } finally {
        if (ok) setLoadingChat(false);
      }
    })();
    return () => {
      ok = false;
    };
  }, [active, session, users.length]);

  // Clear the unread badge when you come back to the window.
  useEffect(() => {
    const clear = () => {
      setFocusTick((t) => t + 1);
      if (document.visibilityState === 'visible' && document.hasFocus() && activeRef.current) {
        const id = activeRef.current;
        setUnread((u) => (u[id] ? { ...u, [id]: 0 } : u));
      }
    };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  // While you are looking at a chat, tell the server (and so your friend) that their messages were seen.
  useEffect(() => {
    if (!session || !active || seenInFlight.current) return;
    if (!(document.visibilityState === 'visible' && document.hasFocus())) return;
    const unseen = (messages[active] || []).filter((m) => m.from === active && !m.seenAt && !m.unsent).map((m) => m.id);
    if (unseen.length === 0) return;

    seenInFlight.current = true;
    api
      .markSeen(active)
      .then(({ seenAt }) => patchMessages(unseen, () => ({ seenAt: seenAt || new Date().toISOString() })))
      .catch(() => {})
      .finally(() => {
        seenInFlight.current = false;
        setFocusTick((t) => t + 1); // re-check in case more arrived meanwhile
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, active, focusTick, session]);

  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = total ? `(${total}) ChatBro` : 'ChatBro';
  }, [unread]);

  /* ---------- sending ---------- */

  async function postMessage(peer, payload, fileId = null) {
    const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
    const { iv, ct } = await encryptJson(key, payload, `${session.user.id}>${peer.id}`);
    return decode(await api.send(peer.id, { iv, ct, fileId }));
  }

  // Text shows up immediately with a "sending" clock, then settles to sent / delivered / seen.
  async function sendText(peer, text, replyTo) {
    const tmpId = `tmp-${++tmpCounter.current}`;
    const payload = { k: 'text', text, ...(replyTo ? { replyTo } : {}) };
    addMessage({
      id: tmpId,
      from: session.user.id,
      to: peer.id,
      peerId: peer.id,
      createdAt: new Date().toISOString(),
      payload,
      reactions: [],
      status: 'sending',
    });
    const dropTmp = () =>
      setMessages((prev) => ({ ...prev, [peer.id]: (prev[peer.id] || []).filter((m) => m.id !== tmpId) }));
    try {
      const real = await postMessage(peer, payload);
      dropTmp();
      addMessage(real);
    } catch (e) {
      dropTmp();
      throw e;
    }
  }

  async function sendFile(peer, file, onProgress, { replyTo, voice } = {}) {
    const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
    onProgress?.(0, 'encrypting');
    const { iv, data } = await encryptBytes(key, await file.arrayBuffer(), `file:${session.user.id}>${peer.id}`);
    const { fileId } = await api.uploadFile(new Blob([data]), (pct) => onProgress?.(pct, 'uploading'));
    const reply = replyTo ? { replyTo } : {};
    const payload = voice
      ? { k: 'voice', mime: file.type || 'audio/webm', size: file.size, fiv: iv, dur: voice.dur, wave: voice.wave, ...reply }
      : { k: 'file', name: file.name, mime: file.type || 'application/octet-stream', size: file.size, fiv: iv, ...reply };
    addMessage(await postMessage(peer, payload, fileId));
  }

  /* ---------- message actions ---------- */

  async function reactTo(peer, m, emoji) {
    const mine = m.reactions.find((r) => r.by === session.user.id);
    let body = { clear: true };
    if (!(mine && mine.emoji === emoji)) {
      const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
      body = await encryptJson(key, { e: emoji }, `react:${m.id}:${session.user.id}`);
    }
    applyUpdate(await decode(await api.react(peer.id, m.id, body)));
  }

  async function pinMessage(peer, m, pinned) {
    applyUpdate(await decode(await api.pin(peer.id, m.id, pinned)));
  }

  async function unsendMessage(peer, m) {
    await api.unsend(peer.id, m.id);
    // The server also pushes this; applying it now makes the change instant for you.
    applyUpdate({ ...m, unsent: true, payload: undefined, fileId: null, reactions: [], pinned: false, pinnedAt: null });
  }

  async function deleteChat(peer) {
    await api.deleteChat(peer.id);
    live.current.clearChat(peer.id);
  }

  async function togglePinChat(peerId) {
    const pinned = !pinnedChats.includes(peerId);
    setPinnedChats((p) => (pinned ? [...p, peerId] : p.filter((x) => x !== peerId))); // optimistic
    try {
      const { pinnedChats: saved } = await api.pinChat(peerId, pinned);
      setPinnedChats(saved);
    } catch {
      setPinnedChats((p) => (pinned ? p.filter((x) => x !== peerId) : [...p, peerId]));
    }
  }

  const ask = (options, onConfirm) => setConfirm({ ...options, onConfirm });

  function askDeleteChat(u) {
    ask(
      {
        title: `Delete your chat with ${u.name}?`,
        body: `All messages and files in this chat are removed from your account. ${u.name} keeps their own copy.`,
        confirmLabel: 'Delete chat',
        danger: true,
      },
      () => deleteChat(u).catch(() => {})
    );
  }

  /* ---------- render ---------- */

  if (booting) {
    return (
      <div className="splash">
        <span className="logo big">ChatBro</span>
      </div>
    );
  }
  if (!session) return <AuthScreen onAuthed={onAuthed} />;

  const me = session.user;
  const showAdmin = view === 'admin' && me.role === 'admin';
  const peer = showAdmin ? null : users.find((u) => u.id === active) || null;

  return (
    <div className={`app ${peer || showAdmin ? 'has-chat' : ''}`}>
      <Sidebar
        me={me}
        users={users}
        online={online}
        unread={unread}
        activity={activity}
        pinnedChats={pinnedChats}
        active={active}
        view={showAdmin ? 'admin' : 'chat'}
        pendingCount={pending.length}
        onOpenAdmin={openAdmin}
        onOpen={openChat}
        onTogglePin={togglePinChat}
        onDeleteChat={askDeleteChat}
        onLogout={logout}
      />

      <main className="chat-pane">
        {showAdmin ? (
          <AdminPanel
            ask={ask}
            online={online}
            refreshKey={adminTick}
            pending={pending}
            onChanged={() => setAdminTick((t) => t + 1)}
            onOpenChat={openChat}
            onClose={() => setView('chat')}
          />
        ) : peer ? (
          <ChatWindow
            key={peer.id}
            me={me}
            peer={peer}
            online={online.has(peer.id)}
            activity={activity[peer.id]}
            messages={messages[peer.id] || []}
            loading={loadingChat}
            chatPinned={pinnedChats.includes(peer.id)}
            ask={ask}
            onSendText={(text, replyTo) => sendText(peer, text, replyTo)}
            onSendFile={(file, onProgress, extra) => sendFile(peer, file, onProgress, extra)}
            onActivity={(kind, on) => sendActivity(peer.id, kind, on)}
            onReact={(m, emoji) => reactTo(peer, m, emoji)}
            onPin={(m, pinned) => pinMessage(peer, m, pinned)}
            onUnsend={(m) => unsendMessage(peer, m)}
            onTogglePinChat={() => togglePinChat(peer.id)}
            onDeleteChat={() => deleteChat(peer)}
            getKey={() => sharedKeyFor(session.privateKey, peer.id, peer.publicKey)}
            onBack={() => setActive(null)}
          />
        ) : (
          <div className="empty">
            <span className="logo big">ChatBro</span>
            <p className="muted">
              {users.length
                ? 'Pick someone to start an end-to-end encrypted chat.'
                : me.role === 'admin'
                  ? 'Nobody has joined yet. Open "Groups & codes", create a group and share its code.'
                  : 'Nobody else is in your group yet.'}
            </p>
          </div>
        )}
      </main>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.onConfirm;
            setConfirm(null);
            run();
          }}
        />
      )}

      <Toasts
        items={toasts}
        onOpen={openToast}
        onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
      />
    </div>
  );
}
