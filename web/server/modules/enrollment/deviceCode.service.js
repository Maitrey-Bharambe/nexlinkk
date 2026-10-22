'use strict';

const crypto = require('node:crypto');
const { Device } = require('../../database/models/device');
const { DeviceCode } = require('../../database/models/deviceCode');
const { decodeKey32, keyFingerprint, sha256Hex, randomToken, verifyEd25519 } = require('../../utils/crypto');
const { badRequest, unauthorized, notFound, conflict } = require('../../utils/errors');
const { assertKeysUnused, bindIdentity } = require('./enrollment.service');

// No 0/O, 1/I/L, U/V lookalikes: easy to read aloud and type.
const ALPHABET = 'BCDFGHJKMNPQRSTWXYZ23456789';
const CODE_LEN = 8;

const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
/** Accepts "kxrt-4p2m", "KXRT4P2M", " kxrt 4p2m " … */
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newUserCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Proof-of-possession string; must match networking-agent/internal/enrollment/devicecode.go. */
function deviceCodeMessage({ identityPublicKey, wireguardPublicKey, hostname, timestamp }) {
  return ['NEXLINK-DEVICECODE-V1', identityPublicKey, wireguardPublicKey, hostname, String(timestamp)].join('\n');
}

/** A device name that passes the same rules as a typed one. */
function nameFromHostname(h) {
  const n = String(h || '').replace(/[^\w .-]/g, '-').replace(/-+/g, '-').trim().slice(0, 64);
  return n.length >= 2 ? n : 'new-device';
}

/**
 * Step 1 (agent, unauthenticated): the agent proves it holds the keys it
 * will enroll with and receives a code to show plus a secret to poll with.
 */
async function startDeviceCode(input, { config, ip }) {
  const identityRaw = decodeKey32(input.identityPublicKey);
  const wgRaw = decodeKey32(input.wireguardPublicKey);
  if (!identityRaw) throw badRequest('INVALID_IDENTITY_KEY', 'identityPublicKey must be a base64 Ed25519 public key');
  if (!wgRaw) throw badRequest('INVALID_WIREGUARD_KEY', 'wireguardPublicKey must be a base64 Curve25519 public key');
  if (Math.abs(Date.now() - input.timestamp) > config.AGENT_CLOCK_SKEW_SECONDS * 1000) {
    throw unauthorized('ENROLLMENT_TIMESTAMP_SKEW', 'Timestamp outside allowed window — check this computer’s clock');
  }
  if (!verifyEd25519(identityRaw, deviceCodeMessage(input), input.signature)) {
    throw unauthorized('ENROLLMENT_PROOF_INVALID', 'Proof-of-possession signature invalid');
  }
  await assertKeysUnused(identityRaw, wgRaw);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.DEVICE_CODE_TTL_MINUTES * 60_000);
  const deviceCode = `nxd_${randomToken(32)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    try {
      await DeviceCode.create({
        userCode,
        deviceCodeHash: sha256Hex(deviceCode),
        identityPublicKey: identityRaw.toString('base64'),
        identityFingerprint: keyFingerprint(identityRaw),
        wireguardPublicKey: wgRaw.toString('base64'),
        hostname: input.hostname,
        platform: input.platform,
        agentVersion: input.agentVersion,
        requestedFrom: ip || null,
        createdAt: now,
        expiresAt,
        purgeAt: new Date(expiresAt.getTime() + 86400_000),
      });
      return { userCode: formatCode(userCode), deviceCode, expiresAt, intervalSeconds: 3 };
    } catch (err) {
      if (err?.code !== 11000) throw err; // a live code collided: draw again
    }
  }
  throw conflict('DEVICE_CODE_UNAVAILABLE', 'Could not allocate a code, try again');
}

/** Step 2 (operator): what the console shows before anyone approves. */
async function lookupDeviceCode(rawCode) {
  const userCode = normalizeCode(rawCode);
  if (userCode.length !== CODE_LEN) throw badRequest('INVALID_CODE', 'Codes have 8 letters and digits, like KXRT-4P2M');
  const dc = await DeviceCode.findOne({ userCode, status: 'pending' });
  if (!dc || dc.expiresAt < new Date()) throw notFound('Code');
  return dc;
}

function serializeDeviceCode(dc) {
  return {
    userCode: formatCode(dc.userCode),
    hostname: dc.hostname,
    suggestedName: nameFromHostname(dc.hostname),
    platform: dc.platform,
    agentVersion: dc.agentVersion,
    identityFingerprint: dc.identityFingerprint,
    requestedFrom: dc.requestedFrom,
    createdAt: dc.createdAt,
    expiresAt: dc.expiresAt,
    status: dc.status,
  };
}

/** Step 3 (operator): approve — creates the enrolled device in one step. */
async function approveDeviceCode({ dc, network, name, user }) {
  // Claim the code atomically so two approvals cannot both create a device.
  const claimed = await DeviceCode.findOneAndUpdate(
    { _id: dc._id, status: 'pending', expiresAt: { $gt: new Date() } },
    { status: 'approved', decidedAt: new Date(), decidedBy: user._id },
    { new: true },
  );
  if (!claimed) throw conflict('CODE_NOT_PENDING', 'This code was already used or has expired');
  const device = await Device.create({ name, networkId: network._id, createdBy: user._id });
  try {
    const out = await bindIdentity({
      device,
      network,
      identityRaw: Buffer.from(claimed.identityPublicKey, 'base64'),
      wgRaw: Buffer.from(claimed.wireguardPublicKey, 'base64'),
      agentVersion: claimed.agentVersion,
      platform: claimed.platform,
    });
    await DeviceCode.updateOne({ _id: claimed._id }, { deviceId: device._id });
    return out;
  } catch (err) {
    await Device.deleteOne({ _id: device._id });
    await DeviceCode.updateOne({ _id: claimed._id }, { status: 'denied', deviceId: null });
    throw err;
  }
}

async function denyDeviceCode({ dc, user }) {
  await DeviceCode.updateOne({ _id: dc._id, status: 'pending' }, { status: 'denied', decidedAt: new Date(), decidedBy: user._id });
}

/** Step 4 (agent): poll with the secret until approved, denied or expired. */
async function pollDeviceCode(deviceCode) {
  const dc = await DeviceCode.findOne({ deviceCodeHash: sha256Hex(String(deviceCode || '')) });
  if (!dc) throw unauthorized('DEVICE_CODE_INVALID', 'Unknown device code');
  if (dc.status === 'denied') return { status: 'denied' };
  if (dc.status === 'pending') return { status: dc.expiresAt < new Date() ? 'expired' : 'pending', expiresAt: dc.expiresAt };
  if (!dc.deviceId) return { status: 'pending', expiresAt: dc.expiresAt }; // approval in progress
  return { status: 'approved', deviceId: dc.deviceId };
}

module.exports = {
  startDeviceCode,
  lookupDeviceCode,
  serializeDeviceCode,
  approveDeviceCode,
  denyDeviceCode,
  pollDeviceCode,
  deviceCodeMessage,
  normalizeCode,
  nameFromHostname,
};
