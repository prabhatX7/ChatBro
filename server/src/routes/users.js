import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { requireAuth, wrap } from '../middleware/auth.js';
import { isAdmin } from '../services/access.js';
import { mayChat } from '../services/pairs.js';
import { baseWire, adminWire, groupNames } from '../services/wire.js';

const OID = /^[a-f0-9]{24}$/;

export default function usersRouter(io) {
  const r = Router();

  // The people YOU may see:
  //  - admin  -> everyone approved, each tagged with their group (folder)
  //  - member -> the admin, plus approved members of your own group. A member with no group sees only the admin.
  //              Nobody else is ever sent to your browser, and people still waiting for approval never appear.
  // `pinnedChats` is the list of friends you pinned to the top.
  r.get(
    '/',
    requireAuth,
    wrap(async (req, res) => {
      const me = await User.findById(req.userId, 'role group pinnedChats').lean();
      if (!me) return res.status(401).json({ error: 'Account not found' });
      const admin = isAdmin(me);
      const approved = { status: { $ne: 'pending' } };

      const filter = admin
        ? { _id: { $ne: me._id }, ...approved }
        : {
            _id: { $ne: me._id },
            ...approved,
            $or: [{ role: 'admin' }, ...(me.group ? [{ group: me.group }] : [])],
          };

      const list = await User.find(filter, 'name publicKey role group via').sort({ name: 1 }).lean();
      const names = admin ? await groupNames(list.flatMap((u) => [u.group, u.via])) : new Map();

      res.json({
        // Only the admin is told which group someone is in.
        users: list.map((u) => (admin ? adminWire(u, names) : baseWire(u))),
        pinnedChats: (me.pinnedChats || []).map(String),
      });
    })
  );

  // Pin or unpin a chat in your own list (private to you, synced across your devices).
  r.put(
    '/pins/:peerId',
    requireAuth,
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId) || peerId === req.userId) return res.status(400).json({ error: 'Bad id' });
      if (!(await mayChat(req.userId, peerId))) return res.status(404).json({ error: 'User not found' });

      const id = new mongoose.Types.ObjectId(peerId);
      await User.updateOne(
        { _id: req.userId },
        req.body?.pinned === true ? { $addToSet: { pinnedChats: id } } : { $pull: { pinnedChats: id } }
      );
      const me = await User.findById(req.userId, 'pinnedChats').lean();
      const pinnedChats = (me?.pinnedChats || []).map(String);
      io.to(`user:${req.userId}`).emit('chats:pinned', pinnedChats);
      res.json({ pinnedChats });
    })
  );

  return r;
}
