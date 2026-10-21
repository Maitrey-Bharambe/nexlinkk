# Database schema (MongoDB)

Models: `web/server/database/models/*.js`. Indexes are created by `syncIndexes()` on startup.

| Collection | Key fields | Constraints / indexes | Retention |
|---|---|---|---|
| users | email, displayName, passwordHash (scrypt), role, disabled, failedLoginCount, lockedUntil | unique email | — |
| sessions | tokenHash (sha256), userId, csrfToken, expiresAt | unique tokenHash; TTL expiresAt | session TTL |
| networks | name, cidr, prefixLength, rangeStart/rangeEnd (uint32), reservedAddresses, ownerId, collaborators[], configVersion, status | unique name where active; (status, rangeStart, rangeEnd) | soft delete |
| memberships | networkId, deviceId, address, addressInt, status, holdsAddress | **unique (networkId, addressInt) where holdsAddress**; unique (networkId, deviceId) where active | — |
| devices | name, networkId, enrollmentState, identityPublicKey/Fingerprint, wireguardPublicKey/Fingerprint, capabilities, lastHeartbeatAt, lastHeartbeat{bootId, sequence}, vpn{state, source, observedAt, keyMatches}, endpoints | unique identityFingerprint; unique wireguardPublicKey | — |
| enrollmenttokens | tokenHash, deviceId, networkId, expiresAt, usedAt | unique tokenHash; TTL purgeAt (expiry + 7 d) | 7 d after expiry |
| agentnonces | deviceId, nonce, expiresAt | unique (deviceId, nonce); TTL | 4 min |
| heartbeats | deviceId, receivedAt, sequence, health, vpnInterface, clockSkewMs | (deviceId, receivedAt); TTL | 3 d |
| measurements | deviceId, networkId, type, target{kind, ref, peerDeviceId}, value|null, unit, valid, source, sampleCount, error, measuredAt, commandId | (deviceId, type, measuredAt); TTL | 7 d |
| peerobservations | networkId, deviceId (observer), peerDeviceId, lastHandshakeAt, endpoint, path, rx/tx, observedAt | unique (deviceId, peerDeviceId) | latest only |
| incidents | category, severity, state, active, source (detector|test), deviceId, networkId, peerDeviceId, evidence[], resolution | unique (deviceId, category, peerDeviceId) where active | — |
| diagnosticruns | incidentId, method, provider, status, evidence[], result, validationErrors | (incidentId, startedAt) | — |
| proposedactions | incidentId, deviceId, actionType, params, risk, validation{valid, reasons}, status, commandId, verification{outcome, notes, evidence} | (status, createdAt); (deviceId, actionType, createdAt) | — |
| approvals | actionId, approverId, decision, reason, decidedAt | unique actionId | — |
| agentcommands | deviceId, actionId, type, params, status, deadlineAt, result | (deviceId, status, createdAt); (status, deadlineAt) | — |
| auditevents | at, actor{type,id,label}, operation, target, networkId, decision, outcome, reason, incidentId, actionId, requestId, ip, metadata | (at), (networkId, at), (target.id, at), (operation, at) | kept (security record) |

No private VPN keys, agent signing keys, plaintext passwords or plaintext tokens are stored.

Configured vs observed: configured peer relationships are derived from active memberships (full mesh);
`peerobservations` holds only what WireGuard reported.
