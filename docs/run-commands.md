# Starting NexLink by hand

NexLink is **one process on one port (3000)**: console pages, REST API, Socket.IO live updates and the
encrypted agent relay. Open one PowerShell window per part; press **Ctrl+C** in it to stop that part.

> Shortcut: `scripts\start-all.cmd` (double-click) opens the same windows for you, and `.\scripts\start-all.ps1 -Stop` stops them all.

## 1 · NexLink (port 3000)

```powershell
cd D:\projects\cn\web; npm run dev
```
Wait for `NexLink ready on http://localhost:3000`, then open it. Check: http://localhost:3000/healthz

No database step: without `MONGODB_URI` it uses the MongoDB already running on this PC, or starts an
embedded one with its data in `web\.data\mongo`. Set `MONGODB_URI` in `web\.env` to use Atlas or Docker.

## 2 · AI diagnostic service (optional, port 8090; reads the Groq key from `diagnostic-service\.env`)

```powershell
cd D:\projects\cn\diagnostic-service; .\.venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090
```
Check: http://127.0.0.1:8090/healthz

## 3 · Agent on this PC (pc-1)

```powershell
cd D:\projects\cn\networking-agent\bin; .\nexlink-agent.exe run --userspace --server http://127.0.0.1:3000 --state-dir .\pc-1
```
NexLink runs on this same PC, so the agent uses `127.0.0.1` and keeps working when you switch Wi-Fi.
Other devices still find this PC: directly through the LAN address it reports, or through the relay.
Add `--share rdp` to allow remote desktop sessions to this PC.

## 4 · Demo tunnel (only if you created demo data)

```powershell
cd D:\projects\cn\networking-agent\bin; .\nexlink-agent.exe lab --server http://127.0.0.1:3000 --a .\demo\demo-laptop-a --b .\demo\demo-laptop-b --duration 0
```
Keeps demo-laptop-a and demo-laptop-b healthy with a real WireGuard tunnel between them. `start-all` starts it automatically.

## Demo data for every page

```powershell
cd D:\projects\cn; .\scripts\demo-data.ps1
```
Creates the demo-campus / demo-branch networks, enrolls demo devices with the real agent, starts the demo tunnel and runs [TEST] drills through diagnosis, approval and verification. Remove it again with `.\scripts\demo-data.ps1 -Remove`. The page-by-page explanation is in `docs/NexLink-Page-Script.pdf`.

## Add another computer

Easiest: **add a device** (sidebar). Run its one line on the computer — the same line for every computer,
nothing secret in it:

```powershell
irm 'http://<this PC's address>:3000/join.ps1' | iex
```

It shows a short code (e.g. `KXRT-4P2M`). Enter it on **add a device**, check the computer name, approve.
New to NexLink? **set up** walks through network → devices → verified connectivity. Invite links still work.

* **Same Wi-Fi as this PC:** open the portal there as `http://<this PC's address>:3000`. Once, on this PC,
  in PowerShell **as Administrator**: `.\scripts\lan-firewall.ps1 -Server -Agent`.
* **Any other network:** the portal must be reachable from the internet — deploy it (see
  [deploy.md](deploy.md)) or expose port 3000 through a tunnel service, and set `PUBLIC_URL`. The devices
  then connect directly when possible and through the relay otherwise; nobody needs to be on your Wi-Fi.

Closing the agent window disconnects that computer; pasting the same line again reconnects it.

## Remote session

On your own enrolled PC (the agent must be running):

```powershell
& "$env:LOCALAPPDATA\NexLink\nexlink-agent.exe" session --list             # devices, online/direct|relay, what they share
& "$env:LOCALAPPDATA\NexLink\nexlink-agent.exe" session office-pc rdp      # opens Remote Desktop through the tunnel
```
For the agent in `networking-agent\bin\pc-1` add `--state-dir .\pc-1`.

## If something breaks

| What you see | Fix |
|---|---|
| Every console page shows **HTTP 500**; the window prints `Cannot find module './611.js'` (any number) | The dev build cache is corrupted — usually because `npm run build` was run while `npm run dev` was running. Ctrl+C, then run the command below. Never run `npm run build` while the dev server is running. |
| Another PC can't open the portal | Same Wi-Fi: check this PC's current address with `ipconfig` and the firewall rule. Different network: the portal is not on the internet yet — see [deploy.md](deploy.md). |
| Agent window prints `heartbeat failed … context deadline exceeded` | Its `--server` points at an old address (or the old `:4000` port). Paste a fresh join line; on this PC use `--server http://127.0.0.1:3000`. |
| Link shows **relay** although both PCs are on one Wi-Fi | Works fine, just slower. Allow UDP 51820 (`lan-firewall.ps1 -Agent`) and make sure the router doesn't isolate Wi-Fi clients. |
| `session` says `shares nothing` | On that computer run the join line again with **allow remote sessions** set, or add `--share rdp`. |
| demo-laptop-a / -b show unreachable | The demo tunnel window (step 4) is not running. |

```powershell
cd D:\projects\cn\web; Remove-Item -Recurse -Force .next; npm run dev
```

## First time on a machine (or after `git pull`)

```powershell
cd D:\projects\cn; .\scripts\start-all.ps1 -Install
```
Installs `web` and the AI service, and builds the agent downloads for every OS (`scripts\build-agent.ps1`).
