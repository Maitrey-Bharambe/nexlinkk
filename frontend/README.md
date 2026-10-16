# NexLink console (Next.js)

JavaScript only (App Router), Tailwind v4, lucide-react, React Flow (`@xyflow/react`), Socket.IO client.

## Run

```bash
cp .env.example .env.local
npm install
npm run dev        # http://localhost:3000 (control plane must be on :4000)
npm run build      # production build check
```

`/api/v1/*` is rewritten to `CONTROL_PLANE_URL`, so the session cookie stays same-origin, HttpOnly and
SameSite=Strict. The CSRF token lives in memory only. Live updates connect to
`NEXT_PUBLIC_CONTROL_PLANE_WS` and only trigger refetches; every page also polls because health changes when
heartbeats *stop*, which emits no event.

## Visual language

Palette: ink `#0F0F0F`, electric lime `#C7FF2E`, white `#FFFFFF`, charcoal `#2E2E2E`, mid gray `#808080`,
plus coral `#FF5A36` used only for bad states. Status shape is consistent everywhere:

* solid lime = observed good · lime outline = partial / in flight · coral = observed bad
* gray hatch = configured or unknown — **not observed**

Topology edges: solid lime = fresh handshake; dashed = configured/connecting; coral dashed = stale handshake.

## Pages

overview · networks (+detail) · devices (+detail with the three independent signals) · topology ·
diagnostics (+incident workspace) · approvals · audit log. Every number comes from the API; empty states
explain what evidence is missing.
