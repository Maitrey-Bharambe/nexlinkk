# Putting NexLink on the internet

On a laptop, NexLink only reaches computers on the same Wi-Fi. Deployed at a public HTTPS address, it
reaches **any** computer: invited people open a link, paste one line, and their computer joins — from home,
an office, a hotel or a phone hotspot. Nobody joins your Wi-Fi, opens a router port or installs a VPN app.

## What you deploy

One container (`Dockerfile`) and one MongoDB.

| Piece | Where |
|---|---|
| Console, REST API, Socket.IO, agent relay | one Node process, port 3000 (`web/server.js`) |
| Agent downloads (Windows, Linux x64/ARM64, macOS Intel/Apple silicon) | built into the image, served at `/downloads/*` |
| Data | MongoDB — Atlas free tier, a managed instance, or the compose service |
| AI diagnostics (optional) | `diagnostic-service`, reached via `DIAGNOSTIC_SERVICE_URL` |

The host must keep the process running and allow WebSockets: agents keep one relay socket open, and the
incident detector runs in the background. Render, Railway, Fly.io, a VPS, or Kubernetes all work.
Serverless function platforms do not.

## Settings that matter

| Variable | Set to |
|---|---|
| `MONGODB_URI` | your database (required in production) |
| `PUBLIC_URL` | the address people use, e.g. `https://nexlink.example.com` — invite links and join scripts use it |
| `TRUST_PROXY` | `true` behind a load balancer / reverse proxy you control (all PaaS hosts) |
| `COOKIE_SECURE` | `true` (default in production) — HTTPS only |
| `ALLOW_SIGNUP` | `false` once your accounts exist, if the portal is public |
| `RELAY_ENABLED` / `RELAY_MAX_BYTES_PER_SECOND` | relay on/off and the per-device bandwidth cap |

Everything else has safe defaults (see `web/.env.example`).

## Option A · one server with Docker Compose

```bash
git clone <repo> nexlink && cd nexlink
PUBLIC_URL=https://nexlink.example.com docker compose up -d --build
```
Put HTTPS in front, e.g. Caddy (`/etc/caddy/Caddyfile`):
```
nexlink.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
Caddy fetches the certificate itself and passes WebSocket upgrades through unchanged.

## Option B · a PaaS (Render, Railway, Fly.io)

1. Create a MongoDB Atlas cluster; copy its connection string; allow the host's outbound IPs (or 0.0.0.0/0).
2. New web service from this repository, **Docker** runtime, root `Dockerfile`, port `3000`,
   health check `/healthz`.
3. Environment: `MONGODB_URI`, `PUBLIC_URL` (the service's https URL or your domain), `TRUST_PROXY=true`.
4. Deploy, open the URL, **sign up** — the first account becomes admin.

## Option C · try it from your laptop

Any HTTPS tunnel that forwards WebSockets (Cloudflare Tunnel, ngrok, Tailscale Funnel) works for a demo:
point it at `http://localhost:3000`, set `PUBLIC_URL` to the tunnel's https address in `web/.env`, restart
`npm run dev`, and open the portal **through the tunnel address** when you create invites.

## Then

1. **Devices → add a device**, name it, pick its network → copy the **invite link** and send it.
2. The invited person opens the link, optionally allows remote desktop, pastes the line. Their computer
   appears in **devices** as soon as it enrolls, and in **topology** with a *direct* or *relay* link.
3. Remote session from your own enrolled PC: the device page shows the command
   (`nexlink-agent session <device> rdp`).

## Security notes for a public portal

* Agents authenticate every request (and the relay socket) with their own Ed25519 key; enrollment tokens
  are single-use, hashed at rest, valid 15 minutes, and travel in invite links after the `#`, which browsers
  never send to the server.
* The relay forwards WireGuard ciphertext between devices of the same network only and never holds a
  WireGuard key. Revoking a device closes its relay socket immediately.
* Remote sessions only reach services a device's owner shared, and only through the tunnel.
* See [threat-model.md](threat-model.md) for the full analysis.
