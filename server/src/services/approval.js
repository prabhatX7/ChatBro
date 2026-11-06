/**
 * Where does a person end up when the admin approves them (or moves them)?
 *
 *   requested  the group whose code they signed up with: { id, private } or null
 *   choice     what the admin picked:
 *                undefined -> accept the request as it is (follow the code they used)
 *                null      -> "only me": no group, the person sees only the admin
 *                { id, private } -> a specific group
 *
 * Returns { group, via }.
 *   group  the group they belong to, or null (null = they only see the admin)
 *   via    for a person who joined with a PRIVATE code: that code's group. Shown in the admin's folders only,
 *          it gives them no visibility of anyone else.
 */
export function decideDestination(requested, choice) {
  const requestedId = requested ? String(requested.id) : null;

  if (choice && typeof choice === 'object') {
    return choice.private ? { group: null, via: String(choice.id) } : { group: String(choice.id), via: null };
  }
  if (choice === null) {
    return { group: null, via: requested?.private ? requestedId : null };
  }
  if (!requested) return { group: null, via: null };
  return requested.private ? { group: null, via: requestedId } : { group: requestedId, via: null };
}
