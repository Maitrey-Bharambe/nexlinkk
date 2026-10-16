'use strict';

const crypto = require('node:crypto');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Decodes a base64 (std or url) 32-byte key; returns Buffer or null. */
function decodeKey32(b64) {
  if (typeof b64 !== 'string' || b64.length > 64) return null;
  try {
    const buf = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/** Short, human-comparable fingerprint for a public key. */
function keyFingerprint(rawKey) {
  return `SHA256:${crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
}

function ed25519PublicKey(raw32) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw32.toString('base64url') },
    format: 'jwk',
  });
}

/** Verifies an Ed25519 signature. Never throws on malformed input. */
function verifyEd25519(raw32PublicKey, message, signatureB64) {
  try {
    const sig = Buffer.from(String(signatureB64), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message), ed25519PublicKey(raw32PublicKey), sig);
  } catch {
    return false;
  }
}

module.exports = { randomToken, sha256Hex, safeEqual, decodeKey32, keyFingerprint, verifyEd25519 };
