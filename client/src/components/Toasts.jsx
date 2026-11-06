export default function Toasts({ items, onOpen, onClose }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast" role="status" onClick={() => onOpen(t.peerId)}>
          <div className="toast-text">
            <div className="toast-title">{t.title}</div>
            <div className="toast-body">{t.body}</div>
          </div>
          <button
            className="icon-btn"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
