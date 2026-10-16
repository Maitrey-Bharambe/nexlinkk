'use strict';

const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.id },
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let e = err;
  if (err?.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  else if (err?.type === 'entity.parse.failed') e = new AppError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  else if (err?.code === 11000) e = new AppError(409, 'DUPLICATE', 'A conflicting record already exists');

  if (!(e instanceof AppError)) {
    req.log?.error({ err }, 'unhandled error');
    e = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  } else if (e.status >= 500) {
    req.log?.error({ err }, 'server error');
  }

  res.status(e.status).json({
    ok: false,
    error: { code: e.code, message: e.message, details: e.details, requestId: req.id },
  });
}

module.exports = { errorHandler, notFoundHandler };
