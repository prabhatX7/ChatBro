// Small helpers shared by several components.

export const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const OID_RE = /^[a-f0-9]{24}$/;

/** One-line description of a decrypted message, used for pop-ups, quotes and the pinned bar. */
export function previewOf(m) {
  if (!m) return 'New encrypted message';
  if (m.unsent) return '🚫 This message was unsent';
  const payload = m.payload;
  if (!payload) return 'New encrypted message';
  if (payload.k === 'voice') return `🎤 Voice message${payload.dur ? ` (${fmtDuration(payload.dur)})` : ''}`;
  if (payload.k === 'file') {
    const mime = String(payload.mime || '');
    if (mime.startsWith('image/')) return '📷 Photo';
    if (mime.startsWith('audio/')) return `🎵 ${payload.name}`;
    if (mime.startsWith('video/')) return `🎬 ${payload.name}`;
    return `📎 ${payload.name}`;
  }
  const text = String(payload.text || '');
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}
