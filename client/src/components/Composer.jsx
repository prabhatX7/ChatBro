import { useEffect, useRef, useState } from 'react';
import { fmtDuration, previewOf } from '../util.js';

const MAX_VOICE_SECONDS = 300;
const WAVE_POINTS = 40;
const SAMPLE_MS = 80;

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const wanted = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return wanted.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

// Squash the amplitude samples into a fixed number of 0–100 bars for the message's waveform.
function toWave(samples) {
  const out = [];
  for (let i = 0; i < WAVE_POINTS; i++) {
    const start = Math.floor((i * samples.length) / WAVE_POINTS);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / WAVE_POINTS));
    const slice = samples.slice(start, end);
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0);
  }
  const peak = Math.max(0.2, ...out);
  return out.map((v) => Math.round((v / peak) * 100));
}

export default function Composer({
  replyTo,
  replyWho,
  onCancelReply,
  onSendText,
  onFiles,
  onVoice,
  onActivity,
  onError,
  focusTick, // bumped by the chat window each time a reply starts, so the cursor goes back to the box
}) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState([]);
  const fileRef = useRef(null);
  const areaRef = useRef(null);

  // Latest callbacks, so timers started once still call the current versions.
  const cb = useRef({});
  cb.current = { onVoice, onActivity, onError };

  // Put the cursor in the message box: when a chat opens, when a reply starts, and when a recording ends.
  useEffect(() => {
    if (!recording) areaRef.current?.focus({ preventScroll: true });
  }, [focusTick, recording]);

  /* ---------- typing signal ---------- */

  const typing = useRef({ lastSent: 0, idle: null });

  function stopTyping() {
    clearTimeout(typing.current.idle);
    if (typing.current.lastSent) {
      cb.current.onActivity('typing', false);
      typing.current.lastSent = 0;
    }
  }

  function noteTyping() {
    const t = typing.current;
    const now = Date.now();
    if (now - t.lastSent > 2500) {
      cb.current.onActivity('typing', true);
      t.lastSent = now;
    }
    clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, 3500);
  }

  /* ---------- voice recording ---------- */

  const rec = useRef(null);

  function releaseRecorder(r) {
    clearInterval(r.sampler);
    clearInterval(r.heartbeat);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx?.close().catch(() => {});
    cb.current.onActivity('speaking', false);
  }

  async function startRecording() {
    if (rec.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      cb.current.onError('Voice messages need a browser with microphone support and an https:// (or localhost) page.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      cb.current.onError('Microphone access was blocked. Allow it for this site to send voice messages.');
      return;
    }

    const mimeType = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      cb.current.onError('Could not start the recorder in this browser.');
      return;
    }

    const r = { recorder, stream, chunks: [], samples: [], startedAt: Date.now(), send: false, mimeType };
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.onstop = () => {
      releaseRecorder(r);
      const seconds = (Date.now() - r.startedAt) / 1000;
      const blob = new Blob(r.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (r.send && seconds >= 0.6 && blob.size > 0) {
        cb.current.onVoice(blob, { dur: Math.round(seconds * 10) / 10, wave: toWave(r.samples) });
      }
    };

    // Live level meter (also becomes the waveform drawn on the message).
    try {
      r.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = r.ctx.createAnalyser();
      analyser.fftSize = 512;
      r.ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      r.sampler = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 3.5);
        r.samples.push(level);
        setLevels((l) => [...l.slice(-31), level]);
        const secs = Math.floor((Date.now() - r.startedAt) / 1000);
        setElapsed(secs);
        if (secs >= MAX_VOICE_SECONDS) finishRecording(true);
      }, SAMPLE_MS);
    } catch {
      r.sampler = setInterval(() => setElapsed(Math.floor((Date.now() - r.startedAt) / 1000)), 250);
    }

    // Let the friend see "speaking…". Repeated so it also clears itself if we vanish.
    cb.current.onActivity('speaking', true);
    r.heartbeat = setInterval(() => cb.current.onActivity('speaking', true), 3000);

    stopTyping();
    rec.current = r;
    setElapsed(0);
    setLevels([]);
    setRecording(true);
    recorder.start(250);
  }

  function finishRecording(send) {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    r.send = send;
    setRecording(false);
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else releaseRecorder(r);
  }

  useEffect(
    () => () => {
      finishRecording(false);
      stopTyping();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /* ---------- text ---------- */

  const grow = (el) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  async function submit() {
    const value = text.trim();
    if (!value) return;
    setText('');
    stopTyping();
    if (areaRef.current) areaRef.current.style.height = 'auto';
    areaRef.current?.focus(); // keep typing, even if you pressed the Send button
    const ok = await onSendText(value);
    if (!ok) setText(value); // put the text back if sending failed
  }

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-bar">
          <div className="reply-info">
            <span className="quote-who">Replying to {replyWho}</span>
            <span className="quote-text">{previewOf(replyTo)}</span>
          </div>
          <button className="icon-btn" aria-label="Cancel reply" onClick={onCancelReply}>
            ✕
          </button>
        </div>
      )}

      {recording ? (
        <div className="composer recording">
          <button className="icon-btn" title="Discard recording" aria-label="Discard recording" onClick={() => finishRecording(false)}>
            🗑
          </button>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">{fmtDuration(elapsed)}</span>
          <div className="rec-bars" aria-hidden="true">
            {levels.map((v, i) => (
              <i key={i} style={{ height: `${Math.max(8, v * 100)}%` }} />
            ))}
          </div>
          <button className="btn send" onClick={() => finishRecording(true)} aria-label="Send voice message">
            Send
          </button>
        </div>
      ) : (
        <div className="composer">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...e.target.files];
              e.target.value = '';
              if (files.length) {
                onFiles(files);
                areaRef.current?.focus();
              }
            }}
          />
          <button className="icon-btn attach" title="Attach files (any format)" aria-label="Attach files" onClick={() => fileRef.current.click()}>
            📎
          </button>
          <textarea
            ref={areaRef}
            rows={1}
            maxLength={10000}
            placeholder="Write a message…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              grow(e.target);
              if (e.target.value.trim()) noteTyping();
              else stopTyping();
            }}
            onBlur={stopTyping}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                onCancelReply();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                onFiles(files);
              }
            }}
          />
          {text.trim() ? (
            <button className="btn send" onClick={submit}>
              Send
            </button>
          ) : (
            <button className="icon-btn mic" title="Record a voice message" aria-label="Record a voice message" onClick={startRecording}>
              🎤
            </button>
          )}
        </div>
      )}
    </div>
  );
}
