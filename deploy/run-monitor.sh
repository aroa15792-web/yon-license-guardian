#!/bin/bash
# Dedicated procurement monitor. No X server, VNC, or TCP listener.
set -euo pipefail
umask 077
export HOME=/var/lib/yon-license-monitor
export XDG_CONFIG_HOME="$HOME/config"
export XDG_CACHE_HOME="$HOME/cache"
export YON_BROWSER_MODE=summary
export YON_BROWSER_HEADLESS=1
[[ ${YON_TENANT_HASH:-} =~ ^[a-f0-9]{64}$ ]] || { printf 'Verified tenant hash is required\n' >&2; exit 1; }
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
exec 9>/run/yon-license-login/controller.lock
flock -n 9 || { printf 'Another controller owns the runtime lock\n' >&2; exit 1; }

yon_browser_pid=''
yon_monitor_pid=''
yon_status_pid=''
yon_cleanup() {
  trap - EXIT
  # Do not let a repeated stop signal interrupt the graceful child shutdown.
  trap '' TERM INT
  if [[ -n "$yon_monitor_pid" ]]; then
    kill "$yon_monitor_pid" 2>/dev/null || true
    wait "$yon_monitor_pid" 2>/dev/null || true
  fi
  if [[ -n "$yon_browser_pid" ]]; then
    kill "$yon_browser_pid" 2>/dev/null || true
    wait "$yon_browser_pid" 2>/dev/null || true
  fi
  if [[ -n "$yon_status_pid" ]]; then
    kill "$yon_status_pid" 2>/dev/null || true
    wait "$yon_status_pid" 2>/dev/null || true
  fi
}
yon_stop() {
  yon_cleanup
  exit 0
}
trap yon_cleanup EXIT
trap yon_stop TERM INT
node /opt/yon-license-monitor/deploy/cloud-browser/session.mjs &
yon_browser_pid=$!
# Wait only for our own browser's private socket. Startup failure stops this unit.
for yon_attempt in {1..120}; do
  kill -0 "$yon_browser_pid"
  [[ -S /run/yon-license-login/browser-control.sock ]] && break
  sleep 0.5
done
[[ -S /run/yon-license-login/browser-control.sock ]] || exit 1
if [[ ${YON_AUTO_RELEASE:-0} = 1 ]]; then
  node /opt/yon-license-monitor/src/auto-release-main.mjs &
else
  node /opt/yon-license-monitor/src/summary-monitor.mjs &
fi
yon_monitor_pid=$!
node /opt/yon-license-monitor/deploy/status-viewer/server.mjs &
yon_status_pid=$!
wait -n "$yon_browser_pid" "$yon_monitor_pid" "$yon_status_pid" || true
# An unrequested child exit must be visible as a failure to systemd.
# A requested stop exits directly from yon_stop, before reaching this line.
exit 1
