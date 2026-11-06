import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDestination } from '../src/services/approval.js';
import { canChat } from '../src/services/access.js';

const family = { id: 'g-family', private: false };
const solo = { id: 'g-solo', private: true }; // a private (one-to-one) code

test('accepting a normal request puts the person in the group whose code they used', () => {
  assert.deepEqual(decideDestination(family, undefined), { group: 'g-family', via: null });
});

test('accepting a request made with a PRIVATE code leaves the person with no group (they see only the admin)', () => {
  assert.deepEqual(decideDestination(solo, undefined), { group: null, via: 'g-solo' });
});

test('"only me" means no group, and remembers the private code for the admin\'s folders', () => {
  assert.deepEqual(decideDestination(family, null), { group: null, via: null });
  assert.deepEqual(decideDestination(solo, null), { group: null, via: 'g-solo' });
});

test('the admin can override the requested group', () => {
  assert.deepEqual(decideDestination(family, { id: 'g-friends', private: false }), { group: 'g-friends', via: null });
  assert.deepEqual(decideDestination(solo, { id: 'g-friends', private: false }), { group: 'g-friends', via: null });
});

test('choosing a private group as the destination never gives anyone a shared group', () => {
  assert.deepEqual(decideDestination(family, { id: 'g-solo', private: true }), { group: null, via: 'g-solo' });
});

test('no requested group and no choice: no group', () => {
  assert.deepEqual(decideDestination(null, undefined), { group: null, via: null });
});

test('moving a member (no request involved) works the same way', () => {
  assert.deepEqual(decideDestination(null, null), { group: null, via: null });
  assert.deepEqual(decideDestination(null, family), { group: 'g-family', via: null });
  assert.deepEqual(decideDestination(null, solo), { group: null, via: 'g-solo' });
});

// ---- what that means for who can see whom ----

const admin = { role: 'admin', group: null, status: 'active' };
const inFamily1 = { role: 'member', group: 'g-family', status: 'active' };
const inFamily2 = { role: 'member', group: 'g-family', status: 'active' };
const onlyMe1 = { role: 'member', group: null, status: 'active' };
const onlyMe2 = { role: 'member', group: null, status: 'active' };
const waiting = { role: 'member', group: null, status: 'pending' };

test('people set to "only me" see the admin, and never each other or any group', () => {
  assert.equal(canChat(onlyMe1, admin), true);
  assert.equal(canChat(admin, onlyMe1), true);
  assert.equal(canChat(onlyMe1, onlyMe2), false);
  assert.equal(canChat(onlyMe1, inFamily1), false);
  assert.equal(canChat(inFamily1, onlyMe1), false);
});

test('a group still sees itself, and nothing changed for the admin', () => {
  assert.equal(canChat(inFamily1, inFamily2), true);
  assert.equal(canChat(inFamily1, admin), true);
});

test('someone waiting for approval can be seen by nobody, not even the admin, and cannot message anyone', () => {
  for (const other of [admin, inFamily1, onlyMe1, waiting]) {
    assert.equal(canChat(waiting, other), false);
    assert.equal(canChat(other, waiting), false);
  }
});

test('old accounts with no status field are treated as approved', () => {
  assert.equal(canChat({ role: 'member', group: 'g1' }, { role: 'member', group: 'g1' }), true);
  assert.equal(canChat({ role: 'member', group: null }, admin), true);
});
