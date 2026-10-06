#!/usr/bin/env bash
# Logs of a deployed compose project.
#
#   scripts/logs.sh <market|a|b|c|flux> [service] [--follow] [--tail N]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

usage() {
  echo "usage: scripts/logs.sh <market|a|b|c|flux> [service] [--follow] [--tail N]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
role=$1
shift
host=$(role_host "$role") || usage
project=$(role_project "$role")

service=""
follow=""
tail=200
while [ $# -gt 0 ]; do
  case "$1" in
    --follow | -f)
      follow="--follow"
      shift
      ;;
    --tail)
      [ $# -ge 2 ] || usage
      tail=$2
      shift 2
      ;;
    -*) usage ;;
    *)
      service=$1
      shift
      ;;
  esac
done

tty=""
[ -z "$follow" ] || tty="-t"
# shellcheck disable=SC2086
ssh $SSH_OPTS $tty "root@$(host_ip "$host")" \
  "cd /opt/pekkah/$project && $(remote_compose "$role") logs --no-color --tail $tail $follow $service"
