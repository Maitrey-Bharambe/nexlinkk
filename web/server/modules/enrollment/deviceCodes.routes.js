'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { loadNetworkInScope } = require('../networks/scope');
const { ensureUserNetwork } = require('../onboarding/onboarding.routes');
const { serializeDevice } = require('../telemetry/state.service');
const { lookupDeviceCode, serializeDeviceCode, approveDeviceCode, denyDeviceCode } = require('./deviceCode.service');
const audit = require('../audit/audit.service');

const codeParams = z.object({ code: z.string().min(8).max(16) }).strict();
const approveBody = z
  .object({
    networkId: objectId.optional(),
    deviceName: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[\w .-]+$/, 'Letters, digits, space, dot, dash and underscore only'),
  })
  .strict();

/**
 * Operator side of "join with a code". Approving creates the enrolled device
 * from the keys the agent proved it holds when it asked for the code.
 */
function deviceCodesRouter({ limits }) {
  const r = express.Router();

  r.get(
    '/device-codes/:code',
    requirePermission('devices:enroll'),
    limits.sensitive,
    validate({ params: codeParams }),
    ah(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      send(res, serializeDeviceCode(await lookupDeviceCode(req.valid.params.code)));
    }),
  );

  r.post(
    '/device-codes/:code/approve',
    requirePermission('devices:enroll'),
    requireCsrf,
    limits.sensitive,
    validate({ params: codeParams, body: approveBody }),
    ah(async (req, res) => {
      const dc = await lookupDeviceCode(req.valid.params.code);
      const network = req.valid.body.networkId
        ? await loadNetworkInScope(req.user, req.valid.body.networkId, { write: true })
        : (await ensureUserNetwork(req)).network;
      const { device, membership } = await approveDeviceCode({ dc, network, name: req.valid.body.deviceName, user: req.user });
      await audit.record(
        {
          operation: 'device.enroll',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          metadata: {
            via: 'device_code',
            hostname: dc.hostname,
            identityFingerprint: device.identityFingerprint,
            address: membership.address,
            platform: device.platform,
            requestedFrom: dc.requestedFrom,
          },
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) }, req.user._id);
      send(res, { device: serializeDevice(device.toObject(), { membership }), network: { id: String(network._id), name: network.name, cidr: network.cidr } }, 201);
    }),
  );

  r.post(
    '/device-codes/:code/deny',
    requirePermission('devices:enroll'),
    requireCsrf,
    limits.sensitive,
    validate({ params: codeParams }),
    ah(async (req, res) => {
      const dc = await lookupDeviceCode(req.valid.params.code);
      await denyDeviceCode({ dc, user: req.user });
      await audit.record({ operation: 'device.enroll', decision: 'deny', outcome: 'failure', reason: 'device code denied by operator', metadata: { via: 'device_code', hostname: dc.hostname } }, req);
      send(res, { status: 'denied' });
    }),
  );

  return r;
}

module.exports = { deviceCodesRouter };
