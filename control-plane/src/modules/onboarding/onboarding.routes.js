'use strict';

const express = require('express');
const { z } = require('zod');
const { Network } = require('../../database/models/network');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah } = require('../../utils/http');
const { createNetwork, serializeNetwork, suggestFreeCidr } = require('../networks/networks.service');
const { createEnrollmentRequest } = require('../enrollment/enrollment.service');
const { serializeDevice } = require('../telemetry/state.service');
const audit = require('../audit/audit.service');

const registerBody = z
  .object({
    deviceName: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[\w .-]+$/, 'Letters, digits, space, dot, dash and underscore only'),
  })
  .strict();

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'my';

/**
 * "Register this PC" for new users. The browser cannot register a computer
 * on its own — the agent must run there and generate its keys. This issues
 * the one-time token (creating the user's first private network if needed);
 * the device only becomes "enrolled" when the agent completes enrollment.
 */
function onboardingRouter({ config, limits }) {
  const r = express.Router();

  r.post(
    '/onboarding/register-device',
    requirePermission('devices:enroll'),
    requireCsrf,
    limits.sensitive,
    validate({ body: registerBody }),
    ah(async (req, res) => {
      let network = await Network.findOne({ ownerId: req.user._id, status: 'active' }).sort({ createdAt: 1 });
      let createdNetwork = false;
      if (!network) {
        const base = `${slug(req.user.displayName)}-net`;
        for (let i = 0; i < 5 && !network; i++) {
          try {
            network = await createNetwork({ name: i ? `${base}-${i + 1}` : base, cidr: await suggestFreeCidr(), ownerId: req.user._id });
          } catch (err) {
            // Name taken or a concurrent create claimed the range: try again.
            if (!['NETWORK_NAME_TAKEN', 'CIDR_OVERLAP'].includes(err.code) || i === 4) throw err;
          }
        }
        createdNetwork = true;
        await audit.record(
          {
            operation: 'network.create',
            target: { type: 'network', id: String(network._id), label: network.name },
            networkId: network._id,
            metadata: { cidr: network.cidr, via: 'onboarding' },
          },
          req,
        );
        req.app.locals.realtime?.emitNetwork(network._id, 'network:update', { networkId: String(network._id) }, req.user._id);
      }

      const { device, token, expiresAt } = await createEnrollmentRequest({
        network,
        name: req.valid.body.deviceName,
        user: req.user,
        ttlMinutes: config.ENROLLMENT_TOKEN_TTL_MINUTES,
      });
      await audit.record(
        {
          operation: 'device.enrollment_request',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          metadata: { expiresAt, via: 'onboarding' },
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) }, req.user._id);
      res.set('Cache-Control', 'no-store');
      send(
        res,
        {
          network: serializeNetwork(network.toObject ? network.toObject() : network),
          createdNetwork,
          device: serializeDevice(device.toObject(), {}),
          enrollment: { token, expiresAt, singleUse: true },
        },
        201,
      );
    }),
  );

  return r;
}

module.exports = { onboardingRouter };
