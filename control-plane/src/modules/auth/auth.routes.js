'use strict';

const express = require('express');
const { z } = require('zod');
const { User, Session, ROLES } = require('../../database/models/identity');
const { hashPassword, verifyPassword, burnTime } = require('./passwords');
const { randomToken, sha256Hex } = require('../../utils/crypto');
const { validate } = require('../../middleware/validate');
const { requireUser, requireCsrf, requirePermission, SESSION_COOKIE } = require('../../middleware/auth');
const { permissionsFor } = require('../policies/permissions');
const { send, ah } = require('../../utils/http');
const { unauthorized, conflict, forbidden } = require('../../utils/errors');
const audit = require('../audit/audit.service');

const loginBody = z
  .object({ email: z.string().email().max(254), password: z.string().min(1).max(256) })
  .strict();

const createUserBody = z
  .object({
    email: z.string().email().max(254),
    displayName: z.string().trim().min(1).max(80),
    password: z.string().min(12, 'Use at least 12 characters').max(256),
    role: z.enum(ROLES),
  })
  .strict();

const signupBody = z
  .object({
    email: z.string().email().max(254),
    displayName: z.string().trim().min(1).max(80),
    password: z.string().min(12, 'Use at least 12 characters').max(256),
  })
  .strict();

function publicUser(u) {
  return {
    id: String(u._id),
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    permissions: permissionsFor(u.role),
    lastLoginAt: u.lastLoginAt,
  };
}

function authRouter({ config, limits }) {
  const r = express.Router();

  const cookieOpts = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
  };

  async function issueSession(req, res, user) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
    await Session.create({
      tokenHash: sha256Hex(token),
      userId: user._id,
      csrfToken,
      ip: req.ip,
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      expiresAt,
    });
    await User.updateOne({ _id: user._id }, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });
    res.cookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    req.user = user;
    return { csrfToken, expiresAt };
  }

  r.post(
    '/auth/login',
    limits.login,
    validate({ body: loginBody }),
    ah(async (req, res) => {
      const { email, password } = req.valid.body;
      const user = await User.findOne({ email: email.toLowerCase() }).select(
        '+passwordHash +failedLoginCount +lockedUntil',
      );
      const fail = async (reason) => {
        await audit.record(
          {
            actor: { type: 'anonymous', id: null, label: email },
            operation: 'auth.login',
            decision: 'deny',
            outcome: 'failure',
            reason,
          },
          req,
        );
        throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      };

      if (!user || user.disabled) {
        await burnTime(password, config.PASSWORD_SCRYPT_N);
        return fail(user ? 'account disabled' : 'unknown account');
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        // Same generic response; the lock reason is only recorded in the audit log.
        await burnTime(password, config.PASSWORD_SCRYPT_N);
        return fail('account temporarily locked');
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        const failures = (user.failedLoginCount || 0) + 1;
        const lock = failures >= config.LOGIN_MAX_FAILURES;
        await User.updateOne(
          { _id: user._id },
          {
            failedLoginCount: lock ? 0 : failures,
            lockedUntil: lock ? new Date(Date.now() + config.LOGIN_LOCK_MINUTES * 60_000) : null,
          },
        );
        return fail(lock ? 'bad password; account locked' : 'bad password');
      }

      const { csrfToken, expiresAt } = await issueSession(req, res, user);
      await audit.record({ operation: 'auth.login', target: { type: 'user', id: String(user._id) } }, req);
      send(res, { user: publicUser(user), csrfToken, expiresAt });
    }),
  );

  /**
   * Self-service signup (disable with ALLOW_SIGNUP=false). The very first
   * account bootstraps as admin; everyone after that is an operator, which
   * only ever sees networks they own or are invited to. The role is decided
   * here, never taken from the request.
   */
  r.post(
    '/auth/signup',
    limits.signup,
    validate({ body: signupBody }),
    ah(async (req, res) => {
      if (!config.ALLOW_SIGNUP) {
        throw forbidden('SIGNUP_DISABLED', 'Self-service signup is disabled; ask an administrator for an account');
      }
      const { email, displayName, password } = req.valid.body;
      if (await User.exists({ email: email.toLowerCase() })) {
        await audit.record(
          { actor: { type: 'anonymous', id: null, label: email }, operation: 'auth.signup', decision: 'deny', outcome: 'failure', reason: 'email taken' },
          req,
        );
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists — sign in instead');
      }
      const role = (await User.estimatedDocumentCount()) === 0 ? 'admin' : 'operator';
      let user;
      try {
        user = await User.create({ email, displayName, role, passwordHash: await hashPassword(password, config.PASSWORD_SCRYPT_N) });
      } catch (err) {
        if (err?.code === 11000) throw conflict('EMAIL_TAKEN', 'An account with this email already exists — sign in instead');
        throw err;
      }
      const { csrfToken, expiresAt } = await issueSession(req, res, user);
      await audit.record({ operation: 'auth.signup', target: { type: 'user', id: String(user._id), label: user.email }, metadata: { role } }, req);
      send(res, { user: publicUser(user), csrfToken, expiresAt }, 201);
    }),
  );

  r.post(
    '/auth/logout',
    requireUser,
    requireCsrf,
    ah(async (req, res) => {
      await Session.deleteOne({ _id: req.userSession._id });
      res.clearCookie(SESSION_COOKIE, cookieOpts);
      await audit.record({ operation: 'auth.logout', target: { type: 'user', id: String(req.user._id) } }, req);
      send(res, { loggedOut: true });
    }),
  );

  r.get(
    '/auth/me',
    requireUser,
    ah(async (req, res) => {
      send(res, {
        user: publicUser(req.user),
        csrfToken: req.userSession.csrfToken,
        expiresAt: req.userSession.expiresAt,
      });
    }),
  );

  r.get(
    '/users',
    requirePermission('users:manage'),
    ah(async (_req, res) => {
      const users = await User.find().sort({ createdAt: 1 }).lean();
      send(res, users.map(publicUser));
    }),
  );

  r.post(
    '/users',
    requirePermission('users:manage'),
    requireCsrf,
    limits.sensitive,
    validate({ body: createUserBody }),
    ah(async (req, res) => {
      const { email, displayName, password, role } = req.valid.body;
      if (await User.exists({ email: email.toLowerCase() })) throw conflict('EMAIL_TAKEN', 'Email already registered');
      const user = await User.create({
        email,
        displayName,
        role,
        passwordHash: await hashPassword(password, config.PASSWORD_SCRYPT_N),
      });
      await audit.record(
        { operation: 'user.create', target: { type: 'user', id: String(user._id), label: email }, metadata: { role } },
        req,
      );
      send(res, publicUser(user), 201);
    }),
  );

  return r;
}

module.exports = { authRouter, publicUser };
