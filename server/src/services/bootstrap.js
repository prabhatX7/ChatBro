import User from '../models/User.js';
import Group from '../models/Group.js';
import { config } from '../config.js';
import { makeCode, normalizeCode, formatCode } from './codes.js';

/**
 * Runs on every start, after the database connects. Safe to run repeatedly.
 *  1. The account whose email is ADMIN_EMAIL is the admin (and nobody else is).
 *  2. Accounts created before groups existed are moved into an "Original group", whose code is the old INVITE_CODE,
 *     so existing members keep working. Only OLD accounts are touched: they are the ones with no `status` field.
 *     (A person the admin deliberately set to "only me" has no group either, but always has a status, so they stay.)
 *  3. Every account gets an explicit status, so step 2 can never match it again.
 */
export async function bootstrap() {
  const promoted = await User.updateOne({ email: config.adminEmail }, { $set: { role: 'admin', group: null, status: 'active' } });
  if (promoted.matchedCount) {
    console.log(`Admin account: ${config.adminEmail}`);
  } else {
    console.log(
      `No account for ${config.adminEmail} yet. Sign up with that email and your ADMIN_SETUP_CODE to become the admin.`
    );
  }

  const demoted = await User.updateMany(
    { role: 'admin', email: { $ne: config.adminEmail } },
    { $set: { role: 'member' } }
  );
  if (demoted.modifiedCount) {
    console.log(`ADMIN_EMAIL changed: ${demoted.modifiedCount} earlier admin account(s) are now ordinary members.`);
  }

  // Old accounts with no group (a missing field counts as null) and no status.
  const legacyFilter = { role: { $ne: 'admin' }, group: null, status: { $exists: false } };
  const legacy = await User.countDocuments(legacyFilter);
  if (legacy > 0) {
    const code = normalizeCode(config.legacyInviteCode) || makeCode();
    const group = (await Group.findOne({ code })) || (await Group.create({ name: 'Original group', code }));
    await User.updateMany(legacyFilter, { $set: { group: group._id, status: 'active' } });
    console.log(`Moved ${legacy} existing member(s) into "${group.name}" (code ${formatCode(group.code)}).`);
  }

  // Everyone else from before approvals existed is already approved.
  const backfilled = await User.updateMany({ status: { $exists: false } }, { $set: { status: 'active' } });
  if (backfilled.modifiedCount) {
    console.log(`Marked ${backfilled.modifiedCount} existing account(s) as approved.`);
  }

  const waiting = await User.countDocuments({ status: 'pending' });
  if (waiting) console.log(`${waiting} sign-up request(s) are waiting for the admin's approval.`);
}
