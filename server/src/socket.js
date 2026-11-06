import { Server } from 'socket.io';
import { config } from './config.js';
import { verifyToken } from './middleware/auth.js';
import { markDelivered } from './services/receipts.js';
import { canChat, isAdmin } from './services/access.js';
import User from './models/User.js';

const OID = /^[a-f0-9]{24}$/;
const ACTIVITY = new Set(['typing', 'speaking']);

export function createSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.clientOrigin },
    maxHttpBufferSize: 1e5, // sockets only carry tiny events; files go over HTTP
  });

  // userId -> { count, role, group }. Role and group are kept so we can decide who may see whom.
  const online = new Map();
  io.isOnline = (userId) => (online.get(String(userId))?.count || 0) > 0;

  // Rooms: user:<id> (one person, all their tabs), group:<id> (members of a group), admins (the admin).
  io.use(async (socket, next) => {
    try {
      const id = verifyToken(socket.handshake.auth?.token);
      const u = await User.findById(id, 'role group status').lean();
      if (!u || u.status === 'pending') return next(new Error('unauthorized'));
      socket.userId = id;
      socket.meta = { role: u.role || 'member', group: u.group ? String(u.group) : null };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // Online/offline is only announced to people who are allowed to see this person.
  function announce(userId, meta, isOnline) {
    const payload = { userId, online: isOnline };
    if (isAdmin(meta)) {
      io.emit('presence', payload); // everyone can see the admin
      return;
    }
    let target = io.to('admins');
    if (meta.group) target = target.to(`group:${meta.group}`);
    target.emit('presence', payload);
  }

  io.on('connection', (socket) => {
    const id = socket.userId;
    const meta = socket.meta;

    socket.join(`user:${id}`);
    if (isAdmin(meta)) socket.join('admins');
    if (meta.group) socket.join(`group:${meta.group}`);

    // Always take the latest role/group: it changes when the admin moves someone, and that person reconnects.
    const entry = online.get(id) || { count: 0 };
    Object.assign(entry, { count: entry.count + 1, ...meta });
    online.set(id, entry);
    announce(id, meta, true);

    // Only the people you may see, never the whole server's online list.
    const visible = [...online.entries()].filter(([uid, m]) => uid !== id && canChat(meta, m)).map(([uid]) => uid);
    socket.emit('presence:list', visible);

    // Anything friends sent while you were away has now been delivered.
    markDelivered(io, id).catch((err) => console.error('markDelivered failed:', err.message));

    // "typing" / "speaking" hints. They are never stored, only relayed to the friend, and capped per connection.
    let budget = 30;
    const refill = setInterval(() => (budget = 30), 5000);
    socket.on('activity', (p) => {
      if (budget-- <= 0) return;
      if (!p || typeof p.to !== 'string' || !OID.test(p.to) || !ACTIVITY.has(p.kind)) return;
      const target = online.get(p.to);
      if (!target || !canChat(meta, target)) return; // only relay to someone you are allowed to talk to
      io.to(`user:${p.to}`).emit('activity', { from: id, kind: p.kind, on: p.on === true });
    });

    socket.on('disconnect', () => {
      clearInterval(refill);
      const e = online.get(id);
      if (!e) return;
      e.count -= 1;
      if (e.count <= 0) {
        online.delete(id);
        announce(id, meta, false);
      }
    });
  });

  return io;
}
