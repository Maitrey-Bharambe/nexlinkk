# Architecture

## Components

```
            browser (operator)
                 │  HTTPS, session cookie, CSRF header
                 ▼
   ┌──────────────────────────┐        Socket.IO (ids only)
   │ frontend (Next.js :3000) │◄──────────────────────────┐
   │  /api/v1/* → rewrite     │                           │
   └────────────┬─────────────┘                           │
                ▼                                         │
   ┌──────────────────────────────────────────────────────┴──┐       ┌────────────────────┐
   │ control plane (Express :4000)                            │──────►│ diagnostic-service │
   │  user API  (cookie auth, RBAC, CSRF)                     │ HTTP  │ (FastAPI, optional)│
   │  agent API (Ed25519-signed requests, separate auth path) │       └────────────────────┘
   │  incident detector · policy engine · audit               │
   └──────────────┬───────────────────────────────────────────┘
                  │ MongoDB
                  ▼
              [ mongo ]

   control traffic (HTTPS)  ▲                   ▲
                            │                   │
                ┌───────────┴──┐   WireGuard   ┌┴─────────────┐
                │ agent  (Go)  │◄═════UDP═════►│ agent  (Go)  │   ← data plane: direct, peer-to-peer
                │ wg iface     │               │ wg iface     │
                └──────────────┘               └──────────────┘
```

* **Control plane** holds the *desired* state (networks, memberships, addresses, peer keys) and the
  *observed* state reported by agents. It never carries VPN packets.
* **Data plane** is WireGuard between devices. NexLink does not implement cryptography or tunnelling.
* **Agent** is the only component that touches the host. It is read-only by default; changing the WireGuard
  interface requires `NEXLINK_ENABLE_PRIVILEGED=true` on that host *and* an approved command or an explicit
  `nexlink-agent apply`.

## Five layers of "is it connected?"

| Layer | Meaning | Evidence used |
|---|---|---|
| Device registration | A record exists, identity key enrolled | `devices.enrollmentState = enrolled` |
| VPN configuration | Desired peer set computed, config version N | `networks.configVersion`, `/agent/config` |
| Tunnel establishment | WireGuard completed a handshake | `peerobservations.lastHandshakeAt` within 180 s of report |
| Peer reachability | Packets cross the tunnel | TCP probe to the peer's tunnel address (`run_connectivity_test`) |
| Application connectivity | A service on the peer works | not measured yet |

A row is never inferred from the row above it. A heartbeat proves only that the agent can reach the control
plane over HTTPS.

## Health model (control-plane/src/modules/telemetry/health.js)

* **agent**: `online` (≤ 3× heartbeat interval), `stale` (≤ 10×), `offline`, `never_seen` — server clock only.
* **vpn**: interface `up|down|absent|unknown` from the latest telemetry; becomes `unknown` when the report is
  stale or comes from a `simulated` source.
* **peer link**: `configured` (no observation) → `connecting` (peer on interface, no handshake) →
  `connected` (fresh handshake) / `degraded` (fresh handshake, loss > 5 % or RTT > 250 ms) /
  `unreachable` (handshake older than 180 s) / `unknown` (observations stale).
* **device**: `healthy` only when the agent is online, the interface is up with the enrolled key, and every
  configured peer has a fresh handshake. Missing evidence yields `unknown`, never `healthy`.

## Diagnostic loop

```
OBSERVE (detector, every 30 s) → CLASSIFY (category) → GATHER EVIDENCE (read-only tools)
→ HYPOTHESES (rules or provider) → VALIDATE OUTPUT (schema + grounding) → PROPOSE ACTIONS
→ POLICY ENGINE (allowlist, params, state, capability, rate limit) → HUMAN APPROVAL (policy re-run)
→ AGENT EXECUTES (agent-side allowlist again) → VERIFY (fresh measurements) → detector re-evaluates incident
```

Incidents are `resolved` only by the detector observing the condition cleared. A manual close is `closed`.

## MongoDB in place of PostgreSQL

Integrity rules that a relational schema would express as constraints are enforced with MongoDB indexes:

* unique `(networkId, addressInt)` where `holdsAddress = true` — no duplicate address allocation
* unique `(networkId, deviceId)` where `status = active` — one active membership per network
* unique `identityFingerprint`, `wireguardPublicKey` — no duplicate device identity
* unique `(deviceId, nonce)` with TTL — replay protection
* unique `(deviceId, category, peerDeviceId)` where `active` — one open incident per condition
* unique `actionId` on approvals — one decision per action
* TTL indexes bound heartbeats (3 d), measurements (7 d), nonces, sessions and expired enrollment tokens

CIDR overlap cannot be a unique index; it is checked before insert and re-checked after insert, with the
older record winning a race (tested with concurrent creates). Indexes are built by `syncIndexes()` at
startup — this is the schema-migration mechanism for this milestone.
