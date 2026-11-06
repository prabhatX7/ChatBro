// Message status marks: sending (clock), sent (✓), delivered (✓✓), seen (✓✓ glowing), failed (!).

const LABEL = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', seen: 'Seen', failed: 'Failed' };

export default function Ticks({ status }) {
  return (
    <span className={`ticks ${status}`} title={LABEL[status]} aria-label={LABEL[status]} role="img">
      <svg viewBox="0 0 30 24" width="17" height="14" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {status === 'sending' && (
          <g stroke="currentColor">
            <circle cx="15" cy="12" r="8" />
            <path className="clock-hand" d="M15 7.5V12l3 2" />
          </g>
        )}
        {status === 'sent' && <path stroke="currentColor" d="M9 12.5l5 5L22 7" />}
        {(status === 'delivered' || status === 'seen') && (
          <g stroke="currentColor">
            <path d="M3 12.5l5 5L18 7" />
            <path d="M12 17.5l1.2 1.2L25 7" />
          </g>
        )}
        {status === 'failed' && (
          <g stroke="currentColor">
            <path d="M15 5v9M15 19h.01" />
          </g>
        )}
      </svg>
    </span>
  );
}

/** "Alice is typing…" / "Alice is speaking…" with a looping animation. */
export function ActivityLabel({ name, kind, short = false }) {
  const who = short ? '' : `${name} `;
  if (kind === 'speaking') {
    return (
      <span className="act">
        {who}
        {short ? 'speaking' : 'is speaking'}
        <span className="eq" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
    );
  }
  return (
    <span className="act">
      {who}
      {short ? 'typing' : 'is typing'}
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
