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

## 7. NAT traversal & relay

* **Endpoint candidates** — agents report the addresses they listen on; the control plane adds a reflexive
  guess (source IP of the agent's HTTPS request + its WireGuard port) and, when `RELAY_ENABLED`, a
  `relay:<deviceId>` candidate for every peer.
* **Direct first** — a userspace agent configures each peer with its best direct candidate (same subnet,
  then reflexive, then reported) and persistent keepalive 25 s; simultaneous outbound UDP opens most cone NATs.
* **Relay fallback** — no handshake within 20 s → the agent sets the peer's endpoint to `relay:<id>` and
  sends one packet into the tunnel so the handshake starts at once. While on the relay it retries direct
  every 3 min until a handshake is fresh. A peer that receives a relayed handshake roams to the relay
  endpoint on its own (standard WireGuard endpoint learning, authenticated by the handshake).
* **Relay transport** — `GET /api/v1/agent/relay`, WebSocket upgrade signed exactly like any agent request
  (canonical string over method, path, timestamp, nonce, device id, empty body). Binary frames:
  `[12-byte device id][payload ≤ 2048 B]`. Agent → relay: id = destination; relay → agent: id = source
  (set by the relay, never by the sender). Keepalive: a 12-byte frame every 20 s; idle > 60 s closes.
  Forwarded only between connected devices with an active membership in the same network; per-sender
  token bucket (`RELAY_MAX_BYTES_PER_SECOND`); excess is dropped like UDP.
* **What the relay sees** — WireGuard messages: handshake initiations/responses and transport data,
  all ChaCha20-Poly1305 / Noise IK. It cannot decrypt, modify undetectably, or inject packets.
* **Connection state** — telemetry reports each peer's endpoint; `peerobservations.path` is `relay` for
  `relay:` endpoints and `direct` for `ip:port`. Topology and device pages show it per link.
* **Path verification** — every telemetry cycle probes each peer with a fresh handshake through the tunnel.

Kernel / WireGuard-app mode cannot use the relay (the OS owns the UDP socket); use `--userspace` there.
The relay keeps connections in memory: run one instance, or pin agents to instances (sticky sessions).

## 8. Remote sessions

* `run --userspace --share rdp,ssh,vnc,http:3000,tcp:8080` — the agent listens on `<tunnel ip>:<port>` inside
  its own network stack and forwards each connection to `127.0.0.1:<port>`. Shared services are reported in
  heartbeats (`services[]`) and handed to peers in `/agent/config`.
* The running agent serves a localhost-only API (`127.0.0.1:<random>`, bearer token in
  `session-gateway.json` in the user's profile and state dir; requests with an `Origin` header are refused).
  `POST /v1/forward {peer, service}` → a local listener that tunnels to the peer's shared port.
* `nexlink-agent session <peer> <service>` calls it and starts the client: `mstsc` for rdp on Windows,
  `ssh -o HostKeyAlias=nexlink-<peer>` for ssh, the browser for http(s). Both agents log each session.
