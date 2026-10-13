#!/bin/bash
# One explicit procurement release test. No listener or periodic monitor.
set -euo pipefail
umask 077
[[ ${YON_MANUAL_TEST_ONCE:-0} = 1 ]] || { printf 'Manual test is disabled\n' >&2; exit 1; }
[[ ${YON_TENANT_HASH:-} =~ ^[a-f0-9]{64}$ ]] || { printf 'Verified tenant hash is required\n' >&2; exit 1; }
[[ $# = 1 && $1 = --confirm-procurement-release ]] || { printf 'Explicit procurement test confirmation is required\n' >&2; exit 1; }
yon_manual_state_directory=/var/lib/yon-license-monitor
export XDG_CONFIG_HOME="$yon_manual_state_directory/config"
export XDG_CACHE_HOME="$yon_manual_state_directory/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
exec 9>/run/yon-license-login/controller.lock
flock -n 9 || { printf 'Another controller owns the runtime lock\n' >&2; exit 1; }
yon_manual_pid=''
yon_cleanup() {
  trap - EXIT
  trap '' TERM INT
  if [[ -n "$yon_manual_pid" ]]; then
    kill "$yon_manual_pid" 2>/dev/null || true
    wait "$yon_manual_pid" 2>/dev/null || true
  fi
}
yon_stop() { yon_cleanup; exit 0; }
trap yon_cleanup EXIT
trap yon_stop TERM INT
node /opt/yon-license-monitor/deploy/cloud-browser/manual-test.mjs --confirm-procurement-release &
yon_manual_pid=$!
yon_manual_status=0
wait "$yon_manual_pid" || yon_manual_status=$?
yon_manual_pid=''
exit "$yon_manual_status"
