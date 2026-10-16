# NexLink control plane

Express + MongoDB. Authoritative configuration, device identity, telemetry ingestion, health evaluation,
incident detection, policy engine, approvals and audit. It never carries VPN traffic.

## Run

```bash
cp .env.example .env
npm install
npm run dev:mongo            # dev-only mongod (127.0.0.1:27017, data in ./.data). Skip if you have MongoDB/Atlas.
npm run create-user -- --email admin@example.com --name Admin --role admin
npm run dev                  # :4000, restarts on change
```

MongoDB options: local `mongod`, `docker compose up -d mongo` (repo root), `npm run dev:mongo`, or Atlas
(`MONGODB_URI=mongodb+srv://…` in `.env`, add your IP to the Atlas access list).

## Test

```bash
npm test     # node:test + supertest against an ephemeral mongod (first run downloads the binary)
```

Suites: `auth`, `networks`, `enrollment`, `telemetry`, `incidents`, `ipv4`. The agent in tests is a
simulated fixture (`tests/helpers.js#FakeAgent`) that uses real Ed25519/X25519 keys and the real signed
protocol — no WireGuard or host networking is involved.

## Layout

```
src/config        env validation (zod), logger with secret redaction
src/database      mongoose models + index sync (the "migrations")
src/middleware    session auth, CSRF, RBAC, agent signature auth, validation, errors, rate limits
src/modules
  auth            login/logout/me, users
  networks        CIDR validation, overlap checks, address allocation, scope
  devices         device views, revoke, membership removal
  enrollment      one-time tokens, proof-of-possession enrollment
  agent           agent-only API (enroll, heartbeat, telemetry, config, commands)
  telemetry       schema v1, ingestion, health model
  topology        topology graph + overview
  incidents       deterministic detector + incident API
  diagnostics     read-only tool registry, deterministic planner, result schema, diagnostic-service client
  policies        permissions, action registry, policy engine
  approvals       approve/reject, command dispatch, verification
  audit           append-only audit service + read API
src/sockets       Socket.IO (ids only; clients refetch through REST)
```

## Troubleshooting

* `Invalid configuration: …` — fix the named env var; startup refuses unsafe defaults.
* `MongooseServerSelectionError` — MongoDB not reachable at `MONGODB_URI`.
* Login works but every write returns `CSRF_TOKEN_INVALID` — the client must send `X-CSRF-Token` from `/auth/me`.
* Agent gets `AGENT_TIMESTAMP_SKEW` — fix the host clock (NTP); window is `AGENT_CLOCK_SKEW_SECONDS`.
* Devices stay `unknown` — no telemetry yet, or the agent cannot read WireGuard (needs root/Administrator).
