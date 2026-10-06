#!/usr/bin/env bash
# Shows the sandbox of the job container(s) running on a worker host (PLAN 7.3): network,
# read-only root, dropped capabilities, memory, CPUs, pids, user and mounts. It reads only
# HostConfig fields, never the container's env.
# Usage: scripts/inspect-job.sh <a|b|c|local>    (a, b and c go through scripts/ssh.sh)
set -euo pipefail

role="${1:-}"
format='{{.Name}}  NetworkMode={{.HostConfig.NetworkMode}}  ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}}  CapDrop={{.HostConfig.CapDrop}}  Memory={{.HostConfig.Memory}}  NanoCpus={{.HostConfig.NanoCpus}}  PidsLimit={{.HostConfig.PidsLimit}}  User={{.Config.User}}  SecurityOpt={{.HostConfig.SecurityOpt}}  Mounts={{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}'
inspect="ids=\$(docker ps -q --filter label=pekkah.job); if [ -z \"\$ids\" ]; then echo 'no job container is running' >&2; exit 1; fi; docker inspect --format '$format' \$ids"

case "$role" in
  local) bash -c "$inspect" ;;
  a | b | c) exec "$(dirname "$0")/ssh.sh" "$role" "$inspect" ;;
  *)
    echo "usage: scripts/inspect-job.sh <a|b|c|local>" >&2
    exit 2
    ;;
esac
