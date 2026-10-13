#!/bin/bash
# Run on the selected server. Does not install dependencies or change other units.
set -euo pipefail
[[ $(id -u) = 0 ]] || { printf 'Root is required to start this isolated unit\n' >&2; exit 1; }
for yon_tool in Xvfb x11vnc xauth google-chrome node; do command -v "$yon_tool" >/dev/null; done
[[ -f /opt/yon-license-monitor/visual-login/server.mjs ]]
[[ -f /opt/yon-license-monitor/run-visual-login.sh ]]
[[ -f /opt/yon-license-monitor/deploy/cloud-browser/session.mjs ]]
yon_browser_mode=${1:-summary}
case "$yon_browser_mode" in summary|login) ;; *) printf 'Mode must be summary or login\n' >&2; exit 1 ;; esac
if ss -lntH 'sport = :19590' | read -r yon_existing; then
  printf 'VNC port already occupied; refusing to replace it\n' >&2
  exit 1
fi
if systemctl is-active --quiet yon-license-login; then
  printf 'Login service already active; stop only that service before restarting\n' >&2
  exit 1
fi
if systemctl is-active --quiet yon-license-monitor; then
  printf 'Read-only monitor is active; stop that service before entering interactive login\n' >&2
  exit 1
fi
systemd-run --unit=yon-license-login --collect --description='Temporary isolated YonSuite visual login; no monitoring or release' \
  --property=Type=exec --property=DynamicUser=yes --property=User=yon-license-login \
  --property=StateDirectory=yon-license-monitor --property=StateDirectoryMode=0700 \
  --property=RuntimeDirectory=yon-license-login --property=RuntimeDirectoryMode=0700 \
  --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateTmp=yes \
  --property=PrivateIPC=yes --property=NoNewPrivileges=yes --property=UMask=0077 \
  --property=CPUQuota=50% --property=MemoryHigh=448M --property=MemoryMax=512M \
  --property=MemorySwapMax=0 --property=TasksMax=192 --property=RuntimeMaxSec=30min \
  --property=KillMode=mixed --property=TimeoutStopSec=25s --property=OOMPolicy=kill \
  --setenv="YON_BROWSER_MODE=$yon_browser_mode" --property=Restart=no /bin/bash /opt/yon-license-monitor/run-visual-login.sh
