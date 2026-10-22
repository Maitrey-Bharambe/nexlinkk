'use strict';

const { Device, EnrollmentToken } = require('../../database/models/device');
const { Network } = require('../../database/models/network');
const { randomToken, sha256Hex, decodeKey32, keyFingerprint, verifyEd25519 } = require('../../utils/crypto');
const { unauthorized, conflict, badRequest } = require('../../utils/errors');
const { allocateMembership } = require('../networks/networks.service');

/**
 * Message an agent signs with its new identity key to prove possession of the
 * private key during enrollment. Binding the token hash and both public keys
 * means a captured enrollment request cannot be re-pointed at other keys.
 */
function enrollmentMessage({ tokenHash, identityPublicKey, wireguardPublicKey, timestamp }) {
  return ['NEXLINK-ENROLL-V1', tokenHash, identityPublicKey, wireguardPublicKey, String(timestamp)].join('\n');
}

async function createEnrollmentRequest({ network, name, user, ttlMinutes }) {
  const device = await Device.create({ name, networkId: network._id, createdBy: user._id });
  const token = `nxe_${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await EnrollmentToken.create({
    tokenHash: sha256Hex(token),
    deviceId: device._id,
    networkId: network._id,
    createdBy: user._id,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 7 * 86400_000),
  });
  // The plaintext token is returned exactly once and never stored.
  return { device, token, expiresAt };
}

async function enrollmentStatus(deviceId) {
  const t = await EnrollmentToken.findOne({ deviceId }).sort({ createdAt: -1 }).lean();
  if (!t) return { state: 'none' };
  if (t.usedAt) return { state: 'used', usedAt: t.usedAt, expiresAt: t.expiresAt };
  if (t.expiresAt < new Date()) return { state: 'expired', expiresAt: t.expiresAt };
  return { state: 'waiting', expiresAt: t.expiresAt };
}

async function completeEnrollment(input, { clockSkewSec }) {
  const identityRaw = decodeKey32(input.identityPublicKey);
  const wgRaw = decodeKey32(input.wireguardPublicKey);
  if (!identityRaw) throw badRequest('INVALID_IDENTITY_KEY', 'identityPublicKey must be a base64 Ed25519 public key');
  if (!wgRaw) throw badRequest('INVALID_WIREGUARD_KEY', 'wireguardPublicKey must be a base64 Curve25519 public key');

  const skewMs = Math.abs(Date.now() - input.timestamp);
  if (skewMs > clockSkewSec * 1000) throw unauthorized('ENROLLMENT_TIMESTAMP_SKEW', 'Enrollment timestamp outside allowed window');

  const tokenHash = sha256Hex(input.enrollmentToken);
  const msg = enrollmentMessage({
    tokenHash,
    identityPublicKey: input.identityPublicKey,
    wireguardPublicKey: input.wireguardPublicKey,
    timestamp: input.timestamp,
  });
  if (!verifyEd25519(identityRaw, msg, input.signature)) {
    await EnrollmentToken.updateOne({ tokenHash }, { $inc: { failedAttempts: 1 } });
    throw unauthorized('ENROLLMENT_PROOF_INVALID', 'Proof-of-possession signature invalid');
  }

  const identityFingerprint = keyFingerprint(identityRaw);

  // Atomic single-use consumption: replaying the same token fails here.
  const now = new Date();
  const tokenDoc = await EnrollmentToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { usedAt: now, usedByFingerprint: identityFingerprint },
    { new: true },
  );
  if (!tokenDoc) {
    const existing = await EnrollmentToken.findOne({ tokenHash }).lean();
    if (!existing) throw unauthorized('ENROLLMENT_TOKEN_INVALID', 'Enrollment token not recognised');
    if (existing.usedAt) throw unauthorized('ENROLLMENT_TOKEN_USED', 'Enrollment token already used');
    throw unauthorized('ENROLLMENT_TOKEN_EXPIRED', 'Enrollment token expired');
  }

  const device = await Device.findById(tokenDoc.deviceId);
  if (!device || device.enrollmentState !== 'pending') {
    throw conflict('DEVICE_NOT_PENDING', `Device is ${device?.enrollmentState || 'missing'}; create a new enrollment request`);
  }
  const network = await Network.findOne({ _id: tokenDoc.networkId, status: 'active' });
  if (!network) throw conflict('NETWORK_UNAVAILABLE', 'Target network no longer active');

  return bindIdentity({ device, network, identityRaw, wgRaw, agentVersion: input.agentVersion, platform: input.platform, now });
}

/** Fails if either public key already belongs to an enrolled device. */
async function assertKeysUnused(identityRaw, wgRaw) {
  if (await Device.exists({ identityFingerprint: keyFingerprint(identityRaw) })) {
    throw conflict('DUPLICATE_IDENTITY', 'This agent identity is already enrolled as another device');
  }
  if (await Device.exists({ wireguardPublicKey: wgRaw.toString('base64') })) {
    throw conflict('DUPLICATE_WIREGUARD_KEY', 'This WireGuard public key is already registered');
  }
}

/**
 * Binds proven public keys to a pending device and gives it an address. Shared
 * by token enrollment and device-code approval: same checks, same result.
 */
async function bindIdentity({ device, network, identityRaw, wgRaw, agentVersion, platform, now = new Date() }) {
  await assertKeysUnused(identityRaw, wgRaw);
  device.identityPublicKey = identityRaw.toString('base64');
  device.identityFingerprint = keyFingerprint(identityRaw);
  device.wireguardPublicKey = wgRaw.toString('base64');
  device.wireguardFingerprint = keyFingerprint(wgRaw);
  device.agentVersion = agentVersion;
  device.platform = platform;
  device.enrollmentState = 'enrolled';
  device.enrolledAt = now;
  await device.save();

  const membership = await allocateMembership({ network, deviceId: device._id });
  return { device, network, membership };
}

module.exports = { createEnrollmentRequest, completeEnrollment, enrollmentStatus, enrollmentMessage, bindIdentity, assertKeysUnused };
