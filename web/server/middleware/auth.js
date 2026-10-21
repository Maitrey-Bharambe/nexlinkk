'use strict';

const { Session, User } = require('../database/models/identity');
const { sha256Hex, safeEqual } = require('../utils/crypto');
const { unauthorized, forbidden } = require('../utils/errors');
const { hasPermission } = require('../modules/policies/permissions');
const audit = require('../modules/audit/audit.service');

const SESSION_COOKIE = 'nx_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function loadSession(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 128) return null;
  const session = await Session.findOne({ tokenHash: sha256Hex(rawToken), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const user = await User.findById(session.userId);
  if (!user || user.disabled) return null;
  return { session, user };
}

/** Resolves the session cookie into req.user / req.session. Does not reject. */
async function attachUser(req, _res, next) {
  try {
    const found = await loadSession(req.cookies?.[SESSION_COOKIE]);
    if (found) {
      req.user = found.user;
      req.userSession = found.session;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireUser(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/**
 * CSRF: synchronizer token bound to the session, sent in X-CSRF-Token on every
 * state-changing request. Combined with SameSite=Strict cookies and a JSON-only
 * body parser this blocks cross-site form posts.
 */
function requireCsrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.get('x-csrf-token');
  if (!req.userSession || !header || !safeEqual(header, req.userSession.csrfToken)) {
    return next(forbidden('CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token'));
  }
  next();
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user, permission)) {
      audit.record(
        {
          operation: `permission.denied`,
          decision: 'deny',
          outcome: 'failure',
          reason: `missing ${permission}`,
          target: { type: 'route', id: `${req.method} ${req.baseUrl}${req.route?.path || ''}` },
        },
        req,
      );
      return next(forbidden('PERMISSION_DENIED', `Your role (${req.user.role}) lacks ${permission}`));
    }
    next();
  };
}

module.exports = { attachUser, requireUser, requireCsrf, requirePermission, loadSession, SESSION_COOKIE };
