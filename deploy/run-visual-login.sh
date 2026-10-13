#!/bin/bash
# Runs only inside the dedicated, resource-limited transient systemd service.
set -euo pipefail
umask 077
export HOME=/var/lib/yon-license-monitor
export XDG_CONFIG_HOME="$HOME/config"
export XDG_CACHE_HOME="$HOME/cache"
export DISPLAY=:197
export XAUTHORITY=/run/yon-license-login/Xauthority
export YON_VNC_SOCKET_PATH=/run/yon-license-login/web.sock
export YON_VNC_PASSWORD_FILE=/run/yon-license-login/vnc-password
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

python3 - <<'PY'
import os, secrets, string, subprocess
path = os.environ['YON_VNC_PASSWORD_FILE']
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)) + '\n')
auth = os.environ['XAUTHORITY']
with open(auth, 'x'):
    pass
subprocess.run(['xauth', '-f', auth, 'source', '-'], input=f'add :197 . {secrets.token_hex(16)}\n', text=True, check=True, capture_output=True)
PY

yon_children=()
yon_browser_pid=''
yon_cleanup() {
  trap - EXIT TERM INT
  # Close Chrome through its owning Node process before stopping the display.
  if [[ -n "$yon_browser_pid" ]]; then
    kill "$yon_browser_pid" 2>/dev/null || true
    wait "$yon_browser_pid" 2>/dev/null || true
  fi
  for yon_pid in "${yon_children[@]}"; do kill "$yon_pid" 2>/dev/null || true; done
  wait || true
}
trap yon_cleanup EXIT
trap 'yon_cleanup; exit 0' TERM INT

Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp -auth "$XAUTHORITY" >/dev/null 2>&1 &
yon_display_pid=$!
yon_children+=("$yon_display_pid")
for yon_attempt in {1..50}; do
  kill -0 "$yon_display_pid"
  [[ -S /tmp/.X11-unix/X197 ]] && break
  sleep 0.1
done
[[ -S /tmp/.X11-unix/X197 ]] || { printf 'Display did not start\n' >&2; exit 1; }

x11vnc -norc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -localhost -no6 -noipv6 -rfbport 19590 -passwdfile "$YON_VNC_PASSWORD_FILE" -forever -shared -noxdamage -noremote -nosel -noprimary -noclipboard >/dev/null 2>&1 &
yon_children+=("$!")

node /opt/yon-license-monitor/deploy/cloud-browser/session.mjs &
yon_browser_pid=$!
yon_children+=("$yon_browser_pid")

node /opt/yon-license-monitor/visual-login/server.mjs &
yon_children+=("$!")
# Any child ending tears down only this service's process group via systemd.
wait -n "${yon_children[@]}"
