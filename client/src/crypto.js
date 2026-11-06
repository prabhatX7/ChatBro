// All encryption happens here, in the browser, using the built-in WebCrypto API.
// The server never receives a password, a private key, or any plaintext.

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// NOTE: the "veil-chat" strings below are internal key-derivation labels from before the ChatBro rename.
// They are NOT shown to anyone, and changing them would make every existing account's keys and messages
// undecryptable, so they intentionally stay as they are.
const PBKDF2_ITERATIONS = 310000;
const ZERO32 = new Uint8Array(32);
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export const b64 = {
  enc(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function cryptoAvailable() {
  return Boolean(subtle);
}

/**
 * password + email  ->  { authSecret, wrapKey }
 * authSecret is sent to the server (it only stores a bcrypt hash of it).
 * wrapKey never leaves this device; it protects your private key.
 */
export async function deriveCredentials(email, password) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(`veil-chat:v1:${email.trim().toLowerCase()}`),
      iterations: PBKDF2_ITERATIONS,
    },
    base,
    256
  );
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const authBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ZERO32, info: enc.encode('veil-chat:auth') },
    hk,
    256
  );
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ZERO32, info: enc.encode('veil-chat:wrap') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { authSecret: hex(authBits), wrapKey };
}

const KEY_AAD = enc.encode('veil-chat:private-key');

/** New identity key pair. The private key is returned wrapped (for the server) and as a non-extractable key (for this device). */
export async function createIdentity(wrapKey) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const publicKey = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: KEY_AAD }, wrapKey, pkcs8);

  const privateKey = await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey', 'deriveBits']);
  return { publicKey, encPrivateKey: { iv: b64.enc(iv), data: b64.enc(data) }, privateKey };
}

/** Unlock the private key returned by the server at login. Throws if the password was wrong. */
export async function unwrapIdentity(wrapKey, { iv, data }) {
  const pkcs8 = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64.dec(iv), additionalData: KEY_AAD },
    wrapKey,
    b64.dec(data)
  );
  return subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey', 'deriveBits']);
}

const sharedCache = new Map();
export function clearSharedCache() {
  sharedCache.clear();
}

/** AES key shared by exactly you and one friend: ECDH(myPrivate, theirPublic) -> HKDF. */
export async function sharedKeyFor(privateKey, peerId, peerPublicKey) {
  const cacheKey = `${peerId}:${peerPublicKey}`;
  if (sharedCache.has(cacheKey)) return sharedCache.get(cacheKey);

  const peerPub = await subtle.importKey('jwk', JSON.parse(peerPublicKey), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peerPub }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ZERO32, info: enc.encode('veil-chat:v1:message') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  sharedCache.set(cacheKey, key);
  return key;
}

const newIv = () => crypto.getRandomValues(new Uint8Array(12));

/** Encrypt a JSON-able object. `aad` binds the ciphertext to its sender>recipient direction. */
export async function encryptJson(key, obj, aad) {
  const iv = newIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}

export async function decryptJson(key, iv, ct, aad) {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64.dec(iv), additionalData: enc.encode(aad) },
    key,
    b64.dec(ct)
  );
  return JSON.parse(dec.decode(plain));
}

/** Encrypt raw file bytes. Returns the ciphertext bytes and the IV (the IV goes inside the encrypted message). */
export async function encryptBytes(key, buffer, aad) {
  const iv = newIv();
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, buffer);
  return { iv: b64.enc(iv), data };
}

export function decryptBytes(key, iv, buffer, aad) {
  return subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv), additionalData: enc.encode(aad) }, key, buffer);
}

/** Short code both friends can compare out-of-band to be sure nobody swapped the keys. */
export async function fingerprint(publicKeyA, publicKeyB) {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = await subtle.digest('SHA-256', enc.encode(`${first}|${second}`));
  return hex(digest)
    .slice(0, 32)
    .toUpperCase()
    .match(/.{4}/g)
    .join(' ');
}
