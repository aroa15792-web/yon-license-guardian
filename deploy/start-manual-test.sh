#!/bin/bash
# Explicit, one-time server-side acceptance test; never scheduled or restarted.
set -euo pipefail
[[ $(id -u) = 0 ]] || exit 1
for yon_unit in yon-license-monitor yon-license-login; do
  if systemctl is-active --quiet "$yon_unit"; then
    printf 'Stop this project service before the one-time test: %s\n' "$yon_unit" >&2
    exit 1
  fi
done
[[ -f /etc/yon-license-monitor/yon-login.json ]] || exit 1
systemd-run --unit=yon-license-test --collect --wait --pipe \
  --description='One explicit procurement occupancy release acceptance test' \
  --property=Type=exec --property=DynamicUser=yes --property=User=yon-license-login \
  --property=StateDirectory=yon-license-monitor --property=StateDirectoryMode=0700 \
  --property=RuntimeDirectory=yon-license-login --property=RuntimeDirectoryMode=0700 \
  --property=EnvironmentFile=/opt/yon-license-monitor/monitor.env \
  --property=LoadCredential=yon-login:/etc/yon-license-monitor/yon-login.json \
  --setenv=YON_MANUAL_TEST_ONCE=1 \
  --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes \
  --property=PrivateIPC=yes --property=NoNewPrivileges=yes --property=UMask=0077 \
  --property=CPUQuota=50% --property=MemoryHigh=448M --property=MemoryMax=512M \
  --property=MemorySwapMax=0 --property=TasksMax=192 --property=RuntimeMaxSec=3min \
  --property=KillMode=mixed --property=TimeoutStopSec=50s --property=OOMPolicy=kill \
  --property=Restart=no \
  /bin/bash /opt/yon-license-monitor/run-manual-test.sh --confirm-procurement-release
