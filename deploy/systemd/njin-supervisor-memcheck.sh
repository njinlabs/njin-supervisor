#!/usr/bin/env bash
# Restarts njin-supervisor.service (graceful — via `systemctl restart`, which sends SIGTERM and
# lets the 10.5s drain in supervisor.ts's shutdown() run) once its RSS crosses THRESHOLD_BYTES.
# This exists because worker.terminate() leaks memory on Bun (see the comment in
# njin-supervisor.service) — RAM only trends upward over the process's lifetime, so a periodic,
# controlled restart is the practical mitigation until that's fixed upstream.
set -euo pipefail

SERVICE="njin-supervisor.service"
# Keep this comfortably below MemoryMax in njin-supervisor.service (2G there) — the goal is for
# this script to always win the race and restart gracefully before the kernel's cgroup OOM killer
# ever has a reason to SIGKILL.
THRESHOLD_BYTES=$((1500 * 1024 * 1024)) # 1.5G

current=$(systemctl show "$SERVICE" -p MemoryCurrent --value)

if [ "$current" = "[not set]" ] || [ -z "$current" ]; then
  echo "njin-supervisor-memcheck: could not read MemoryCurrent for $SERVICE, skipping"
  exit 0
fi

if [ "$current" -ge "$THRESHOLD_BYTES" ]; then
  echo "njin-supervisor-memcheck: ${current} bytes >= ${THRESHOLD_BYTES} threshold, restarting $SERVICE"
  systemctl restart "$SERVICE"
else
  echo "njin-supervisor-memcheck: ${current} bytes < ${THRESHOLD_BYTES} threshold, no action"
fi
