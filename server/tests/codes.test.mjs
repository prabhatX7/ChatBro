import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, normalizeCode, formatCode } from '../src/services/codes.js';

test('generated codes are 10 characters without confusing letters', () => {
  for (let i = 0; i < 500; i++) {
    const c = makeCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/); // no 0, O, 1 or I
  }
});

test('generated codes are not repeated', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(makeCode());
  assert.equal(seen.size, 2000);
});

test('typing a code with dashes, spaces or lower case still matches', () => {
  const code = 'K7QMX2PD4N';
  assert.equal(normalizeCode('k7qmx-2pd4n'), code);
  assert.equal(normalizeCode('  K7QMX 2PD4N '), code);
  assert.equal(normalizeCode(code), code);
});

test('empty or odd input normalises to an empty code (which never matches a group)', () => {
  assert.equal(normalizeCode(undefined), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode('---'), '');
  assert.equal(normalizeCode({}), '');
  assert.equal(normalizeCode(['K7QMX2PD4N']), ''); // only plain strings are accepted
  assert.equal(normalizeCode(12345), '');
});

test('display form groups the code in fives', () => {
  assert.equal(formatCode('K7QMX2PD4N'), 'K7QMX-2PD4N');
  assert.equal(formatCode('DDC8FB150AA9'), 'DDC8F-B150A-A9');
  assert.equal(normalizeCode(formatCode('K7QMX2PD4N')), 'K7QMX2PD4N');
});

test('an old hex invite code keeps working as a group code', () => {
  assert.equal(normalizeCode('ddc8fb150aa9'), 'DDC8FB150AA9');
});
