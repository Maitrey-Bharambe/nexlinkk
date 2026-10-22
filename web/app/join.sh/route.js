/**
 * GET /join.sh[?device=<id>][&share=ssh] — the Linux / macOS installer:
 *
 *   curl -fsSL 'https://<portal>/join.sh' | sh
 *       easiest: shows a code an operator approves in the console
 *   curl -fsSL 'https://<portal>/join.sh?device=<id>' | NEXLINK_ENROLLMENT_TOKEN='nxe_…' sh
 *       invite link; falls back to a code if the token no longer works
 *
 * Same contract as /join.ps1: no secrets in the script or the URL, keys are
 * created on the device, and the agent reaches the portal (API + relay) from
 * any network. No root needed: the tunnel runs inside the agent.
 */
import { joinParams, portalOrigin, isPlainHttp, textResponse } from '@/lib/server/portal';

export function GET(request) {
  const portal = portalOrigin(request);
  const { device, share } = joinParams(request);
  if (!portal || device === null || share === null) {
    return textResponse("echo 'NexLink: invalid join link - copy it again from the portal.' >&2; exit 1\n", 400);
  }
  return textResponse(script({ portal, device, share, http: isPlainHttp(portal) }));
}

const script = ({ portal, device, share, http }) => `#!/bin/sh
set -eu
PORTAL='${portal}'
BASE="\${XDG_DATA_HOME:-$HOME/.local/share}/nexlink"
STATE="$BASE/${device || 'this-pc'}"
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

${device ? '' : `# Generic line: reuse an existing enrollment on this computer.
if [ ! -f "$STATE/state.json" ]; then
  for d in "$BASE"/*/; do [ -f "$d/state.json" ] && STATE="\${d%/}" && break; done
fi
`}
if [ ! -f "$STATE/state.json" ]; then
  echo '  [2/3] joining the network (keys are created here and never leave this computer)...'
  JOINED=no
  if [ -n "\${NEXLINK_ENROLLMENT_TOKEN:-}" ]; then
    # shellcheck disable=SC2086
    if "$EXE" enroll --server "$PORTAL" --state-dir "$STATE" $FLAGS; then JOINED=yes
    else echo '        the invite token did not work (expired or used) - joining with a code instead.'; fi
  fi
  if [ "$JOINED" = no ]; then
    # Shows a short code; an operator approves it in the console. Waits until then.
    # shellcheck disable=SC2086
    "$EXE" join --server "$PORTAL" --state-dir "$STATE" $FLAGS || { echo '  this computer was not added. Run the same line to try again.' >&2; exit 1; }
  fi
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
