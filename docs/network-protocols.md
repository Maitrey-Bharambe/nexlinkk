# Network protocols

## 1. Enrollment (once per device)

```
operator ──POST /devices/enrollment-requests──► control plane   → returns nxe_<token> once (15 min, single use)
agent: generate Ed25519 identity key + WireGuard key locally
agent ──POST /agent/enroll {token, identityPub, wgPub, ts, sig}──► control plane
        sig = Ed25519( "NEXLINK-ENROLL-V1\n" + sha256hex(token) + "\n" + identityPub + "\n" + wgPub + "\n" + ts )
control plane: verify ts window → verify sig with identityPub → atomically consume token
               → bind keys to the pending device → allocate address → audit
```

## 2. Signed agent requests

Headers: `X-NexLink-Device`, `X-NexLink-Timestamp` (ms), `X-NexLink-Nonce` (16–64 url-safe chars),
`X-NexLink-Signature` (base64 Ed25519) over:

```
NEXLINK-AGENT-SIG-V1\n<METHOD>\n<path?query>\n<timestamp>\n<nonce>\n<deviceId>\n<sha256hex(body)>
```

Server checks: header shape → |now − ts| ≤ 120 s → device exists with a key → signature → revocation →
nonce unused (unique index, TTL 2× window). A Go↔Node test vector lives in
`networking-agent/internal/transport/client_test.go`.

## 3. Heartbeat (every 30 s)

`POST /agent/heartbeat` — `{schemaVersion:1, deviceId, bootId, sequence, agentTime, agentVersion, health,
vpnInterface, capabilities}`. Within one `bootId`, `sequence` must strictly increase (atomic conditional
update). Freshness uses the **server** receive time; agent time is recorded only to report clock skew.

## 4. Telemetry (every 60 s, and on demand)

`POST /agent/telemetry` — schema v1:

* `interface`: name, state (`up|down|absent|unknown`), listenPort, publicKey, appliedConfigVersion,
  `source` (`wgctrl` = read from WireGuard; `unavailable` = could not read; `simulated` = test fixture).
* `peers[]`: WireGuard peer status (public key, endpoint, last handshake, rx/tx bytes, allowed IPs).
  Only peers whose key belongs to an active member of the same network are stored.
* `measurements[]`: `{type, target{kind,ref}, value|null, unit, valid, source, sampleCount, error, measuredAt}`.
  `valid:false` requires `value:null`; units are fixed per type; loss is 0–100.

### Probes
TCP connect (no raw sockets/privileges). A RST proves the host answered and counts as reachable; a timeout
is a lost sample. ≥ 3 attempts are needed before a loss % is reported; ≥ 2 successes for jitter. Probes are
capped at 20 attempts, 3 s timeout, ≥ 100 ms spacing. ICMP is not used, and a failed probe is never treated
as proof that a host is down.

## 5. Desired configuration

`GET /agent/config` → `{configVersion, network{cidr}, address "10.x.y.z/24", peers[{publicKey, allowedIPs
[/32], endpointCandidates[{endpoint, kind}], persistentKeepaliveSeconds:25}]}`.

Endpoint candidates are *hints*: `host_reported` (the peer's local interface addresses) and
`reflexive_guess` (the source IP the control plane saw + the peer's listen port). Behind NAT neither may
work. The agent's applier accepts only IP-literal endpoints and /32 allowed IPs inside the network CIDR.

## 6. Commands

`GET /agent/commands` (marks queued → delivered), `POST /agent/commands/:id/result`. Types:
`connectivity_test`, `report_peer_status`, `refresh_vpn_config` (privileged). The agent re-validates type
and params against its own allowlist. Results carry measurements tagged with the command id; the control
plane verifies from those plus fresh telemetry.

## 7. NAT traversal & relay (designed, not implemented)

Planned interfaces:

* **Endpoint updates** — agents report candidates (done); control plane distributes them (done).
* **Direct attempts** — both peers configure each other with candidates and persistent keepalive 25 s;
  simultaneous outbound UDP opens most cone NATs. Success is detected only by a fresh handshake.
* **Connection state** — `peerobservations.path` (`direct|relay|unknown`) already exists.
* **Relay** — a UDP relay (e.g. a WireGuard hub on a public host, or DERP-style relay) with health checks;
  `request_relay_fallback` exists in the action registry but is marked unavailable.
* **Path verification** — a tunnel probe to the peer's tunnel address after any path change.

Symmetric NAT on both sides, UDP-blocking firewalls and CGNAT can make direct paths impossible; NexLink will
not claim universal NAT traversal.
