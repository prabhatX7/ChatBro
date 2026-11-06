import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Group from '../models/Group.js';
import { config } from '../config.js';
import { requireAuth, signToken, wrap } from '../middleware/auth.js';
import { normalizeCode } from '../services/codes.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX64 = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9+/=]+$/;
// Compared against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-secret', 12);

const publicUser = (u) => ({
  id: String(u._id),
  name: u.name,
  publicKey: u.publicKey,
  role: u.role || 'member',
});

function validPublicKey(s) {
  try {
    const k = JSON.parse(s);
    return k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && s.length < 400;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const BAD_CODE = 'That code is not valid';

export default function authRouter(io) {
  const r = Router();

  r.post(
    '/register',
    wrap(async (req, res) => {
      const { name, email, authSecret, publicKey, encPrivateKey, inviteCode } = req.body || {};

      if (typeof name !== 'string' || !name.trim() || name.trim().length > 40)
        return res.status(400).json({ error: 'Name must be 1–40 characters' });
      if (typeof email !== 'string' || !EMAIL.test(email) || email.length > 200)
        return res.status(400).json({ error: 'Enter a valid email' });
      if (typeof authSecret !== 'string' || !HEX64.test(authSecret))
        return res.status(400).json({ error: 'Malformed credentials' });
      if (typeof publicKey !== 'string' || !validPublicKey(publicKey))
        return res.status(400).json({ error: 'Malformed public key' });
      if (
        !encPrivateKey ||
        typeof encPrivateKey.iv !== 'string' ||
        typeof encPrivateKey.data !== 'string' ||
        !B64.test(encPrivateKey.iv) ||
        !B64.test(encPrivateKey.data) ||
        encPrivateKey.iv.length > 32 ||
        encPrivateKey.data.length > 2000
      )
        return res.status(400).json({ error: 'Malformed key bundle' });

      const normalizedEmail = email.trim().toLowerCase();

      // Who is this person joining as?
      //  - the ADMIN_EMAIL address, with the admin setup code  -> the admin
      //  - any other address, with an open group's code        -> a member of that group
      // The error is the same in every failure case so it does not reveal which email is the admin's.
      let role = 'member';
      let group = null;
      if (normalizedEmail === config.adminEmail) {
        if (!config.adminSetupCode || !safeEqual(String(inviteCode || '').trim(), config.adminSetupCode)) {
          return res.status(403).json({ error: BAD_CODE });
        }
        role = 'admin';
      } else {
        const code = normalizeCode(inviteCode);
        group = code ? await Group.findOne({ code, active: true }) : null;
        if (!group) return res.status(403).json({ error: BAD_CODE });
      }

      if (await User.exists({ email: normalizedEmail }))
        return res.status(409).json({ error: 'An account with that email already exists' });

      const user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        authHash: await bcrypt.hash(authSecret, 12),
        publicKey,
        encPrivateKey: { iv: encPrivateKey.iv, data: encPrivateKey.data },
        role,
        // Members wait for the admin. The code they used is only a request: they get no group (and so see
        // nobody) until the admin approves them.
        status: role === 'admin' ? 'active' : 'pending',
        group: null,
        requestedGroup: group ? group._id : null,
      });

      const pub = publicUser(user);
      if (role === 'admin') {
        io.emit('user:new', pub); // everyone can see the admin
        return res.status(201).json({ token: signToken(user._id), user: pub });
      }

      // No token: a pending person cannot use the app. Only the admin hears about the request.
      io.to('admins').emit('signup:pending', { id: String(user._id), name: user.name });
      res.status(201).json({ pending: true });
    })
  );

  r.post(
    '/login',
    wrap(async (req, res) => {
      const { email, authSecret } = req.body || {};
      if (typeof email !== 'string' || typeof authSecret !== 'string' || !HEX64.test(authSecret))
        return res.status(400).json({ error: 'Malformed credentials' });

      const user = await User.findOne(
        { email: email.trim().toLowerCase() },
        'name publicKey authHash encPrivateKey role status'
      );
      const ok = await bcrypt.compare(authSecret, user ? user.authHash : DUMMY_HASH);
      if (!user || !ok) return res.status(401).json({ error: 'Wrong email or password' });

      // Told only after the password is right, so this does not reveal which emails exist.
      if (user.status === 'pending') {
        return res
          .status(403)
          .json({ error: 'Your request is waiting for the admin to approve it. Please try again later.', pending: true });
      }

      res.json({
        token: signToken(user._id),
        user: publicUser(user),
        encPrivateKey: { iv: user.encPrivateKey.iv, data: user.encPrivateKey.data },
      });
    })
  );

  r.get(
    '/me',
    requireAuth,
    wrap(async (req, res) => {
      const user = await User.findById(req.userId, 'name publicKey role');
      if (!user) return res.status(401).json({ error: 'Account not found' });
      res.json({ user: publicUser(user) });
    })
  );

  return r;
}
