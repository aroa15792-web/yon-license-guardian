#!/usr/bin/env bash
# Read-only host inventory. Run on the intended host; this script does not SSH.
# It writes only to stdout/stderr and continues when an optional tool is absent.
set -uo pipefail

yon_preflight_failures=0

yon_section() {
  printf '\n[%s]\n' "$1"
}

yon_read() {
  if "$@"; then
    return 0
  else
    yon_read_status=$?
    printf 'Read failed (exit %s): %s\n' "$yon_read_status" "$1" >&2
    yon_preflight_failures=$((yon_preflight_failures + 1))
    return 0
  fi
}

yon_section 'OS and kernel'
if [ -r /etc/os-release ]; then
  yon_read awk '/^(PRETTY_NAME|ID|VERSION_ID)=/ { print }' /etc/os-release
fi
yon_read uname -srmo

yon_section 'CPU'
if command -v lscpu >/dev/null 2>&1; then
  # Select hardware capacity fields only; omit unrelated identifiers.
  if ! LC_ALL=C lscpu | awk '/^(Architecture:|CPU\(s\):|On-line CPU\(s\) list:|Thread\(s\) per core:|Core\(s\) per socket:|Socket\(s\):)/ { print }'; then
    printf 'CPU inventory unavailable\n' >&2
    yon_preflight_failures=$((yon_preflight_failures + 1))
  fi
elif command -v nproc >/dev/null 2>&1; then
  yon_read nproc
else
  printf 'Neither lscpu nor nproc is available\n'
  yon_preflight_failures=$((yon_preflight_failures + 1))
fi

yon_section 'Memory (MiB)'
if command -v free >/dev/null 2>&1; then
  yon_read free -m
elif [ -r /proc/meminfo ]; then
  yon_read awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { print }' /proc/meminfo
else
  printf 'Memory inventory unavailable\n'
  yon_preflight_failures=$((yon_preflight_failures + 1))
fi

yon_section 'Filesystem space'
yon_read df -h /
if [ -d /opt ]; then
  yon_read df -h /opt
fi

yon_section 'Listening TCP and UDP ports'
if command -v ss >/dev/null 2>&1; then
  yon_read ss -lntu
elif command -v netstat >/dev/null 2>&1; then
  yon_read netstat -lntu
else
  printf 'Neither ss nor netstat is available; do not assume ports are free\n'
  yon_preflight_failures=$((yon_preflight_failures + 1))
fi

if command -v docker >/dev/null 2>&1; then
  yon_section 'Compose projects'
  # This is a read of daemon state; no Compose file or environment is loaded.
  yon_read docker compose ls --all

  yon_section 'Containers (no command lines or environment)'
  yon_read docker ps --all --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

  yon_section 'One resource sample; not a peak-capacity measurement'
  yon_read docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}'

  yon_section 'Docker network names and subnets only'
  # Formatted network inspection deliberately excludes container attachments,
  # options, labels, and full inspection output.
  if yon_network_ids=$(docker network ls --quiet); then
    while IFS= read -r yon_network_id; do
      [ -n "$yon_network_id" ] || continue
      yon_read docker network inspect --format '{{.Name}}{{range .IPAM.Config}} subnet={{.Subnet}}{{end}}' "$yon_network_id"
    done <<< "$yon_network_ids"
  else
    printf 'Docker network inventory unavailable\n' >&2
    yon_preflight_failures=$((yon_preflight_failures + 1))
  fi
else
  yon_section 'Docker'
  printf 'Docker command unavailable; nothing installed or changed\n'
  yon_preflight_failures=$((yon_preflight_failures + 1))
fi

printf '\nRead-only inventory finished; failed or unavailable checks: %s\n' "$yon_preflight_failures"
if [ "$yon_preflight_failures" -gt 0 ]; then
  exit 1
fi
