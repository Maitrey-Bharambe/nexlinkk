# Runbook: first real WireGuard tunnel between two Windows PCs

Goal: two PCs on the same Wi-Fi/LAN join one NexLink network, bring up a WireGuard tunnel, and the
console shows the link as **connected** because WireGuard reported a handshake — not because a record exists.

Test category: **separate physical machines, actual WireGuard interface** (see implementation-roadmap.md).

* **PC-1** runs the control plane + console (this dev machine). Its LAN IP below is `192.168.0.105` —
  check yours with `ipconfig` (the Wi-Fi/Ethernet adapter, not Radmin/Tailscale/vEthernet).
* **PC-2** only runs the agent. It does **not** need Go, Node or MongoDB.

Every command marked **(Admin)** must run in PowerShell opened with *Run as administrator*.

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

## Cleanup

WireGuard app → Deactivate / Remove `nexlink0`; **(Admin)** `Remove-NetFirewallRule -DisplayName "NexLink*"`.
Revoke the devices in the console if you're done with them.
