import crypto from 'node:crypto';

// No 0/O or 1/I, so a code read aloud or typed from a screenshot is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random group code, e.g. "K7QMX2PD4N". 32^10 possibilities, and sign-up attempts are rate-limited. */
export function makeCode(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** Codes are compared without case, spaces or dashes: "k7qmx-2pd4n" and "K7QMX2PD4N" are the same code. */
export const normalizeCode = (s) => (typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

/** Friendly display form: "K7QMX-2PD4N". */
export const formatCode = (code) => (String(code).match(/.{1,5}/g) || []).join('-');
