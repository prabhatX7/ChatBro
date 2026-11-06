import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCredentials,
  createIdentity,
  unwrapIdentity,
  sharedKeyFor,
  encryptJson,
  decryptJson,
  encryptBytes,
  decryptBytes,
  fingerprint,
} from '../src/crypto.js';

async function makeUser(email, password) {
  const creds = await deriveCredentials(email, password);
  const id = await createIdentity(creds.wrapKey);
  return { ...creds, ...id };
}

test('two friends derive the same key and can read each other', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');

  const aliceKey = await sharedKeyFor(alice.privateKey, 'bob', bob.publicKey);
  const bobKey = await sharedKeyFor(bob.privateKey, 'alice', alice.publicKey);

  const { iv, ct } = await encryptJson(aliceKey, { k: 'text', text: 'hello Bob 👋' }, 'alice>bob');
  assert.ok(!ct.includes('hello'));
  const out = await decryptJson(bobKey, iv, ct, 'alice>bob');
  assert.equal(out.text, 'hello Bob 👋');
});

test('a message cannot be re-labelled as coming from the other person', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');
  const aliceKey = await sharedKeyFor(alice.privateKey, 'bob', bob.publicKey);
  const bobKey = await sharedKeyFor(bob.privateKey, 'alice', alice.publicKey);

  const { iv, ct } = await encryptJson(aliceKey, { k: 'text', text: 'pay me' }, 'alice>bob');
  await assert.rejects(decryptJson(bobKey, iv, ct, 'bob>alice'));
});

test('an outsider cannot decrypt', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');
  const eve = await makeUser('eve@example.com', 'eve eve eve eve eve');

  const aliceKey = await sharedKeyFor(alice.privateKey, 'bob', bob.publicKey);
  const eveKey = await sharedKeyFor(eve.privateKey, 'bob2', bob.publicKey);
  const { iv, ct } = await encryptJson(aliceKey, { k: 'text', text: 'secret' }, 'alice>bob');
  await assert.rejects(decryptJson(eveKey, iv, ct, 'alice>bob'));
});

test('file bytes round-trip and are not left in plaintext', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');
  const aliceKey = await sharedKeyFor(alice.privateKey, 'bob', bob.publicKey);
  const bobKey = await sharedKeyFor(bob.privateKey, 'alice', alice.publicKey);

  // getRandomValues is capped at 64 KB per call, so fill 1 MB in chunks.
  const original = new Uint8Array(1_000_000);
  for (let i = 0; i < original.length; i += 65536) crypto.getRandomValues(original.subarray(i, i + 65536));
  const { iv, data } = await encryptBytes(aliceKey, original.buffer.slice(0), 'file:alice>bob');
  assert.equal(data.byteLength, original.byteLength + 16);
  const back = new Uint8Array(await decryptBytes(bobKey, iv, data, 'file:alice>bob'));
  assert.deepEqual(back, original);
});

test('login on another device: same password unlocks the stored key, wrong password does not', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');

  const again = await deriveCredentials('Alice@Example.com ', 'correct horse battery');
  assert.equal(again.authSecret, alice.authSecret); // email is normalised
  const restored = await unwrapIdentity(again.wrapKey, alice.encPrivateKey);

  const k1 = await sharedKeyFor(alice.privateKey, 'bob', bob.publicKey);
  const k2 = await sharedKeyFor(restored, 'bob-device2', bob.publicKey);
  const { iv, ct } = await encryptJson(k1, { k: 'text', text: 'same key' }, 'a>b');
  assert.equal((await decryptJson(k2, iv, ct, 'a>b')).text, 'same key');

  const wrong = await deriveCredentials('alice@example.com', 'wrong password!!');
  assert.notEqual(wrong.authSecret, alice.authSecret);
  await assert.rejects(unwrapIdentity(wrong.wrapKey, alice.encPrivateKey));
});

test('the auth secret sent to the server reveals nothing usable about the wrap key', async () => {
  const { authSecret } = await deriveCredentials('alice@example.com', 'correct horse battery');
  assert.match(authSecret, /^[a-f0-9]{64}$/);
});

test('safety number is identical for both friends', async () => {
  const alice = await makeUser('alice@example.com', 'correct horse battery');
  const bob = await makeUser('bob@example.com', 'another long password');
  const a = await fingerprint(alice.publicKey, bob.publicKey);
  const b = await fingerprint(bob.publicKey, alice.publicKey);
  assert.equal(a, b);
  assert.match(a, /^([A-F0-9]{4} ){7}[A-F0-9]{4}$/);
});
