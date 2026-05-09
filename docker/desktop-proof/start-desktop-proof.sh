#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
screen="${MANOR_DESKTOP_PROOF_SCREEN:-1920x1080x24}"
rfb_port="${MANOR_DESKTOP_PROOF_RFB_PORT:-5900}"
vnc_port="${MANOR_DESKTOP_PROOF_VNC_PORT:-6080}"
state_dir="${MANOR_DESKTOP_PROOF_STATE_DIR:-/state}"
desktop_home="${MANOR_DESKTOP_PROOF_HOME:-$state_dir/home}"

export HOME="$desktop_home"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$HOME/.fluxbox"

if [ ! -f "$HOME/.fluxbox/init" ]; then
  cat >"$HOME/.fluxbox/init" <<'EOF'
session.screen0.rootCommand: fbsetroot -solid "#1f2933"
session.screen0.toolbar.visible: true
session.screen0.toolbar.autoHide: false
session.screen0.allowRemoteActions: true
EOF
fi

if grep -q '^session.screen0.allowRemoteActions:' "$HOME/.fluxbox/init"; then
  sed -i 's/^session.screen0.allowRemoteActions:.*/session.screen0.allowRemoteActions: true/' "$HOME/.fluxbox/init"
else
  printf '\nsession.screen0.allowRemoteActions: true\n' >>"$HOME/.fluxbox/init"
fi

if command -v dbus-launch >/dev/null 2>&1 && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax)"
fi

rm -f "/tmp/.X${display#:}-lock"

Xvfb "$display" -screen 0 "$screen" -ac +extension RANDR &

tries=0
until xdpyinfo -display "$display" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 50 ]; then
    echo "Desktop display did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done

fluxbox >/tmp/manor-fluxbox.log 2>&1 &
x11vnc -display "$display" -forever -shared -nopw -listen 0.0.0.0 -rfbport "$rfb_port" >/tmp/manor-x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ "$vnc_port" "127.0.0.1:$rfb_port" >/tmp/manor-novnc.log 2>&1 &

exec node /opt/manor/desktop-proof/desktop-proof-server.mjs
