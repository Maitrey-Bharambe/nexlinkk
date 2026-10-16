# Threat model (foundation milestone)

## Assets
Operator sessions · device identity keys · WireGuard private keys · network membership/addresses ·
the ability to change a host's WireGuard configuration · audit integrity.

## Trust boundaries
1. Browser ↔ control plane (user API)
2. Agent ↔ control plane (agent API)
3. Control plane ↔ diagnostic service / any LLM provider
4. Agent ↔ host OS (privileged operations)

## Threats and mitigations

| Threat | Mitigation | Status |
|---|---|---|
| Session theft via XSS | HttpOnly cookie; CSRF token held in memory only; no tokens in localStorage | ✅ |
| CSRF | SameSite=Strict + synchronizer token header + JSON-only bodies | ✅ tested |
| Credential stuffing | scrypt (N=2^17), per-IP+email rate limit, account lockout, generic errors, timing equalisation | ✅ tested |
| Privilege escalation | RBAC checked server-side on every route; scope (owner/collaborator) checked per resource; out-of-scope → 404 | ✅ tested |
| Mass assignment | Strict zod schemas reject unknown fields | ✅ tested |
| NoSQL operator injection | Every input parsed to scalars by zod before use in queries; `strictQuery` | ✅ |
| Enrollment token leakage | 15-min TTL, single use (atomic), stored as SHA-256, returned once, never in URLs/logs/audit, agent reads it from env/stdin not argv | ✅ tested |
| Device impersonation | Ed25519 proof-of-possession at enrollment; every agent request signed; device id taken from the signature, body id must match | ✅ tested |
| Replay of agent requests | ±120 s timestamp window + unique nonce (TTL index) + per-boot monotonic heartbeat sequence | ✅ tested |
| Revoked device continues | Revocation checked on every signed request; tokens invalidated; queued commands cancelled | ✅ tested |
| Telemetry spoofing of other devices | Peer observations accepted only for peers in the reporter's network; deviceId mismatch rejected | ✅ tested |
| Fabricated health | Unknown ≠ 0; simulated sources never yield healthy; links "configured" until handshake | ✅ tested |
| Malicious/hallucinated AI output | Strict schema (no confidence field), evidence-ref grounding, action allowlist, policy engine, human approval, agent-side allowlist | ✅ tested |
| Compromised control plane pushes harmful config | Agent validates every AllowedIP is a /32 inside the network CIDR, endpoints are IP literals; privileged mode is a local opt-in | ✅ unit tested (Go) — not compiled yet |
| Audit tampering via API | No write routes; only backend code records events; secret-like metadata keys redacted | ✅ tested |
| Secrets in logs | pino redaction paths; tokens/keys never logged | ✅ |
| Plain HTTP agent traffic | Agent refuses non-loopback `http://` unless `NEXLINK_ALLOW_HTTP=true` (lab use) | ✅ |

## Known gaps (accepted for this milestone)
* No TLS termination provided — run the control plane behind a TLS reverse proxy in any shared deployment.
* Agent key files rely on filesystem permissions (0600 on Unix; use NTFS ACLs on Windows). No TPM/keychain.
* No MFA, no SSO, no password reset flow.
* Socket.IO room membership is computed at connect time; a user added to a network later needs a reconnect.
* Rate limits are in-memory (single instance).
* Relay/NAT traversal absent: some device pairs cannot connect directly and will show `unreachable`.
