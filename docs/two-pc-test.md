# Runbook: first real WireGuard tunnel between two Windows PCs

Goal: two PCs on the same Wi-Fi/LAN join one NexLink network, bring up a WireGuard tunnel, and the
console shows the link as **connected** because WireGuard reported a handshake — not because a record exists.

Test category: **separate physical machines, actual WireGuard interface** (see implementation-roadmap.md).

* **PC-1** runs the control plane + console (this dev machine). Its LAN IP below is `192.168.0.105` —
  check yours with `ipconfig` (the Wi-Fi/Ethernet adapter, not Radmin/Tailscale/vEthernet).
* **PC-2** only runs the agent. It does **not** need Go, Node or MongoDB.

Every command marked **(Admin)** must run in PowerShell opened with *Run as administrator*.

---

## Quick path: userspace tunnel (recommended — no WireGuard app, no admin on PC-2)

`run --userspace` carries the WireGuard tunnel inside the agent (wireguard-go + an in-process network
stack). It carries NexLink traffic — handshakes, probes and approved tests — not other Windows apps.
For a system-wide VPN adapter use the full path in sections 0–5 below.

**PC-1 (the portal PC), once:**

1. Services running (MongoDB, control plane on 4000, console on 3000). `control-plane/.env` has
   `CORS_ALLOW_PRIVATE_LAN=true`.
2. Wi-Fi set to *Private* (Settings → Network & internet → Wi-Fi → your network → Private network).
3. **(Admin)** open the portal, control plane and WireGuard ports to the LAN (Private profile only):
   ```powershell
   cd D:\projects\cn
   .\scripts\lan-firewall.ps1 -Server -Agent
   ```
   It prints PC-1's LAN address, e.g. `192.168.0.105`.
4. Start PC-1's own agent (it is already enrolled as `pc-1`):
   ```powershell
   cd D:\projects\cn\networking-agent\bin
   .\nexlink-agent.exe run --userspace --allow-http --state-dir .\pc-1
   ```

**PC-2 (same Wi-Fi):**

1. In a browser open `http://192.168.0.105:3000` and sign in with the **same account** as PC-1
   (so both devices land in the same network).
2. **register this pc** → name it → **download agent for Windows**. If SmartScreen warns:
   *More info → Run anyway*.
3. PowerShell (normal, not admin), paste the token when asked:
   ```powershell
   cd $HOME\Downloads
   .\nexlink-agent.exe enroll --server http://192.168.0.105:4000 --allow-http
   .\nexlink-agent.exe run --userspace --allow-http
   ```
   When Windows asks about network access, allow it on **private** networks.

**Verify (from either PC's browser):** the setup page turns lime ("PC-2 is in"); the device page's
agent console shows `tunnel peers updated` then `tunnel probe … rtt_ms=…`; **topology** shows the link
as *connected · direct*. On the device page, **test tunnel** to the other PC → approve → verified result.

---

## 0. One-time prep

**PC-1**

1. Services running: `npm --prefix control-plane run dev:mongo`, `npm --prefix control-plane run dev`,
   `npm --prefix frontend run dev`.
2. Make sure your Wi-Fi is a *Private* network: `Get-NetConnectionProfile` → `NetworkCategory : Private`.
   If it says Public: Settings → Network & internet → Wi-Fi → (your network) → *Private network*.
3. **(Admin)** let PC-2's agent reach the control plane on the LAN only:
   ```powershell
   New-NetFirewallRule -DisplayName "NexLink control plane" -Direction Inbound -Protocol TCP -LocalPort 4000 -Profile Private -Action Allow
   ```
4. Copy `networking-agent\bin\nexlink-agent.exe` to PC-2 (USB stick, shared folder, …).

**Both PCs**

5. Install **WireGuard for Windows** from https://www.wireguard.com/install/.
6. **(Admin)** firewall: WireGuard's UDP port from the LAN, and the NexLink probe port from the tunnel only:
   ```powershell
   New-NetFirewallRule -DisplayName "NexLink WireGuard" -Direction Inbound -Protocol UDP -LocalPort 51820 -Profile Private -Action Allow
   New-NetFirewallRule -DisplayName "NexLink tunnel probe" -Direction Inbound -Protocol TCP -LocalPort 7946 -RemoteAddress 10.0.0.0/8 -Action Allow
   ```
   (The WireGuard tunnel appears to Windows as an "unidentified/Public" network, so the probe rule is
   scoped by remote address instead of profile.)

## 1. Register both PCs (from PC-1's browser)

1. Open http://localhost:3000, **sign up** (or sign in), then **register a pc**.
2. Name it `pc-1` → *register this pc* → copy the token. A private network (e.g. `10.100.0.0/24`) is
   created for you on first use.
3. Go back to **register a pc**, name it `pc-2` → copy that second token too (each token: one use, 15 min).

## 2. Enroll

**PC-1 (Admin)**, in the folder with `nexlink-agent.exe` (`networking-agent\bin`):
```powershell
.\nexlink-agent.exe enroll --server http://192.168.0.105:4000     # paste pc-1's token at the prompt
```
**PC-2 (Admin)**:
```powershell
$env:NEXLINK_ALLOW_HTTP = "true"      # plain http on a home LAN: requests are signed, not encrypted
.\nexlink-agent.exe enroll --server http://192.168.0.105:4000     # paste pc-2's token
```
The setup page flips to "pc-1 is in." / "pc-2 is in." as each one enrolls.

## 3. Start the agents (leave these windows open)

**Both PCs (Admin)** — Administrator is needed to *read* WireGuard state; nothing is changed:
```powershell
$env:NEXLINK_ALLOW_HTTP = "true"      # PC-2 only
.\nexlink-agent.exe run
```
Within ~30 s each agent has reported its LAN endpoint (e.g. `192.168.0.105:51820`).

## 4. Create the tunnel

**Both PCs (Admin)**, in a second PowerShell window:
```powershell
$env:NEXLINK_ALLOW_HTTP = "true"      # PC-2 only
.\nexlink-agent.exe export-config      # writes nexlink0.conf
```
Check the output lists the other PC with an `endpoint 192.168.x.x:51820`. Then:

1. WireGuard app → **Import tunnel(s) from file** → `nexlink0.conf` → **Activate**.
2. Delete `nexlink0.conf` (it contains this PC's private key).

The file only adds a route for the other PC's single tunnel address (/32). It sets no DNS and no default
route, so your normal internet traffic is untouched.

## 5. Verify

```powershell
.\nexlink-agent.exe doctor            # Admin; read-only
```
Expected on both:
```
  ok   interface nexlink0 up, listening udp/51820
  ok   peer pc-2: handshake 12s ago — tunnel established
  ok   peer pc-2 answers on tunnel 10.100.0.3:7946 (3/3 probes)
all checks passed
```
In the console (http://localhost:3000):

* **Topology** — the pc-1 ↔ pc-2 edge turns **solid lime, "direct"**.
* **Devices → pc-1** — *3 · peer tunnels: 1/1 peers with a fresh handshake*; status **healthy**.
* Stop the tunnel on PC-2 (WireGuard → Deactivate): within ~3–5 min the edge goes **unreachable**
  (stale handshake) and an incident `peer_handshake_stale` opens. Re-activate → it resolves on its own
  once a fresh handshake is observed.

`ping 10.100.0.x` may fail even when the tunnel works — Windows blocks inbound ICMP by default. The
handshake and the TCP probe are the evidence NexLink uses.

## Troubleshooting

| doctor says | Fix |
|---|---|
| `cannot read WireGuard state` | Run PowerShell as Administrator; install WireGuard for Windows. |
| `control plane … unreachable` (PC-2) | PC-1 firewall rule for TCP 4000; Wi-Fi profile Private; correct PC-1 IP. |
| `refusing plain http to a non-loopback server` | `$env:NEXLINK_ALLOW_HTTP = "true"` in that window. |
| `interface nexlink0 not found` | Import `nexlink0.conf` in the WireGuard app and Activate (tunnel name must be `nexlink0`). |
| `tunnel uses a different key` | An old tunnel is active. Remove it in WireGuard, `export-config --force`, re-import. |
| `peer … missing from the tunnel` | A device joined after you exported: `export-config --force`, re-import. |
| `peer …: no handshake yet` | UDP 51820 firewall rule on **both** PCs; the other PC's tunnel is Activated; its endpoint is a 192.168.x.x address (re-export after both agents ran). Some routers isolate Wi-Fi clients ("AP/client isolation") — then use Ethernet or another network. |
| `no answer on …:7946` (handshake ok) | The other PC's agent isn't running, or its TCP 7946 rule is missing. The tunnel itself is fine. |

## Rehearse on one PC first (no admin, no WireGuard app)

`nexlink-agent lab` runs a real WireGuard tunnel between two enrolled agents on one machine using
wireguard-go (userspace) devices — no network adapter, route or DNS change:

```powershell
# register two devices in the console (register a pc → "lab-a", "lab-b"), then:
.
exlink-agent.exe enroll --server http://localhost:4000 --state-dir .lab-a   # paste token 1
.
exlink-agent.exe enroll --server http://localhost:4000 --state-dir .lab-b   # paste token 2
.
exlink-agent.exe lab --server http://localhost:4000 --a .lab-a --b .lab-b --duration 5m
```
Topology shows *lab-a ⇄ lab-b connected · direct*. Windows may ask about firewall access for the UDP
ports; loopback works either way.

## Cleanup

WireGuard app → Deactivate / Remove `nexlink0`; **(Admin)** `Remove-NetFirewallRule -DisplayName "NexLink*"`.
Revoke the devices in the console if you're done with them.
