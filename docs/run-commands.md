# Starting NexLink by hand

Open one PowerShell window per part, in this order. Leave each window open; press **Ctrl+C** in it to stop that part.

> Shortcut: `scripts\start-all.cmd` (double-click) opens the same windows for you, and `.\scripts\start-all.ps1 -Stop` stops them all.

## 1 · Database (MongoDB)

```powershell
cd D:\projects\cn\control-plane; npm run dev:mongo
```
Wait for `dev mongod listening`.

## 2 · Control plane (API, port 4000)

```powershell
cd D:\projects\cn\control-plane; npm run dev
```
Wait for `control plane listening`. Check: http://localhost:4000/healthz

## 3 · AI diagnostic service (port 8090, reads the Groq key from `diagnostic-service\.env`)

```powershell
cd D:\projects\cn\diagnostic-service; .\.venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090
```
Check: http://127.0.0.1:8090/healthz

## 4 · Web console (port 3000)

```powershell
cd D:\projects\cn\frontend; npm run dev
```
Wait for `Ready`, then open http://localhost:3000

## 5 · Agent on this PC (pc-1)

Find this PC's Wi-Fi address with `ipconfig` (Wireless LAN adapter Wi-Fi → IPv4 Address), then:

```powershell
cd D:\projects\cn\networking-agent\bin; .\nexlink-agent.exe run --userspace --allow-http --server http://192.168.0.105:4000 --state-dir .\pc-1
```
Replace `192.168.0.105` with your address. With no Wi-Fi, use `--server http://127.0.0.1:4000`.

## Second PC on the same Wi-Fi (optional)

Once on this PC, in PowerShell **as Administrator**:

```powershell
cd D:\projects\cn; .\scripts\lan-firewall.ps1 -Server -Agent
```

On the second PC:

1. Open `http://<this PC's address>:3000` and sign in with the **same account** (admin), so both PCs are in one network.
2. **register a pc** → name it → **register** → **copy command**.
3. Open PowerShell, paste, press Enter. Click **Allow** if Windows asks about network access, and keep the window open.

The line downloads the agent, joins the network and starts the tunnel. Closing the window disconnects that PC; pasting the same line again reconnects it.

## If something breaks

| What you see | Fix |
|---|---|
| Every console page shows **HTTP 500**; the web console window prints `Cannot find module './611.js'` (any number) | The dev build cache is corrupted — usually because `npm run build` was run while `npm run dev` was running. Press Ctrl+C in the web console window, then run the command below. Never run `npm run build` while the dev server is running. |
| A second PC can't open the portal | Both PCs must be on the same Wi-Fi/hotspot. Check this PC's address with `ipconfig` — it changes when you switch networks — and restart the agent (step 5) with the new address. |
| Agent window prints `heartbeat failed … context deadline exceeded` | The address in `--server` is old (network changed). Ctrl+C and start it again with the current address. |

```powershell
cd D:\projects\cn\frontend; Remove-Item -Recurse -Force .next; npm run dev
```

## First time on a machine (or after `git pull`)

```powershell
cd D:\projects\cn\control-plane; npm install; cd ..\frontend; npm install; cd ..\diagnostic-service; .\.venv\Scripts\python.exe -m pip install -r requirements.txt
```
