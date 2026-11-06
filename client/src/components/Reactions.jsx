import { useState } from 'react';

export const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const MORE = [
  '😀', '😁', '🥹', '😍', '🤩', '😎', '🤔', '😅', '🥲', '😭', '😡', '🤯',
  '👏', '🙌', '👎', '👀', '🔥', '🎉', '💯', '✅', '❌', '💜', '💔', '✨',
  '🤝', '👌', '🤞', '🫡', '😴', '🤮', '🥳', '😬', '🫶', '💀', '🍕', '☕',
];

/** Emoji row shown when you react to a message. `mine` is the emoji you already used (tap it again to remove). */
export default function EmojiPicker({ mine, onPick }) {
  const [more, setMore] = useState(false);
  return (
    <div className="emoji-picker">
      <div className="emoji-row">
        {QUICK.map((e) => (
          <button key={e} className={`emoji ${mine === e ? 'on' : ''}`} onClick={() => onPick(e)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
        <button className={`emoji plus ${more ? 'on' : ''}`} onClick={() => setMore((v) => !v)} aria-label="More emoji">
          ＋
        </button>
      </div>
      {more && (
        <div className="emoji-grid">
          {MORE.map((e) => (
            <button key={e} className={`emoji ${mine === e ? 'on' : ''}`} onClick={() => onPick(e)} aria-label={`React ${e}`}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
