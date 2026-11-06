import { io } from 'socket.io-client';

let socket = null;

export function connectSocket(token) {
  disconnectSocket();
  socket = io({ auth: { token } });
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/** Tell a friend you are typing / speaking (kind: 'typing' | 'speaking'). Never stored by the server. */
export function sendActivity(to, kind, on) {
  if (socket?.connected) socket.emit('activity', { to, kind, on });
}
