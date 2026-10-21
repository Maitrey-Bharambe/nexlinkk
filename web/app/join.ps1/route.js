/**
 * GET /join.ps1?device=<id>[&share=rdp] — the one-line "connect this PC"
 * installer for Windows, usable from any network:
 *
 *   $env:NEXLINK_ENROLLMENT_TOKEN='nxe_…'; irm 'https://<portal>/join.ps1?device=<id>' | iex
 *
 * The script holds no secrets: the one-time token travels only in the
 * environment variable of the user's own PowerShell (never in a URL or a flag).
 * The agent talks to the same address (API + relay), so the PC does not need
 * to be on the operator's network — any internet connection works.
 */
import { joinParams, portalOrigin, isPlainHttp, textResponse } from '@/lib/server/portal';

export function GET(request) {
  const portal = portalOrigin(request);
  const { device, share } = joinParams(request);
  if (!portal || !device || share === null) {
    return textResponse("Write-Host 'NexLink: invalid join link - copy it again from the portal.' -ForegroundColor Red\n", 400);
  }
  return textResponse(script({ portal, device, share, http: isPlainHttp(portal) }));
}

// ASCII only: Windows PowerShell 5.1 runs this through `irm | iex`.
const script = ({ portal, device, share, http }) => `
$ErrorActionPreference = 'Stop'
$Portal = '${portal}'
$Base   = Join-Path $env:LOCALAPPDATA 'NexLink'
$Exe    = Join-Path $Base 'nexlink-agent.exe'
$State  = Join-Path $Base '${device}'
$Flags  = @(${http ? "'--allow-http'" : ''})
$Share  = '${share}'
$Host.UI.RawUI.WindowTitle = 'NexLink agent - keep this window open'

Write-Host ''
Write-Host '  NexLink - connecting this PC' -ForegroundColor Green
Write-Host ''
New-Item -ItemType Directory -Force $Base | Out-Null

# Always fetch the portal's current agent (small, and keeps every PC in step).
Write-Host '  [1/3] downloading the agent...'
$tmp = "$Exe.part"
try {
  Invoke-WebRequest -UseBasicParsing "$Portal/downloads/nexlink-agent.exe" -OutFile $tmp
  Get-Process nexlink-agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  Move-Item -Force $tmp $Exe
} catch {
  if (-not (Test-Path $Exe)) { throw }
  Write-Host '        could not download; using the copy already on this PC' -ForegroundColor DarkGray
}

if (-not (Test-Path (Join-Path $State 'state.json'))) {
  if (-not $env:NEXLINK_ENROLLMENT_TOKEN) {
    Write-Host '  no enrollment token - copy the full line again from the portal.' -ForegroundColor Red
    return
  }
  Write-Host '  [2/3] joining the network (keys are created on this PC and never leave it)...'
  & $Exe enroll --server $Portal --state-dir $State @Flags
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  could not join - the invite may have expired. Ask for a new one.' -ForegroundColor Red
    return
  }
} else {
  Write-Host '  [2/3] this PC is already enrolled'
}
Remove-Item Env:NEXLINK_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue

$RunArgs = @('run', '--userspace', '--server', $Portal, '--state-dir', $State) + $Flags
if ($Share) {
  $RunArgs += @('--share', $Share)
  Write-Host "        sharing for remote sessions: $Share (tunnel peers only)" -ForegroundColor DarkGray
}
Write-Host '  [3/3] starting the encrypted tunnel. Direct when possible, through the relay otherwise.'
Write-Host '        Closing this window disconnects this PC. Run the same line again to reconnect.' -ForegroundColor DarkGray
Write-Host "        Open a remote session from here:  & '$Exe' session <device> rdp" -ForegroundColor DarkGray
Write-Host ''
$ErrorActionPreference = 'Continue'
& $Exe @RunArgs 2>&1 | ForEach-Object {
  $line = "$_"
  try {
    $j = $line | ConvertFrom-Json
    $extra = ($j.PSObject.Properties | Where-Object { 'time', 'level', 'msg' -notcontains $_.Name } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  '
    $color = switch ($j.level) { 'ERROR' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
    if ($j.msg -like 'tunnel probe*' -or $j.msg -like 'tunnel peers*' -or $j.msg -like 'remote session*' -or $j.msg -like 'relay connected*') { $color = 'Green' }
    Write-Host ('  {0}  {1}   {2}' -f ([datetime]$j.time).ToString('HH:mm:ss'), $j.msg, $extra) -ForegroundColor $color
  } catch {
    Write-Host "  $line"
  }
}
`;
