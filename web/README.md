# NexLink web app — console + control plane in one Next.js process

`server.js` runs everything on one HTTP server and one port:

| Path | What |
|---|---|
| `/`, `/devices`, … | console pages (App Router, JavaScript, Tailwind v4, lucide-react, React Flow, Socket.IO client) |
| `/join`, `/join.ps1`, `/join.sh`, `/downloads/*` | invite page, one-line installers, agent binaries |
| `/api/v1/*` | REST API — the Express control plane in `server/` (auth, networks, enrollment, telemetry, incidents, policy, approvals, audit) |
| `/api/v1/agent/*` | agent API, Ed25519-signed requests |
| `/api/v1/agent/relay` | encrypted relay (WebSocket) for devices that cannot reach each other directly |
| `/socket.io/` | live updates (ids only; clients refetch through REST) |

## Run

```bash
cp .env.example .env
npm install
npm run dev        # http://localhost:3000 — embedded MongoDB unless MONGODB_URI is set
npm test           # node:test + supertest against an ephemeral mongod, relay over real WebSockets
npm run build && npm start     # production (MONGODB_URI required)
```

Browser calls are same-origin, so the session cookie stays HttpOnly and SameSite=Strict with no CORS and no
proxy. The CSRF token lives in memory only. Every page also polls, because health changes when heartbeats
*stop*, which emits no event. Deployment: [../docs/deploy.md](../docs/deploy.md).

## Layout

```
server.js           one HTTP server: Next.js + Express API + Socket.IO + relay
server/config       env validation (zod), logger with secret redaction
server/database     mongoose models + index sync; devMongo.js (embedded MongoDB in development)
server/middleware   session auth, CSRF, RBAC, agent signature auth, validation, errors, rate limits
server/modules      auth · networks · devices · enrollment · agent · telemetry · topology · incidents
                    diagnostics · policies · approvals · audit · onboarding · relay
server/sockets      Socket.IO rooms per network
app/ features/ components/ hooks/ lib/    the console
tests/              integration tests (simulated agents with real keys)
scripts/            create-user, dev-mongo, seed-demo
```

## Visual language

Palette: ink `#0F0F0F`, electric lime `#C7FF2E`, white `#FFFFFF`, charcoal `#2E2E2E`, mid gray `#808080`,
plus coral `#FF5A36` used only for bad states. Status shape is consistent everywhere:

* solid lime = observed good · lime outline = partial / in flight · coral = observed bad
* gray hatch = configured or unknown — **not observed**

Topology edges: solid lime = fresh handshake (labelled `direct` or `relay`); dashed = configured/connecting;
coral dashed = stale handshake.

## Pages

overview · networks (+detail) · devices (+detail: three independent signals, agent console, remote session,
approved actions) · topology · simulation · diagnostics (+incident workspace) · approvals · audit log ·
setup (register this pc) · join (public invite page). Every number comes from the API; empty states explain
what evidence is missing.
