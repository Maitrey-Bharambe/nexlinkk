'use strict';

const mongoose = require('mongoose');
const { Device, AgentNonce } = require('../database/models/device');
const { sha256Hex, verifyEd25519 } = require('../utils/crypto');
const { unauthorized, forbidden } = require('../utils/errors');
const audit = require('../modules/audit/audit.service');

/**
 * Canonical string an agent signs for every authenticated request.
 * Covers method, path+query, timestamp, nonce, device id and a body digest,
 * so no part of the request can be altered or replayed.
 */
function canonicalRequest({ method, path, timestamp, nonce, deviceId, body }) {
  return [
    'NEXLINK-AGENT-SIG-V1',
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    deviceId,
    sha256Hex(body || Buffer.alloc(0)),
  ].join('\n');
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Agent authentication path — fully separate from user sessions. The device
 * is identified by the key that signed the request, not by any id in the body.
 */
function agentAuth(config) {
  const skewMs = config.AGENT_CLOCK_SKEW_SECONDS * 1000;
  return async (req, _res, next) => {
    try {
      const deviceId = req.get('x-nexlink-device');
      const tsRaw = req.get('x-nexlink-timestamp');
      const nonce = req.get('x-nexlink-nonce');
      const signature = req.get('x-nexlink-signature');
      if (!deviceId || !tsRaw || !nonce || !signature) throw unauthorized('AGENT_AUTH_MISSING', 'Missing agent signature headers');
      if (!/^[a-f0-9]{24}$/i.test(deviceId) || !mongoose.isValidObjectId(deviceId)) throw unauthorized('AGENT_AUTH_INVALID', 'Malformed device id');
      if (!/^\d{10,16}$/.test(tsRaw) || !NONCE_RE.test(nonce)) throw unauthorized('AGENT_AUTH_INVALID', 'Malformed timestamp or nonce');

      const timestamp = Number(tsRaw);
      if (Math.abs(Date.now() - timestamp) > skewMs) {
        throw unauthorized('AGENT_TIMESTAMP_SKEW', 'Request timestamp outside allowed window');
      }

      const device = await Device.findById(deviceId);
      if (!device || !device.identityPublicKey) throw unauthorized('AGENT_UNKNOWN', 'Unknown or unenrolled device');

      const message = canonicalRequest({
        method: req.method,
        path: req.originalUrl,
        timestamp,
        nonce,
        deviceId,
        body: req.rawBody,
      });
      if (!verifyEd25519(Buffer.from(device.identityPublicKey, 'base64'), message, signature)) {
        await audit.record(
          {
            actor: { type: 'anonymous', id: null, label: `claims device ${deviceId}` },
            operation: 'agent.auth',
            target: { type: 'device', id: deviceId, label: device.name },
            decision: 'deny',
            outcome: 'failure',
            reason: 'signature invalid',
          },
          req,
        );
        throw unauthorized('AGENT_SIGNATURE_INVALID', 'Request signature invalid');
      }

      // Revocation is checked after the signature so only the genuine device
      // learns that it was revoked.
      if (device.enrollmentState === 'revoked') {
        await audit.record(
          {
            actor: { type: 'device', id: deviceId, label: device.name },
            operation: 'agent.auth',
            target: { type: 'device', id: deviceId, label: device.name },
            decision: 'deny',
            outcome: 'failure',
            reason: 'device revoked',
          },
          req,
        );
        throw forbidden('DEVICE_REVOKED', 'This device has been revoked');
      }
      if (device.enrollmentState !== 'enrolled') throw forbidden('DEVICE_NOT_ENROLLED', 'Device not enrolled');

      try {
        await AgentNonce.create({ deviceId: device._id, nonce, expiresAt: new Date(Date.now() + 2 * skewMs) });
      } catch (err) {
        if (err?.code === 11000) throw unauthorized('REPLAY_DETECTED', 'Nonce already used');
        throw err;
      }

      req.device = device;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { agentAuth, canonicalRequest };
