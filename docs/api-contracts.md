# API contracts (v1)

Envelope: success `{ "ok": true, "data": … }`, error `{ "ok": false, "error": { "code", "message", "details?", "requestId" } }`.
User API: session cookie `nx_session` + header `X-CSRF-Token` on every non-GET; `Content-Type: application/json`.
Agent API: Ed25519 request signatures (see network-protocols.md); cookies are ignored.

Everything is served by one process on one origin; there is no separate control-plane port.

| Method & path | Auth | Notes |
|---|---|---|
| GET `/healthz` | — | process liveness only |
| GET `/api/v1/meta` | — | `{publicUrl, relay}` — used to build invite links |
| GET `/join.ps1?device=<id>[&share=rdp]` | — | Windows installer script (no secrets; token comes from the caller's env var) |
| GET `/join.sh?device=<id>[&share=ssh]` | — | Linux / macOS installer script |
| GET `/join#t=…&d=…&n=…` | — | invite page; the token stays in the fragment |
| GET `/downloads/nexlink-agent*` | — | agent binaries (Windows, Linux amd64/arm64, macOS amd64/arm64) |

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
| GET `/topology?networkId=` | `networks:read` | nodes + edges (`control`, `membership`, `peer`) with observed state; device nodes carry `address` (virtual IP) and `endpoint` (first agent-reported `ip:port`, or null) |
| GET `/devices?networkId=&status=` | `devices:read` | |
| POST `/devices/enrollment-requests` | `devices:enroll` | `{networkId, name}` → token returned once, `Cache-Control: no-store` |
| GET `/devices/:id` | `devices:read` | health, vpn, peer links (`path: direct\|relay\|unknown`), last 20 heartbeats, enrollment status, `relay {connected, since, rxBytes, txBytes, dropped}`, `services [{name, port}]` |
| GET `/devices/:id/history` | `devices:read` | heartbeats, incidents, audit events, memberships |
| GET `/devices/:id/measurements?type=&limit=` | `telemetry:read` | |
| POST `/devices/:id/revoke` | `devices:revoke` | `{reason}` |
| DELETE `/devices/:id/membership` | `devices:membership` | releases the address |
| GET `/devices/:id/activity?limit=` | `devices:read` | agent console: streamed agent log lines + recent commands |
| GET `/devices/:id/actions` | `actions:read` | recent actions for this device |
| POST `/devices/:id/actions` | `actions:request` | `{actionType, params}` from the device page — policy-checked, needs approval |
| POST `/devices/:id/analysis` | `incidents:diagnose` | "analyze with AI": read-only tools collect evidence, the diagnostic service (Groq) explains it with an **empty action allowlist**; returns `{status: completed\|rejected\|failed, provider, result, evidence}`. Grounding-validated, audited as `device.analyze`, not stored |
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
| POST `/heartbeat` | signed | heartbeat schema v1; optional `services: [{name: rdp\|ssh\|vnc\|http\|https\|tcp, port}]` (≤8); capabilities may include `relay`, `remote_session` |
| POST `/telemetry` | signed | telemetry schema v1 |
| GET `/config` | signed | — ; each peer has `endpointCandidates` (`host_reported`, `reflexive_guess`, `relay`) and `services` |
| GET `/relay` (WebSocket) | signed upgrade | binary frames `[12-byte device id][WireGuard payload]`; see network-protocols.md §7 |
| GET `/commands` | signed | — |
| POST `/events` | signed | `{schemaVersion:1, deviceId, events:[{at, level, message, fields}]}` (≤100 events, ≤12 fields each) |
| POST `/commands/:id/result` | signed | `{status, startedAt, finishedAt, output, error?, measurements[]}` |

## Diagnostic service (`diagnostic-service`)

POST `/v1/diagnose` `{incident, evidence[], tools[], allowed_actions[]}` → `{provider, result: DiagnosticResult}`.
The control plane re-validates the result (schema + grounding) and runs proposals through the policy engine.
