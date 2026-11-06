import User from '../models/User.js';
import { wrap } from './auth.js';

// The role is read from the database on every request, never trusted from the login token.
export const requireAdmin = wrap(async (req, res, next) => {
  const me = await User.findById(req.userId, 'role').lean();
  if (me?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
});
