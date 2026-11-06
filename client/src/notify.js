// Desktop pop-ups use the browser Notification API. The text shown is decrypted locally on this device.

export const notificationsSupported = () => typeof Notification !== 'undefined';
export const notificationPermission = () => (notificationsSupported() ? Notification.permission : 'unsupported');

export function askPermission() {
  if (!notificationsSupported() || Notification.permission !== 'default') {
    return Promise.resolve(notificationPermission());
  }
  return Notification.requestPermission();
}

export function desktopNotify({ title, body, tag, onClick }) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, icon: '/icon.svg' });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}

let audioCtx = null;

/** Short two-tone chime. */
export function ping() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch {
    /* audio blocked until the user interacts with the page */
  }
}
