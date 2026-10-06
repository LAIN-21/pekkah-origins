#!/usr/bin/env bash
# Real failures for the demo (PLAN 9, PR-06 and PR-09). Nothing is simulated: these act on the
# worker hosts.
#
#   scripts/chaos.sh kill-job <a|b|c>       docker kill the running job container: the job
#                                           fails, the market answers 502, nothing is charged
#   scripts/chaos.sh stop-worker <a|b|c>    stop the worker: offline within 15 s
#   scripts/chaos.sh start-worker <a|b|c>   start it again: online and recalibrated
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

usage() {
  echo "usage: scripts/chaos.sh <kill-job|stop-worker|start-worker> <a|b|c>" >&2
  exit 2
}
[ $# -eq 2 ] || usage
action=$1
role=$2
case "$role" in a | b | c) ;; *) usage ;; esac
host=$(role_host "$role")
compose=$(remote_compose "$role")

case "$action" in
  kill-job)
    remote "$host" "ids=\$(docker ps -q --filter label=pekkah.job); if [ -z \"\$ids\" ]; then echo 'no job container is running' >&2; exit 1; fi; docker kill \$ids >/dev/null && echo \"killed job container(s): \$(docker ps -a --filter label=pekkah.job --format '{{.Names}}' | tr '\\n' ' ')\""
    ;;
  stop-worker)
    remote "$host" "cd /opt/pekkah/worker && $compose stop worker" && echo "worker $role stopped at $(date +%H:%M:%S)"
    ;;
  start-worker)
    remote "$host" "cd /opt/pekkah/worker && $compose start worker" && echo "worker $role started at $(date +%H:%M:%S)"
    ;;
  *) usage ;;
esac
