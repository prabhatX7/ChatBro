import mongoose from 'mongoose';
import User from '../models/User.js';

const { ObjectId } = mongoose.Types;

// Set `fields` on the given messages in BOTH participants' documents (each keeps its own copy).
export function updateMessageEverywhere(userIds, messageId, fields) {
  const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`messages.$[m].${k}`, v]));
  return User.updateMany(
    { _id: { $in: userIds.map((i) => new ObjectId(String(i))) } },
    { $set: set },
    { arrayFilters: [{ 'm._id': new ObjectId(String(messageId)) }] }
  );
}

async function stamp(me, sender, ids, fields) {
  if (ids.length === 0) return;
  const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`messages.$[m].${k}`, v]));
  await User.updateMany(
    { _id: { $in: [me, sender] } },
    { $set: set },
    { arrayFilters: [{ 'm._id': { $in: ids } }] }
  );
}

/**
 * Messages sent TO `userId` that have not been marked delivered yet (they were sent while the user was offline).
 * Called when the user connects. Tells each sender, in realtime, that their messages arrived.
 */
export async function markDelivered(io, userId) {
  const me = new ObjectId(userId);
  const [doc] = await User.aggregate([
    { $match: { _id: me } },
    {
      $project: {
        pending: {
          $map: {
            input: {
              $filter: {
                input: '$messages',
                as: 'm',
                cond: { $and: [{ $eq: ['$$m.to', me] }, { $eq: [{ $ifNull: ['$$m.deliveredAt', null] }, null] }] },
              },
            },
            as: 'm',
            in: { id: '$$m._id', from: '$$m.from' },
          },
        },
      },
    },
  ]);

  const bySender = new Map();
  for (const p of doc?.pending || []) {
    const key = String(p.from);
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push(p.id);
  }

  const now = new Date();
  for (const [senderId, ids] of bySender) {
    await stamp(me, new ObjectId(senderId), ids, { deliveredAt: now });
    io.to(`user:${senderId}`).emit('status', { ids: ids.map(String), deliveredAt: now });
  }
}

/**
 * `userId` is looking at the chat with `peerId`: everything the friend sent is now seen.
 * Returns the ids that changed so the caller can update its own screen too.
 */
export async function markSeen(io, userId, peerId) {
  const me = new ObjectId(userId);
  const peer = new ObjectId(peerId);
  const [doc] = await User.aggregate([
    { $match: { _id: me } },
    {
      $project: {
        ids: {
          $map: {
            input: {
              $filter: {
                input: '$messages',
                as: 'm',
                cond: {
                  $and: [
                    { $eq: ['$$m.peer', peer] },
                    { $eq: ['$$m.from', peer] },
                    { $eq: [{ $ifNull: ['$$m.seenAt', null] }, null] },
                  ],
                },
              },
            },
            as: 'm',
            in: '$$m._id',
          },
        },
      },
    },
  ]);

  const ids = doc?.ids || [];
  if (ids.length === 0) return { ids: [], seenAt: null };

  const now = new Date();
  // Seen implies delivered; fill it in for the rare message that was never marked.
  await stamp(me, peer, ids, { seenAt: now });
  await User.updateMany(
    { _id: { $in: [me, peer] } },
    { $set: { 'messages.$[m].deliveredAt': now } },
    { arrayFilters: [{ 'm._id': { $in: ids }, 'm.deliveredAt': null }] }
  );

  io.to(`user:${peerId}`).emit('status', { ids: ids.map(String), deliveredAt: now, seenAt: now });
  return { ids: ids.map(String), seenAt: now };
}
