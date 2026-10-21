/**
 * GET /join.sh?device=<id>[&share=ssh] — the Linux / macOS installer:
 *
 *   curl -fsSL 'https://<portal>/join.sh?device=<id>' | NEXLINK_ENROLLMENT_TOKEN='nxe_…' sh
 *
 * Same contract as /join.ps1: no secrets in the script or the URL, keys are
 * created on the device, and the agent reaches the portal (API + relay) from
 * any network. No root needed: the tunnel runs inside the agent.
 */
import { joinParams, portalOrigin, isPlainHttp, textResponse } from '@/lib/server/portal';

export function GET(request) {
  const portal = portalOrigin(request);
  const { device, share } = joinParams(request);
  if (!portal || !device || share === null) {
    return textResponse("echo 'NexLink: invalid join link - copy it again from the portal.' >&2; exit 1\n", 400);
  }
  return textResponse(script({ portal, device, share, http: isPlainHttp(portal) }));
}

const script = ({ portal, device, share, http }) => `#!/bin/sh
set -eu
PORTAL='${portal}'
BASE="\${XDG_DATA_HOME:-$HOME/.local/share}/nexlink"
STATE="$BASE/${device}"
FLAGS='${http ? '--allow-http' : ''}'
SHARE='${share}'

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) BIN=nexlink-agent-linux-amd64 ;;
  Linux-aarch64|Linux-arm64) BIN=nexlink-agent-linux-arm64 ;;
  Darwin-x86_64) BIN=nexlink-agent-darwin-amd64 ;;
  Darwin-arm64) BIN=nexlink-agent-darwin-arm64 ;;
  *) echo "NexLink: no agent build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

echo
echo '  NexLink - connecting this computer'
echo
mkdir -p "$BASE"
EXE="$BASE/nexlink-agent"
echo '  [1/3] downloading the agent...'
if curl -fsSL "$PORTAL/downloads/$BIN" -o "$EXE.part"; then
  chmod +x "$EXE.part" && mv -f "$EXE.part" "$EXE"
elif [ ! -x "$EXE" ]; then
  echo '  could not download the agent' >&2; exit 1
fi

if [ ! -f "$STATE/state.json" ]; then
  if [ -z "\${NEXLINK_ENROLLMENT_TOKEN:-}" ]; then
    echo '  no enrollment token - copy the full line again from the portal.' >&2; exit 1
  fi
  echo '  [2/3] joining the network (keys are created here and never leave this computer)...'
  # shellcheck disable=SC2086
  "$EXE" enroll --server "$PORTAL" --state-dir "$STATE" $FLAGS
else
  echo '  [2/3] already enrolled'
fi
unset NEXLINK_ENROLLMENT_TOKEN

set -- run --userspace --server "$PORTAL" --state-dir "$STATE"
[ -n "$FLAGS" ] && set -- "$@" $FLAGS
[ -n "$SHARE" ] && set -- "$@" --share "$SHARE"
echo '  [3/3] starting the encrypted tunnel (direct when possible, relay otherwise). Ctrl+C disconnects.'
echo "        remote session from here:  $EXE session <device> ssh"
echo
exec "$EXE" "$@"
`;
