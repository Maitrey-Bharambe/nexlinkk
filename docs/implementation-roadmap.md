# Implementation roadmap & test categories

## Stage status

| Stage | Status |
|---|---|
| 1. Repository audit | Done — repository was empty; greenfield build. |
| 2. Foundation (web, control plane, MongoDB, auth, validation) | Done, tested. |
| 3. Device agent (identity, heartbeat, telemetry, probes) | Done: Go agent builds, unit + integration tests pass against a live control plane. |
| 4. VPN integration | Real WireGuard tunnel **verified in a single-host lab** (`nexlink-agent lab`, wireguard-go): handshake, telemetry, *connected* in the console, approved peer test 0.23 ms / 0% loss. `run --userspace` verified between two agent processes over the LAN address (handshake, 0.3–2.9 ms, *connected · direct*). Kernel/WireGuardNT and two-machine runs pending. |
| 5. Incident engine | Done, tested (deterministic). |
| 6. AI integration | Groq provider wired (JSON mode) behind schema + grounding + policy + approval; mock remains default. Live Groq diagnosis verified (`openai/gpt-oss-120b`). |
| 7. Testing & docs | This document set. |

## Test categories

| Category | What | Where |
|---|---|---|
| Unit-tested behaviour | CIDR math, health thresholds, Go probes/policy/validation/identity | `control-plane/tests/ipv4.test.js`, parts of `telemetry.test.js`, `networking-agent/internal/**/*_test.go` |
| Simulated test fixtures | Control-plane integration tests with an in-process agent using real Ed25519/X25519 keys and the real signed protocol; peer handshake data is injected (labelled `wgctrl` in tests to exercise the server path) | `control-plane/tests/*.test.js` |
| Agent ↔ control plane on one machine | Real Go agent against a running control plane, interface absent | `networking-agent/tests/integration_test.go` (`-tags integration`) — ✅ passed |
| Actual WireGuard protocol, one host | Two enrolled agents, two wireguard-go devices over loopback UDP, live control plane | `nexlink-agent lab` + `internal/wireguard/userspace_test.go` — ✅ passed |
| Actual WireGuard protocol over the LAN address | Two agent processes, `run --userspace` on UDP 51820/51821 via 192.168.0.105, live control plane | manual run — ✅ passed |
| Kernel / WireGuardNT interface | Privileged `apply` or imported tunnel + handshake telemetry | **not yet run** |
| Separate physical / virtual machines | Two hosts, one network, verified handshake + tunnel probe | **not yet run** |

## Next steps (in order)

1. ~~Build + test the Go agent~~ (done).
2. **First real private-network test** (two machines on one LAN) — step-by-step in
   [two-pc-test.md](two-pc-test.md): PC-2 opens the portal by LAN address, downloads the agent,
   `enroll` + `run --userspace` (no admin). Verified on one machine with two agent processes over the LAN
   address; the two-PC run itself is **pending**.
3. Relay: deploy a UDP relay, implement `request_relay_fallback`, add `path=relay` reporting.
4. ~~LLM provider~~ (Groq done, live diagnosis verified).
5. Hardening: TLS deployment guide, agent key storage in OS keychain/TPM, MFA, shared rate-limit store.
