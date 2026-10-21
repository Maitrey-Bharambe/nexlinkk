/**
 * GET /join.ps1?device=<id> — the one-line "connect this PC" installer.
 *
 * The setup page shows:
 *   $env:NEXLINK_ENROLLMENT_TOKEN='nxe_…'; irm 'http://<portal>/join.ps1?device=<id>' | iex
 *
 * The script holds no secrets: the one-time token travels only in the
 * environment variable of the user's own PowerShell (never in a URL or a flag).
 * The portal address is taken from the request, i.e. the address this PC
 * already used to reach the console; it is validated before being embedded.
 */

const HOST_RE = /^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(?::\d{1,5})?$/;
const DEVICE_RE = /^[a-f0-9]{24}$/;

export function GET(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || '';
  const device = url.searchParams.get('device') || '';
  if (!HOST_RE.test(host) || !DEVICE_RE.test(device)) {
    return new Response("Write-Host 'NexLink: invalid join link - copy it again from the setup page.' -ForegroundColor Red\n", {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const hostname = host.replace(/:\d+$/, '');
  return new Response(script({ portal: `${scheme}://${host}`, server: `${scheme}://${hostname}:4000`, device }), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ASCII only: Windows PowerShell 5.1 runs this through `irm | iex`.
const script = ({ portal, server, device }) => `
$ErrorActionPreference = 'Stop'
$Portal = '${portal}'
$Server = '${server}'
$Base   = Join-Path $env:LOCALAPPDATA 'NexLink'
$Exe    = Join-Path $Base 'nexlink-agent.exe'
$State  = Join-Path $Base '${device}'
$Host.UI.RawUI.WindowTitle = 'NexLink agent - keep this window open'

Write-Host ''
Write-Host '  NexLink - connecting this PC' -ForegroundColor Green
Write-Host ''
New-Item -ItemType Directory -Force $Base | Out-Null

if (-not (Test-Path $Exe)) {
  Write-Host '  [1/3] downloading the agent...'
  $tmp = "$Exe.part"
  Invoke-WebRequest -UseBasicParsing "$Portal/downloads/nexlink-agent.exe" -OutFile $tmp
  Move-Item -Force $tmp $Exe
} else {
  Write-Host '  [1/3] agent already downloaded'
}

if (-not (Test-Path (Join-Path $State 'state.json'))) {
  if (-not $env:NEXLINK_ENROLLMENT_TOKEN) {
    Write-Host '  no enrollment token - copy the full line again from the setup page.' -ForegroundColor Red
    return
  }
  Write-Host '  [2/3] joining your network (keys are created on this PC)...'
  & $Exe enroll --server $Server --allow-http --state-dir $State
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  could not join - the token may have expired. Click "register a pc" again.' -ForegroundColor Red
    return
  }
} else {
  Write-Host '  [2/3] this PC is already enrolled'
}
Remove-Item Env:NEXLINK_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue

Write-Host '  [3/3] starting the encrypted tunnel. If Windows asks about network access, click Allow.'
Write-Host '        Closing this window disconnects this PC. Run the same line again to reconnect.' -ForegroundColor DarkGray
Write-Host ''
$ErrorActionPreference = 'Continue'
& $Exe run --userspace --allow-http --state-dir $State 2>&1 | ForEach-Object {
  $line = "$_"
  try {
    $j = $line | ConvertFrom-Json
    $extra = ($j.PSObject.Properties | Where-Object { 'time', 'level', 'msg' -notcontains $_.Name } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  '
    $color = switch ($j.level) { 'ERROR' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
    if ($j.msg -like 'tunnel probe*' -or $j.msg -like 'tunnel peers*') { $color = 'Green' }
    Write-Host ('  {0}  {1}   {2}' -f ([datetime]$j.time).ToString('HH:mm:ss'), $j.msg, $extra) -ForegroundColor $color
  } catch {
    Write-Host "  $line"
  }
}
`;
