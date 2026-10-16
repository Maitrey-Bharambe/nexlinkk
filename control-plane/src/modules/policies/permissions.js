'use strict';

/**
 * Role → permission map. The backend enforces these on every route; the
 * frontend only uses them to decide what to render.
 */
const ROLE_PERMISSIONS = {
  admin: ['*'],
  operator: [
    'networks:read',
    'networks:create',
    'networks:delete',
    'devices:read',
    'devices:enroll',
    'devices:revoke',
    'devices:membership',
    'telemetry:read',
    'incidents:read',
    'incidents:diagnose',
    'incidents:close',
    'actions:read',
    'actions:approve:low',
    'audit:read',
  ],
  viewer: ['networks:read', 'devices:read', 'telemetry:read', 'incidents:read', 'actions:read'],
};

function hasPermission(user, permission) {
  if (!user || user.disabled) return false;
  const perms = ROLE_PERMISSIONS[user.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

module.exports = { ROLE_PERMISSIONS, hasPermission, permissionsFor };
