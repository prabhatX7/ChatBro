import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { decryptBytes } from '../crypto.js';
import { fmtDuration, fmtTime, OID_RE, previewOf } from '../util.js';
import Popover from './Popover.jsx';
import EmojiPicker from './Reactions.jsx';
import Ticks from './Ticks.jsx';

const AUTO_LOAD_BYTES = 20 * 1024 * 1024; // images/audio/video up to 20 MB load by themselves

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function kindOf(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  return 'file';
}

const ICON = { image: '🖼️', audio: '🎵', video: '🎬', file: '📎' };

function saveAs(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Download the encrypted blob and decrypt it on this device. Returns a blob: URL once ready. */
function useDecryptedBlob(m, getKey, type, auto) {
  const p = m.payload;
  const [url, setUrl] = useState(null);
  const [state, setState] = useState(auto ? 'loading' : 'idle'); // idle | loading | ready | error
  const urlRef = useRef(null);

  async function ensure() {
    if (urlRef.current) return urlRef.current;
    setState('loading');
    try {
      const key = await getKey();
      const cipher = await api.downloadFile(m.fileId);
      const plain = await decryptBytes(key, p.fiv, cipher, `file:${m.from}>${m.to}`);
      const objectUrl = URL.createObjectURL(new Blob([plain], { type }));
      urlRef.current = objectUrl;
      setUrl(objectUrl);
      setState('ready');
      return objectUrl;
    } catch {
      setState('error');
      return null;
    }
  }

  useEffect(() => {
    if (auto) ensure();
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { url, state, ensure };
}

function FileBody({ m, getKey, onLoaded }) {
  const p = m.payload;
  const kind = kindOf(p.mime);
  const auto = kind !== 'file' && p.size <= AUTO_LOAD_BYTES;
  // Only media types keep their type; everything else is treated as opaque bytes.
  const { url, state, ensure } = useDecryptedBlob(m, getKey, kind === 'file' ? 'application/octet-stream' : p.mime, auto);

  const hint =
    state === 'loading' ? 'decrypting…' : state === 'error' ? 'failed, tap to retry' : kind === 'file' ? 'tap to download' : 'tap to load';

  if (kind === 'file') {
    return (
      <button
        className="file-card"
        onClick={async () => {
          const u = await ensure();
          if (u) saveAs(u, p.name);
        }}
      >
        <span className="file-icon">{ICON.file}</span>
        <span className="file-meta">
          <span className="file-name">{p.name}</span>
          <span className="muted small-text">
            {fmtSize(p.size)} · {hint}
          </span>
        </span>
      </button>
    );
  }

  if (state !== 'ready') {
    return (
      <button className="file-card" onClick={ensure} disabled={state === 'loading'}>
        <span className="file-icon">{ICON[kind]}</span>
        <span className="file-meta">
          <span className="file-name">{p.name}</span>
          <span className="muted small-text">
            {fmtSize(p.size)} · {hint}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="media-wrap">
      {kind === 'image' && <img className="media" src={url} alt={p.name} onLoad={onLoaded} />}
      {kind === 'video' && <video className="media" src={url} controls preload="metadata" onLoadedMetadata={onLoaded} />}
      {kind === 'audio' && <audio className="audio" src={url} controls preload="metadata" />}
      <div className="media-foot">
        <span className="muted small-text">
          {p.name} · {fmtSize(p.size)}
        </span>
        <button className="link small-text" onClick={() => saveAs(url, p.name)}>
          Save
        </button>
      </div>
    </div>
  );
}

let playingAudio = null; // only one voice message plays at a time

function VoiceBody({ m, getKey }) {
  const p = m.payload;
  const type = /^audio\/[\w.+-]+(;.*)?$/i.test(p.mime) ? p.mime : 'audio/webm';
  const { url, state, ensure } = useDecryptedBlob(m, getKey, type, true);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // seconds

  const dur = Number.isFinite(p.dur) && p.dur > 0 ? p.dur : 0;
  const wave = Array.isArray(p.wave) && p.wave.length ? p.wave.slice(0, 64) : Array.from({ length: 40 }, () => 35);
  const progress = dur ? Math.min(1, pos / dur) : 0;

  async function toggle() {
    const a = audioRef.current;
    if (!a) {
      if (state === 'error') ensure();
      return;
    }
    if (a.paused) {
      if (playingAudio && playingAudio !== a) playingAudio.pause();
      playingAudio = a;
      a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
  }

  return (
    <div className={`voice ${playing ? 'playing' : ''}`}>
      <button
        className="voice-btn"
        onClick={toggle}
        disabled={state === 'loading'}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {state === 'loading' ? '…' : state === 'error' ? '↻' : playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-wave" aria-hidden="true">
        {wave.map((v, i) => (
          <i key={i} className={i / wave.length < progress ? 'done' : ''} style={{ height: `${Math.max(12, Math.min(100, v))}%` }} />
        ))}
      </div>
      <span className="voice-time small-text">{fmtDuration(playing || pos > 0 ? pos : dur)}</span>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        />
      )}
    </div>
  );
}

function validFile(p) {
  return (
    typeof p.name === 'string' &&
    typeof p.mime === 'string' &&
    typeof p.fiv === 'string' &&
    Number.isFinite(p.size) &&
    p.size >= 0
  );
}

function validVoice(p) {
  return typeof p.mime === 'string' && typeof p.fiv === 'string' && Number.isFinite(p.size) && p.size >= 0;
}

function statusOf(m) {
  if (m.status) return m.status; // 'sending' | 'failed' (set locally)
  if (m.seenAt) return 'seen';
  if (m.deliveredAt) return 'delivered';
  return 'sent';
}

// Groups reactions into { emoji, count, mine } chips.
function groupReactions(list, myId) {
  const map = new Map();
  for (const r of list || []) {
    const g = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    g.count += 1;
    if (r.by === myId) g.mine = true;
    map.set(r.emoji, g);
  }
  return [...map.values()];
}

export default function MessageBubble({
  m,
  mine,
  myId,
  peerName,
  quoted,
  getKey,
  onLoaded,
  onReply,
  onReact,
  onPin,
  onUnsend,
  onJump,
}) {
  const [menu, setMenu] = useState(null); // { kind: 'react' | 'more', anchor: HTMLElement }
  const closeMenu = () => setMenu(null);
  const openMenu = (kind) => (e) => {
    const anchor = e.currentTarget;
    setMenu((cur) => (cur?.kind === kind ? null : { kind, anchor }));
  };

  const p = m.payload;
  const replyId = typeof p?.replyTo === 'string' && OID_RE.test(p.replyTo) ? p.replyTo : null;
  const tmp = m.status === 'sending';

  let body;
  if (m.unsent) {
    body = <span className="unsent">🚫 {mine ? 'You unsent this message' : 'This message was unsent'}</span>;
  } else if (m.error) {
    body = <span className="muted">⚠ {m.error}</span>;
  } else if (p?.k === 'text' && typeof p.text === 'string') {
    body = <p className="text">{p.text}</p>;
  } else if (p?.k === 'voice' && m.fileId && validVoice(p)) {
    body = <VoiceBody m={m} getKey={getKey} />;
  } else if (p?.k === 'file' && m.fileId && validFile(p)) {
    body = <FileBody m={m} getKey={getKey} onLoaded={onLoaded} />;
  } else {
    body = <span className="muted">⚠ Unsupported message</span>;
  }

  const live = !m.unsent && !m.error && !tmp;
  const chips = live ? groupReactions(m.reactions, myId) : [];
  const myReaction = m.reactions?.find((r) => r.by === myId)?.emoji;
  const copyable = p?.k === 'text' && typeof p.text === 'string' && live;

  // Clicking a message starts a reply to it. Buttons, players and links inside it keep their own action,
  // and selecting text with the mouse is not mistaken for a click.
  function onBubbleClick(e) {
    if (!live) return;
    if (window.getSelection?.()?.toString()) return;
    if (e.target.closest('button, a, audio, video, input, textarea, select')) return;
    onReply(m);
  }

  return (
    <div className={`row ${mine ? 'mine' : ''} ${menu ? 'open' : ''}`}>
      <div className="msg-col">
        <div
          className={`bubble ${mine ? 'mine' : ''} ${m.error ? 'broken' : ''} ${m.unsent ? 'gone' : ''} ${live ? 'replyable' : ''}`}
          onClick={onBubbleClick}
        >
          {m.pinned && !m.unsent && <div className="pin-tag">📌 Pinned</div>}

          {replyId && !m.unsent && (
            <button className="quote" onClick={() => quoted && onJump(replyId)} disabled={!quoted}>
              <span className="quote-who">{quoted ? (quoted.from === myId ? 'You' : peerName) : 'Original message'}</span>
              <span className="quote-text">{quoted ? previewOf(quoted) : 'Earlier message'}</span>
            </button>
          )}

          {body}

          <span className="meta">
            <span className="time">{fmtTime(m.createdAt)}</span>
            {mine && !m.unsent && <Ticks status={statusOf(m)} />}
          </span>
        </div>

        {chips.length > 0 && (
          <div className="reactions">
            {chips.map((c) => (
              <button
                key={c.emoji}
                className={`chip ${c.mine ? 'mine' : ''}`}
                onClick={() => onReact(m, c.emoji)}
                title={c.mine ? 'Tap to remove your reaction' : 'React with the same emoji'}
              >
                {c.emoji}
                {c.count > 1 && <span className="chip-n">{c.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {live && (
        <div className="msg-tools">
          <button className="tool" onClick={openMenu('react')} aria-label="React with emoji" title="React">
            ☺
          </button>
          <button className="tool" onClick={() => onReply(m)} aria-label="Reply" title="Reply">
            ↩
          </button>
          <button className="tool" onClick={openMenu('more')} aria-label="More actions" title="More">
            ⋯
          </button>
        </div>
      )}

      {menu?.kind === 'react' && (
        <Popover anchor={menu.anchor} onClose={closeMenu}>
          <EmojiPicker
            mine={myReaction}
            onPick={(emoji) => {
              closeMenu();
              onReact(m, emoji);
            }}
          />
        </Popover>
      )}

      {menu?.kind === 'more' && (
        <Popover anchor={menu.anchor} onClose={closeMenu} className="menu">
          <button
            className="menu-item"
            onClick={() => {
              closeMenu();
              onReply(m);
            }}
          >
            ↩ Reply
          </button>
          <button
            className="menu-item"
            onClick={() => {
              closeMenu();
              onPin(m, !m.pinned);
            }}
          >
            📌 {m.pinned ? 'Unpin message' : 'Pin message'}
          </button>
          {copyable && (
            <button
              className="menu-item"
              onClick={() => {
                closeMenu();
                navigator.clipboard?.writeText(p.text).catch(() => {});
              }}
            >
              ⧉ Copy text
            </button>
          )}
          {mine && (
            <button
              className="menu-item danger"
              onClick={() => {
                closeMenu();
                onUnsend(m);
              }}
            >
              🗑 Unsend
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}
