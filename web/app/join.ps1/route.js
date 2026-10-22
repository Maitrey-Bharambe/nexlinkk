/**
 * GET /join.ps1[?device=<id>][&share=rdp] — the one-line "connect this PC"
 * installer for Windows, usable from any network. Two ways in:
 *
 *   irm 'https://<portal>/join.ps1' | iex
 *       easiest: the same line for every PC. The PC shows a short code; an
 *       operator approves it in the console. Nothing secret is copied around.
 *
 *   $env:NEXLINK_ENROLLMENT_TOKEN='nxe_…'; irm 'https://<portal>/join.ps1?device=<id>' | iex
 *       invite link: enrolls with the one-time token, and falls back to a
 *       code if the token has expired or was already used.
 *
 * The script holds no secrets: a token travels only in the environment
 * variable of the user's own PowerShell (never in a URL or a flag).
 * The agent talks to the same address (API + relay), so the PC does not need
 * to be on the operator's network — any internet connection works.
 */
import { joinParams, portalOrigin, isPlainHttp, textResponse } from '@/lib/server/portal';

export function GET(request) {
  const portal = portalOrigin(request);
  const { device, share } = joinParams(request);
  if (!portal || device === null || share === null) {
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
$State  = Join-Path $Base '${device || 'this-pc'}'
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

${device ? '' : `# Generic line: reuse this PC's existing enrollment instead of creating a second one.
if (-not (Test-Path (Join-Path $State 'state.json'))) {
  $prev = Get-ChildItem $Base -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'state.json') } | Select-Object -First 1
  if ($prev) { $State = $prev.FullName }
}
`}
if (-not (Test-Path (Join-Path $State 'state.json'))) {
  Write-Host '  [2/3] joining the network (keys are created on this PC and never leave it)...'
  $joined = $false
  if ($env:NEXLINK_ENROLLMENT_TOKEN) {
    & $Exe enroll --server $Portal --state-dir $State @Flags
    $joined = ($LASTEXITCODE -eq 0)
    if (-not $joined) { Write-Host '        the invite token did not work (expired or used) - joining with a code instead.' -ForegroundColor Yellow }
  }
  if (-not $joined) {
    # Shows a short code; an operator approves it in the console. Waits until then.
    & $Exe join --server $Portal --state-dir $State @Flags
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  this PC was not added (denied or cancelled). Run the same line to try again.' -ForegroundColor Red
      return
    }
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
