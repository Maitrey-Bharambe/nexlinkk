<#
  NexLink - fill every console page with a demo scenario (real enrollments, a real
  tunnel, [TEST] incidents through the real approval path). Needs NexLink running
  (scripts\start-all.ps1).

      .\scripts\demo-data.ps1           create demo networks/devices, start the demo tunnel, run the scenarios
      .\scripts\demo-data.ps1 -Remove   stop the demo tunnel and delete all demo data

  The demo tunnel runs in its own window ("NexLink - demo tunnel"). Keep it open during
  the demo; scripts\start-all.ps1 starts it again automatically next time.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Web = Join-Path $Root 'web'
$AgentDir = Join-Path $Root 'networking-agent\bin'

function Stop-DemoTunnel {
  Get-CimInstance Win32_Process -Filter "Name = 'nexlink-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*lab*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host '  stopped demo tunnel' }
}

Push-Location $Web
try {
  if ($Remove) {
    Stop-DemoTunnel
    Start-Sleep -Seconds 1
    node scripts/seed-demo.js remove
    return
  }

  Write-Host 'Creating demo networks and devices...' -ForegroundColor Green
  node scripts/seed-demo.js setup
  if ($LASTEXITCODE -ne 0) { throw 'setup failed (see above)' }

  Write-Host 'Starting the demo tunnel window...' -ForegroundColor Green
  Stop-DemoTunnel
  $cmd = "`$Host.UI.RawUI.WindowTitle = 'NexLink - demo tunnel'; .\nexlink-agent.exe lab --server http://127.0.0.1:3000 --a .\demo\demo-laptop-a --b .\demo\demo-laptop-b --duration 0"
  Start-Process powershell -WorkingDirectory $AgentDir -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $cmd | Out-Null

  Write-Host 'Running the scenarios (incidents, diagnoses, approvals)...' -ForegroundColor Green
  node scripts/seed-demo.js scenarios
  if ($LASTEXITCODE -ne 0) { throw 'scenarios failed (see above)' }
  Write-Host 'Done. Open http://localhost:3000' -ForegroundColor Green
} finally {
  Pop-Location
}
