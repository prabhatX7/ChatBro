import { Router } from 'express';
import User from '../models/User.js';
import Group from '../models/Group.js';
import { requireAuth, wrap } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { makeCode, formatCode } from '../services/codes.js';
import { decideDestination } from '../services/approval.js';
import { baseWire, adminWire, groupNames } from '../services/wire.js';

const OID = /^[a-f0-9]{24}$/;
const validName = (s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 40;

const toWire = (g, members = []) => ({
  id: String(g._id),
  name: g.name,
  code: g.code,
  display: formatCode(g.code),
  active: g.active !== false,
  private: Boolean(g.private),
  createdAt: g.createdAt,
  members: members.map((u) => ({ id: String(u._id), name: u.name })),
});

async function oneWire(id) {
  const g = await Group.findById(id).lean();
  if (!g) return null;
  const members = await User.find({ status: { $ne: 'pending' }, $or: [{ group: g._id }, { via: g._id }] }, 'name')
    .sort({ name: 1 })
    .lean();
  return toWire(g, members);
}

// Run `fn(code)` with a fresh random code, retrying in the (astronomically unlikely) case of a duplicate.
async function withNewCode(fn) {
  for (let i = 0; i < 5; i++) {
    try {
      return await fn(makeCode());
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error('Could not generate a unique code');
}

// Reads the admin's "where should this person go" answer from a request body.
//   no `group` key  -> choice undefined (accept the request as it is)
//   group: null     -> "only me"
//   group: "<id>"   -> that group (must exist)
async function parseChoice(body) {
  if (!body || !('group' in body)) return { ok: true, choice: undefined };
  if (body.group === null) return { ok: true, choice: null };
  if (typeof body.group === 'string' && OID.test(body.group)) {
    const g = await Group.findById(body.group, 'private').lean();
    if (!g) return { ok: false, status: 404, error: 'Group not found' };
    return { ok: true, choice: { id: String(g._id), private: Boolean(g.private) } };
  }
  return { ok: false, status: 400, error: 'Bad group' };
}

// Everything here is admin-only. The server checks the role on every request.
export default function adminRouter(io) {
  const r = Router();
  r.use(requireAuth, requireAdmin);

  const adminsChanged = () => io.to('admins').emit('admin:changed');

  // All groups (folders) with their codes and members, plus people who chat only with the admin and have no folder.
  r.get(
    '/groups',
    wrap(async (req, res) => {
      const [groups, people] = await Promise.all([
        Group.find({}).sort({ createdAt: 1 }).lean(),
        User.find({ status: { $ne: 'pending' }, role: { $ne: 'admin' } }, 'name group via').sort({ name: 1 }).lean(),
      ]);
      const byGroup = new Map();
      const loose = [];
      for (const u of people) {
        const key = u.group || u.via;
        if (!key) {
          loose.push({ id: String(u._id), name: u.name });
          continue;
        }
        if (!byGroup.has(String(key))) byGroup.set(String(key), []);
        byGroup.get(String(key)).push(u);
      }
      res.json({
        groups: groups.map((g) => toWire(g, byGroup.get(String(g._id)) || [])),
        privateOthers: loose,
      });
    })
  );

  // New group with a freshly generated code. `private: true` makes a one-to-one code for individuals.
  r.post(
    '/groups',
    wrap(async (req, res) => {
      const { name, private: isPrivate } = req.body || {};
      if (!validName(name)) return res.status(400).json({ error: 'Give the group a name (1–40 characters)' });
      const g = await withNewCode((code) => Group.create({ name: name.trim(), code, private: isPrivate === true }));
      res.status(201).json(toWire(g.toObject(), []));
    })
  );

  // Rename, open/close sign-ups with the code, or replace the code with a new one.
  r.patch(
    '/groups/:id',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const { name, active, regenerate } = req.body || {};

      const set = {};
      if (name !== undefined) {
        if (!validName(name)) return res.status(400).json({ error: 'Name must be 1–40 characters' });
        set.name = name.trim();
      }
      if (active !== undefined) {
        if (typeof active !== 'boolean') return res.status(400).json({ error: 'Bad value' });
        set.active = active;
      }

      if (!(await Group.exists({ _id: id }))) return res.status(404).json({ error: 'Group not found' });

      if (regenerate === true) {
        await withNewCode((code) => Group.updateOne({ _id: id }, { $set: { ...set, code } }));
      } else if (Object.keys(set).length) {
        await Group.updateOne({ _id: id }, { $set: set });
      }
      res.json(await oneWire(id));
    })
  );

  // Only a group nobody belongs to (and nobody is waiting to join) can be deleted.
  r.delete(
    '/groups/:id',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });
      if (await User.exists({ $or: [{ group: id }, { via: id }, { requestedGroup: id }] }))
        return res.status(409).json({ error: 'This group still has members or waiting requests. Close its code instead.' });
      await Group.deleteOne({ _id: id });
      res.json({ ok: true });
    })
  );

  // ---------- people waiting for approval ----------

  r.get(
    '/pending',
    wrap(async (req, res) => {
      const list = await User.find({ status: 'pending' }, 'name email createdAt requestedGroup').sort({ createdAt: 1 }).lean();
      const groups = await Group.find({ _id: { $in: list.map((u) => u.requestedGroup).filter(Boolean) } }, 'name private').lean();
      const byId = new Map(groups.map((g) => [String(g._id), g]));
      res.json({
        pending: list.map((u) => {
          const g = u.requestedGroup ? byId.get(String(u.requestedGroup)) : null;
          return {
            id: String(u._id),
            name: u.name,
            email: u.email,
            createdAt: u.createdAt,
            requested: g ? { id: String(g._id), name: g.name, private: Boolean(g.private) } : null,
          };
        }),
      });
    })
  );

  // Approve a request. Body: nothing (accept as requested), {group: null} (only me), or {group: "<id>"}.
  r.post(
    '/pending/:id/approve',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });

      const user = await User.findOne({ _id: id, status: 'pending' }, 'requestedGroup').lean();
      if (!user) return res.status(404).json({ error: 'That request no longer exists' });

      const parsed = await parseChoice(req.body);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });

      const requestedDoc = user.requestedGroup ? await Group.findById(user.requestedGroup, 'private').lean() : null;
      const requested = requestedDoc ? { id: String(requestedDoc._id), private: Boolean(requestedDoc.private) } : null;
      const dest = decideDestination(requested, parsed.choice);

      await User.updateOne(
        { _id: id, status: 'pending' },
        { $set: { status: 'active', group: dest.group, via: dest.via, requestedGroup: null } }
      );

      // Now (and only now) the newcomer becomes visible, and only to the people allowed to see them.
      const fresh = await User.findById(id, 'name publicKey role group via').lean();
      const names = await groupNames([fresh.group, fresh.via]);
      io.to('admins').emit('user:new', adminWire(fresh, names));
      if (dest.group) io.to(`group:${dest.group}`).emit('user:new', baseWire(fresh));
      adminsChanged();

      res.json({ user: adminWire(fresh, names) });
    })
  );

  // Turn a request down. The account is removed, so they can sign up again with a valid code.
  r.post(
    '/pending/:id/reject',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const result = await User.deleteOne({ _id: id, status: 'pending' });
      if (!result.deletedCount) return res.status(404).json({ error: 'That request no longer exists' });
      adminsChanged();
      res.json({ ok: true });
    })
  );

  // ---------- people who are already in ----------

  // Move a member to another group, or to "only me" ({group: null}). They keep their chats and history.
  r.patch(
    '/members/:id',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });
      if (!req.body || !('group' in req.body)) return res.status(400).json({ error: 'Say which group to move them to' });

      const user = await User.findOne({ _id: id, role: { $ne: 'admin' }, status: { $ne: 'pending' } }, 'group').lean();
      if (!user) return res.status(404).json({ error: 'Member not found' });

      const parsed = await parseChoice(req.body);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });

      const dest = decideDestination(null, parsed.choice);
      const oldGroup = user.group ? String(user.group) : null;

      // `status` is written explicitly so this person can never be mistaken for an old, pre-groups account.
      await User.updateOne({ _id: id }, { $set: { group: dest.group, via: dest.via, status: 'active' } });

      // Everyone who could see them before or now reloads their list, and the moved person reconnects so their
      // live updates match their new group.
      for (const gid of new Set([oldGroup, dest.group].filter(Boolean))) io.to(`group:${gid}`).emit('users:changed');
      io.to(`user:${id}`).emit('session:refresh');
      adminsChanged();

      const fresh = await User.findById(id, 'name publicKey role group via').lean();
      res.json({ user: adminWire(fresh, await groupNames([fresh.group, fresh.via])) });
    })
  );

  return r;
}
