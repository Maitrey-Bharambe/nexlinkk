'use strict';

const { Network } = require('../../database/models/network');
const { Device } = require('../../database/models/device');
const { notFound, forbidden } = require('../../utils/errors');

/**
 * Administrative scope. Admins see every network; everyone else sees networks
 * they own or collaborate on. Out-of-scope resources answer 404, not 403, so
 * identifiers of other tenants' resources are not confirmed.
 */
function networkScopeFilter(user) {
  if (user.role === 'admin') return {};
  return { $or: [{ ownerId: user._id }, { 'collaborators.userId': user._id }] };
}

async function visibleNetworkIds(user) {
  const nets = await Network.find({ ...networkScopeFilter(user), status: 'active' }).select('_id').lean();
  return nets.map((n) => n._id);
}

/** Effective role of a user on a specific network (admin > owner > collaborator). */
function roleOnNetwork(user, network) {
  if (user.role === 'admin') return 'admin';
  if (String(network.ownerId) === String(user._id)) return user.role === 'viewer' ? 'viewer' : 'operator';
  const c = network.collaborators?.find((x) => String(x.userId) === String(user._id));
  if (!c) return null;
  // A collaborator grant can never exceed the user's global role.
  return user.role === 'viewer' ? 'viewer' : c.role;
}

async function loadNetworkInScope(user, networkId, { write = false } = {}) {
  const network = await Network.findOne({ _id: networkId, status: 'active' });
  if (!network) throw notFound('Network');
  const role = roleOnNetwork(user, network);
  if (!role) throw notFound('Network');
  if (write && role === 'viewer') throw forbidden('SCOPE_DENIED', 'Read-only access to this network');
  return network;
}

async function loadDeviceInScope(user, deviceId, opts = {}) {
  const device = await Device.findById(deviceId);
  if (!device) throw notFound('Device');
  const network = await Network.findById(device.networkId);
  if (!network || !roleOnNetwork(user, network)) throw notFound('Device');
  if (opts.write && roleOnNetwork(user, network) === 'viewer') {
    throw forbidden('SCOPE_DENIED', 'Read-only access to this network');
  }
  return { device, network };
}

module.exports = { networkScopeFilter, visibleNetworkIds, roleOnNetwork, loadNetworkInScope, loadDeviceInScope };
