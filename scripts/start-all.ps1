<#
  NexLink - start everything for a demo, each part in its own window.

      .\scripts\start-all.ps1              database, control plane, console, AI service, pc-1 agent
      .\scripts\start-all.ps1 -NoAgent     same, without the agent
      .\scripts\start-all.ps1 -NoAI        same, without the diagnostic (Groq) service
      .\scripts\start-all.ps1 -Install     run npm / pip installs first (new machine or after git pull)
      .\scripts\start-all.ps1 -Stop        stop everything this script starts

  Or just double-click scripts\start-all.cmd.
  Anything already running (port already listening) is left alone, so it is safe to run twice.
#>
param([switch]$NoAgent, [switch]$NoAI, [switch]$Install, [switch]$Stop)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CP = Join-Path $Root 'control-plane'
$FE = Join-Path $Root 'frontend'
$DS = Join-Path $Root 'diagnostic-service'
$AgentDir = Join-Path $Root 'networking-agent\bin'

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.ConnectAsync('127.0.0.1', $port).Wait(300) -and $c.Connected } catch { $false } finally { $c.Dispose() }
}

function Wait-Port([int]$port, [string]$name, [int]$seconds = 90) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { Write-Host "  ok   $name (port $port)" -ForegroundColor Green; return $true }
    Start-Sleep -Milliseconds 700
  }
  Write-Host "  FAIL $name did not open port $port in ${seconds}s - look at its window" -ForegroundColor Red
  return $false
}

# Opens a new PowerShell window with a title, running $command in $dir.
function Start-Window([string]$title, [string]$dir, [string]$command) {
  $full = "`$Host.UI.RawUI.WindowTitle = 'NexLink - $title'; Write-Host '$title' -ForegroundColor Green; $command"
  Start-Process powershell -WorkingDirectory $dir -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $full | Out-Null
}

# Address other PCs on the Wi-Fi use: the IPv4 of the adapter that holds the default route.
function Get-LanIP {
  try {
    $idx = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex
    (Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).IPAddress
  } catch { $null }
}

if ($Stop) {
  Write-Host 'Stopping NexLink...'
  foreach ($port in 3000, 4000, 8090, 27017) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "  stopped port $port" }
  }
  Get-Process nexlink-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host 'Done. (A NexLink Agent Windows service, if installed, keeps running: nexlink-agent.exe uninstall)'
  return
}

if ($Install) {
  Write-Host 'Installing dependencies...'
  Push-Location $CP; npm install; Pop-Location
  Push-Location $FE; npm install; Pop-Location
  if (-not (Test-Path "$DS\.venv\Scripts\python.exe")) { Push-Location $DS; python -m venv .venv; Pop-Location }
  & "$DS\.venv\Scripts\python.exe" -m pip install -q -r "$DS\requirements.txt"
}

# Preflight: the things that cannot be fixed by starting a window.
$missing = @()
if (-not (Test-Path "$CP\node_modules")) { $missing += 'control-plane\node_modules' }
if (-not (Test-Path "$FE\node_modules")) { $missing += 'frontend\node_modules' }
if (-not (Test-Path "$CP\.env")) { $missing += 'control-plane\.env (copy .env.example)' }
if (-not $NoAI -and -not (Test-Path "$DS\.venv\Scripts\python.exe")) { $missing += 'diagnostic-service\.venv' }
if ($missing) {
  Write-Host 'Missing:' -ForegroundColor Red; $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host 'Run:  .\scripts\start-all.ps1 -Install' -ForegroundColor Yellow
  exit 1
}

$ip = Get-LanIP
Write-Host ''
Write-Host 'Starting NexLink' -ForegroundColor Green

# 1. Database
if (Test-Port 27017) { Write-Host '  skip database (already running)' }
else { Start-Window 'database' $CP 'npm run dev:mongo' }
if (-not (Wait-Port 27017 'database')) { exit 1 }

# 2. Control plane
if (Test-Port 4000) { Write-Host '  skip control plane (already running)' }
else { Start-Window 'control plane' $CP 'npm run dev' }
$cpOk = Wait-Port 4000 'control plane'

# 3. AI diagnostic service (reads the Groq key from diagnostic-service\.env)
if (-not $NoAI) {
  if (Test-Port 8090) { Write-Host '  skip diagnostic service (already running)' }
  else { Start-Window 'diagnostic service' $DS '.\.venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090' }
  [void](Wait-Port 8090 'diagnostic service')
}

# 4. Web console
if (Test-Port 3000) { Write-Host '  skip web console (already running)' }
else { Start-Window 'web console' $FE 'npm run dev' }
$feOk = Wait-Port 3000 'web console' 120

# 5. Agent pc-1, pointed at this PC's current address so a second PC can reach its tunnel.
if (-not $NoAgent) {
  if (Get-Process nexlink-agent -ErrorAction SilentlyContinue) { Write-Host '  skip agent (already running)' }
  elseif (-not (Test-Path "$AgentDir\pc-1\state.json")) { Write-Host '  skip agent (pc-1 is not enrolled on this PC)' -ForegroundColor Yellow }
  elseif (-not $cpOk) { Write-Host '  skip agent (control plane is not up)' -ForegroundColor Yellow }
  else {
    $server = if ($ip) { "http://${ip}:4000" } else { 'http://127.0.0.1:4000' }
    Start-Window 'agent pc-1' $AgentDir ".\nexlink-agent.exe run --userspace --allow-http --server $server --state-dir .\pc-1"
    Write-Host "  ok   agent pc-1 started (server $server)" -ForegroundColor Green
  }
}

Write-Host ''
if ($cpOk -and $feOk) {
  Write-Host 'NexLink is up.' -ForegroundColor Green
  Write-Host '  this PC:        http://localhost:3000'
  if ($ip) { Write-Host "  other PCs:      http://${ip}:3000   (needs scripts\lan-firewall.ps1 -Server -Agent once, as Administrator)" }
  Write-Host '  stop all:       .\scripts\start-all.ps1 -Stop'
  Start-Process 'http://localhost:3000'
} else {
  Write-Host 'Something did not start - check the window named after it.' -ForegroundColor Red
}
