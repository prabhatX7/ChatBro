import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { config } from '../config.js';
import { requireAuth, wrap } from '../middleware/auth.js';
import { markSeen, updateMessageEverywhere } from '../services/receipts.js';
import { mayChat } from '../services/pairs.js';

const { ObjectId } = mongoose.Types;
const OID = /^[a-f0-9]{24}$/;
const FILE_ID = /^[a-f0-9]{32}$/;
const B64 = /^[A-Za-z0-9+/=]+$/;

const toWire = (m) => {
  const base = {
    _id: String(m._id),
    from: String(m.from),
    to: String(m.to),
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt || null,
    seenAt: m.seenAt || null,
  };
  // An unsent message keeps only its place in the timeline; the ciphertext is already gone.
  if (m.unsent) return { ...base, unsent: true, iv: '', ct: '', fileId: null, pinned: false, pinnedAt: null, reactions: [] };
  return {
    ...base,
    unsent: false,
    iv: m.iv,
    ct: m.ct,
    fileId: m.fileId || null,
    pinned: Boolean(m.pinned),
    pinnedAt: m.pinnedAt || null,
    reactions: (m.reactions || []).map((r) => ({ by: String(r.by), iv: r.iv, ct: r.ct })),
  };
};

// A blob can be deleted from disk once no one's document points at it any more.
async function removeFilesIfOrphaned(fileIds) {
  for (const id of fileIds) {
    if (!id || !FILE_ID.test(id)) continue;
    if (await User.exists({ 'messages.fileId': id })) continue;
    await fs.promises.rm(path.join(config.uploadDir, id), { force: true });
  }
}

export default function messagesRouter(io) {
  const r = Router();
  r.use(requireAuth);

  // The caller's own copy of one message in the chat with `peerId` (also proves they take part in it).
  async function findMine(req, res) {
    const { peerId, msgId } = req.params;
    if (!OID.test(peerId) || !OID.test(msgId)) {
      res.status(400).json({ error: 'Bad id' });
      return null;
    }
    const doc = await User.findOne(
      { _id: req.userId, messages: { $elemMatch: { _id: msgId, peer: peerId } } },
      { 'messages.$': 1 }
    ).lean();
    const m = doc?.messages?.[0];
    if (!m) {
      res.status(404).json({ error: 'Message not found' });
      return null;
    }
    return m;
  }

  // Tell both people (every open tab) the current state of one message.
  async function broadcastUpdate(req, msgId, peerId) {
    const doc = await User.findOne(
      { _id: req.userId, messages: { $elemMatch: { _id: msgId, peer: peerId } } },
      { 'messages.$': 1 }
    ).lean();
    const m = doc?.messages?.[0];
    if (!m) return null;
    const wire = toWire(m);
    io.to(`user:${req.userId}`).to(`user:${peerId}`).emit('message:update', wire);
    return wire;
  }

  // Encrypted history with one friend (latest first-N, oldest to newest).
  r.get(
    '/:peerId',
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId)) return res.status(400).json({ error: 'Bad id' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

      const [doc] = await User.aggregate([
        { $match: { _id: new ObjectId(req.userId) } },
        {
          $project: {
            messages: {
              $slice: [
                { $filter: { input: '$messages', as: 'm', cond: { $eq: ['$$m.peer', new ObjectId(peerId)] } } },
                -limit,
              ],
            },
          },
        },
      ]);
      res.json({ messages: (doc?.messages || []).map(toWire) });
    })
  );

  // Store a ciphertext in both users' documents and push it to both in realtime.
  r.post(
    '/:peerId',
    wrap(async (req, res) => {
      const { peerId } = req.params;
      const { iv, ct, fileId = null } = req.body || {};

      if (!OID.test(peerId)) return res.status(400).json({ error: 'Bad id' });
      if (peerId === req.userId) return res.status(400).json({ error: 'You cannot message yourself' });
      if (typeof iv !== 'string' || iv.length > 32 || !B64.test(iv)) return res.status(400).json({ error: 'Bad message' });
      if (typeof ct !== 'string' || ct.length > 100000 || !B64.test(ct)) return res.status(400).json({ error: 'Bad message' });
      if (fileId !== null && (typeof fileId !== 'string' || !FILE_ID.test(fileId)))
        return res.status(400).json({ error: 'Bad file reference' });
      if (fileId && !fs.existsSync(path.join(config.uploadDir, fileId)))
        return res.status(400).json({ error: 'Attachment was not uploaded' });
      if (!(await User.exists({ _id: peerId }))) return res.status(404).json({ error: 'User not found' });
      // Groups: members can only message their own group and the admin; the admin can message anyone.
      if (!(await mayChat(req.userId, peerId))) return res.status(403).json({ error: 'You cannot message this user' });

      const now = new Date();
      const base = {
        _id: new ObjectId(),
        from: req.userId,
        to: peerId,
        iv,
        ct,
        fileId,
        createdAt: now,
        // If your friend has the app open right now, it is delivered the moment it is stored.
        deliveredAt: io.isOnline(peerId) ? now : null,
        seenAt: null,
        pinned: false,
        pinnedAt: null,
        unsent: false,
        reactions: [],
      };
      await Promise.all([
        User.updateOne({ _id: req.userId }, { $push: { messages: { ...base, peer: peerId } } }),
        User.updateOne({ _id: peerId }, { $push: { messages: { ...base, peer: req.userId } } }),
      ]);

      const wire = toWire(base);
      io.to(`user:${req.userId}`).to(`user:${peerId}`).emit('message', wire);
      res.status(201).json(wire);
    })
  );

  // You are looking at this chat: mark the friend's messages as seen.
  r.post(
    '/:peerId/seen',
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId)) return res.status(400).json({ error: 'Bad id' });
      const out = await markSeen(io, req.userId, peerId);
      res.json(out);
    })
  );

  // Unsend: remove your own message for both people. A "this message was unsent" marker stays in the timeline.
  r.delete(
    '/:peerId/:msgId',
    wrap(async (req, res) => {
      const m = await findMine(req, res);
      if (!m) return;
      if (String(m.from) !== req.userId) return res.status(403).json({ error: 'You can only unsend your own messages' });
      if (m.unsent) return res.json({ ok: true });

      await updateMessageEverywhere([req.userId, req.params.peerId], req.params.msgId, {
        unsent: true,
        iv: '',
        ct: '',
        fileId: null,
        pinned: false,
        pinnedAt: null,
        reactions: [],
      });
      await removeFilesIfOrphaned([m.fileId]);
      await broadcastUpdate(req, req.params.msgId, req.params.peerId);
      res.json({ ok: true });
    })
  );

  // React with an emoji (encrypted by the browser). One reaction per person; send `clear: true` to remove yours.
  r.put(
    '/:peerId/:msgId/react',
    wrap(async (req, res) => {
      const m = await findMine(req, res);
      if (!m) return;
      if (m.unsent) return res.status(409).json({ error: 'This message was unsent' });

      const { iv, ct, clear } = req.body || {};
      if (clear !== true) {
        if (typeof iv !== 'string' || iv.length > 32 || !B64.test(iv)) return res.status(400).json({ error: 'Bad reaction' });
        if (typeof ct !== 'string' || ct.length > 400 || !B64.test(ct)) return res.status(400).json({ error: 'Bad reaction' });
      }

      const both = { _id: { $in: [new ObjectId(req.userId), new ObjectId(req.params.peerId)] } };
      const filters = { arrayFilters: [{ 'm._id': new ObjectId(req.params.msgId) }] };
      const me = new ObjectId(req.userId);
      await User.updateMany(both, { $pull: { 'messages.$[m].reactions': { by: me } } }, filters);
      if (clear !== true) {
        await User.updateMany(both, { $push: { 'messages.$[m].reactions': { by: me, iv, ct } } }, filters);
      }
      const wire = await broadcastUpdate(req, req.params.msgId, req.params.peerId);
      res.json(wire);
    })
  );

  // Pin / unpin a message for both people.
  r.put(
    '/:peerId/:msgId/pin',
    wrap(async (req, res) => {
      const m = await findMine(req, res);
      if (!m) return;
      if (m.unsent) return res.status(409).json({ error: 'This message was unsent' });

      const pinned = req.body?.pinned === true;
      await updateMessageEverywhere([req.userId, req.params.peerId], req.params.msgId, {
        pinned,
        pinnedAt: pinned ? new Date() : null,
      });
      const wire = await broadcastUpdate(req, req.params.msgId, req.params.peerId);
      res.json(wire);
    })
  );

  // Delete the whole chat with one friend, from YOUR side only. They keep their copy.
  r.delete(
    '/:peerId',
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId)) return res.status(400).json({ error: 'Bad id' });

      const doc = await User.findById(req.userId, 'messages').lean();
      const fileIds = (doc?.messages || []).filter((m) => String(m.peer) === peerId && m.fileId).map((m) => m.fileId);

      await User.updateOne({ _id: req.userId }, { $pull: { messages: { peer: new ObjectId(peerId) } } });
      await removeFilesIfOrphaned(fileIds);

      io.to(`user:${req.userId}`).emit('chat:deleted', { peerId });
      res.json({ ok: true });
    })
  );

  return r;
}
