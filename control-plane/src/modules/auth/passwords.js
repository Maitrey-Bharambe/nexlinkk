'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

/** scrypt$N$r$p$salt$hash — parameters are stored so cost can be raised later. */
async function hashPassword(password, N = 131072) {
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * Number(N) * Number(r),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the email is unknown, so response timing does not reveal which accounts exist.
let dummyHash = null;
async function burnTime(password, N) {
  dummyHash = dummyHash || (await hashPassword('nexlink-dummy-password', N));
  await verifyPassword(password, dummyHash);
}

module.exports = { hashPassword, verifyPassword, burnTime };
