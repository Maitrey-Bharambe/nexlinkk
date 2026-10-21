'use strict';

const { Schema, model, models } = require('mongoose');

const ROLES = ['admin', 'operator', 'viewer'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    // scrypt hash only — plaintext passwords never reach the database.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    disabled: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });

const sessionSchema = new Schema(
  {
    // Only the SHA-256 of the cookie value is stored; a DB leak does not leak live sessions.
    tokenHash: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    csrfToken: { type: String, required: true },
    ip: String,
    userAgent: { type: String, maxlength: 300 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = models.User || model('User', userSchema);
const Session = models.Session || model('Session', sessionSchema);

module.exports = { User, Session, ROLES };
