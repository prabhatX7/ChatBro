import test from 'node:test';
import assert from 'node:assert/strict';
import { canChat, isAdmin } from '../src/services/access.js';

const admin = { role: 'admin', group: null };
const a1 = { role: 'member', group: 'g1' };
const a2 = { role: 'member', group: 'g1' };
const b1 = { role: 'member', group: 'g2' };
const lost = { role: 'member', group: null }; // e.g. an account with no group

test('members of the same group can chat', () => {
  assert.equal(canChat(a1, a2), true);
  assert.equal(canChat(a2, a1), true);
});

test('members of different groups cannot see or message each other', () => {
  assert.equal(canChat(a1, b1), false);
  assert.equal(canChat(b1, a1), false);
});

test('everyone can chat with the admin, and the admin with everyone', () => {
  for (const m of [a1, b1, lost]) {
    assert.equal(canChat(admin, m), true);
    assert.equal(canChat(m, admin), true);
  }
});

test('two members with no group are NOT treated as the same group', () => {
  assert.equal(canChat(lost, { role: 'member', group: null }), false);
  assert.equal(canChat(lost, a1), false);
});

test('group ids compare by value, so ObjectId-like objects work', () => {
  const id = { toString: () => 'abc123' };
  assert.equal(canChat({ role: 'member', group: id }, { role: 'member', group: 'abc123' }), true);
});

test('missing users never match', () => {
  assert.equal(canChat(null, a1), false);
  assert.equal(canChat(a1, undefined), false);
  assert.equal(isAdmin(undefined), false);
});

test('a missing role means an ordinary member (accounts made before groups existed)', () => {
  assert.equal(isAdmin({ group: 'g1' }), false);
  assert.equal(canChat({ group: 'g1' }, { group: 'g1' }), true); // same group, so they can chat
  assert.equal(canChat({ group: 'g1' }, { group: 'g2' }), false);
  assert.equal(canChat({}, {}), false); // no group at all, never matched
});
