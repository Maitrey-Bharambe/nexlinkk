<#
  NexLink - start everything for a demo, each part in its own window.

      .\scripts\start-all.ps1              NexLink (console + API + relay), AI service, pc-1 agent
      .\scripts\start-all.ps1 -NoAgent     same, without the agent
      .\scripts\start-all.ps1 -NoAI        same, without the diagnostic (Groq) service
      .\scripts\start-all.ps1 -Install     npm / pip installs and agent builds first (new machine or after git pull)
      .\scripts\start-all.ps1 -Stop        stop everything this script starts

  Or just double-click scripts\start-all.cmd.
  NexLink is one process on one port (3000). Without MONGODB_URI it uses the
  MongoDB already on this PC or starts an embedded one. Anything already
  running is left alone, so it is safe to run twice.
#>
param([switch]$NoAgent, [switch]$NoAI, [switch]$Install, [switch]$Stop)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Web = Join-Path $Root 'web'
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

# A running nexlink-agent whose command line contains $match (e.g. 'pc-1' or 'lab').
function Get-AgentProcess([string]$match) {
  Get-CimInstance Win32_Process -Filter "Name = 'nexlink-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$match*" }
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
  foreach ($port in 3000, 8090, 27017) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "  stopped port $port" }
  }
  Get-Process nexlink-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host 'Done. (A NexLink Agent Windows service, if installed, keeps running: nexlink-agent.exe uninstall)'
  return
}

# One-time move from the old two-app layout: keep the dev database and dev admin.
$oldData = Join-Path $Root 'control-plane\.data'
$newData = Join-Path $Web '.data'
if ((Test-Path $oldData) -and -not (Test-Path (Join-Path $newData 'mongo')) -and -not (Test-Port 27017)) {
  New-Item -ItemType Directory -Force $newData | Out-Null
  Get-ChildItem $oldData | ForEach-Object { Move-Item -Force $_.FullName $newData }
  Write-Host '  moved control-plane\.data to web\.data (dev database + dev admin)' -ForegroundColor Green
}
if (-not (Test-Path (Join-Path $Web '.env')) -and (Test-Path (Join-Path $Root 'control-plane\.env'))) {
  Get-Content (Join-Path $Root 'control-plane\.env') | Where-Object { $_ -notmatch '^(PORT|CORS_ORIGINS|CORS_ALLOW_PRIVATE_LAN)=' } |
    Set-Content -Encoding utf8 (Join-Path $Web '.env')
  Write-Host '  copied control-plane\.env to web\.env' -ForegroundColor Green
}

if ($Install) {
  Write-Host 'Installing dependencies...'
  Push-Location $Web; npm install; Pop-Location
  if (-not (Test-Path "$DS\.venv\Scripts\python.exe")) { Push-Location $DS; python -m venv .venv; Pop-Location }
  & "$DS\.venv\Scripts\python.exe" -m pip install -q -r "$DS\requirements.txt"
  & (Join-Path $PSScriptRoot 'build-agent.ps1')
}

# Preflight: the things that cannot be fixed by starting a window.
$missing = @()
if (-not (Test-Path "$Web\node_modules")) { $missing += 'web\node_modules' }
if (-not (Test-Path "$Web\public\downloads\nexlink-agent.exe")) { $missing += 'agent downloads (scripts\build-agent.ps1)' }
if (-not $NoAI -and -not (Test-Path "$DS\.venv\Scripts\python.exe")) { $missing += 'diagnostic-service\.venv' }
if ($missing) {
  Write-Host 'Missing:' -ForegroundColor Red; $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host 'Run:  .\scripts\start-all.ps1 -Install' -ForegroundColor Yellow
  exit 1
}

$ip = Get-LanIP
Write-Host ''
Write-Host 'Starting NexLink' -ForegroundColor Green

# 1. AI diagnostic service (reads the Groq key from diagnostic-service\.env)
if (-not $NoAI) {
  if (Test-Port 8090) { Write-Host '  skip diagnostic service (already running)' }
  else { Start-Window 'diagnostic service' $DS '.\.venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090' }
  [void](Wait-Port 8090 'diagnostic service')
}

# 2. NexLink: console, REST API, Socket.IO and agent relay in one process.
if (Test-Port 3000) { Write-Host '  skip NexLink (already running)' }
else { Start-Window 'nexlink' $Web 'npm run dev' }
$ok = Wait-Port 3000 'NexLink' 180

# 3. Agent pc-1 (this PC's side of the tunnel).
if (-not $NoAgent) {
  if (Get-AgentProcess 'pc-1') { Write-Host '  skip agent (already running)' }
  elseif (-not (Test-Path "$AgentDir\pc-1\state.json")) { Write-Host '  skip agent (pc-1 is not enrolled on this PC)' -ForegroundColor Yellow }
  elseif (-not $ok) { Write-Host '  skip agent (NexLink is not up)' -ForegroundColor Yellow }
  else {
    # Loopback keeps working when the Wi-Fi (and the LAN IP) changes. Peers still
    # learn the LAN address (the agent reports it) and fall back to the relay.
    Start-Window 'agent pc-1' $AgentDir '.\nexlink-agent.exe run --userspace --server http://127.0.0.1:3000 --state-dir .\pc-1'
    Write-Host '  ok   agent pc-1 started' -ForegroundColor Green
  }
}

# 4. Demo tunnel (only if demo data was created with scripts\demo-data.ps1).
$demoA = Join-Path $AgentDir 'demo\demo-laptop-a'
$demoB = Join-Path $AgentDir 'demo\demo-laptop-b'
if ((Test-Path "$demoA\state.json") -and (Test-Path "$demoB\state.json") -and $ok) {
  if (Get-AgentProcess 'lab') { Write-Host '  skip demo tunnel (already running)' }
  else {
    Start-Window 'demo tunnel' $AgentDir ".\nexlink-agent.exe lab --server http://127.0.0.1:3000 --a .\demo\demo-laptop-a --b .\demo\demo-laptop-b --duration 0"
    Write-Host '  ok   demo tunnel started (demo-laptop-a <-> demo-laptop-b)' -ForegroundColor Green
  }
}

Write-Host ''
if ($ok) {
  Write-Host 'NexLink is up.' -ForegroundColor Green
  Write-Host '  this PC:        http://localhost:3000'
  if ($ip) { Write-Host "  other PCs:      http://${ip}:3000   (same Wi-Fi; scripts\lan-firewall.ps1 -Server once, as Administrator)" }
  Write-Host '  any network:    deploy it (Dockerfile) or expose port 3000 and set PUBLIC_URL - see docs\deploy.md'
  Write-Host '  stop all:       .\scripts\start-all.ps1 -Stop'
  Start-Process 'http://localhost:3000'
} else {
  Write-Host 'Something did not start - check the window named after it.' -ForegroundColor Red
}
