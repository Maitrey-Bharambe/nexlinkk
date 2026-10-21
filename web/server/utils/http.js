'use strict';

const mongoose = require('mongoose');
const { z } = require('zod');

/** Consistent success envelope: { ok: true, data }. Errors use { ok: false, error }. */
const send = (res, data, status = 200) => res.status(status).json({ ok: true, data });

/** Express 4 does not forward rejected promises; this does. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v), {
  message: 'Invalid identifier',
});

const iso = (d) => (d ? new Date(d).toISOString() : null);

module.exports = { send, ah, objectId, iso };
