import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/**
 * Small floating panel anchored to a button. Rendered in <body> so the scrolling message list
 * can never clip it, and flipped below the anchor when there is no room above.
 */
export default function Popover({ anchor, onClose, children, className = '' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = a.top - h - 8;
    if (top < 8) top = a.bottom + 8;
    top = clamp(top, 8, Math.max(8, window.innerHeight - h - 8));
    const left = clamp(a.left + a.width / 2 - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [anchor, children]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onScroll = (e) => !ref.current?.contains(e.target) && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body
  );
}
