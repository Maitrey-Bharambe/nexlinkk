'use strict';

const { Network, Membership } = require('../../database/models/network');
const { parseCIDR, freeAddresses, defaultReserved, intToIPv4 } = require('../../utils/ipv4');
const { badRequest, conflict } = require('../../utils/errors');

/**
 * Overlap is checked across *all* active networks: one control plane is one
 * administrative scope, and a device may later join more than one network,
 * so overlapping ranges would make routes ambiguous.
 */
async function findOverlapping(range, excludeId) {
  const q = { status: 'active', rangeStart: { $lte: range.end }, rangeEnd: { $gte: range.start } };
  if (excludeId) q._id = { $ne: excludeId };
  return Network.find(q).select('name cidr createdAt').lean();
}

async function createNetwork({ name, cidr, ownerId }) {
  const parsed = parseCIDR(cidr);
  if (!parsed.ok) throw badRequest(parsed.code, parsed.message);
  const range = parsed.value;

  const existing = await findOverlapping(range);
  if (existing.length) {
    throw conflict('CIDR_OVERLAP', `${range.cidr} overlaps ${existing.map((n) => `${n.name} (${n.cidr})`).join(', ')}`, {
      overlaps: existing.map((n) => ({ id: String(n._id), name: n.name, cidr: n.cidr })),
    });
  }
  if (await Network.exists({ name, status: 'active' })) throw conflict('NETWORK_NAME_TAKEN', 'Network name already in use');

  const network = await Network.create({
    name,
    cidr: range.cidr,
    prefixLength: range.prefix,
    rangeStart: range.start,
    rangeEnd: range.end,
    reservedAddresses: defaultReserved(range.start),
    ownerId,
  });

  // Two concurrent creates can both pass the pre-check. Resolve deterministically:
  // the older record wins and the newer one withdraws itself.
  const racing = await findOverlapping(range, network._id);
  const older = racing.find(
    (n) => n.createdAt < network.createdAt || (+n.createdAt === +network.createdAt && String(n._id) < String(network._id)),
  );
  if (older) {
    await Network.deleteOne({ _id: network._id });
    throw conflict('CIDR_OVERLAP', `${range.cidr} overlaps ${older.name} (${older.cidr})`);
  }
  return network;
}

/**
 * Allocates the lowest free host address. The unique partial index on
 * (networkId, addressInt) is the real guard; on a duplicate-key race we retry.
 */
async function allocateMembership({ network, deviceId }, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const held = await Membership.find({ networkId: network._id, holdsAddress: true }).select('addressInt').lean();
    // First try the lowest free address; after a collision, spread out over the
    // lowest free candidates so concurrent enrollments stop racing for one slot.
    const candidates = freeAddresses(
      { start: network.rangeStart, end: network.rangeEnd, used: held.map((m) => m.addressInt), reserved: network.reservedAddresses },
      i === 0 ? 1 : 32,
    );
    const addr = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    if (addr === null) throw conflict('ADDRESS_POOL_EXHAUSTED', `No free addresses left in ${network.cidr}`);
    try {
      const membership = await Membership.create({
        networkId: network._id,
        deviceId,
        address: intToIPv4(addr),
        addressInt: addr,
      });
      await Network.updateOne({ _id: network._id }, { $inc: { configVersion: 1 } });
      return membership;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      if (err.keyPattern?.deviceId) throw conflict('ALREADY_MEMBER', 'Device already has an active membership in this network');
    }
  }
  throw conflict('ADDRESS_ALLOCATION_CONTENDED', 'Could not allocate an address, retry');
}

/** First 10.X.0.0/24 (X = 100..254) that overlaps no active network. */
async function suggestFreeCidr() {
  for (let x = 100; x <= 254; x++) {
    const cidr = `10.${x}.0.0/24`;
    if (!(await findOverlapping(parseCIDR(cidr).value)).length) return cidr;
  }
  throw conflict('NO_FREE_RANGE', 'No free 10.x.0.0/24 range left; create a network with an explicit CIDR');
}

async function bumpConfigVersion(networkId) {
  await Network.updateOne({ _id: networkId }, { $inc: { configVersion: 1 } });
}

function serializeNetwork(n, extra = {}) {
  const usable = n.rangeEnd - n.rangeStart - 1;
  return {
    id: String(n._id),
    name: n.name,
    cidr: n.cidr,
    prefixLength: n.prefixLength,
    firstAddress: intToIPv4(n.rangeStart),
    lastAddress: intToIPv4(n.rangeEnd),
    usableHosts: Math.max(0, usable - (n.reservedAddresses?.length || 0)),
    reservedAddresses: (n.reservedAddresses || []).map(intToIPv4),
    ownerId: String(n.ownerId),
    collaborators: (n.collaborators || []).map((c) => ({ userId: String(c.userId), role: c.role })),
    configVersion: n.configVersion,
    status: n.status,
    createdAt: n.createdAt,
    ...extra,
  };
}

module.exports = { createNetwork, allocateMembership, bumpConfigVersion, findOverlapping, serializeNetwork, suggestFreeCidr };
