<#
  Builds the NexLink agent for every platform the portal offers and puts the
  binaries where /join.ps1 and /join.sh download them from:

      web\public\downloads\nexlink-agent.exe               Windows x64
      web\public\downloads\nexlink-agent-linux-amd64        Linux x64
      web\public\downloads\nexlink-agent-linux-arm64        Linux ARM64 (Raspberry Pi 4/5, ARM servers)
      web\public\downloads\nexlink-agent-darwin-amd64       macOS Intel
      web\public\downloads\nexlink-agent-darwin-arm64       macOS Apple silicon

  and a copy for local use in networking-agent\bin. Uses Go from PATH, or the
  portable one in .tools\go. Pure Go (CGO off): no C toolchain needed.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Agent = Join-Path $Root 'networking-agent'
$Out = Join-Path $Root 'web\public\downloads'
New-Item -ItemType Directory -Force $Out | Out-Null

$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) {
  $go = Join-Path $Root '.tools\go\bin\go.exe'
  if (-not (Test-Path $go)) { throw 'Go not found: install Go 1.22+ or unpack it to .tools\go' }
  $env:GOPATH = Join-Path $Root '.tools\gopath'
  $env:GOCACHE = Join-Path $Root '.tools\gocache'
}

$targets = @(
  @('windows', 'amd64', 'nexlink-agent.exe'),
  @('linux', 'amd64', 'nexlink-agent-linux-amd64'),
  @('linux', 'arm64', 'nexlink-agent-linux-arm64'),
  @('darwin', 'amd64', 'nexlink-agent-darwin-amd64'),
  @('darwin', 'arm64', 'nexlink-agent-darwin-arm64')
)
$env:CGO_ENABLED = '0'
Push-Location $Agent
try {
  foreach ($t in $targets) {
    $env:GOOS = $t[0]; $env:GOARCH = $t[1]
    & $go build -trimpath -ldflags '-s -w' -o (Join-Path $Out $t[2]) ./cmd/nexlink-agent
    if ($LASTEXITCODE -ne 0) { throw "build failed for $($t[0])/$($t[1])" }
    Write-Host "  ok  $($t[0])/$($t[1])  ->  web\public\downloads\$($t[2])" -ForegroundColor Green
  }
} finally {
  Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
  Pop-Location
}
New-Item -ItemType Directory -Force (Join-Path $Agent 'bin') | Out-Null
Copy-Item -Force (Join-Path $Out 'nexlink-agent.exe') (Join-Path $Agent 'bin\nexlink-agent.exe')
Write-Host '  ok  networking-agent\bin\nexlink-agent.exe (local copy)' -ForegroundColor Green
