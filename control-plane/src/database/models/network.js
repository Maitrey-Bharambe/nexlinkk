'use strict';

const { Schema, model, models } = require('mongoose');

const networkSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 64 },
    cidr: { type: String, required: true },
    prefixLength: { type: Number, required: true },
    // Unsigned 32-bit bounds of the range, used for exact overlap queries.
    rangeStart: { type: Number, required: true },
    rangeEnd: { type: Number, required: true },
    reservedAddresses: [{ type: Number }],
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    collaborators: [
      {
        _id: false,
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['operator', 'viewer'], required: true },
      },
    ],
    // Bumped on every change to membership/peer set so agents can detect drift.
    configVersion: { type: Number, default: 1 },
    status: { type: String, enum: ['active', 'deleted'], default: 'active' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
networkSchema.index({ status: 1, rangeStart: 1, rangeEnd: 1 });
networkSchema.index({ name: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
networkSchema.index({ ownerId: 1 });
networkSchema.index({ 'collaborators.userId': 1 });

const membershipSchema = new Schema(
  {
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    address: { type: String, required: true },
    addressInt: { type: Number, required: true },
    status: { type: String, enum: ['active', 'revoked', 'removed'], default: 'active' },
    // True while the address must not be handed out again. Revoked devices keep
    // their address so stale peer configs never point at a new device.
    holdsAddress: { type: Boolean, default: true },
    joinedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// The database — not application code — guarantees no two devices hold one address.
membershipSchema.index(
  { networkId: 1, addressInt: 1 },
  { unique: true, partialFilterExpression: { holdsAddress: true } },
);
membershipSchema.index(
  { networkId: 1, deviceId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
membershipSchema.index({ deviceId: 1 });

const Network = models.Network || model('Network', networkSchema);
const Membership = models.Membership || model('Membership', membershipSchema);

module.exports = { Network, Membership };
