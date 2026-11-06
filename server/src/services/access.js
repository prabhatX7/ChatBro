// Who may see and message whom. Pure functions with no database, so they are easy to test.
//
//  - The admin can see and message everyone who has been approved.
//  - Everyone can see and message the admin.
//  - Members can only see and message members of their own group (the group the admin approved them into).
//  - A member with no group (a "private" one-to-one person) sees only the admin.
//  - Someone who is still waiting for approval is invisible to everyone and cannot message anyone.

export const isAdmin = (u) => Boolean(u) && u.role === 'admin';
export const isPending = (u) => Boolean(u) && u.status === 'pending';

/** `a` and `b` look like { role, group, status }. `group` may be an id string, an ObjectId or null. */
export function canChat(a, b) {
  if (!a || !b) return false;
  if (isPending(a) || isPending(b)) return false;
  if (isAdmin(a) || isAdmin(b)) return true;
  return Boolean(a.group) && Boolean(b.group) && String(a.group) === String(b.group);
}
