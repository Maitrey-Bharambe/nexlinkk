# nexlink-agent (Go)

Runs on each managed computer. Enrolls with a one-time token, reports heartbeats and telemetry over a
signed HTTPS protocol, executes **approved, allowlisted** commands, and (only in privileged mode) applies
WireGuard peer configuration through `wgctrl`.

> Status: builds with Go 1.27, `go vet` clean, unit tests pass, and the integration test passes against a
> live control plane (enroll → token replay rejected → telemetry → run loop). Not yet tested: a real
> WireGuard interface (privileged `apply`) and two separate machines.

## Build & test

```bash
go mod tidy                                   # resolves golang.zx2c4.com/wireguard/wgctrl
go build -o bin/nexlink-agent ./cmd/nexlink-agent
go test ./...                                 # unit tests: loopback sockets only, no host changes
NEXLINK_IT_SERVER=http://127.0.0.1:4000 NEXLINK_IT_TOKEN=nxe_... go test -tags integration ./tests/
```

## Use

```bash
nexlink-agent enroll --server https://cp.example.com     # paste token at the prompt (or NEXLINK_ENROLLMENT_TOKEN)
nexlink-agent run                                       # safe mode: read-only
nexlink-agent status                                    # local inspection, no network calls
nexlink-agent probe --target 10.42.0.3:22 --count 5     # bounded TCP probe
nexlink-agent doctor                                    # read-only preflight: control plane, WireGuard, handshakes, tunnel probe
nexlink-agent export-config                             # write nexlink0.conf for the WireGuard app / wg-quick (contains private key)
NEXLINK_ENABLE_PRIVILEGED=true nexlink-agent apply --dry-run   # show desired WireGuard peers
NEXLINK_ENABLE_PRIVILEGED=true nexlink-agent apply             # explicitly apply + verify
```

| Env | Default | Meaning |
|---|---|---|
| `NEXLINK_SERVER` | — | control plane URL (stored after enrollment) |
| `NEXLINK_STATE_DIR` | `<UserConfigDir>/nexlink-agent` | keys (`identity.key`, `wireguard.key`, 0600) + `state.json` |
| `NEXLINK_INTERFACE` | `nexlink0` | WireGuard interface to inspect/manage |
| `NEXLINK_HEARTBEAT_SECONDS` | 30 | heartbeat interval |
| `NEXLINK_ENABLE_PRIVILEGED` | `false` | allow `refresh_vpn_config` / `apply` to change the interface |
| `NEXLINK_ALLOW_HTTP` | `false` | allow plain http to a non-loopback server (lab only) |
| `NEXLINK_PROBE_TCP_PORT` | 7946 | TCP port each agent answers on (tunnel address only) for peer probes |
| `NEXLINK_LISTEN_PORT` | 51820 | WireGuard UDP port; advertised to peers and written by `export-config` |

## Safety model

* **Safe mode (default):** reads WireGuard state, runs TCP probes, sends telemetry. Never changes host config.
* **Privileged mode:** opt-in per host. The applier sets the interface private key to the enrolled key and
  replaces its peer set. It refuses any AllowedIP that is not a /32 inside the network CIDR and any endpoint
  that is not an IP literal, then reads the interface back to verify. It does **not** create interfaces,
  assign addresses or edit routes — do that once yourself (see `docs/implementation-roadmap.md`).
* Commands from the control plane pass a second, agent-local allowlist (`internal/policy`). There is no shell.
* Reading WireGuard state needs root/Administrator. Without it, telemetry says `source: unavailable`,
  state `unknown` — never a guess.
* Windows: protect the state directory with NTFS ACLs (file mode bits are not enforced).

## Packages

`config` · `identity` (Ed25519 + WireGuard keys) · `transport` (signed client) · `enrollment` ·
`wireguard` (Inspector / Applier / safety envelope) · `connectivity` (TCP probes) · `telemetry` (schema v1) ·
`policy` (command allowlist) · `diagnostics` (executor) · `platform` (endpoint candidates) · `agent` (loop).
