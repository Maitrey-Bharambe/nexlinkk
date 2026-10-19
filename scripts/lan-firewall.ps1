<#
  NexLink LAN setup — run in an ADMINISTRATOR PowerShell.

  On the PC that runs the portal (PC-1):
      .\scripts\lan-firewall.ps1 -Server
  On every PC that runs an agent in userspace mode (PC-1 and PC-2):
      .\scripts\lan-firewall.ps1 -Agent
  Remove all NexLink rules again:
      .\scripts\lan-firewall.ps1 -Remove

  Rules apply to the Private network profile only (your home/lab Wi-Fi must be
  set to "Private"), so nothing is opened on public networks.
#>
param([switch]$Server, [switch]$Agent, [switch]$Remove)

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Error 'Run this script in a PowerShell opened with "Run as administrator".' }

if ($Remove) {
  Get-NetFirewallRule -DisplayName 'NexLink*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host 'Removed all NexLink firewall rules.'
  return
}
if (-not ($Server -or $Agent)) { Write-Error 'Pass -Server, -Agent or -Remove (see the top of this file).' }

function Add-Rule($name, $proto, $port) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol $proto -LocalPort $port -Profile Private -Action Allow | Out-Null
  Write-Host "  allowed $proto $port  ($name)"
}

$profiles = Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory
if ($profiles -notcontains 'Private') {
  Write-Warning 'No network is set to Private. Settings > Network & internet > Wi-Fi > (your network) > Private network.'
}

if ($Server) {
  Write-Host 'Portal PC: letting other PCs on this LAN reach the console and control plane'
  Add-Rule 'NexLink console (3000)' TCP 3000
  Add-Rule 'NexLink control plane (4000)' TCP 4000
}
if ($Agent) {
  Write-Host 'Agent PC: letting peers reach the WireGuard tunnel'
  Add-Rule 'NexLink WireGuard (51820)' UDP 51820
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match 'Wi-Fi|Ethernet' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
if ($ip) { Write-Host "This PC's LAN address: $ip" }
