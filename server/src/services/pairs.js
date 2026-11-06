import User from '../models/User.js';
import { canChat } from './access.js';

/** True when `userId` is allowed to see and message `peerId` (looked up fresh from the database). */
export async function mayChat(userId, peerId) {
  if (String(userId) === String(peerId)) return false;
  const docs = await User.find({ _id: { $in: [userId, peerId] } }, 'role group status').lean();
  if (docs.length !== 2) return false;
  return canChat(docs[0], docs[1]);
}
