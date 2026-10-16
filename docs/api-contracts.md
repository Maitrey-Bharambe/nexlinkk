# API contracts (v1)

Envelope: success `{ "ok": true, "data": … }`, error `{ "ok": false, "error": { "code", "message", "details?", "requestId" } }`.
User API: session cookie `nx_session` + header `X-CSRF-Token` on every non-GET; `Content-Type: application/json`.
Agent API: Ed25519 request signatures (see network-protocols.md); cookies are ignored.

## User API (`/api/v1`)

| Method & path | Permission | Notes |
|---|---|---|
| POST `/auth/login` | — | rate-limited; sets cookie; returns `{user, csrfToken, expiresAt}` |
| POST `/auth/signup` | — (`ALLOW_SIGNUP=true`) | `{email, displayName, password≥12}`; first account → admin, later → operator; signs in |
| POST `/onboarding/register-device` | `devices:enroll` | `{deviceName}`; creates the caller's first network (free 10.x.0.0/24) if needed, returns a one-time token |
| POST `/auth/logout` | session | deletes server-side session |
| GET `/auth/me` | session | `{user{role, permissions}, csrfToken}` |
| GET/POST `/users` | `users:manage` (admin) | create operator/viewer/admin |
| GET `/overview` | `networks:read` | counts computed from records |
| GET `/networks` | `networks:read` | scoped; includes observed summary |
| POST `/networks` | `networks:create` | `{name, cidr}`; 400 `CIDR_*`, 409 `CIDR_OVERLAP` |
| GET `/networks/:id` | `networks:read` | devices with health, peer links |
| DELETE `/networks/:id` | `networks:delete` | 409 `NETWORK_NOT_EMPTY` while devices active/pending |
| POST `/networks/:id/collaborators` | owner/admin | `{email, role: operator|viewer}` |
| GET `/topology?networkId=` | `networks:read` | nodes + edges (`control`, `membership`, `peer`) with observed state |
| GET `/devices?networkId=&status=` | `devices:read` | |
| POST `/devices/enrollment-requests` | `devices:enroll` | `{networkId, name}` → token returned once, `Cache-Control: no-store` |
| GET `/devices/:id` | `devices:read` | health, vpn, peer links, last 20 heartbeats, enrollment status |
| GET `/devices/:id/history` | `devices:read` | heartbeats, incidents, audit events, memberships |
| GET `/devices/:id/measurements?type=&limit=` | `telemetry:read` | |
| POST `/devices/:id/revoke` | `devices:revoke` | `{reason}` |
| DELETE `/devices/:id/membership` | `devices:membership` | releases the address |
| GET `/incidents?state=active|…&deviceId=` | `incidents:read` | |
| POST `/incidents/test` | `incidents:create_test` (admin) | explicit `[TEST]` incident, never auto-resolved |
| GET `/incidents/:id` | `incidents:read` | evidence, diagnostic runs, actions |
| POST `/incidents/:id/diagnostics` | `incidents:diagnose` | `{mode: deterministic|diagnostic_service}` |
| GET `/incidents/:id/actions` | `actions:read` | |
| POST `/incidents/:id/close` | `incidents:close` | `{note}` → state `closed` (not resolved) |
| GET `/diagnostics/registry` | `incidents:read` | tools + action allowlist |
| GET `/approvals?status=` | `actions:read` | |
| POST `/actions/:id/approve` | policy: low risk → `actions:approve:low`, else `actions:approve:high` | policy re-evaluated; 403 / 409 `POLICY_REJECTED` |
| POST `/actions/:id/reject` | `actions:approve:low` | `{reason}` |
| GET `/audit-events?q=&decision=&networkId=&before=&limit=` | `audit:read` | read-only |

Roles: **admin** = all; **operator** = networks/devices/enroll/revoke/diagnose/approve low-risk/audit read;
**viewer** = read only.

## Agent API (`/api/v1/agent`)

| Method & path | Auth | Body |
|---|---|---|
| POST `/enroll` | token + proof signature | `{enrollmentToken, identityPublicKey, wireguardPublicKey, agentVersion, platform, timestamp, signature}` |
| POST `/heartbeat` | signed | heartbeat schema v1 |
| POST `/telemetry` | signed | telemetry schema v1 |
| GET `/config` | signed | — |
| GET `/commands` | signed | — |
| POST `/commands/:id/result` | signed | `{status, startedAt, finishedAt, output, error?, measurements[]}` |

## Diagnostic service (`diagnostic-service`)

POST `/v1/diagnose` `{incident, evidence[], tools[], allowed_actions[]}` → `{provider, result: DiagnosticResult}`.
The control plane re-validates the result (schema + grounding) and runs proposals through the policy engine.
