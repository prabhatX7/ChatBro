import Group from '../models/Group.js';

/** What every signed-in person may know about another person. */
export const baseWire = (u) => ({
  id: String(u._id),
  name: u.name,
  publicKey: u.publicKey,
  role: u.role || 'member',
});

/** id -> group name, for the ids given (ignores empty ones). */
export async function groupNames(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const groups = await Group.find({ _id: { $in: unique } }, 'name').lean();
  return new Map(groups.map((g) => [String(g._id), g.name]));
}

/** The admin also learns which group (folder) someone is in, and which private code they joined with. */
export function adminWire(u, names) {
  const ref = (id) => (id ? { id: String(id), name: names.get(String(id)) || 'Group' } : null);
  return { ...baseWire(u), group: ref(u.group), via: ref(u.via) };
}
