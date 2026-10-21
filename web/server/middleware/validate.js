'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validates body/params/query with zod. Schemas should be .strict() so unknown
 * fields are rejected (mass-assignment protection). Parsed values land on
 * req.valid; handlers never read raw req.body.
 */
function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        return next(
          badRequest(
            'VALIDATION_FAILED',
            `Invalid request ${part}`,
            result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

module.exports = { validate };
