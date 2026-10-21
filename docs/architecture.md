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
* **Two ways to run the data plane.** With the WireGuard app installed, the agent reads (and, if privileged,
  applies) the OS interface. With `run --userspace`, the agent runs wireguard-go with an in-process network
  stack: peers are synced from the control plane and probes/approved tests go through the tunnel, with no
  VPN app and no Administrator rights. It carries NexLink traffic only, not other applications.
* **Agent console.** The agent tees its own log lines (Info and above, secrets redacted) to a signed
  `POST /agent/events`; the control plane stores them with a TTL and pushes them live to the device page.
* **Access from the LAN.** With `CORS_ALLOW_PRIVATE_LAN=true` the console can be opened from another PC on a
  private address (`http://192.168.x.y:3000`), which also serves the Windows agent download.

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

## Protocol simulation (`/simulation`)

An SVG replay of the two-PC tunnel for teaching and demos. `frontend/features/simulation/engine.js`
turns a scenario into a deterministic timeline of packets, log lines and state changes that follows
the real protocol step by step:

1. **Enrollment** — `POST /agent/enroll` with the one-time token, both public keys and a proof signature; reply assigns the virtual IP.
2. **Peer config** — signed `GET /agent/config`; reply carries the peer's public key, `allowedIPs` (/32) and endpoint.
3. **Handshake** — Noise_IKpsk2: Handshake Initiation (type 1, 148 B) and Response (type 2, 92 B), then the initiator's first Transport Data (keepalive, 32 B).
4. **Encrypted traffic** — TCP probes to the peer's tunnel address (`:7946`) inside Transport Data messages (16 B header + padded payload + 16 B tag).
5. **Telemetry** — signed `POST /agent/telemetry`; only then does the server mark the link *connected*.

Scenarios: normal, 30 % loss (→ *degraded*), peer offline (handshake retried every 5 s, link never
*connected*, incident raised), control plane down (telemetry fails, the tunnel keeps working) and
revocation (`403 DEVICE_REVOKED`, peer removed from the other side's config).

The scene (`features/simulation/SimulationCanvas.js`) is hand-built SVG: two laptops whose screens
show the agent (`nexlink-agent run --userspace`, interface `nexlink-userspace`, virtual IP), a
rack-style control-plane server, the Wi-Fi gateway the UDP datagrams cross, the WireGuard tunnel
drawn as a glowing conduit, and packet capsules tagged by type (`HTTP`, `WG-INIT`, `WG-RESP`,
`WG-DATA`, `KEEPALIVE`) that travel along their route; lost datagrams burst at the gateway. A dimmed
circuit-board image (`public/simulation-bg.jpg`) sits behind a grid overlay. The replay clock is
wall-clock based, so it keeps real speed even when the browser throttles animation frames.

The canvas separates the PCs' session state (*tunnel up* after the handshake) from the server's
evidence-based link state, mirroring the rule used everywhere else. Every packet is labelled
**simulated**; when two enrolled devices are selected, their real names, virtual IPs and reported
endpoints are used, and a side panel shows the link state their agents actually report.

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
